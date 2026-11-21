import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { parseSize } from "../server/quota.js";
import { isStorageFull, openStore } from "../server/store.js";
import { connectLive, drawRectangle, expectStatus } from "./helpers.js";

const PASSWORD = "quota-admin-password";
const MB = 1024 * 1024;
const tempDir = (name) => mkdtempSync(path.join(tmpdir(), `escalidusk-${name}-`));
const scene = (bytes) => JSON.stringify({ elements: [], appState: { name: "x".repeat(bytes) } });

/** Starts a separate server with its own database and the given environment. */
async function startServer(env) {
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: tempDir("quota-server"), ...env },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const url = `http://127.0.0.1:${port}`;
  return { url, child, exited, stop: () => child.kill() };
}

const ready = (server) =>
  expect
    .poll(() => fetch(`${server.url}/api/health`).then((r) => r.ok, () => false), { timeout: 15_000 })
    .toBe(true);

test("sizes are read as written in .env", () => {
  expect(parseSize("")).toBeNull();
  expect(parseSize(undefined)).toBeNull();
  expect(parseSize("5GB")).toBe(5 * 1024 ** 3);
  expect(parseSize(" 500 mb ")).toBe(500 * MB);
  expect(parseSize("1.5g")).toBe(1.5 * 1024 ** 3);
  expect(parseSize("2097152")).toBe(2 * MB);
  for (const wrong of ["lots", "5 gigabytes", "-1GB", "GB", "100KB", "0"]) {
    expect(() => parseSize(wrong), wrong).toThrow(/MAX_DATABASE_SIZE/);
  }
  // Another setting, with its own name and its own least.
  const diagram = { name: "MAX_DIAGRAM_SIZE", smallest: 100 * 1024, smallestText: "100KB" };
  expect(parseSize("500KB", diagram)).toBe(500 * 1024);
  expect(parseSize("", diagram)).toBeNull();
  expect(() => parseSize("50KB", diagram)).toThrow('MAX_DIAGRAM_SIZE: "50KB" is too small. The least that works is 100KB.');
  expect(() => parseSize("big", diagram)).toThrow(/^MAX_DIAGRAM_SIZE: "big" is not a size/);
});

test.describe("a database with a size limit", () => {
  test("refuses what would take it past the limit, changes nothing, and stays whole", () => {
    const dataDir = tempDir("quota");
    const store = openStore(dataDir, { maxBytes: 3 * MB });
    const [kept, growing] = [randomUUID(), randomUUID()];
    expect(store.storage()).toMatchObject({ limit: 3 * MB, nearlyFull: false });

    store.saveDiagram(kept, 0, scene(1000));
    store.saveDiagram(growing, 0, scene(1000));
    let stored = 0;
    let refused;
    try {
      for (; stored < 100; stored++) store.putFile(growing, `image-${stored}`, "image/png", Buffer.alloc(200_000, 1));
    } catch (error) {
      refused = error;
    }
    expect(isStorageFull(refused)).toBe(true);
    expect(stored).toBeGreaterThan(10);
    expect(stored).toBeLessThan(16);
    const full = store.storage();
    expect(full.nearlyFull).toBe(true);
    expect(full.used).toBeLessThanOrEqual(3 * MB);
    // The image that did not fit left nothing behind.
    expect(store.getFile(growing, `image-${stored}`)).toBeUndefined();

    // A save that does not fit is refused whole: the stored version is untouched.
    let saveRefused;
    try {
      store.saveDiagram(kept, 1, scene(MB));
    } catch (error) {
      saveRefused = error;
    }
    expect(isStorageFull(saveRefused)).toBe(true);
    expect(store.findDiagram(kept).row).toMatchObject({ version: 1, scene: scene(1000) });

    // Reading and deleting still work, and deleting makes room that is used again.
    expect(store.getFile(growing, "image-0").data).toHaveLength(200_000);
    expect(store.deleteDiagram(growing)).toBe(true);
    expect(store.isDeleted(growing)).toBe(true);
    expect(store.storage().nearlyFull).toBe(false);
    expect(store.saveDiagram(kept, 1, scene(MB))).toMatchObject({ ok: true, version: 2 });
    store.close();

    const db = new DatabaseSync(path.join(dataDir, "escalidusk.db"));
    expect(db.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    db.close();
  });

  test("a limit below what is already stored leaves it readable and deletable, and stops it growing", () => {
    const dataDir = tempDir("quota-over");
    const id = randomUUID();
    let store = openStore(dataDir);
    store.saveDiagram(id, 0, scene(1000));
    for (let i = 0; i < 20; i++) store.putFile(id, `image-${i}`, "image/png", Buffer.alloc(200_000, 1));
    expect(store.storage()).toMatchObject({ limit: null, nearlyFull: false });
    store.close();

    store = openStore(dataDir, { maxBytes: MB });
    expect(store.storage().used).toBeGreaterThan(MB);
    expect(store.findDiagram(id).row.version).toBe(1);
    expect(() => store.putFile(id, "one-more", "image/png", Buffer.alloc(200_000, 1))).toThrow();
    expect(store.deleteDiagram(id)).toBe(true);
    expect(store.storage().used).toBeLessThan(MB);
    store.close();
  });
});

test("a mistyped limit stops the server from starting, rather than meaning no limit", async () => {
  const server = await startServer({ MAX_DATABASE_SIZE: "5 gigs" });
  expect(await server.exited).toBe(1);
});

test.describe("a server that is nearly full", () => {
  let server;
  let diagram; // made while there was room
  const api = (route, init) => fetch(`${server.url}${route}`, init);
  const save = (id, baseVersion, name = "A diagram") =>
    api(`/api/diagrams/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseVersion, elements: [], appState: { name } }),
    });
  const upload = (id, fileId, bytes) =>
    api(`/api/diagrams/${id}/files/${fileId}`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: Buffer.alloc(bytes, 1),
    });
  const admin = async (route) => {
    const login = await api("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    return (await api(`/api/admin${route}`, { headers: { cookie } })).json();
  };

  test.beforeAll(async () => {
    server = await startServer({ MAX_DATABASE_SIZE: "3MB", ADMIN_PASSWORD: PASSWORD });
    await ready(server);
    diagram = randomUUID();
    expect((await save(diagram, 0)).status).toBe(200);
    // Fill it to a little over nine tenths.
    for (let i = 0; i < 14; i++) expect((await upload(diagram, `image-${i}`, 200_000)).status, `image ${i}`).toBe(204);
  });
  test.afterAll(() => server?.stop());

  test("turns away new diagrams and new images, and still saves the diagrams it has", async () => {
    const stats = await admin("/stats");
    expect(stats.storage).toMatchObject({ limit: 3 * MB, nearlyFull: true });
    expect(stats.storage.used).toBeGreaterThanOrEqual(2.7 * MB);

    const refused = await save(randomUUID(), 0);
    expect(refused.status).toBe(507);
    expect(await refused.json()).toEqual({ error: "storage full" });
    expect((await upload(diagram, "one-more", 1000)).status).toBe(507);
    // An image that is already there is not a new one.
    expect((await upload(diagram, "image-0", 200_000)).status).toBe(204);

    expect((await save(diagram, 1, "Renamed")).status).toBe(200);
    expect((await (await api(`/api/diagrams/${diagram}`)).json()).scene.appState.name).toBe("Renamed");
    // Small things still fit.
    const feedback = await api("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Still room for words" }),
    });
    expect(feedback.status).toBe(204);
  });

  test("the editor says the storage is full, and keeps what was drawn", async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.url}/new`);
    await page.waitForSelector(".excalidraw canvas");
    await drawRectangle(page, 300, 250);
    await expectStatus(page, "full");
    const status = page.locator(".save-status");
    await expect(status).toContainText("Storage full");
    await expect(status).toHaveAttribute("title", /out of space/);
    await expect(status).toHaveCSS("background-color", "rgb(201, 42, 42)");
    await page.close();
  });

  test("people can still open diagrams and work together on them", async () => {
    // Someone new, who cannot be noted down once it is completely full, still gets in.
    const live = await connectLive(server.url, diagram, { name: "Newcomer" });
    expect(live.welcome.user).toMatch(/^[0-9a-f-]{36}$/);
    live.socket.close();
  });

  test("the backoffice shows how full it is, and warns", async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.url}/admin`);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(/^2\.\d MB of 3\.0 MB \(9\d%\)/)).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Database size used" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Nearly full. New diagrams and images are turned away");
    await page.close();
  });
});

test("a server that is completely full refuses saves cleanly and keeps serving", async () => {
  const server = await startServer({ MAX_DATABASE_SIZE: "1MB", ADMIN_PASSWORD: PASSWORD });
  try {
    await ready(server);
    const id = randomUUID();
    const save = (baseVersion, bytes) =>
      fetch(`${server.url}/api/diagrams/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-User-Id": randomUUID() },
        body: JSON.stringify({ baseVersion, elements: [], appState: { name: "x".repeat(bytes) } }),
      });
    expect((await save(0, 1000)).status).toBe(200);
    // Far more than fits: refused as "storage full", not as a server error.
    const refused = await save(1, 2 * MB);
    expect(refused.status).toBe(507);
    expect(await refused.json()).toEqual({ error: "storage full" });

    const stored = await (await fetch(`${server.url}/api/diagrams/${id}`)).json();
    expect(stored.version).toBe(1);
    expect((await save(1, 2000)).status).toBe(200);
  } finally {
    server.stop();
  }
});
