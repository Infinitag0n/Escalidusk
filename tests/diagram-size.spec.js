import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { drawRectangle, expectStatus, expectStoredCount, newId, rectangle } from "./helpers.js";

const MB = 1024 * 1024;

/** A save request whose body is about `bytes` long. */
const body = (baseVersion, bytes) =>
  JSON.stringify({ baseVersion, elements: [], appState: { name: "A diagram", filler: "x".repeat(bytes) } });

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
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: mkdtempSync(path.join(tmpdir(), "escalidusk-size-")),
      ...env,
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const url = `http://127.0.0.1:${port}`;
  return { url, exited, stop: () => child.kill() };
}

const ready = (server) =>
  expect
    .poll(() => fetch(`${server.url}/api/health`).then((r) => r.ok, () => false), { timeout: 15_000 })
    .toBe(true);

test("a diagram may be 4 MB unless set otherwise, and a larger one is refused whole", async ({ request }) => {
  const id = newId();
  const save = (baseVersion, bytes) =>
    request.put(`/api/diagrams/${id}`, {
      headers: { "Content-Type": "application/json" },
      data: body(baseVersion, bytes),
    });
  expect((await save(0, 3.9 * MB)).status()).toBe(200);
  const refused = await save(1, 4.1 * MB);
  expect(refused.status()).toBe(413);
  // What was stored is untouched, and can still be saved over.
  expect((await (await request.get(`/api/diagrams/${id}`)).json()).version).toBe(1);
  expect((await save(1, 1000)).status()).toBe(200);

  // Images have their own, larger limit: they are not part of a diagram's size.
  const image = await request.put(`/api/diagrams/${id}/files/large-image`, {
    headers: { "Content-Type": "image/png" },
    data: Buffer.alloc(6 * MB, 1),
  });
  expect(image.status()).toBe(204);
});

test.describe("with MAX_DIAGRAM_SIZE set", () => {
  let server;
  test.beforeAll(async () => {
    server = await startServer({ MAX_DIAGRAM_SIZE: "200KB" });
    await ready(server);
  });
  test.afterAll(() => server?.stop());

  test("the limit is the one that was set", async () => {
    const id = randomUUID();
    const save = (baseVersion, bytes) =>
      fetch(`${server.url}/api/diagrams/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: body(baseVersion, bytes),
      });
    expect((await save(0, 150 * 1024)).status).toBe(200);
    expect((await save(1, 250 * 1024)).status).toBe(413);
  });

  test("the editor says the diagram is too large, keeps it, and saves again once it is smaller", async ({
    browser,
  }) => {
    const page = await browser.newPage();
    await page.goto(`${server.url}/new`);
    await page.waitForSelector(".excalidraw canvas");
    const id = new URL(page.url()).pathname.slice(1);
    await drawRectangle(page, 300, 250);
    await expectStatus(page, "saved");
    const stored = async () => (await (await fetch(`${server.url}/api/diagrams/${id}`)).json()).scene.elements;
    expect(await stored()).toHaveLength(1);

    // Paste in far more than fits: several hundred shapes at once.
    const many = Array.from({ length: 600 }, (_, index) =>
      rectangle({ id: `bulk-${index}`, x: 600 + (index % 30) * 30, y: 100 + Math.floor(index / 30) * 30, width: 20, height: 20 }),
    );
    await page.evaluate(async (elements) => {
      const data = JSON.stringify({ type: "excalidraw/clipboard", elements, files: {} });
      const transfer = new DataTransfer();
      transfer.setData("text/plain", data);
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, many);
    await expectStatus(page, "toolarge");
    const status = page.locator(".save-status");
    await expect(status).toContainText("Too large");
    await expect(status).toHaveAttribute("title", /too large to save/);
    await expect(status).toHaveCSS("background-color", "rgb(201, 42, 42)");
    // Nothing of it reached the server; the drawing is still on the page.
    expect(await stored()).toHaveLength(1);

    // Taking it back out (it is still selected after pasting) lets saving resume.
    await page.keyboard.press("Delete");
    await expectStatus(page, "saved");
    await page.close();
  });
});

test("a mistyped diagram size stops the server from starting", async () => {
  const server = await startServer({ MAX_DIAGRAM_SIZE: "4 megs" });
  expect(await server.exited).toBe(1);
});

test("the default leaves ordinary large diagrams alone", async ({ request }) => {
  // Two thousand shapes: far more than most diagrams, and well within the limit.
  const id = newId();
  const elements = Array.from({ length: 2000 }, (_, index) => rectangle({ id: `shape-${index}` }));
  const response = await request.put(`/api/diagrams/${id}`, { data: { baseVersion: 0, elements, appState: {} } });
  expect(response.status()).toBe(200);
  expect(JSON.stringify(elements).length).toBeLessThan(2 * MB);
  await expectStoredCount(request, id, 2000);
});
