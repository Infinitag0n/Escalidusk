import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { openStore } from "./store.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "data");
const DIST_DIR = fileURLToPath(new URL("../dist", import.meta.url));

const MAX_SCENE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

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
const app = Fastify({ logger: true, bodyLimit: MAX_SCENE_BYTES });

// Image uploads arrive as raw bytes.
app.addContentTypeParser(
  /^image\//,
  { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES },
  (_request, body, done) => done(null, body),
);

function diagramJson(row) {
  // `scene` is already JSON; splice it in rather than parsing and re-encoding.
  return `{"id":"${row.id}","version":${row.version},"updatedAt":${row.updatedAt},"scene":${row.scene}}`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/diagrams/:id", async (request, reply) => {
  const { id } = request.params;
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: "invalid diagram id" });

  const row = store.getDiagram(id);
  if (!row) return reply.code(404).send({ error: "not found" });
  return reply.type("application/json; charset=utf-8").send(diagramJson(row));
});

app.put("/api/diagrams/:id", async (request, reply) => {
  const { id } = request.params;
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: "invalid diagram id" });

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

  const sceneJson = JSON.stringify({ elements: body.elements, appState: body.appState ?? {} });
  const result = store.saveDiagram(id, body.baseVersion, sceneJson);
  if (result.ok) return { version: result.version, updatedAt: result.updatedAt };

  // Someone else saved first (or the diagram is gone). Hand back what is stored
  // so the client can merge and retry.
  const current = result.current ? diagramJson(result.current) : "null";
  return reply
    .code(409)
    .type("application/json; charset=utf-8")
    .send(`{"error":"conflict","current":${current}}`);
});

app.get("/api/diagrams/:id/files/:fileId", async (request, reply) => {
  const { id, fileId } = request.params;
  if (!UUID_RE.test(id) || !FILE_ID_RE.test(fileId)) {
    return reply.code(400).send({ error: "invalid id" });
  }

  const file = store.getFile(id, fileId);
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
    return reply.sendFile("index.html");
  });
} else {
  app.log.warn(`No frontend build at ${DIST_DIR}; serving the API only.`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await app.close();
    store.close();
    process.exit(0);
  });
}

await app.listen({ port: PORT, host: HOST });
