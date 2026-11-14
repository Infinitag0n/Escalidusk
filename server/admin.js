import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "escalidusk_admin";
const SESSION_MS = 12 * 60 * 60 * 1000;
// Password guessing is slowed down for everyone at once, not per address:
// addresses are cheap to change, and there is only one password to guess.
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAGE = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const digest = (text) => createHash("sha256").update(text).digest();

function cookieOf(request) {
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === COOKIE) return value;
  }
  return null;
}

function paging(query) {
  const number = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    search: String(query.search ?? "").trim().slice(0, 200),
    limit: Math.min(number(query.limit, 50), MAX_PAGE),
    offset: number(query.offset, 0),
  };
}

/**
 * The backoffice API, under /api/admin: listing and deleting diagrams, seeing
 * who uses the server, and housekeeping.
 *
 * It is switched on by setting a password. Without one, only the "is it
 * enabled" question is answered and nothing else exists. With one, a correct
 * password buys a session cookie; every other route needs that cookie.
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {object} options
 * @param {ReturnType<import("./store.js").openStore>} options.store
 * @param {ReturnType<import("./live.js").createLiveRooms>} options.live
 * @param {string} options.password empty to leave the backoffice switched off
 */
export function registerAdmin(app, { store, live, password }) {
  const enabled = password.length > 0;
  const sessions = new Map(); // token -> expiry time
  let failures = []; // times of recent wrong passwords

  const signedIn = (request) => {
    const token = cookieOf(request);
    const expires = token && sessions.get(token);
    if (!expires) return false;
    if (expires > Date.now()) return true;
    sessions.delete(token);
    return false;
  };

  const setCookie = (request, reply, value, maxAgeSeconds) => {
    const secure = request.protocol === "https" ? "; Secure" : "";
    reply.header(
      "Set-Cookie",
      `${COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`,
    );
  };

  app.register(
    async (admin) => {
      admin.addHook("onRequest", async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (request.routeOptions.config.open) return;
        if (!signedIn(request)) return reply.code(401).send({ error: "not signed in" });
      });

      admin.get("/session", { config: { open: true } }, async (request) => ({
        enabled,
        signedIn: enabled && signedIn(request),
      }));

      if (!enabled) return;
      if (password.length < 12) {
        app.log.warn("ADMIN_PASSWORD is short. The backoffice can delete every diagram; use a long one.");
      }

      admin.post("/login", { config: { open: true } }, async (request, reply) => {
        const now = Date.now();
        failures = failures.filter((time) => now - time < FAILURE_WINDOW_MS);
        if (failures.length >= MAX_FAILURES) {
          const wait = Math.ceil((failures[0] + FAILURE_WINDOW_MS - now) / 1000);
          return reply
            .code(429)
            .header("Retry-After", wait)
            .send({ error: "too many attempts", retryAfter: wait });
        }
        const given = typeof request.body?.password === "string" ? request.body.password : "";
        // Compare digests so the comparison takes the same time whatever was typed.
        if (!timingSafeEqual(digest(given), digest(password))) {
          failures.push(now);
          return reply.code(401).send({ error: "wrong password" });
        }
        const token = randomBytes(32).toString("hex");
        sessions.set(token, now + SESSION_MS);
        setCookie(request, reply, token, SESSION_MS / 1000);
        return { signedIn: true };
      });

      admin.post("/logout", { config: { open: true } }, async (request, reply) => {
        sessions.delete(cookieOf(request));
        setCookie(request, reply, "", 0);
        return { signedIn: false };
      });

      admin.get("/stats", async () => store.stats());

      admin.get("/diagrams", async (request) => {
        const result = store.listDiagrams(paging(request.query));
        const presence = live.presence();
        for (const diagram of result.diagrams) diagram.openNow = presence.get(diagram.id) ?? 0;
        return result;
      });

      admin.delete("/diagrams/:id", async (request, reply) => {
        const { id } = request.params;
        if (!UUID_RE.test(id)) return reply.code(400).send({ error: "invalid diagram id" });
        if (!store.deleteDiagram(id)) return reply.code(404).send({ error: "not found" });
        live.closeRoom(id);
        request.log.info({ diagram: id }, "diagram deleted from the backoffice");
        return reply.code(204).send();
      });

      admin.get("/users", async (request) => store.listUsers(paging(request.query)));

      admin.post("/remove-orphaned-images", async () => ({
        removed: store.removeOrphanedImages(),
      }));
    },
    { prefix: "/api/admin" },
  );
}
