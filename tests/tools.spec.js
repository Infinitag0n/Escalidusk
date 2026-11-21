import { expect, test } from "@playwright/test";
import {
  dropImage,
  expectStoredCount,
  liveElements,
  openDiagram,
  rectangle,
  seedDiagram,
  stored,
} from "./helpers.js";

const moreTools = (page) => page.locator(".App-toolbar__extra-tools-trigger");
const toolbarTool = (page, name) => page.locator(`label:has([data-testid="toolbar-${name}"])`);
const movedTool = (page, type) => page.locator(`[data-testid="moved-tool-${type}"]`);

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

const types = async (request, id) =>
  liveElements(await stored(request, id)).map((element) => element.type);

test("Insert image and Eraser are under More tools, not in the toolbar", async ({ page }) => {
  await openDiagram(page);
  for (const name of ["image", "eraser"]) {
    await expect(toolbarTool(page, name)).toBeHidden();
  }
  // The rest of the toolbar is as it was: the tools for keys 1 to 8, none skipped.
  for (const name of ["selection", "rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text"]) {
    await expect(toolbarTool(page, name)).toBeVisible();
  }

  await moreTools(page).click();
  const menu = page.locator(".App-toolbar__extra-tools-dropdown");
  const labels = await menu.locator(".dropdown-menu-item__text").allTextContents();
  expect(labels.slice(0, 2)).toEqual(["Insert image", "Eraser"]);
  expect(labels).toContain("Laser pointer"); // Excalidraw's own entries are still there
  await expect(movedTool(page, "eraser").locator(".dropdown-menu-item__shortcut")).toHaveText("E");
});

test("Eraser from the menu erases, and the menu closes behind it", async ({ page, request }) => {
  const { id } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, id);
  await moreTools(page).click();
  await movedTool(page, "eraser").click();
  await expect(page.locator(".App-toolbar__extra-tools-dropdown")).toHaveCount(0);
  // "More tools" lights up while a tool from it is selected.
  await expect(page.locator(".editor--moved-tool-active")).toHaveCount(1);

  // The seeded rectangle is centred on screen; drag across it.
  const { width, height } = page.viewportSize();
  await drag(page, { x: width / 2 - 150, y: height / 2 }, { x: width / 2 + 150, y: height / 2 });
  await expectStoredCount(request, id, 0);

  await page.locator('[data-testid="toolbar-selection"]').click({ force: true });
  await expect(page.locator(".editor--moved-tool-active")).toHaveCount(0);
});

test("Draw is in the toolbar, on key 7", async ({ page, request }) => {
  const id = await openDiagram(page);
  await page.mouse.click(600, 500); // give the canvas the keyboard
  await page.keyboard.press("7");
  await expect(page.locator('[data-testid="toolbar-freedraw"]')).toBeChecked();
  await expect(page.locator(".editor--moved-tool-active")).toHaveCount(0);
  await drag(page, { x: 300, y: 300 }, { x: 450, y: 360 });
  await expectStoredCount(request, id, 1);
  expect(await types(request, id)).toEqual(["freedraw"]);
});

test("the keyboard shortcut for the eraser still works", async ({ page, request }) => {
  const { id } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, id);
  const { width, height } = page.viewportSize();
  await page.mouse.click(width / 2, height / 2 + 300); // give the canvas the keyboard
  await page.keyboard.press("e");
  await expect(page.locator(".editor--moved-tool-active")).toHaveCount(1);
  await drag(page, { x: width / 2 - 150, y: height / 2 }, { x: width / 2 + 150, y: height / 2 });
  await expectStoredCount(request, id, 0);
});

test("the selected entry is marked in the menu", async ({ page }) => {
  await openDiagram(page);
  await moreTools(page).click();
  await movedTool(page, "eraser").click();
  await moreTools(page).click();
  await expect(movedTool(page, "eraser")).toHaveClass(/dropdown-menu-item--selected/);
  await expect(movedTool(page, "image")).not.toHaveClass(/dropdown-menu-item--selected/);
});

test("images can still be added by dropping them on the canvas", async ({ page, request }) => {
  const id = await openDiagram(page);
  await dropImage(page, 600, 300);
  await expectStoredCount(request, id, 1);
  expect(await types(request, id)).toEqual(["image"]);
});

test("Insert image from the menu selects the image tool", async ({ page }) => {
  await openDiagram(page);
  // Selecting the tool opens the system file picker, which a test cannot
  // drive; what matters here is that the tool is chosen.
  await page.evaluate(() => {
    window.showOpenFilePicker = () => new Promise(() => {});
  });
  await moreTools(page).click();
  await movedTool(page, "image").click();
  await expect(page.locator(".editor--moved-tool-active")).toHaveCount(1);
});
