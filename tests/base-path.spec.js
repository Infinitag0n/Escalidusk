import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { UUID_RE, drawRectangle, expectStatus, rectangle } from "./helpers.js";

// The app served under /draw, as behind a proxy that forwards only that path.
// It needs its own build (the prefix is baked into the pages) and its own server.

const BASE = "/draw";
const PASSWORD = "base-path-admin-password";

test.describe.configure({ mode: "serial" });

let server;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const dist = mkdtempSync(path.join(tmpdir(), "escalidusk-dist-"));
  const build = spawnSync(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"],
    { env: { ...process.env, BASE_PATH: BASE }, encoding: "utf8" },
  );
  expect(build.status, build.stderr).toBe(0);

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
      DATA_DIR: mkdtempSync(path.join(tmpdir(), "escalidusk-base-")),
      DIST_DIR: dist,
      BASE_PATH: BASE,
      ADMIN_PASSWORD: PASSWORD,
    },
    stdio: "ignore",
  });
  const origin = `http://127.0.0.1:${port}`;
  await expect
    .poll(() => fetch(`${origin}${BASE}/api/health`).then((r) => r.ok, () => false), { timeout: 15_000 })
    .toBe(true);
  server = { origin, url: `${origin}${BASE}`, stop: () => child.kill() };
});

test.afterAll(() => server?.stop());

test("the editor works under the path, and asks for nothing outside it", async ({ browser }) => {
  const page = await browser.newPage();
  const outside = [];
  const sockets = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === server.origin && !url.pathname.startsWith(`${BASE}/`)) outside.push(url.pathname);
  });
  page.on("websocket", (socket) => sockets.push(new URL(socket.url()).pathname));

  await page.goto(`${server.url}/new`);
  await page.waitForSelector(".excalidraw canvas");
  const { pathname } = new URL(page.url());
  expect(pathname.startsWith(`${BASE}/`)).toBe(true);
  const id = pathname.slice(BASE.length + 1);
  expect(id).toMatch(UUID_RE);

  await drawRectangle(page, 500, 400);
  await expectStatus(page, "saved");
  const saved = await (await fetch(`${server.url}/api/diagrams/${id}`)).json();
  expect(saved.scene.elements).toHaveLength(1);

  // Text pulls in a font, which must come from under the path too.
  await page.locator('[data-testid="toolbar-text"]').click({ force: true });
  await page.mouse.click(300, 300);
  await page.keyboard.type("hello");
  await page.keyboard.press("Escape");

  await expect.poll(() => sockets).toEqual([`${BASE}/api/diagrams/${id}/live`]);
  expect(outside).toEqual([]);
  await page.close();
});

test("links to other diagrams and the backoffice point under the path", async ({ browser }) => {
  const id = crypto.randomUUID();
  const save = await fetch(`${server.url}/api/diagrams/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseVersion: 0, elements: [rectangle()], appState: { name: "Under a path" } }),
  });
  const { viewId } = await save.json();

  const page = await browser.newPage();
  await page.goto(`${server.url}/admin`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  const name = page.getByRole("link", { name: "Under a path" });
  await expect(name).toHaveAttribute("href", `${BASE}/${id}`);
  await expect(page.getByRole("row").filter({ has: name }).getByRole("link", { name: "View" }))
    .toHaveAttribute("href", `${BASE}/${viewId}`);

  // The session cookie is scoped to the backoffice API under the path.
  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === "escalidusk_admin")?.path).toBe(`${BASE}/api/admin`);
  await page.close();
});

test("a proxy may also strip the path before forwarding", async () => {
  expect((await fetch(`${server.origin}/api/health`)).ok).toBe(true);
  const page = await fetch(`${server.origin}/`);
  expect(await page.text()).toContain(`${BASE}/assets/`);
  // Only a whole path segment counts as the prefix: this is not the API (but
  // falls through to the page, like any unknown address).
  const lookalike = await fetch(`${server.origin}/drawing/api/health`);
  expect(lookalike.headers.get("content-type")).toContain("text/html");
});
