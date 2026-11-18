import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { drawRectangle, expectStatus } from "./helpers.js";

// BANNER puts a thin notice across the top of every page. It needs a server
// of its own, started with it set.

const BANNER = 'Experimental build 2026-11-18 <b>"not bold"</b> & more';
const PASSWORD = "banner-admin-password";

test.describe.configure({ mode: "serial" });

let server;

test.beforeAll(async () => {
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
      DATA_DIR: mkdtempSync(path.join(tmpdir(), "escalidusk-banner-")),
      BANNER: `  ${BANNER}\n`,
      ADMIN_PASSWORD: PASSWORD,
    },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  await expect
    .poll(() => fetch(`${url}/api/health`).then((r) => r.ok, () => false), { timeout: 15_000 })
    .toBe(true);
  server = { url, stop: () => child.kill() };
});

test.afterAll(() => server?.stop());

const banner = (page) => page.getByRole("note");

/** Draws a rectangle and returns where it landed on the canvas, in scene coordinates. */
async function drawnAt(page, origin) {
  await page.goto(`${origin}/new`);
  await page.waitForSelector(".excalidraw canvas");
  const id = new URL(page.url()).pathname.slice(1);
  await drawRectangle(page, 400, 300);
  await expectStatus(page, "saved");
  const stored = await (await fetch(`${origin}/api/diagrams/${id}`)).json();
  const [element] = stored.scene.elements;
  return { id, x: element.x, y: element.y };
}

test("the banner sits above the editor, which fills the rest and draws where the mouse is", async ({
  browser,
  baseURL,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const plain = await drawnAt(page, baseURL);
  await expect(banner(page)).toHaveCount(0);

  const { id, ...withBanner } = await drawnAt(page, server.url);
  // Shown as the text it is: whitespace tidied, markup left as text.
  await expect(banner(page)).toHaveText(BANNER);
  await expect(banner(page)).toHaveAttribute("title", BANNER);

  const bar = await banner(page).boundingBox();
  const editor = await page.locator(".excalidraw").boundingBox();
  expect(bar.y).toBe(0);
  expect(bar.height).toBeGreaterThan(16);
  expect(bar.height).toBeLessThan(32);
  expect(editor.y).toBeCloseTo(bar.height, 0);
  expect(editor.y + editor.height).toBeCloseTo(800, 0);
  // The editor knows it moved down: the same mouse movement lands that much higher on the canvas.
  expect(withBanner.x).toBeCloseTo(plain.x, 0);
  expect(withBanner.y).toBeCloseTo(plain.y - bar.height, 0);
  // Nothing scrolls.
  expect(await page.evaluate(() => document.scrollingElement.scrollHeight)).toBe(800);

  // The read-only page and the home page have it too.
  const { viewId } = await (await fetch(`${server.url}/api/diagrams/${id}`)).json();
  await page.goto(`${server.url}/${viewId}`);
  await page.waitForSelector(".excalidraw canvas");
  await expect(banner(page)).toHaveText(BANNER);
  await page.goto(`${server.url}/`);
  await expect(page.getByRole("heading", { name: "Escalidusk" })).toBeVisible();
  await expect(banner(page)).toHaveText(BANNER);
  await page.close();
});

test("the backoffice has the banner too", async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(`${server.url}/admin`);
  await expect(banner(page)).toHaveText(BANNER);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Escalidusk backoffice" })).toBeVisible();
  await expect(banner(page)).toHaveText(BANNER);
  await page.close();
});

test("a long banner is cut short on a narrow screen, never wrapped", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 360, height: 700 } });
  await page.goto(`${server.url}/new`);
  await page.waitForSelector(".excalidraw canvas");
  const bar = await banner(page).boundingBox();
  expect(bar.height).toBeLessThan(32);
  expect(await banner(page).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.close();
});

test("the page files themselves are not served without it", async () => {
  for (const address of ["/", "/index.html", "/admin", "/admin.html", "/assets/"]) {
    const response = await fetch(`${server.url}${address}`);
    expect(response.status, address).toBe(200);
    expect(await response.text(), address).toContain('class="app-banner"');
  }
});
