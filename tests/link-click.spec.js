import { expect, test } from "@playwright/test";
import { diagramLinkAt, onlyLinkSelected, outlineContains } from "../src/linkHit.js";
import {
  drawRectangle,
  expectStatus,
  expectStoredCount,
  hexagonLink,
  liveElements,
  newId,
  openDiagram,
  seedDiagram,
  stored,
} from "./helpers.js";

// A link to another diagram is opened by clicking its hexagon: one click
// while viewing, a double-click while editing (where one click selects).

const pathOf = (page) => new URL(page.url()).pathname.slice(1);
const centreOf = (page) => {
  const { width, height } = page.viewportSize();
  return { x: width / 2, y: height / 2 };
};
/** Where Excalidraw's link icon used to sit: just outside the hexagon's top-right corner. */
const oldIconOf = (page, hexagon) => {
  const centre = centreOf(page);
  return { x: centre.x + hexagon.width / 2 + 7, y: centre.y - hexagon.height / 2 - 9 };
};
const textEditor = (page) => page.locator(".excalidraw-wysiwyg");

/** A source diagram whose only content is a link to a target, both made through the API. */
async function linked(request, { link = null, edit = true, extra = [] } = {}) {
  const target = await seedDiagram(request, { appState: { name: "Target" } });
  const elements = [
    ...hexagonLink({ view: target.viewId, edit: edit ? target.id : undefined, name: "Target", link }),
    ...extra,
  ];
  const source = await seedDiagram(request, { elements, appState: { name: "Source" } });
  return { target, source, hexagon: elements[0] };
}

test.describe("the outline of a hexagon", () => {
  const [hexagon] = hexagonLink({ view: newId(), x: 400, y: 400 });
  // It spans x 290 to 510 and y 345 to 455, with slanted sides.

  test("holds its middle and not its bounding box's corners", () => {
    expect(outlineContains(hexagon, { x: 400, y: 400 })).toBe(true);
    expect(outlineContains(hexagon, { x: 400, y: 350 })).toBe(true);
    expect(outlineContains(hexagon, { x: 295, y: 400 })).toBe(true);
    // Inside the box around it, but cut off by the slanted sides.
    expect(outlineContains(hexagon, { x: 295, y: 350 })).toBe(false);
    expect(outlineContains(hexagon, { x: 505, y: 450 })).toBe(false);
    expect(outlineContains(hexagon, { x: 400, y: 460 })).toBe(false);
    expect(outlineContains(hexagon, { x: 520, y: 400 })).toBe(false);
  });

  test("follows the hexagon when it is turned or stretched", () => {
    // A quarter turn: now tall and narrow about the same centre.
    const turned = { ...hexagon, angle: Math.PI / 2 };
    expect(outlineContains(turned, { x: 400, y: 400 })).toBe(true);
    expect(outlineContains(turned, { x: 400, y: 500 })).toBe(true); // was outside, below
    expect(outlineContains(turned, { x: 500, y: 400 })).toBe(false); // was inside, to the right
    // Twice as wide.
    const wide = { ...hexagon, points: hexagon.points.map(([x, y]) => [x * 2, y]) };
    expect(outlineContains(wide, { x: 700, y: 400 })).toBe(true);
    expect(outlineContains(hexagon, { x: 700, y: 400 })).toBe(false);
  });

  test("the topmost link under a point is the one found, and deleted ones are not", () => {
    const [lower] = hexagonLink({ view: newId(), x: 400, y: 400 });
    const [upper] = hexagonLink({ view: newId(), x: 450, y: 400 });
    const other = { id: "plain", type: "rectangle", x: 0, y: 0, width: 1000, height: 1000 };
    expect(diagramLinkAt([lower, upper, other], { x: 430, y: 400 }).element).toBe(upper);
    expect(diagramLinkAt([lower, { ...upper, isDeleted: true }], { x: 430, y: 400 }).element).toBe(lower);
    expect(diagramLinkAt([lower, upper], { x: 310, y: 400 }).element).toBe(lower);
    expect(diagramLinkAt([lower, upper], { x: 100, y: 100 })).toBeNull();
    expect(diagramLinkAt([other], { x: 400, y: 400 })).toBeNull();
  });

  test("a link counts as selected only when nothing else is selected with it", () => {
    const [shape, label] = hexagonLink({ view: newId() });
    const other = { id: "other", groupIds: [] };
    const all = [shape, label, other];
    const ids = (...elements) => Object.fromEntries(elements.map((element) => [element.id, true]));
    expect(onlyLinkSelected(all, ids(shape, label), shape)).toBe(true);
    expect(onlyLinkSelected(all, ids(shape), shape)).toBe(true);
    expect(onlyLinkSelected(all, ids(label), shape)).toBe(true);
    expect(onlyLinkSelected(all, {}, shape)).toBe(false);
    expect(onlyLinkSelected(all, ids(other), shape)).toBe(false);
    expect(onlyLinkSelected(all, ids(shape, label, other), shape)).toBe(false);
    // Put in a larger group with something else: selected together, it is not "only the link".
    const grouped = [shape, label, other].map((element) => ({ ...element, groupIds: [...element.groupIds, "outer"] }));
    expect(onlyLinkSelected(grouped, ids(...grouped), grouped[0])).toBe(false);
    expect(onlyLinkSelected(grouped, ids(grouped[0], grouped[1]), grouped[0])).toBe(true);
  });
});

test.describe("while editing", () => {
  test("one click selects and a drag moves, as for any shape; neither opens anything", async ({
    page,
    request,
  }) => {
    const { source, hexagon } = await linked(request);
    await openDiagram(page, source.id);
    const centre = centreOf(page);

    await page.mouse.click(centre.x, centre.y);
    await page.waitForTimeout(600); // longer than any double-click wait
    expect(pathOf(page)).toBe(source.id);
    // Selected: the shape's properties are offered.
    await expect(page.locator(".App-menu__left")).toBeVisible();

    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 150, centre.y + 60, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => liveElements(await stored(request, source.id)).find((e) => e.id === hexagon.id).x)
      .toBeCloseTo(hexagon.x + 150, 0);
    expect(pathOf(page)).toBe(source.id);
    await expect(textEditor(page)).toHaveCount(0);
  });

  test("a double-click opens the linked diagram, for editing", async ({ page, request }) => {
    const { source, target } = await linked(request);
    await openDiagram(page, source.id);
    const centre = centreOf(page);
    await page.mouse.dblclick(centre.x, centre.y);
    await page.waitForURL(`**/${target.id}`);
    await expect(page.getByLabel("Diagram name")).toHaveValue("Target");
  });

  test("a double-click on its edge, away from the label, opens it too", async ({ page, request }) => {
    const { source, target, hexagon } = await linked(request);
    await openDiagram(page, source.id);
    const centre = centreOf(page);
    await page.mouse.dblclick(centre.x - hexagon.width / 2 + 25, centre.y);
    await page.waitForURL(`**/${target.id}`);
  });

  test("it does not start editing the label or the outline, even when the diagram stays open", async ({
    page,
    request,
  }) => {
    const { source, target, hexagon } = await linked(request);
    await openDiagram(page, source.id);
    const centre = centreOf(page);

    // With Ctrl held it opens in a new tab, and this page stays as it was.
    await page.keyboard.down("Control");
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.mouse.dblclick(centre.x, centre.y),
    ]);
    await page.keyboard.up("Control");
    await popup.waitForURL(`**/${target.id}`);
    await popup.close();

    expect(pathOf(page)).toBe(source.id);
    await expect(textEditor(page)).toHaveCount(0);
    // Typing now must not land in a label, nor change anything.
    await page.keyboard.type("xyz");
    await page.waitForTimeout(1500);
    await expectStatus(page, "saved");
    const after = liveElements(await stored(request, source.id));
    expect(after.find((element) => element.type === "text").text).toBe("Target");
    expect(after.find((element) => element.id === hexagon.id).points).toEqual(hexagon.points);
  });

  test("double-clicking anything else is still Excalidraw's: text is edited, the canvas gets new text", async ({
    page,
    request,
  }) => {
    const { source } = await linked(request);
    await openDiagram(page, source.id);
    const centre = centreOf(page);
    // Empty canvas: Excalidraw starts a new piece of text there.
    await page.mouse.dblclick(centre.x, centre.y + 250);
    await expect(textEditor(page)).toHaveCount(1);
    await page.keyboard.type("Plain text");
    await page.keyboard.press("Escape");
    await expectStoredCount(request, source.id, 3);
    expect(pathOf(page)).toBe(source.id);
  });

  test("with another tool picked, a double-click draws with it and opens nothing", async ({ page, request }) => {
    const { source } = await linked(request);
    await openDiagram(page, source.id);
    const centre = centreOf(page);
    await page.locator('[data-testid="toolbar-text"]').click({ force: true });
    await page.mouse.dblclick(centre.x, centre.y);
    await page.waitForTimeout(600);
    expect(pathOf(page)).toBe(source.id);
  });

  test("inside a group someone made, the first double-click steps into the group and the next one opens", async ({
    page,
    request,
  }) => {
    const { source, target } = await linked(request);
    await openDiagram(page, source.id);
    const centre = centreOf(page);
    await drawRectangle(page, centre.x + 250, centre.y - 40);
    await expectStoredCount(request, source.id, 3);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+g");
    await expect
      .poll(async () => liveElements(await stored(request, source.id)).every((e) => e.groupIds.length >= 1 && e.groupIds.at(-1)))
      .toBeTruthy();
    await page.mouse.click(centre.x, centre.y + 300); // deselect

    await page.mouse.dblclick(centre.x - 80, centre.y);
    await page.waitForTimeout(600);
    expect(pathOf(page)).toBe(source.id);
    await expect(textEditor(page)).toHaveCount(0);

    await page.mouse.dblclick(centre.x - 80, centre.y);
    await page.waitForURL(`**/${target.id}`);
  });
});

test.describe("while viewing", () => {
  test("one click on the hexagon opens the linked diagram, read-only, and the pointer shows it can be clicked", async ({
    page,
    request,
  }) => {
    const { source, target } = await linked(request);
    await openDiagram(page, source.viewId);
    const centre = centreOf(page);
    const canvas = page.locator(".excalidraw canvas.interactive");

    await page.mouse.move(centre.x, centre.y + 250);
    await expect(canvas).not.toHaveCSS("cursor", "pointer");
    await page.mouse.move(centre.x, centre.y, { steps: 3 });
    await expect(canvas).toHaveCSS("cursor", "pointer");
    await page.mouse.move(centre.x, centre.y + 250, { steps: 3 });
    await expect(canvas).not.toHaveCSS("cursor", "pointer");

    await page.mouse.click(centre.x, centre.y);
    await page.waitForURL(`**/${target.viewId}`);
    await expect(page.locator(".save-status")).toHaveText("Read-only");
  });

  test("dragging across it pans the view and opens nothing", async ({ page, request }) => {
    const { source } = await linked(request);
    await openDiagram(page, source.viewId);
    const centre = centreOf(page);
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 120, centre.y + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    expect(pathOf(page)).toBe(source.viewId);
    // It moved with the drag: the old spot is empty now, the new one opens it.
    await page.mouse.click(centre.x - 100, centre.y - 45);
    await page.waitForTimeout(400);
    expect(pathOf(page)).toBe(source.viewId);
  });

  test("a click beside it, or with the right button, opens nothing", async ({ page, request }) => {
    const { source, hexagon } = await linked(request);
    await openDiagram(page, source.viewId);
    const centre = centreOf(page);
    await page.mouse.click(centre.x, centre.y + 200);
    // The corner of the box around it, which the slanted sides cut off.
    await page.mouse.click(centre.x - hexagon.width / 2 + 5, centre.y - hexagon.height / 2 + 5);
    await page.mouse.click(centre.x, centre.y, { button: "right" });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    expect(pathOf(page)).toBe(source.viewId);
  });

  test("an editor who switched to viewing opens it with one click too, and stays able to edit", async ({
    page,
    request,
  }) => {
    const { source, target } = await linked(request);
    await openDiagram(page, source.id);
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await page.getByRole("button", { name: "View mode" }).click();
    await expect(page.locator(".App-toolbar")).toHaveCount(0);
    const centre = centreOf(page);
    await page.mouse.click(centre.x, centre.y);
    await page.waitForURL(`**/${target.viewId}`);
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  });

  test("with the laser on, a click on it draws and opens nothing", async ({ page, request }) => {
    const { source } = await linked(request);
    await openDiagram(page, source.viewId);
    const centre = centreOf(page);
    await page.mouse.click(centre.x, centre.y + 250); // give the canvas the keyboard
    await page.keyboard.press("k");
    await page.mouse.click(centre.x, centre.y);
    await page.waitForTimeout(600);
    expect(pathOf(page)).toBe(source.viewId);
  });
});

test.describe("a hexagon made before the shape itself was the link", () => {
  test("shows no link icon, and opens by a click like any other", async ({ page, request }) => {
    // Stored with a plain Excalidraw link, as hexagons used to be.
    const target = await seedDiagram(request, { appState: { name: "Target" } });
    const elements = hexagonLink({ view: target.viewId, edit: target.id, name: "Target", link: `/${target.viewId}` });
    const source = await seedDiagram(request, { elements, appState: { name: "Source" } });
    expect(liveElements(await stored(request, source.id))[0].link).toBe(`/${target.viewId}`);

    await openDiagram(page, source.viewId);
    // Where the icon used to be: nothing there to click.
    const icon = oldIconOf(page, elements[0]);
    await page.mouse.move(icon.x - 30, icon.y + 30);
    await page.mouse.move(icon.x, icon.y, { steps: 4 });
    await page.mouse.click(icon.x, icon.y);
    await page.waitForTimeout(600);
    expect(pathOf(page)).toBe(source.viewId);
    await expect(page.locator(".excalidraw-hyperlinkContainer")).toHaveCount(0);

    const centre = centreOf(page);
    await page.mouse.click(centre.x, centre.y);
    await page.waitForURL(`**/${target.viewId}`);
  });

  test("loses the stored link the next time it is saved, without anyone having to do anything to it", async ({
    page,
    request,
  }) => {
    const target = await seedDiagram(request, { appState: { name: "Target" } });
    const elements = hexagonLink({ view: target.viewId, edit: target.id, name: "Target", link: `/${target.viewId}` });
    const source = await seedDiagram(request, { elements, appState: { name: "Source" } });

    await openDiagram(page, source.id);
    const centre = centreOf(page);
    await drawRectangle(page, centre.x + 250, centre.y + 150);
    await expectStoredCount(request, source.id, 3);
    const after = liveElements(await stored(request, source.id)).find((element) => element.type === "line");
    expect(after.link).toBeNull();
    expect(after.customData.escalidusk.diagramLink).toEqual({ view: target.viewId, edit: target.id });
  });
});

test("an ordinary link on any other shape keeps Excalidraw's icon and way of opening", async ({
  page,
  request,
  baseURL,
}) => {
  const target = await seedDiagram(request, { appState: { name: "Target" } });
  const { rectangle } = await import("./helpers.js");
  const source = await seedDiagram(request, { elements: [rectangle({ link: `${baseURL}/${target.id}` })] });
  await openDiagram(page, source.id);
  const centre = centreOf(page);
  // Clicking the shape selects it and offers its link; it does not open by itself.
  await page.mouse.click(centre.x, centre.y);
  await expect(page.locator(".excalidraw-hyperlinkContainer-link")).toBeVisible();
  expect(pathOf(page)).toBe(source.id);
  await page.mouse.dblclick(centre.x, centre.y);
  await page.waitForTimeout(500);
  expect(pathOf(page)).toBe(source.id);
});
