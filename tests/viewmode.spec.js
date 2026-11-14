import { expect, test } from "@playwright/test";
import {
  drawRectangle,
  expectStatus,
  expectStoredCount,
  liveElements,
  openDiagram,
  rectangle,
  seedDiagram,
  stored,
} from "./helpers.js";

const toolbar = (page) => page.locator('[data-testid="toolbar-rectangle"]');
const editButton = (page) => page.getByRole("button", { name: "Edit", exact: true });
const tapSpace = (page) => page.keyboard.press("Space");

async function expectViewing(page) {
  await expect(toolbar(page)).toHaveCount(0);
  await expect(editButton(page)).toBeVisible();
}

async function expectEditing(page) {
  await expect(toolbar(page)).toHaveCount(1);
  await expect(editButton(page)).toHaveCount(0);
}

test("a tap on the space bar switches between editing and viewing", async ({ page, request }) => {
  const { id } = await seedDiagram(request, { elements: [rectangle()], appState: { name: "Plan" } });
  await openDiagram(page, id);
  await expectEditing(page);

  await tapSpace(page);
  await expectViewing(page);
  // Viewing means nothing can be changed: no drawing, no link button, a name that is a label.
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
  await expect(page.locator(".diagram-title--readonly")).toHaveText("Plan");
  await expect(page.getByRole("button", { name: "Laser" })).toBeVisible();
  // Still the editor's own page: saving status and both share buttons remain.
  await expect(page.locator(".save-status")).toHaveAttribute("data-status", "saved");
  await expect(page.getByRole("button", { name: "Share Edit", exact: true })).toBeEnabled();

  await tapSpace(page);
  await expectEditing(page);
  await expect(page.getByLabel("Diagram name")).toHaveValue("Plan");
});

test("nothing can be changed while viewing, and editing works again afterwards", async ({
  page,
  request,
}) => {
  const { id, version } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, id);
  await tapSpace(page);
  await expectViewing(page);

  await page.mouse.move(300, 450);
  await page.mouse.down();
  await page.mouse.move(450, 520, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(2500); // longer than the autosave delay
  expect((await stored(request, id)).version).toBe(version);

  await editButton(page).click();
  await expectEditing(page);
  await drawRectangle(page, 700, 150);
  await expectStoredCount(request, id, 2);
});

test("holding the space bar to pan does not switch modes", async ({ page, request }) => {
  const { id } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, id);

  // Space held while dragging: Excalidraw's pan.
  await page.keyboard.down("Space");
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(500, 380, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expectEditing(page);

  // Space held for a while and let go without dragging: a change of mind, not a tap.
  await page.keyboard.down("Space");
  await page.waitForTimeout(500);
  await page.keyboard.up("Space");
  await expectEditing(page);
});

test("spaces typed into text do not switch modes", async ({ page, request }) => {
  const id = await openDiagram(page);

  await page.getByLabel("Diagram name").click();
  await page.keyboard.type("two words");
  await expectEditing(page);
  await expect(page.getByLabel("Diagram name")).toHaveValue("two words");

  await page.getByLabel("Your name").fill("");
  await page.getByLabel("Your name").click();
  await page.keyboard.type("Ada L");
  await expectEditing(page);

  // Text typed onto the canvas.
  await page.locator('[data-testid="toolbar-text"]').click({ force: true });
  await page.mouse.click(500, 400);
  await page.keyboard.type("hello there world");
  await expectEditing(page);
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => liveElements(await stored(request, id)).map((element) => element.text))
    .toEqual(["hello there world"]);
});

test("the menu offers the same switch", async ({ page, request }) => {
  const { id } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, id);

  await page.locator('[data-testid="main-menu-trigger"]').click();
  await page.getByRole("button", { name: /View mode/ }).click();
  await expectViewing(page);

  await page.locator('[data-testid="main-menu-trigger"]').click();
  await page.getByRole("button", { name: /Edit mode/ }).click();
  await expectEditing(page);
});

test("the laser works for an editor who is viewing", async ({ context, page, request }) => {
  const { id } = await seedDiagram(request, { elements: [rectangle()] });
  const pointers = [];
  const other = await context.newPage();
  other.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(payload);
      if (message.t === "pointer") pointers.push(message);
    }),
  );
  await openDiagram(other, id);
  await openDiagram(page, id);
  await expect(other.locator(".UserList")).toBeVisible();

  await tapSpace(page);
  await page.getByRole("button", { name: "Laser" }).click();
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(600, 500, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(() => pointers.filter((p) => p.tool === "laser" && p.button === "down").length)
    .toBeGreaterThan(3);
});

test("a read-only page stays read-only whatever is pressed", async ({ page, request }) => {
  const { viewId } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, viewId);
  await tapSpace(page);
  await page.waitForTimeout(300);
  await expect(toolbar(page)).toHaveCount(0);
  await expect(editButton(page)).toHaveCount(0);
  await expect(page.locator(".save-status")).toHaveText("Read-only");
  await page.locator('[data-testid="main-menu-trigger"]').click();
  await expect(page.getByRole("button", { name: /View mode|Edit mode/ })).toHaveCount(0);
});

test("a save in progress is not disturbed by switching to viewing", async ({ page, request }) => {
  const id = await openDiagram(page);
  await drawRectangle(page, 300, 250);
  await page.mouse.click(700, 500); // let go of the new shape
  await tapSpace(page);
  await expectViewing(page);
  await expectStoredCount(request, id, 1);
  await expectStatus(page, "saved");
});
