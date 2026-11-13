import { expect, test } from "@playwright/test";
import { openDiagram, rectangle, seedDiagram } from "./helpers.js";

test("a link to another diagram opens it in the same tab", async ({
  context,
  page,
  request,
  baseURL,
}) => {
  const target = await seedDiagram(request, {
    elements: [rectangle()],
    appState: { name: "Target diagram" },
  });
  const source = await seedDiagram(request, {
    elements: [rectangle({ link: `${baseURL}/${target.id}` })],
    appState: { name: "Source diagram" },
  });

  await openDiagram(page, source.id);
  await expect(page).toHaveTitle("Source diagram - Escalidusk");

  // The diagram is centred on load, so the rectangle is in the middle of the canvas.
  const { width, height } = page.viewportSize();
  await page.mouse.click(width / 2, height / 2);
  await page.locator(".excalidraw-hyperlinkContainer-link").click();

  await page.waitForURL(`${baseURL}/${target.id}`);
  await expect(page).toHaveTitle("Target diagram - Escalidusk");
  expect(context.pages()).toHaveLength(1);
});
