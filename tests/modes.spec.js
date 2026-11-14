import { expect, test } from "@playwright/test";
import {
  clipboard,
  drawRectangle,
  expectStatus,
  expectStoredCount,
  liveElements,
  newId,
  openDiagram,
  rectangle,
  seedDiagram,
  stored,
} from "./helpers.js";

const title = (page) => page.getByLabel("Diagram name");
const toolbar = (page) => page.locator('[data-testid="toolbar-rectangle"]');
const editButton = (page) => page.getByRole("button", { name: "Edit", exact: true });
const pathOf = (page) => new URL(page.url()).pathname.slice(1);

/** Creates and names a diagram through the editor, as its owner would. */
async function makeDiagram(page, request, name) {
  const id = await openDiagram(page);
  await title(page).fill(name);
  await title(page).press("Enter");
  await expect.poll(async () => (await stored(request, id))?.scene.appState.name).toBe(name);
  await expectStatus(page, "saved");
  return { id, viewId: (await stored(request, id)).viewId };
}

test.describe("the address follows the mode", () => {
  test("viewing shows the read-only id, editing the editing id", async ({ page, request }) => {
    const { id, viewId } = await makeDiagram(page, request, "Plan");
    expect(pathOf(page)).toBe(id);

    await page.keyboard.press("Space");
    await expect(editButton(page)).toBeVisible();
    await expect.poll(() => pathOf(page)).toBe(viewId);

    await page.keyboard.press("Space");
    await expect(toolbar(page)).toHaveCount(1);
    await expect.poll(() => pathOf(page)).toBe(id);

    // Switching does not reload the page or add history entries.
    await editButton(page).waitFor({ state: "detached" });
    expect(await page.evaluate(() => window.history.length)).toBeLessThanOrEqual(3);
  });

  test("a diagram that has never been saved keeps its address while viewing", async ({ page }) => {
    const id = await openDiagram(page);
    await page.keyboard.press("Space");
    await expect(editButton(page)).toBeVisible();
    expect(pathOf(page)).toBe(id); // it has no read-only id yet
  });

  test("the share buttons copy the right links in either mode", async ({ page, request, baseURL }) => {
    const { id, viewId } = await makeDiagram(page, request, "Plan");
    for (const viewing of [false, true]) {
      if (viewing) {
        await page.keyboard.press("Space");
        await expect.poll(() => pathOf(page)).toBe(viewId);
      }
      await page.getByRole("button", { name: "Share", exact: true }).click();
      await expect.poll(() => clipboard(page)).toBe(`${baseURL}/${viewId}`);
      await page.getByRole("button", { name: "Share Edit", exact: true }).click();
      await expect.poll(() => clipboard(page)).toBe(`${baseURL}/${id}`);
    }
  });

  test("saving and collaboration carry on while viewing", async ({ context, page, request }) => {
    const { id, viewId } = await makeDiagram(page, request, "Plan");
    await page.keyboard.press("Space");
    await expect.poll(() => pathOf(page)).toBe(viewId);

    // Another tab of the same person edits; this one, though viewing, stays in step.
    const other = await context.newPage();
    await openDiagram(other, id);
    await title(other).fill("Renamed elsewhere");
    await expect(page.locator(".diagram-title--readonly")).toHaveText("Renamed elsewhere");

    await page.keyboard.press("Space");
    await drawRectangle(page, 300, 300);
    await expectStoredCount(request, id, 1);
  });
});

test.describe("a read-only link in a browser that can edit the diagram", () => {
  test("opens in view mode with Edit one tap away", async ({ page, request }) => {
    const { id, viewId } = await makeDiagram(page, request, "Mine");
    await drawRectangle(page, 300, 300);
    await expectStoredCount(request, id, 1);
    await expectStatus(page, "saved");

    await page.goto(`/${viewId}`);
    await page.waitForSelector(".excalidraw canvas");
    await expect(editButton(page)).toBeVisible();
    await expect(toolbar(page)).toHaveCount(0);
    expect(pathOf(page)).toBe(viewId);
    // Not the bare read-only page: this is the owner, viewing.
    await expect(page.locator(".save-status")).toHaveAttribute("data-status", "saved");
    await expect(page.getByRole("button", { name: "Share Edit", exact: true })).toBeEnabled();

    await page.keyboard.press("Space");
    await expect(toolbar(page)).toHaveCount(1);
    await expect.poll(() => pathOf(page)).toBe(id);
    await drawRectangle(page, 600, 400);
    await expectStoredCount(request, id, 2);
  });

  test("survives a reload, and removing the diagram from the recent list", async ({ page, request }) => {
    const { viewId } = await makeDiagram(page, request, "Mine");
    await page.goto("/");
    await page.getByRole("button", { name: "Remove Mine from this list" }).click();

    await page.goto(`/${viewId}`);
    await page.waitForSelector(".excalidraw canvas");
    await expect(editButton(page)).toBeVisible();
    await page.reload();
    await page.waitForSelector(".excalidraw canvas");
    await expect(editButton(page)).toBeVisible();
    expect(pathOf(page)).toBe(viewId);
  });

  test("someone else's browser gets the plain read-only page", async ({ browser, page, request }) => {
    const { viewId } = await makeDiagram(page, request, "Mine");
    const visitor = await (await browser.newContext()).newPage();
    await openDiagram(visitor, viewId);
    await expect(visitor.locator(".save-status")).toHaveText("Read-only");
    await expect(visitor.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await visitor.keyboard.press("Space");
    await visitor.waitForTimeout(300);
    await expect(visitor.locator('[data-testid="toolbar-rectangle"]')).toHaveCount(0);
    expect(new URL(visitor.url()).pathname.slice(1)).toBe(viewId);
    await visitor.context().close();
  });

  test("falls back to the read-only page if the editing id on record is wrong", async ({
    page,
    request,
  }) => {
    const { viewId } = await seedDiagram(request, {
      elements: [rectangle()],
      appState: { name: "Not mine after all" },
    });
    const bogus = newId();
    await page.addInitScript(
      ([view, edit]) => {
        if (!localStorage.getItem("escalidusk:edit-ids")) {
          localStorage.setItem("escalidusk:edit-ids", JSON.stringify({ [view]: edit }));
        }
      },
      [viewId, bogus],
    );
    await page.goto(`/${viewId}`);
    await expect(page.locator(".save-status")).toHaveText("Read-only");
    await expect(page.locator(".diagram-title--readonly")).toHaveText("Not mine after all");
    expect(pathOf(page)).toBe(viewId);
    // The wrong id was dropped and nothing was created under it.
    expect(await page.evaluate(() => localStorage.getItem("escalidusk:edit-ids"))).toBe("{}");
    expect(await stored(request, bogus)).toBeNull();
  });
});

test.describe("moving between diagrams keeps the current mode", () => {
  async function openRecent(page, name) {
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await page.getByRole("button", { name: "Open recent…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: new RegExp(name) }).click();
  }

  test("from editing to editing, from viewing to viewing", async ({ page, request }) => {
    const first = await makeDiagram(page, request, "First");
    const second = await makeDiagram(page, request, "Second");

    await openRecent(page, "First");
    await page.waitForURL(`**/${first.id}`);
    await expect(toolbar(page)).toHaveCount(1);

    await page.keyboard.press("Space");
    await expect.poll(() => pathOf(page)).toBe(first.viewId);
    await openRecent(page, "Second");
    await page.waitForURL(`**/${second.viewId}`);
    await expect(editButton(page)).toBeVisible();
    await expect(toolbar(page)).toHaveCount(0);

    // Still the owner: one tap goes back to editing, at the editing address.
    await page.keyboard.press("Space");
    await expect.poll(() => pathOf(page)).toBe(second.id);
  });

  test("a hexagon followed while viewing opens the target for viewing, editable on demand", async ({
    page,
    request,
  }) => {
    const target = await makeDiagram(page, request, "Target");
    const source = await makeDiagram(page, request, "Source");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Target/ }).click();
    await expectStoredCount(request, source.id, 2);
    await expectStatus(page, "saved");
    const hexagon = liveElements(await stored(request, source.id)).find((e) => e.type === "line");

    await page.keyboard.press("Space");
    await expect.poll(() => pathOf(page)).toBe(source.viewId);
    const { width, height } = page.viewportSize();
    const icon = { x: width / 2 + hexagon.width / 2 + 7, y: height / 2 - hexagon.height / 2 - 9 };
    await page.mouse.move(icon.x - 30, icon.y + 30);
    await page.mouse.move(icon.x, icon.y, { steps: 4 });
    await page.mouse.click(icon.x, icon.y);

    await page.waitForURL(`**/${target.viewId}`);
    await expect(page.locator(".diagram-title--readonly")).toHaveText("Target");
    await expect(editButton(page)).toBeVisible();
    await editButton(page).click();
    await expect.poll(() => pathOf(page)).toBe(target.id);
  });
});
