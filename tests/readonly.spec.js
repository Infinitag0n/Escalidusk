import { expect, test } from "@playwright/test";
import { openDiagram, rectangle, seedDiagram, stored } from "./helpers.js";

test("a read-only link shows the diagram without any way to change it", async ({
  page,
  request,
}) => {
  const { id, viewId, version } = await seedDiagram(request, { elements: [rectangle()] });

  const saves = [];
  page.on("request", (r) => r.method() === "PUT" && saves.push(r.url()));
  await openDiagram(page, viewId);

  await expect(page.locator(".save-status")).toHaveText("Read-only");
  await expect(page.locator('[data-testid="toolbar-rectangle"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Share Edit" })).toHaveCount(0);

  // Try to edit anyway: drag on the canvas, select all, delete.
  await page.mouse.move(300, 500);
  await page.mouse.down();
  await page.mouse.move(450, 600, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(2500); // longer than the autosave delay

  expect(saves).toEqual([]);
  expect((await stored(request, id)).version).toBe(version);
});

test("the read-only page never learns the editing id", async ({ page, request }) => {
  const { id, viewId } = await seedDiagram(request, { elements: [rectangle()] });

  const bodies = [];
  page.on("response", async (response) => {
    if (response.url().includes("/api/")) bodies.push(await response.text().catch(() => ""));
  });
  await openDiagram(page, viewId);
  await page.waitForTimeout(500);

  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.join("\n")).not.toContain(id);
  expect(await page.content()).not.toContain(id);
});
