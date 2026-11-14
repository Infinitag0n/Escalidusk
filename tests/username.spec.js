import { expect, test } from "@playwright/test";
import { connectLive, openDiagram, rectangle, seedDiagram } from "./helpers.js";

const nameField = (page) => page.getByLabel("Your name");
const storedName = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("escalidusk:username")));

test("your name sits in the bottom-right corner, before the help button, as plain text", async ({
  page,
}) => {
  await openDiagram(page);
  const field = nameField(page);
  await expect(field).toHaveValue(/^Guest \d{3}$/);

  const look = await field.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.borderTopWidth, style.backgroundColor, style.boxShadow, style.outlineStyle].join(";");
  });
  expect(look).toBe("0px;rgba(0, 0, 0, 0);none;none");

  const help = await page.locator(".help-icon").boundingBox();
  const box = await field.boundingBox();
  const { width, height } = page.viewportSize();
  expect(box.x).toBeGreaterThan(width / 2);
  expect(box.y).toBeGreaterThan(height / 2);
  expect(box.x + box.width).toBeLessThanOrEqual(help.x);
  expect(help.x - (box.x + box.width)).toBeLessThan(24);
  expect(Math.abs(box.y + box.height / 2 - (help.y + help.height / 2))).toBeLessThanOrEqual(2);
});

test("the name is kept in the browser and reused for every diagram", async ({ page }) => {
  await openDiagram(page);
  const generated = await nameField(page).inputValue();
  expect(await storedName(page)).toBe(generated);

  await nameField(page).fill("Ruben");
  await nameField(page).press("Enter");
  await expect(nameField(page)).not.toBeFocused();
  expect(await storedName(page)).toBe("Ruben");

  await page.reload();
  await page.waitForSelector(".excalidraw canvas");
  await expect(nameField(page)).toHaveValue("Ruben");

  await openDiagram(page); // a different, new diagram
  await expect(nameField(page)).toHaveValue("Ruben");
});

test("clearing the name falls back to the previous one", async ({ page }) => {
  await openDiagram(page);
  await nameField(page).fill("Ruben");
  await nameField(page).fill("   ");
  await nameField(page).press("Enter");
  await expect(nameField(page)).toHaveValue("Ruben");
  expect(await storedName(page)).toBe("Ruben");
});

test("typing a name does not trigger drawing shortcuts", async ({ page }) => {
  await openDiagram(page);
  await nameField(page).click();
  await nameField(page).fill("");
  await page.keyboard.type("r2d2 rectangle");
  await expect(nameField(page)).toHaveValue("r2d2 rectangle");
  await expect(page.locator('[data-testid="toolbar-selection"]')).toBeChecked();
});

test("a read-only page has the name field too", async ({ page, request }) => {
  const { viewId } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, viewId);
  await expect(nameField(page)).toHaveValue(/^Guest \d{3}$/);
  await nameField(page).fill("Onlooker");
  await nameField(page).press("Enter");
  expect(await storedName(page)).toBe("Onlooker");
});

test("other editors see a new name straight away, and so does anyone joining later", async ({
  browser,
  request,
  baseURL,
}) => {
  const { id } = await seedDiagram(request, { elements: [rectangle()] });
  // Separate browser profiles, so each person has their own stored name.
  const first = await (await browser.newContext()).newPage();
  const second = await (await browser.newContext()).newPage();

  const renames = [];
  second.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(payload);
      if (message.t === "name") renames.push(message.name);
    }),
  );
  await openDiagram(first, id);
  await openDiagram(second, id);
  await expect(second.locator(".UserList")).toBeVisible();

  await nameField(first).fill("Zoe");
  await expect.poll(() => renames.at(-1)).toBe("Zoe");

  // Someone connecting afterwards is told the current name, not the original.
  const late = await connectLive(baseURL, id, { name: "Late" });
  late.socket.close();
  expect(late.welcome.peers.map((peer) => peer.name)).toContain("Zoe");

  await first.context().close();
  await second.context().close();
});
