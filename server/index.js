import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { createAddressHasher } from "./address.js";
import { registerAdmin } from "./admin.js";
import { DIAGRAM_DELETED, createLiveRooms } from "./live.js";
import { openStore } from "./store.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "data");
const DIST_DIR = fileURLToPath(new URL("../dist", import.meta.url));
// Set when a reverse proxy sits in front, so the client's address is taken
// from the X-Forwarded-For header instead of being the proxy's own.
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
// How long to remember which (hashed) addresses a user was seen from.
const ADDRESS_RETENTION_DAYS = Number(process.env.ADDRESS_RETENTION_DAYS ?? 90);
const DAY_MS = 24 * 60 * 60 * 1000;
// The backoffice at /admin exists only when this is set.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const MAX_SCENE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LIVE_MESSAGE_BYTES = 8 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/x-icon",
  "image/avif",
  "image/jfif",
]);

const store = openStore(DATA_DIR);
const live = createLiveRooms();
const hashAddress = createAddressHasher(process.env.ADDRESS_SECRET || store.addressSecret());

store.pruneAddresses(ADDRESS_RETENTION_DAYS);
setInterval(() => store.pruneAddresses(ADDRESS_RETENTION_DAYS), DAY_MS).unref();

const app = Fastify({
  bodyLimit: MAX_SCENE_BYTES,
  trustProxy: TRUST_PROXY,
  logger: {
    serializers: {
      // Addresses are only ever kept hashed, so keep them out of the log too.
      // The query string is dropped as a precaution against ids ending up there.
      req: (request) => ({ method: request.method, url: request.url.split("?")[0] }),
    },
  },
});
await app.register(fastifyWebsocket, { options: { maxPayload: MAX_LIVE_MESSAGE_BYTES } });

// Image uploads arrive as raw bytes.
app.addContentTypeParser(
  /^image\//,
  { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES },
  (_request, body, done) => done(null, body),
);

function diagramJson(row, readOnly) {
  // A read-only link must never reveal the id that allows editing.
  const ids = readOnly
    ? `"id":"${row.viewId}","readOnly":true`
    : `"id":"${row.id}","readOnly":false,"viewId":"${row.viewId}"`;
  // `scene` is already JSON; splice it in rather than parsing and re-encoding.
  return `{${ids},"version":${row.version},"updatedAt":${row.updatedAt},"scene":${row.scene}}`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The private user id a browser sent with a request, if it sent a valid one. */
function userIdOf(request) {
  const value = request.headers["x-user-id"];
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

const DELETED = { error: "deleted" };

app.get("/api/health", async () => ({ ok: true }));

registerAdmin(app, { store, live, password: ADMIN_PASSWORD });

app.get("/api/diagrams/:id", async (request, reply) => {
  const { id } = request.params;
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: "invalid diagram id" });

  const found = store.findDiagram(id);
  if (!found) {
    if (store.isDeleted(id)) return reply.code(410).send(DELETED);
    return reply.code(404).send({ error: "not found" });
  }
  return reply
    .type("application/json; charset=utf-8")
    .send(diagramJson(found.row, found.readOnly));
});

app.put("/api/diagrams/:id", async (request, reply) => {
  const { id } = request.params;
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: "invalid diagram id" });

  // Also stops anyone creating a diagram whose id would shadow a read-only link.
  if (store.isViewId(id)) return reply.code(403).send({ error: "this link is read-only" });
  // A deleted diagram stays deleted, even for someone who still has it open.
  if (store.isDeleted(id)) return reply.code(410).send(DELETED);

  const body = request.body;
  if (
    !isPlainObject(body) ||
    !Number.isInteger(body.baseVersion) ||
    body.baseVersion < 0 ||
    !Array.isArray(body.elements) ||
    (body.appState !== undefined && !isPlainObject(body.appState))
  ) {
    return reply.code(400).send({ error: "expected { baseVersion, elements, appState? }" });
  }
  const key = typeof body.key === "string" && body.key.length <= 512 ? body.key : null;

  const sceneJson = JSON.stringify({ elements: body.elements, appState: body.appState ?? {} });
  const userId = userIdOf(request);
  if (userId) store.seeUser({ id: userId, addressHash: hashAddress(request.ip) });
  const result = store.saveDiagram(id, body.baseVersion, sceneJson, userId);
  if (result.ok) {
    // Let everyone else who has this diagram open know it was saved.
    if (key) live.notifySaved(id, result.version, key, result.viewId);
    return { version: result.version, updatedAt: result.updatedAt, viewId: result.viewId };
  }

  // Someone else saved first (or the diagram is gone). Hand back what is stored
  // so the client can merge and retry.
  const current = result.current ? diagramJson(result.current, false) : "null";
  return reply
    .code(409)
    .type("application/json; charset=utf-8")
    .send(`{"error":"conflict","current":${current}}`);
});

// Live collaboration: a WebSocket per person per open diagram. Opening it
// with a read-only id joins the same room as the editors, but listen-only.
app.get("/api/diagrams/:id/live", { websocket: true }, (socket, request) => {
  const { id } = request.params;
  if (!UUID_RE.test(id)) {
    socket.close(1008, "invalid diagram id");
    return;
  }
  if (store.isDeleted(id)) {
    socket.close(DIAGRAM_DELETED, "diagram deleted");
    return;
  }
  const found = store.findDiagram(id);
  // An unknown id is a diagram that has not been saved yet; its room is the id itself.
  const addressHash = hashAddress(request.ip);
  live.join(found?.row.id ?? id, socket, {
    readOnly: found?.readOnly ?? false,
    identify: ({ user, name }) => store.seeUser({ id: user, name, addressHash }).publicId,
  });
});

app.get("/api/diagrams/:id/files/:fileId", async (request, reply) => {
  const { id, fileId } = request.params;
  if (!UUID_RE.test(id) || !FILE_ID_RE.test(fileId)) {
    return reply.code(400).send({ error: "invalid id" });
  }

  // Images are stored under the editing id; a read-only id maps onto it.
  // An unknown id is used as-is: images are uploaded before a diagram's first save.
  const file = store.getFile(store.findDiagram(id)?.row.id ?? id, fileId);
  if (!file) return reply.code(404).send({ error: "not found" });
  return reply
    .header("Content-Type", file.mimeType)
    .header("Cache-Control", "private, max-age=31536000, immutable")
    // Uploaded SVGs can carry scripts; never let one run as a page on this origin.
    .header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
    .header("X-Content-Type-Options", "nosniff")
    .send(Buffer.from(file.data));
});

app.put("/api/diagrams/:id/files/:fileId", async (request, reply) => {
  const { id, fileId } = request.params;
  if (!UUID_RE.test(id) || !FILE_ID_RE.test(fileId)) {
    return reply.code(400).send({ error: "invalid id" });
  }

  if (store.isViewId(id)) return reply.code(403).send({ error: "this link is read-only" });
  if (store.isDeleted(id)) return reply.code(410).send(DELETED);

  const mimeType = String(request.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!IMAGE_TYPES.has(mimeType)) {
    return reply.code(415).send({ error: "unsupported image type" });
  }
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    return reply.code(400).send({ error: "empty body" });
  }

  store.putFile(id, fileId, mimeType, request.body);
  return reply.code(204).send();
});

// In production the built frontend is served from here too. Every non-API
// path falls back to index.html so /<diagram-uuid> loads the app.
if (existsSync(DIST_DIR)) {
  await app.register(fastifyStatic, {
    root: DIST_DIR,
    setHeaders(reply, filePath) {
      // Vite fingerprints everything under assets/, so it can be cached forever.
      const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
      reply.header(
        "Cache-Control",
        immutable ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    const page = /^\/admin\/?(\?|$)/.test(request.url) ? "admin.html" : "index.html";
    return reply.sendFile(page);
  });
} else {
  app.log.warn(`No frontend build at ${DIST_DIR}; serving the API only.`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    live.close();
    await app.close();
    store.close();
    process.exit(0);
  });
}

await app.listen({ port: PORT, host: HOST });
