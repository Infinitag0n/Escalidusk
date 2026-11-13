import { expect, test } from "@playwright/test";
import {
  UUID_RE,
  drawRectangle,
  dropImage,
  expectStatus,
  expectStoredCount,
  liveElements,
  openDiagram,
  refocus,
  stored,
} from "./helpers.js";

test("opening / starts a new diagram at a fresh UUID, stored only once edited", async ({
  page,
  request,
}) => {
  const id = await openDiagram(page);
  expect(id).toMatch(UUID_RE);
  expect(await stored(request, id)).toBeNull();

  await drawRectangle(page, 300, 250);
  await expectStoredCount(request, id, 1);
  await expectStatus(page, "saved");
});

test("a path that is not a diagram link shows a notice", async ({ page }) => {
  await page.goto("/not-a-diagram");
  await expect(page.getByText("No diagram here")).toBeVisible();
});

test("a reload shows the saved diagram and does not save again", async ({ page, request }) => {
  const id = await openDiagram(page);
  await drawRectangle(page, 300, 250);
  await expectStoredCount(request, id, 1);
  await expectStatus(page, "saved");
  const { version } = await stored(request, id);

  await page.reload();
  await page.waitForSelector(".excalidraw canvas");
  await page.waitForTimeout(2500); // longer than the autosave delay
  expect((await stored(request, id)).version).toBe(version);
});

test("images are stored separately from the scene", async ({ page, request }) => {
  const id = await openDiagram(page);
  await dropImage(page, 650, 300);
  await expectStoredCount(request, id, 1);

  const diagram = await stored(request, id);
  const [image] = liveElements(diagram);
  expect(image.type).toBe("image");
  expect(JSON.stringify(diagram)).not.toContain("data:image");

  const file = await request.get(`/api/diagrams/${id}/files/${image.fileId}`);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toBe("image/png");
});

test("deleted elements are kept as markers", async ({ page, request }) => {
  const id = await openDiagram(page);
  await drawRectangle(page, 300, 250);
  await expectStoredCount(request, id, 1);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await expectStoredCount(request, id, 0);
  expect((await stored(request, id)).scene.elements).toHaveLength(1);
});

test("two tabs on one diagram merge instead of overwriting each other", async ({
  context,
  page,
  request,
}) => {
  const id = await openDiagram(page);
  await drawRectangle(page, 300, 250);
  await expectStoredCount(request, id, 1);

  const second = await context.newPage();
  await openDiagram(second, id);

  // The first tab saves, which leaves the second tab out of date.
  await drawRectangle(page, 300, 450);
  await expectStoredCount(request, id, 2);

  // The second tab's save is refused, merged with the stored copy, and retried.
  await drawRectangle(second, 800, 500);
  await expectStoredCount(request, id, 3);

  // The first tab picks up the second tab's rectangle on focus, without saving again...
  await expectStatus(second, "saved");
  const { version } = await stored(request, id);
  await refocus(page);
  await page.waitForTimeout(2500);
  expect((await stored(request, id)).version).toBe(version);

  // ...so its next edit keeps everything.
  await drawRectangle(page, 800, 150);
  await expectStoredCount(request, id, 4);
});

test("fonts come from this server and nothing is fetched from other hosts", async ({
  page,
  baseURL,
}) => {
  const fontRequests = [];
  const otherHosts = new Set();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.protocol.startsWith("http")) return;
    if (url.origin !== baseURL) otherHosts.add(url.origin);
    if (url.pathname.startsWith("/fonts/")) fontRequests.push(url.pathname);
  });

  await openDiagram(page);
  await page.locator('[data-testid="toolbar-text"]').click({ force: true });
  await page.mouse.click(500, 500);
  await page.keyboard.type("hello");
  await page.keyboard.press("Escape");

  await expect.poll(() => fontRequests.length).toBeGreaterThan(0);
  expect([...otherHosts]).toEqual([]);
});
