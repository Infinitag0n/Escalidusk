import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const newId = () => randomUUID();

/** Opens a diagram (or a brand-new one when no id is given) and returns its id. */
export async function openDiagram(page, id) {
  await page.goto(id ? `/${id}` : "/");
  await page.waitForSelector(".excalidraw canvas");
  return new URL(page.url()).pathname.slice(1);
}

/** The stored diagram as the API returns it, or null if it does not exist. */
export async function stored(request, id) {
  const response = await request.get(`/api/diagrams/${id}`);
  return response.ok() ? response.json() : null;
}

export function liveElements(diagram) {
  return diagram ? diagram.scene.elements.filter((element) => !element.isDeleted) : [];
}

/** Waits until the server holds exactly `count` non-deleted elements for the diagram. */
export async function expectStoredCount(request, id, count) {
  await expect
    .poll(async () => liveElements(await stored(request, id)).length, { timeout: 15_000 })
    .toBe(count);
}

export async function expectStatus(page, status) {
  await expect(page.locator(".save-status")).toHaveAttribute("data-status", status, {
    timeout: 15_000,
  });
}

/** Creates a diagram directly through the API. Returns `{ id, viewId, version }`. */
export async function seedDiagram(request, { elements = [], appState = {} } = {}) {
  const id = newId();
  const response = await request.put(`/api/diagrams/${id}`, {
    data: { baseVersion: 0, elements, appState },
  });
  expect(response.ok()).toBe(true);
  return { id, ...(await response.json()) };
}

/** A complete rectangle element, for seeding diagrams without drawing. */
export function rectangle(overrides = {}) {
  return {
    id: randomUUID().slice(0, 8),
    type: "rectangle",
    x: 300,
    y: 300,
    width: 200,
    height: 120,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: "a0",
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...overrides,
  };
}

/** Draws a rectangle with the mouse, starting at (x, y). */
export async function drawRectangle(page, x, y) {
  // The radio input sits under its icon, so a normal click is intercepted.
  await page.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 80, { steps: 5 });
  await page.mouse.up();
}

/** Drops a small generated PNG onto the canvas, as if dragged in from the desktop. */
export async function dropImage(page, x, y) {
  await page.evaluate(
    async ({ x, y }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d");
      context.fillStyle = "#e8590c";
      context.fillRect(0, 0, 64, 64);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "square.png", { type: "image/png" }));
      const target =
        document.querySelector(".excalidraw canvas.interactive") ??
        document.querySelector(".excalidraw");
      target.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: transfer,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { x, y },
  );
}

export const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

/** Left edge and width of everything in the top-right corner, to detect layout shifts. */
export const topBarLayout = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".top-pill, .sidebar-trigger")]
      .map((element) => {
        const box = element.getBoundingClientRect();
        return `${Math.round(box.left)}/${Math.round(box.width)}`;
      })
      .join(" "),
  );

/** The text currently visible inside a fixed-width pill (which holds several stacked texts). */
export const visibleText = (locator) =>
  locator.evaluate((element) =>
    [...element.children]
      .filter((child) => getComputedStyle(child).visibility === "visible")
      .map((child) => child.textContent.trim())
      .join("|"),
  );

/** Tells the app its tab regained focus, which makes it check the server for changes. */
export const refocus = (page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));

/**
 * Opens a raw live-collaboration connection, introduces itself, and collects
 * the messages it receives. `user` is the private user id to introduce as.
 */
export async function connectLive(baseURL, id, { name = "Test", user = randomUUID() } = {}) {
  const socket = new WebSocket(`${baseURL.replace("http", "ws")}/api/diagrams/${id}/live`);
  const messages = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  socket.send(JSON.stringify({ t: "hello", user, name }));
  await expect.poll(() => messages.some((message) => message.t === "welcome")).toBe(true);
  return {
    socket,
    user,
    messages,
    welcome: messages.find((message) => message.t === "welcome"),
    of: (type) => messages.filter((message) => message.t === type),
    send: (message) => socket.send(JSON.stringify(message)),
  };
}

/** Opens a raw connection, sends `first` (if any) and resolves with the code it gets closed with. */
export function liveCloseCode(baseURL, id, first) {
  const socket = new WebSocket(`${baseURL.replace("http", "ws")}/api/diagrams/${id}/live`);
  return new Promise((resolve) => {
    socket.addEventListener("open", () => first !== undefined && socket.send(first));
    socket.addEventListener("close", (event) => resolve(event.code));
    socket.addEventListener("error", () => {});
  });
}
