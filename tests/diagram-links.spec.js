import { expect, test } from "@playwright/test";
import {
  expectStatus,
  expectStoredCount,
  liveElements,
  newId,
  openDiagram,
  rectangle,
  refocus,
  seedDiagram,
  stored,
} from "./helpers.js";

const title = (page) => page.getByLabel("Diagram name");

/** Creates and names a diagram through the editor, so it lands in this browser's history. */
async function makeDiagram(page, request, name) {
  const id = await openDiagram(page);
  await title(page).fill(name);
  await title(page).press("Enter");
  await expect.poll(async () => (await stored(request, id))?.scene.appState.name).toBe(name);
  return { id, viewId: (await stored(request, id)).viewId };
}

/** Adds a link to `targetName` from the page's current diagram, using the footer button. */
async function addLink(page, targetName) {
  await page.getByRole("button", { name: "Link diagram" }).click();
  const dialog = page.getByRole("dialog", { name: "Link to a diagram" });
  await dialog.getByRole("button", { name: new RegExp(targetName) }).click();
  await expect(dialog).toHaveCount(0);
}

const parts = (diagram) => {
  const elements = liveElements(diagram);
  return {
    hexagon: elements.find((element) => element.type === "line"),
    label: elements.find((element) => element.type === "text"),
  };
};

/** Follows the link on the hexagon in the middle of the screen, through its link icon. */
async function followLink(page, hexagon) {
  const { width, height } = page.viewportSize();
  await page.mouse.click(width / 2, height - 120); // empty canvas: deselect
  const icon = { x: width / 2 + hexagon.width / 2 + 7, y: height / 2 - hexagon.height / 2 - 9 };
  await page.mouse.move(icon.x - 30, icon.y + 30);
  await page.mouse.move(icon.x, icon.y, { steps: 4 });
  await page.mouse.click(icon.x, icon.y);
}

test("linking to a diagram adds a hexagon carrying its name and read-only id", async ({
  page,
  request,
}) => {
  const target = await makeDiagram(page, request, "Billing service");
  const source = await makeDiagram(page, request, "System overview");

  await addLink(page, "Billing service");
  await expectStoredCount(request, source.id, 2);
  const diagram = await stored(request, source.id);
  const { hexagon, label } = parts(diagram);

  // A closed six-sided line, filled, with the name as a text element in the same group.
  expect(hexagon.points).toHaveLength(7);
  expect(hexagon.points[6]).toEqual(hexagon.points[0]);
  expect(hexagon.backgroundColor).not.toBe("transparent");
  expect(label.text).toBe("Billing service");
  expect(hexagon.groupIds).toHaveLength(1);
  expect(label.groupIds).toEqual(hexagon.groupIds);

  // The name sits in the middle of the hexagon, with room to spare.
  expect(label.width).toBeLessThan(hexagon.width - 80);
  const hexagonCentre = hexagon.x + hexagon.width / 2;
  expect(Math.abs(label.x + label.width / 2 - hexagonCentre)).toBeLessThan(2);
  expect(Math.abs(label.y + label.height / 2 - hexagon.y)).toBeLessThan(2);

  // It points at the read-only id. The editing id is nowhere in the scene,
  // so sharing this diagram does not hand out edit access to the other one.
  expect(hexagon.link).toBe(`/${target.viewId}`);
  expect(hexagon.customData).toEqual({ escalidusk: { diagramLink: target.viewId } });
  expect(label.customData).toEqual({ escalidusk: { diagramLinkLabel: target.viewId } });
  expect(JSON.stringify(diagram.scene)).not.toContain(target.id);
});

test("a new hexagon is selected as one unit and answers to the keyboard", async ({
  page,
  request,
}) => {
  await makeDiagram(page, request, "Target");
  const source = await makeDiagram(page, request, "Source");
  await addLink(page, "Target");
  await expectStoredCount(request, source.id, 2);

  await page.keyboard.press("Delete");
  await expectStoredCount(request, source.id, 0); // both parts went together

  await page.keyboard.press("Control+z");
  await expectStoredCount(request, source.id, 2);
});

test("the hexagon grows to fit a long name", async ({ page, request }) => {
  await makeDiagram(page, request, "A rather long name for a diagram about quarterly planning");
  const source = await makeDiagram(page, request, "Index");
  await addLink(page, "A rather long name");
  await expectStoredCount(request, source.id, 2);
  const { hexagon, label } = parts(await stored(request, source.id));
  expect(hexagon.width).toBeGreaterThan(400);
  expect(label.width).toBeLessThan(hexagon.width - 80);
});

test("only other diagrams are offered, and a read-only page cannot add links", async ({
  page,
  request,
}) => {
  await makeDiagram(page, request, "The only one");
  await page.getByRole("button", { name: "Link diagram" }).click();
  await expect(page.getByRole("dialog")).toContainText("No other diagrams have been opened");
  await page.keyboard.press("Escape");

  // The menu offers the same thing.
  await page.locator('[data-testid="main-menu-trigger"]').click();
  await expect(page.getByRole("button", { name: "Link to a diagram…" })).toBeVisible();
  await page.keyboard.press("Escape");

  const { viewId } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, viewId);
  await expect(page.getByRole("button", { name: "Link diagram" })).toHaveCount(0);
  await page.locator('[data-testid="main-menu-trigger"]').click();
  await expect(page.getByRole("button", { name: "Open recent…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Link to a diagram…" })).toHaveCount(0);
});

test("following a link opens the editable page for someone who can edit the target", async ({
  page,
  request,
}) => {
  const target = await makeDiagram(page, request, "Editable target");
  const source = await makeDiagram(page, request, "Source");
  await addLink(page, "Editable target");
  await expectStoredCount(request, source.id, 2);
  await expectStatus(page, "saved");

  await followLink(page, parts(await stored(request, source.id)).hexagon);
  await page.waitForURL(`**/${target.id}`);
  await expect(title(page)).toHaveValue("Editable target");
});

test("following a link gives everyone else the read-only page", async ({
  browser,
  page,
  request,
}) => {
  const target = await makeDiagram(page, request, "Shared target");
  const source = await makeDiagram(page, request, "Shared source");
  await addLink(page, "Shared target");
  await expectStoredCount(request, source.id, 2);
  const { hexagon } = parts(await stored(request, source.id));

  // Someone else, in their own browser, who was given the source diagram to edit.
  const visitor = await (await browser.newContext()).newPage();
  await openDiagram(visitor, source.id);
  await followLink(visitor, hexagon);
  await visitor.waitForURL(`**/${target.viewId}`);
  await expect(visitor.locator(".save-status")).toHaveText("Read-only");
  await expect(visitor.locator(".diagram-title--readonly")).toHaveText("Shared target");
  await visitor.context().close();
});

test("the label follows the linked diagram's name", async ({ page, request }) => {
  const target = await makeDiagram(page, request, "Old name");
  const source = await makeDiagram(page, request, "Index");
  await addLink(page, "Old name");
  await expectStoredCount(request, source.id, 2);
  const before = parts(await stored(request, source.id));

  const { version, scene } = await stored(request, target.id);
  await request.put(`/api/diagrams/${target.id}`, {
    data: { baseVersion: version, elements: scene.elements, appState: { name: "A much longer new name" } },
  });

  await refocus(page);
  await expect
    .poll(async () => parts(await stored(request, source.id)).label.text)
    .toBe("A much longer new name");
  const after = parts(await stored(request, source.id));
  expect(after.label.width).toBeGreaterThan(before.label.width);
  // Still centred on the hexagon.
  const centre = (element) => element.x + element.width / 2;
  expect(Math.abs(centre(after.label) - centre(before.label))).toBeLessThan(2);
  expect(after.label.version).toBeGreaterThan(before.label.version);
});

test("a diagram's labels are brought up to date when it is opened", async ({ page, request }) => {
  const target = await seedDiagram(request, { appState: { name: "Current name" } });
  const marker = { escalidusk: { diagramLinkLabel: target.viewId } };
  const source = await seedDiagram(request, {
    elements: [
      {
        ...rectangle(),
        type: "text",
        text: "Stale name",
        originalText: "Stale name",
        fontSize: 20,
        fontFamily: 5,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        autoResize: true,
        lineHeight: 1.25,
        backgroundColor: "transparent",
        customData: marker,
      },
    ],
  });
  await openDiagram(page, source.id);
  await expect
    .poll(async () => liveElements(await stored(request, source.id))[0].text)
    .toBe("Current name");
});

test("names can be looked up in bulk by either id", async ({ request }) => {
  const named = await seedDiagram(request, { appState: { name: "Named" } });
  const unnamed = await seedDiagram(request);
  const gone = await seedDiagram(request, { appState: { name: "Gone" } });
  await request.post("/api/admin/login", { data: { password: "test-admin-password" } });
  await request.delete(`/api/admin/diagrams/${gone.id}`);
  const unknown = newId();

  const response = await request.post("/api/diagrams/summaries", {
    data: { ids: [named.id, named.viewId, unnamed.viewId, gone.viewId, unknown] },
  });
  expect(await response.json()).toEqual({
    [named.id]: { name: "Named" },
    [named.viewId]: { name: "Named" },
    [unnamed.viewId]: { name: "" },
    [gone.viewId]: { deleted: true },
    [unknown]: null,
  });

  for (const data of [{}, { ids: "nope" }, { ids: ["not-a-uuid"] }]) {
    expect((await request.post("/api/diagrams/summaries", { data })).status()).toBe(400);
  }
});
