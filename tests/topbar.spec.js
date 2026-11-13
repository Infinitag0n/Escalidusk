import { expect, test } from "@playwright/test";
import {
  clipboard,
  drawRectangle,
  expectStatus,
  expectStoredCount,
  openDiagram,
  rectangle,
  seedDiagram,
  stored,
  topBarLayout,
  visibleText,
} from "./helpers.js";

const SAVE_URL = /\/api\/diagrams\/[0-9a-f-]{36}$/;

test.describe("share buttons", () => {
  test("stay disabled until the diagram has been saved", async ({ page, request }) => {
    const id = await openDiagram(page);
    const share = page.getByRole("button", { name: "Share", exact: true });
    const shareEdit = page.getByRole("button", { name: "Share Edit", exact: true });

    await expect(share).toBeDisabled();
    await expect(shareEdit).toBeDisabled();
    await expect(share).toHaveAttribute("title", "Available once the diagram has been saved");

    await drawRectangle(page, 300, 250);
    await expectStoredCount(request, id, 1);
    await expect(share).toBeEnabled();
    await expect(shareEdit).toBeEnabled();
  });

  test("copy the read-only and the editing link", async ({ page, request, baseURL }) => {
    const { id, viewId } = await seedDiagram(request, { elements: [rectangle()] });
    await openDiagram(page, id);

    await page.locator(".share-button").nth(0).click();
    await expect.poll(() => clipboard(page)).toBe(`${baseURL}/${viewId}`);

    await page.locator(".share-button").nth(1).click();
    await expect.poll(() => clipboard(page)).toBe(`${baseURL}/${id}`);
  });

  test("confirm with 'Copied' without changing the layout", async ({ page, request }) => {
    const { id } = await seedDiagram(request, { elements: [rectangle()] });
    await openDiagram(page, id);
    const share = page.locator(".share-button").nth(0);
    const before = await topBarLayout(page);

    await share.click();
    await expect.poll(() => visibleText(share)).toBe("Copied");
    expect(await topBarLayout(page)).toBe(before);

    await expect.poll(() => visibleText(share), { timeout: 5000 }).toBe("Share");
    expect(await topBarLayout(page)).toBe(before);
  });

  test("a read-only page offers only Share, which copies its own link", async ({
    page,
    request,
    baseURL,
  }) => {
    const { viewId } = await seedDiagram(request, { elements: [rectangle()] });
    await openDiagram(page, viewId);

    await expect(page.locator(".share-button")).toHaveCount(1);
    await page.locator(".share-button").click();
    await expect.poll(() => clipboard(page)).toBe(`${baseURL}/${viewId}`);
  });

  test("share buttons have the same size and shape as the save status", async ({
    page,
    request,
  }) => {
    const { id } = await seedDiagram(request, { elements: [rectangle()] });
    await openDiagram(page, id);
    const shape = (selector) =>
      page.locator(selector).first().evaluate((element) => {
        const style = getComputedStyle(element);
        return [
          Math.round(element.getBoundingClientRect().height),
          style.padding,
          style.borderRadius,
          style.fontSize,
          style.boxShadow,
        ].join(";");
      });
    expect(await shape(".share-button")).toBe(await shape(".save-status"));
  });
});

test.describe("save status", () => {
  test("keeps the same layout in every state, and a failed save stays visible", async ({
    page,
    request,
  }) => {
    const id = await openDiagram(page);

    // Record the visible text and layout each time the status changes.
    await page.evaluate(() => {
      const status = document.querySelector(".save-status");
      window.__seen = {};
      const snapshot = () => {
        const text = [...status.children]
          .filter((child) => getComputedStyle(child).visibility === "visible")
          .map((child) => child.textContent)
          .join("|");
        const layout = [...document.querySelectorAll(".top-pill, .sidebar-trigger")]
          .map((element) => {
            const box = element.getBoundingClientRect();
            return `${Math.round(box.left)}/${Math.round(box.width)}`;
          })
          .join(" ");
        window.__seen[status.dataset.status] = { text, layout };
      };
      snapshot();
      new MutationObserver(snapshot).observe(status, { attributes: true, subtree: true });
    });

    let failing = true;
    let failedAttempts = 0;
    await page.route(SAVE_URL, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      if (failing) {
        failedAttempts++;
        return route.abort();
      }
      await new Promise((resolve) => setTimeout(resolve, 800)); // long enough to see "saving"
      return route.continue();
    });

    await drawRectangle(page, 300, 250);
    await expectStatus(page, "error");

    // Further activity must neither hide the error nor trigger a retry storm.
    for (let i = 0; i < 20; i++) {
      await page.mouse.move(300 + i * 10, 500);
      await page.waitForTimeout(100);
    }
    await expectStatus(page, "error");
    expect(failedAttempts).toBeLessThanOrEqual(2);

    failing = false;
    await expectStatus(page, "saved");
    await expectStoredCount(request, id, 1);

    const seen = await page.evaluate(() => window.__seen);
    expect(Object.fromEntries(Object.entries(seen).map(([key, value]) => [key, value.text]))).toEqual({
      saved: "Saved",
      unsaved: "Unsaved",
      saving: "Saving…",
      error: "Save failed",
    });
    expect(new Set(Object.values(seen).map((value) => value.layout)).size).toBe(1);
  });
});

test("the Library button shows only its icon and still opens the library", async ({ page }) => {
  await openDiagram(page);
  const trigger = page.locator(".sidebar-trigger").first();

  await expect(page.locator(".sidebar-trigger__label").first()).toBeHidden();
  expect((await trigger.boundingBox()).width).toBeLessThan(50);

  await trigger.click({ force: true });
  await expect(page.locator(".sidebar")).toBeVisible();
});

test.describe("phone layout", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("keeps the top bar clear and offers sharing from the menu", async ({
    page,
    request,
    baseURL,
  }) => {
    const { id, viewId } = await seedDiagram(request, { elements: [rectangle()] });
    await openDiagram(page, id);

    await expect(page.locator(".share-button")).toHaveCount(0);
    await expect(page.locator(".diagram-title")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    );

    await page.locator('[data-testid="main-menu-trigger"]').click();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect.poll(() => clipboard(page)).toBe(`${baseURL}/${viewId}`);

    await page.locator('[data-testid="main-menu-trigger"]').click();
    await page.getByRole("button", { name: "Share Edit", exact: true }).click();
    await expect.poll(() => clipboard(page)).toBe(`${baseURL}/${id}`);
  });

  test("menu sharing is disabled before the first save", async ({ page, request }) => {
    const id = await openDiagram(page);
    expect(await stored(request, id)).toBeNull();
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Share Edit", exact: true })).toBeDisabled();
  });
});
