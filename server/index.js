import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { LogController } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { createAddressHasher } from "./address.js";
import { registerAdmin } from "./admin.js";
import { bannerText, withBanner } from "./banner.js";
import { normaliseBasePath, withoutBasePath } from "./basePath.js";
import { createHealth } from "./health.js";
import { sceneWithoutEditLinks } from "./links.js";
import { DIAGRAM_DELETED, createLiveRooms } from "./live.js";
import { parseSize } from "./quota.js";
import { isStorageFull, openStore } from "./store.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "data");
const DIST_DIR = path.resolve(process.env.DIST_DIR ?? fileURLToPath(new URL("../dist", import.meta.url)));
// Serve the app under a path such as /draw instead of at the root. The
// frontend must be built with the same value (see vite.config.js).
const BASE_PATH = normaliseBasePath(process.env.BASE_PATH);
// Set when a reverse proxy sits in front, so the client's address is taken
// from the X-Forwarded-For header instead of being the proxy's own.
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
// How long to remember which (hashed) addresses a user was seen from.
const ADDRESS_RETENTION_DAYS = Number(process.env.ADDRESS_RETENTION_DAYS ?? 90);
const DAY_MS = 24 * 60 * 60 * 1000;
// A thin notice across the top of every page, such as "Experimental build".
const BANNER = bannerText(process.env.BANNER);
// Log every request, for tracking something down. Off by default: on a
// server left running it is nearly all of the log, and it fills the disk.
const LOG_REQUESTS = process.env.LOG_REQUESTS === "true";
// The backoffice at /admin exists only when this is set.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// How large one diagram may be, unless MAX_DIAGRAM_SIZE says otherwise.
// Images are stored apart and do not count; 4 MB is some 7,000 shapes. The
// server holds a diagram in memory several times over while saving it, so
// this is also what keeps one save from using up a small machine's memory.
const DEFAULT_DIAGRAM_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

// Feedback is a few paragraphs at most.
const MAX_FEEDBACK_CHARS = 4000;

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

// How large the database may grow, such as 5GB. Unset for no limit.
let MAX_DATABASE_SIZE;
let MAX_SCENE_BYTES;
try {
  MAX_DATABASE_SIZE = parseSize(process.env.MAX_DATABASE_SIZE);
  MAX_SCENE_BYTES =
    parseSize(process.env.MAX_DIAGRAM_SIZE, {
      name: "MAX_DIAGRAM_SIZE",
      smallest: 100 * 1024,
      smallestText: "100KB",
    }) ?? DEFAULT_DIAGRAM_BYTES;
} catch (error) {
  // A limit that was meant but mistyped must not quietly become "no limit".
  console.error(error.message);
  process.exit(1);
}

// A live message carries changed shapes, never more than a whole diagram.
const MAX_LIVE_MESSAGE_BYTES = Math.min(MAX_SCENE_BYTES, 8 * 1024 * 1024);

const store = openStore(DATA_DIR, { maxBytes: MAX_DATABASE_SIZE });
// Set once the server (and with it the log) exists.
let reportError = (error) => console.error(error);
const live = createLiveRooms({ onError: (error, what) => reportError(error, what) });
const health = createHealth({ connections: live.connections, messages: live.messages });
const hashAddress = createAddressHasher(process.env.ADDRESS_SECRET || store.addressSecret());

store.pruneAddresses(ADDRESS_RETENTION_DAYS);
// On a timer nothing catches an error, and an uncaught one stops the server.
setInterval(() => {
  try {
    store.pruneAddresses(ADDRESS_RETENTION_DAYS);
  } catch (error) {
    reportError(error, "forgetting old addresses");
  }
}, DAY_MS).unref();

const app = Fastify({
  bodyLimit: MAX_SCENE_BYTES,
  trustProxy: TRUST_PROXY,
  // Routes below are written as if the app were at the root.
  rewriteUrl: (request) => withoutBasePath(request.url, BASE_PATH),
  // Starting, warnings and failures are logged either way.
  logController: new LogController({ disableRequestLogging: !LOG_REQUESTS }),
  logger: {
    serializers: {
      // Addresses are only ever kept hashed, so keep them out of the log too.
      // The query string is dropped as a precaution against ids ending up there.
      req: (request) => ({ method: request.method, url: request.url.split("?")[0] }),
    },
  },
});
reportError = (error, what) => app.log.error({ err: error }, `Failed while ${what}`);
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
  // Nor the editing ids of diagrams this one links to.
  const scene = readOnly ? sceneWithoutEditLinks(row.scene) : row.scene;
  // `scene` is already JSON; splice it in rather than parsing and re-encoding.
  return `{${ids},"version":${row.version},"updatedAt":${row.updatedAt},"scene":${scene}}`;
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
const STORAGE_FULL = { error: "storage full" };

/**
 * Runs a note-taking write (who was seen, who opened what). On a database
 * that has reached its size limit these fail; that must not stop the request
 * or the connection they belong to, which may well be only reading.
 */
function noting(write, otherwise) {
  try {
    return write();
  } catch (error) {
    if (!isStorageFull(error)) throw error;
    return otherwise;
  }
}

// A write that the database had no room for: say so, rather than "server error".
app.setErrorHandler((error, request, reply) => {
  if (isStorageFull(error)) {
    request.log.warn("the database has reached MAX_DATABASE_SIZE; a write was refused");
    return reply.code(507).send(STORAGE_FULL);
  }
  return reply.send(error);
});

app.addHook("onResponse", async (request, reply) => {
  if (reply.statusCode >= 500 && reply.statusCode !== 507) health.recordServerError();
  if (request.method === "PUT" && request.routeOptions.url === "/api/diagrams/:id") {
    health.recordSave(reply.elapsedTime);
  }
});

app.get("/api/health", async () => ({ ok: true }));

registerAdmin(app, { store, live, health, password: ADMIN_PASSWORD, basePath: BASE_PATH });

// Only the words are kept (and the time): not who sent them, nor from where.
// Feedback is taken whether or not there is a backoffice to read it in: it
// waits in the database until ADMIN_PASSWORD is set.
app.post("/api/feedback", async (request, reply) => {
  const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
  if (!message || message.length > MAX_FEEDBACK_CHARS) {
    return reply
      .code(400)
      .send({ error: `expected { message: 1 to ${MAX_FEEDBACK_CHARS} characters }` });
  }
  store.addFeedback(message);
  return reply.code(204).send();
});

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
  // Nearly full: what room is left is for diagrams that already exist.
  if (body.baseVersion === 0 && store.storage().nearlyFull) {
    return reply.code(507).send(STORAGE_FULL);
  }

  const sceneJson = JSON.stringify({ elements: body.elements, appState: body.appState ?? {} });
  const userId = userIdOf(request);
  if (userId) noting(() => store.seeUser({ id: userId, addressHash: hashAddress(request.ip) }));
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

// Names of several diagrams at once, for the labels of links between
// diagrams. Whoever holds an id could open that diagram anyway.
app.post("/api/diagrams/summaries", async (request, reply) => {
  const ids = request.body?.ids;
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every((id) => UUID_RE.test(id))) {
    return reply.code(400).send({ error: "expected { ids: [up to 200 diagram ids] }" });
  }
  const summaries = {};
  for (const id of ids) {
    const name = store.diagramName(id);
    summaries[id] = name !== undefined ? { name } : store.isDeleted(id) ? { deleted: true } : null;
  }
  return summaries;
});

// Live collaboration: a WebSocket per person per open diagram. Opening it
// with a read-only id joins the same room as the editors, but listen-only.
app.get("/api/diagrams/:id/live", { websocket: true }, (socket, request) => {
  const { id } = request.params;
  if (!UUID_RE.test(id)) {
    socket.close(1008, "invalid diagram id");
    return;
  }
  let found;
  try {
    if (store.isDeleted(id)) {
      socket.close(DIAGRAM_DELETED, "diagram deleted");
      return;
    }
    found = store.findDiagram(id);
  } catch (error) {
    // This runs after the request proper, where nothing else would catch it.
    reportError(error, "opening a live connection");
    socket.close(1011, "server error");
    return;
  }
  // An unknown id is a diagram that has not been saved yet; its room is the id itself.
  const addressHash = hashAddress(request.ip);
  live.join(found?.row.id ?? id, socket, {
    readOnly: found?.readOnly ?? false,
    // Someone who cannot be noted down still gets an id for the others to know them by.
    identify: ({ user, name }) =>
      noting(() => store.seeUser({ id: user, name, addressHash }), { publicId: randomUUID() }).publicId,
    // Visits are recorded for saved diagrams only; a new one has nothing to visit yet.
    joined: found
      ? (user) => noting(() => store.recordVisit(found.row.id, user, !found.readOnly))
      : undefined,
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
  // Nearly full: no new images. One that is already stored is not new.
  if (store.storage().nearlyFull && !store.getFile(id, fileId)) {
    return reply.code(507).send(STORAGE_FULL);
  }

  store.putFile(id, fileId, mimeType, request.body);
  return reply.code(204).send();
});

// In production the built frontend is served from here too. Every non-API
// path falls back to index.html so /<diagram-uuid> loads the app.
if (existsSync(DIST_DIR)) {
  warnIfBuiltForAnotherBasePath();
  // The two app pages are served from memory, with the banner (if any) in them.
  const pages = Object.fromEntries(
    ["index.html", "admin.html"].map((name) => [
      name,
      withBanner(readFileSync(path.join(DIST_DIR, name), "utf8"), BANNER),
    ]),
  );
  await app.register(fastifyStatic, {
    root: DIST_DIR,
    // Never the page files themselves, nor folders ("/" above all): those
    // fall through to the handler below, which serves `pages`.
    index: false,
    allowedPath: (pathName) => !pathName.endsWith("/") && !Object.hasOwn(pages, pathName.slice(1)),
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
    // Without a password there is no backoffice: /admin is an address like any other.
    const admin = ADMIN_PASSWORD && /^\/admin(\.html)?\/?(\?|$)/.test(request.url);
    const page = admin ? "admin.html" : "index.html";
    return reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-cache")
      .send(pages[page]);
  });
} else {
  app.log.warn(`No frontend build at ${DIST_DIR}; serving the API only.`);
}

/**
 * A build made for another BASE_PATH loads a blank page: its scripts are
 * looked for in the wrong place. Say so, rather than leave that to be found.
 */
function warnIfBuiltForAnotherBasePath() {
  const html = readFileSync(path.join(DIST_DIR, "index.html"), "utf8");
  const assets = html.match(/\ssrc="([^"]*)\/assets\//)?.[1];
  if (assets !== undefined && assets !== BASE_PATH) {
    app.log.warn(
      `The frontend in ${DIST_DIR} was built for BASE_PATH="${assets}", but the server has ` +
        `BASE_PATH="${BASE_PATH}". Rebuild with the same BASE_PATH, or pages will be blank.`,
    );
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    live.close();
    health.close();
    await app.close();
    store.close();
    process.exit(0);
  });
}

await app.listen({ port: PORT, host: HOST });
