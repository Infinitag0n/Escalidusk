import { expect, test } from "@playwright/test";
import {
  connectLive,
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

/**
 * Adds a link to `targetName` from the page's current diagram, using the
 * footer button. The link is for editing unless `readOnly` is asked for.
 */
async function addLink(page, targetName, { readOnly = false } = {}) {
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect to a diagram" });
  await expect(dialog.getByRole("radio", { name: "for editing" })).toBeChecked();
  if (readOnly) await dialog.getByRole("radio", { name: "read-only" }).check();
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

test("linking to a diagram adds a hexagon carrying its name and ids", async ({
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

  // Its plain link is the read-only one. By default it also carries the
  // editing id, for the people who can edit this diagram.
  expect(hexagon.link).toBe(`/${target.viewId}`);
  expect(hexagon.customData).toEqual({
    escalidusk: { diagramLink: { view: target.viewId, edit: target.id } },
  });
  expect(label.customData).toEqual({ escalidusk: { diagramLinkLabel: target.viewId } });

  // Read through the read-only link, the same diagram does not contain the
  // editing id anywhere: sharing it for viewing hands out no edit access.
  const asViewer = await stored(request, diagram.viewId);
  expect(parts(asViewer).hexagon.customData).toEqual({
    escalidusk: { diagramLink: { view: target.viewId } },
  });
  expect(JSON.stringify(asViewer)).not.toContain(target.id);
  expect(liveElements(asViewer)).toHaveLength(2);
});

test("a link can be made read-only, and then carries no editing id at all", async ({
  page,
  request,
}) => {
  const target = await makeDiagram(page, request, "Look, don't touch");
  const source = await makeDiagram(page, request, "Overview");
  await addLink(page, "Look, don't touch", { readOnly: true });
  await expectStoredCount(request, source.id, 2);

  const diagram = await stored(request, source.id);
  expect(parts(diagram).hexagon.customData).toEqual({
    escalidusk: { diagramLink: { view: target.viewId } },
  });
  expect(JSON.stringify(diagram.scene)).not.toContain(target.id);
});

test("a diagram this browser can only view is always linked read-only", async ({
  page,
  request,
}) => {
  const target = await seedDiagram(request, { elements: [rectangle()], appState: { name: "Theirs" } });
  await openDiagram(page, target.viewId);
  const source = await makeDiagram(page, request, "Mine");
  await addLink(page, "Theirs"); // "for editing" is selected, but there is no editing id to give
  await expectStoredCount(request, source.id, 2);
  expect(parts(await stored(request, source.id)).hexagon.customData).toEqual({
    escalidusk: { diagramLink: { view: target.viewId } },
  });
});

test("an editing id in a link never reaches a read-only connection", async ({
  browser,
  page,
  request,
  baseURL,
}) => {
  const target = await makeDiagram(page, request, "Private target");
  const source = await makeDiagram(page, request, "Shared for viewing");
  // Someone watching live through the read-only link, and another editor.
  const viewer = await connectLive(baseURL, source.viewId);
  const editor = await connectLive(baseURL, source.id);
  await expect(page.locator(".UserList")).toBeVisible();

  await addLink(page, "Private target");
  await expectStoredCount(request, source.id, 2);
  await expect.poll(() => viewer.of("update").length).toBeGreaterThan(0);

  expect(JSON.stringify(viewer.messages)).not.toContain(target.id);
  expect(JSON.stringify(viewer.messages)).toContain(target.viewId);
  // The other editor does get it.
  expect(JSON.stringify(editor.messages)).toContain(target.id);
  viewer.socket.close();
  editor.socket.close();
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
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("No other diagrams opened");
  await page.keyboard.press("Escape");

  // The menu offers the same thing.
  await page.locator('[data-testid="main-menu-trigger"]').click();
  await expect(page.getByRole("button", { name: "Connect to a diagram…" })).toBeVisible();
  await page.keyboard.press("Escape");

  const { viewId } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, viewId);
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
  await page.locator('[data-testid="main-menu-trigger"]').click();
  await expect(page.getByRole("button", { name: "Open recent…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect to a diagram…" })).toHaveCount(0);
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

test.describe("someone else following a link", () => {
  /** A source diagram linking to a target, and a second person's own browser. */
  async function setUp({ browser, page, request }, linkOptions) {
    const target = await makeDiagram(page, request, "Shared target");
    const source = await makeDiagram(page, request, "Shared source");
    await addLink(page, "Shared target", linkOptions);
    await expectStoredCount(request, source.id, 2);
    await expectStatus(page, "saved");
    const { hexagon } = parts(await stored(request, source.id));
    const visitor = await (await browser.newContext()).newPage();
    return { target, source, hexagon, visitor };
  }

  test("an editor of the source may edit the target too", async ({ browser, page, request }) => {
    const { target, source, hexagon, visitor } = await setUp({ browser, page, request });
    await openDiagram(visitor, source.id);
    await followLink(visitor, hexagon);
    await visitor.waitForURL(`**/${target.id}`);
    await expect(visitor.getByLabel("Diagram name")).toHaveValue("Shared target");
    await expect(visitor.locator('[data-testid="toolbar-rectangle"]')).toHaveCount(1);
    await visitor.context().close();
  });

  test("a viewer of the source gets the target read-only, with no way to edit it", async ({
    browser,
    page,
    request,
  }) => {
    const { target, source, hexagon, visitor } = await setUp({ browser, page, request });
    const received = [];
    visitor.on("response", async (response) => {
      if (response.url().includes("/api/")) received.push(await response.text().catch(() => ""));
    });
    await openDiagram(visitor, source.viewId);
    await followLink(visitor, hexagon);
    await visitor.waitForURL(`**/${target.viewId}`);
    await expect(visitor.locator(".save-status")).toHaveText("Read-only");
    await expect(visitor.locator(".diagram-title--readonly")).toHaveText("Shared target");
    await expect(visitor.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);

    // Nothing that browser was sent or kept names the target's editing id.
    expect(received.join("\n")).not.toContain(target.id);
    const kept = await visitor.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    expect(kept).not.toContain(target.id);
    await visitor.context().close();
  });

  test("a read-only link gives even an editor of the source the read-only page", async ({
    browser,
    page,
    request,
  }) => {
    const { target, source, hexagon, visitor } = await setUp(
      { browser, page, request },
      { readOnly: true },
    );
    await openDiagram(visitor, source.id);
    await followLink(visitor, hexagon);
    await visitor.waitForURL(`**/${target.viewId}`);
    await expect(visitor.locator(".save-status")).toHaveText("Read-only");
    await visitor.context().close();
  });
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
