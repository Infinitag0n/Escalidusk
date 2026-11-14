import { expect, test } from "@playwright/test";
import {
  UUID_RE,
  drawRectangle,
  expectStoredCount,
  openDiagram,
  rectangle,
  seedDiagram,
  stored,
} from "./helpers.js";

const title = (page) => page.getByLabel("Diagram name");
const recent = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("escalidusk:recent") ?? "[]"));

/** Creates and names a diagram through the editor, so it lands in this browser's history. */
async function makeDiagram(page, request, name) {
  const id = await openDiagram(page);
  await title(page).fill(name);
  await title(page).press("Enter");
  await expect.poll(async () => (await stored(request, id))?.scene.appState.name).toBe(name);
  await expect.poll(async () => (await recent(page))[0]).toMatchObject({ id, name });
  return id;
}

test("a diagram joins the browser's history once it is saved, not before", async ({
  page,
  request,
}) => {
  const id = await openDiagram(page);
  await page.waitForTimeout(500);
  expect(await recent(page)).toEqual([]);

  await drawRectangle(page, 300, 250);
  await expectStoredCount(request, id, 1);
  const { viewId } = await stored(request, id);
  await expect
    .poll(() => recent(page))
    .toMatchObject([{ id, viewId, readOnly: false, name: "" }]);

  await title(page).fill("Roadmap");
  await expect.poll(async () => (await recent(page))[0].name).toBe("Roadmap");
});

test("the home page lists recent diagrams and starts new ones", async ({ page, request }) => {
  const first = await makeDiagram(page, request, "First diagram");
  const second = await makeDiagram(page, request, "Second diagram");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Escalidusk" })).toBeVisible();
  const items = page.locator(".diagram-list__item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Second diagram"); // most recent first
  await expect(items.nth(1)).toContainText("First diagram");

  await items.nth(1).click();
  await page.waitForURL(`**/${first}`);
  await expect(title(page)).toHaveValue("First diagram");

  await page.goto("/");
  await expect(page.locator(".diagram-list__item").nth(0)).toContainText("First diagram");
  await page.getByRole("link", { name: "New diagram" }).click();
  await page.waitForSelector(".excalidraw canvas");
  const fresh = new URL(page.url()).pathname.slice(1);
  expect(fresh).toMatch(UUID_RE);
  expect([first, second]).not.toContain(fresh);
});

test("removing a diagram from the list only forgets it here", async ({ page, request }) => {
  const id = await makeDiagram(page, request, "Keep me on the server");
  await page.goto("/");
  await page.getByRole("button", { name: "Remove Keep me on the server from this list" }).click();
  await expect(page.getByText("Nothing here any more")).toBeVisible();
  expect(await recent(page)).toEqual([]);
  expect(await stored(request, id)).not.toBeNull();
});

test("a diagram opened both ways is listed once, as the one that can be edited", async ({
  page,
  request,
}) => {
  const viewOnly = await seedDiagram(request, {
    elements: [rectangle()],
    appState: { name: "Only viewed" },
  });
  await openDiagram(page, viewOnly.viewId);
  await expect.poll(async () => (await recent(page))[0]).toMatchObject({ readOnly: true });

  const both = await seedDiagram(request, {
    elements: [rectangle()],
    appState: { name: "Viewed and edited" },
  });
  await openDiagram(page, both.viewId);
  await openDiagram(page, both.id);
  await expect.poll(async () => (await recent(page))[0]).toMatchObject({ id: both.id });

  await page.goto("/");
  const items = page.locator(".diagram-list li");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Viewed and edited");
  await expect(items.nth(0)).not.toContainText("Read-only");
  await expect(items.nth(1)).toContainText("Only viewed");
  await expect(items.nth(1)).toContainText("Read-only");
});

test("the menu opens other recent diagrams", async ({ page, request }) => {
  const first = await makeDiagram(page, request, "Menu target");
  await makeDiagram(page, request, "Where I am");

  await page.locator('[data-testid="main-menu-trigger"]').click();
  await page.getByRole("button", { name: "Open recent…" }).click();
  const dialog = page.getByRole("dialog", { name: "Open a recent diagram" });
  await expect(dialog.locator(".diagram-list__item")).toHaveCount(1); // not the current one
  await dialog.getByRole("button", { name: /Menu target/ }).click();
  await page.waitForURL(`**/${first}`);
  await expect(title(page)).toHaveValue("Menu target");
});

test("the picker closes with Escape and says when there is nothing to offer", async ({ page }) => {
  await openDiagram(page);
  await page.locator('[data-testid="main-menu-trigger"]').click();
  await page.getByRole("button", { name: "Open recent…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("No other diagrams have been opened in this browser yet.");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a deleted diagram drops out of the history when it is opened", async ({ page, request }) => {
  const id = await makeDiagram(page, request, "Soon gone");
  await request.post("/api/admin/login", { data: { password: "test-admin-password" } });
  expect((await request.delete(`/api/admin/diagrams/${id}`)).status()).toBe(204);

  await page.goto(`/${id}`);
  await expect(page.getByRole("heading", { name: "This diagram was deleted" })).toBeVisible();
  expect(await recent(page)).toEqual([]);
});
