import { expect, test } from "@playwright/test";
import {
  drawRectangle,
  expectStatus,
  expectStoredCount,
  liveElements,
  openDiagram,
  rectangle,
  refocus,
  seedDiagram,
  stored,
} from "./helpers.js";

const title = (page) => page.getByLabel("Diagram name");
const titleLabel = (page) => page.locator(".diagram-title--readonly");
const storedName = async (request, id) => (await stored(request, id))?.scene.appState.name;

test("the name is plain text beside the menu button: no border, no box", async ({ page }) => {
  await openDiagram(page);
  const field = title(page);
  await expect(field).toHaveAttribute("placeholder", "Untitled");
  await expect(field).toHaveValue("");

  const look = await field.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      border: style.borderTopWidth,
      background: style.backgroundColor,
      shadow: style.boxShadow,
      outline: style.outlineStyle,
    };
  });
  expect(look).toEqual({
    border: "0px",
    background: "rgba(0, 0, 0, 0)",
    shadow: "none",
    outline: "none",
  });

  const menu = await page.locator('[data-testid="main-menu-trigger"]').boundingBox();
  const toolbar = await page.locator(".App-toolbar").first().boundingBox();
  const box = await field.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(menu.x + menu.width);
  expect(box.x + box.width).toBeLessThanOrEqual(toolbar.x);
  expect(Math.abs(box.y + box.height / 2 - (menu.y + menu.height / 2))).toBeLessThanOrEqual(2);
});

test("typing a name saves it, sets the tab title, and survives a reload", async ({
  page,
  request,
}) => {
  const id = await openDiagram(page);
  await title(page).fill("Network plan");
  await title(page).press("Enter");

  await expect.poll(() => storedName(request, id)).toBe("Network plan");
  await expect(page).toHaveTitle("Network plan - Escalidusk");
  await expect(title(page)).not.toBeFocused();

  await page.reload();
  await page.waitForSelector(".excalidraw canvas");
  await expect(title(page)).toHaveValue("Network plan");
  await expect(page).toHaveTitle("Network plan - Escalidusk");
});

test("typing in the name does not trigger drawing shortcuts", async ({ page }) => {
  await openDiagram(page);
  await title(page).click();
  await page.keyboard.type("rectangle 123");
  await expect(title(page)).toHaveValue("rectangle 123");
  await expect(page.locator('[data-testid="toolbar-rectangle"]')).not.toBeChecked();
  await expect(page.locator('[data-testid="toolbar-selection"]')).toBeChecked();
});

test("a read-only page shows the name as a label, not a text field", async ({ page, request }) => {
  const { viewId } = await seedDiagram(request, {
    elements: [rectangle()],
    appState: { name: "Quarterly roadmap" },
  });
  await openDiagram(page, viewId);

  await expect(titleLabel(page)).toHaveText("Quarterly roadmap");
  await expect(page.locator("input.diagram-title")).toHaveCount(0);
  await expect(page).toHaveTitle("Quarterly roadmap - Escalidusk");

  // Clicking it must not turn it into anything that looks like a text box.
  await titleLabel(page).click();
  const look = await titleLabel(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.borderTopWidth, style.outlineStyle, style.boxShadow, style.backgroundColor].join(";");
  });
  expect(look).toBe("0px;none;none;rgba(0, 0, 0, 0)");
});

test("a read-only page of an unnamed diagram shows no name at all", async ({ page, request }) => {
  const { viewId } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, viewId);
  await expect(page.locator(".diagram-title")).toHaveCount(0);
});

test("a viewer picks up a rename when their tab regains focus", async ({
  context,
  page,
  request,
}) => {
  const { id, viewId } = await seedDiagram(request, {
    elements: [rectangle()],
    appState: { name: "Before" },
  });
  const viewer = await context.newPage();
  await openDiagram(viewer, viewId);
  await expect(titleLabel(viewer)).toHaveText("Before");

  await openDiagram(page, id);
  await title(page).fill("After");
  await title(page).press("Enter");
  await expect.poll(() => storedName(request, id)).toBe("After");

  await refocus(viewer);
  await expect(titleLabel(viewer)).toHaveText("After");
});

test("a rename in one tab and a drawing in an out-of-date tab both survive", async ({
  context,
  page,
  request,
}) => {
  const { id } = await seedDiagram(request, {
    elements: [rectangle()],
    appState: { name: "Original" },
  });
  await openDiagram(page, id);
  const second = await context.newPage();
  await openDiagram(second, id);

  await title(page).fill("Renamed");
  await title(page).press("Enter");
  await expect.poll(() => storedName(request, id)).toBe("Renamed");

  // The second tab still shows "Original". Its drawing must not undo the rename.
  await drawRectangle(second, 900, 550);
  await expectStoredCount(request, id, 2);
  await expectStatus(second, "saved");

  const diagram = await stored(request, id);
  expect(diagram.scene.appState.name).toBe("Renamed");
  expect(liveElements(diagram)).toHaveLength(2);
  await expect(title(second)).toHaveValue("Renamed");
});
