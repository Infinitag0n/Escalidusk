import { expect, test } from "@playwright/test";
import {
  connectLive,
  drawRectangle,
  dropImage,
  expectStatus,
  expectStoredCount,
  liveCloseCode,
  liveElements,
  openDiagram,
  rectangle,
  seedDiagram,
  stored,
} from "./helpers.js";

const title = (page) => page.getByLabel("Diagram name");

/**
 * Counts pixels the scene has drawn inside a region of the page: dark ones
 * (shape outlines) by default, or orange ones (the test image) with "orange".
 */
function inkIn(page, { x, y, width, height }, colour = "dark") {
  return page.evaluate(
    ({ x, y, width, height, colour }) => {
      const canvas = document.querySelector("canvas.excalidraw__canvas.static");
      const scale = canvas.width / canvas.getBoundingClientRect().width;
      const { data } = canvas
        .getContext("2d")
        .getImageData(x * scale, y * scale, width * scale, height * scale);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a === 0) continue;
        if (colour === "orange" ? r > 200 && g > 50 && g < 130 && b < 60 : r + g + b < 300) count++;
      }
      return count;
    },
    { x, y, width, height, colour },
  );
}

/** Records every request a page makes for the diagram itself after this call. */
function watchDiagramRequests(page, id) {
  const seen = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/diagrams/${id}`) seen.push(request.method());
  });
  return seen;
}

function watchConflicts(...pages) {
  const conflicts = [];
  for (const page of pages) {
    page.on("response", (response) => response.status() === 409 && conflicts.push(response.url()));
  }
  return conflicts;
}

const REGION = { x: 280, y: 230, width: 170, height: 130 }; // around drawRectangle(page, 300, 250)

test("a drawing appears on another editor's screen as it happens", async ({
  context,
  page,
  request,
}) => {
  const { id } = await seedDiagram(request);
  const other = await context.newPage();
  await openDiagram(page, id);
  await openDiagram(other, id);
  await expect(other.locator(".UserList")).toBeVisible(); // both are connected
  expect(await inkIn(other, REGION)).toBe(0);
  const otherRequests = watchDiagramRequests(other, id);

  await drawRectangle(page, 300, 250);

  await expect.poll(() => inkIn(other, REGION), { timeout: 5000 }).toBeGreaterThan(0);
  // It arrived over the live connection, not by fetching the saved diagram.
  expect(otherRequests).toEqual([]);
});

test("someone on a read-only link follows along live", async ({ context, page, request }) => {
  const { id, viewId } = await seedDiagram(request, { appState: { name: "Before" } });
  const viewer = await context.newPage();
  await openDiagram(viewer, viewId);
  await openDiagram(page, id);
  await expect(viewer.locator(".UserList")).toBeVisible();
  const viewerRequests = watchDiagramRequests(viewer, viewId);

  await drawRectangle(page, 300, 250);
  await expect.poll(() => inkIn(viewer, REGION), { timeout: 5000 }).toBeGreaterThan(0);

  await title(page).fill("After");
  await expect(viewer.locator(".diagram-title--readonly")).toHaveText("After");
  await expect(viewer).toHaveTitle("After - Escalidusk");

  // The viewer never fetched the diagram again and never tried to save.
  await expectStatus(page, "saved");
  expect(viewerRequests).toEqual([]);
});

test("a rename shows up for the other editor without a refresh", async ({
  context,
  page,
  request,
}) => {
  const { id } = await seedDiagram(request, { elements: [rectangle()], appState: { name: "Old" } });
  const other = await context.newPage();
  await openDiagram(page, id);
  await openDiagram(other, id);
  await expect(other.locator(".UserList")).toBeVisible();

  await title(page).fill("New name");
  await expect(title(other)).toHaveValue("New name");
});

test("two editors drawing in turn lose nothing and never conflict", async ({
  context,
  page,
  request,
}) => {
  const { id } = await seedDiagram(request);
  const other = await context.newPage();
  await openDiagram(page, id);
  await openDiagram(other, id);
  await expect(other.locator(".UserList")).toBeVisible();
  const conflicts = watchConflicts(page, other);

  await drawRectangle(page, 300, 250);
  await expectStoredCount(request, id, 1);
  await expectStatus(page, "saved");

  await drawRectangle(other, 700, 450);
  await expectStoredCount(request, id, 2);
  await expectStatus(other, "saved");

  await drawRectangle(page, 300, 500);
  await expectStoredCount(request, id, 3);
  await expectStatus(page, "saved");

  // Each save was accepted first time: the other editor already knew the new version.
  expect(conflicts).toEqual([]);

  // And nobody re-saves what a collaborator already saved (the fallback delay is 5-7s).
  const { version } = await stored(request, id);
  await page.waitForTimeout(8000);
  const after = await stored(request, id);
  expect(after.version).toBe(version);
  expect(liveElements(after)).toHaveLength(3);
});

test("two editors drawing at the same moment both keep both drawings", async ({
  context,
  page,
  request,
}) => {
  const { id } = await seedDiagram(request);
  const other = await context.newPage();
  await openDiagram(page, id);
  await openDiagram(other, id);
  await expect(other.locator(".UserList")).toBeVisible();

  await Promise.all([drawRectangle(page, 300, 250), drawRectangle(other, 700, 450)]);

  const second = { x: 680, y: 430, width: 170, height: 130 }; // around drawRectangle(other, 700, 450)
  for (const screen of [page, other]) {
    await expect.poll(() => inkIn(screen, REGION), { timeout: 5000 }).toBeGreaterThan(0);
    await expect.poll(() => inkIn(screen, second), { timeout: 5000 }).toBeGreaterThan(0);
  }
  await expectStoredCount(request, id, 2);
  await expectStatus(page, "saved");
  await expectStatus(other, "saved");

  // Whatever order the saves landed in, things settle instead of saving back and forth.
  await page.waitForTimeout(8000);
  const { version } = await stored(request, id);
  await page.waitForTimeout(3000);
  const after = await stored(request, id);
  expect(after.version).toBe(version);
  expect(liveElements(after)).toHaveLength(2);
});

test("an editor can share a diagram whose first save was made by a collaborator", async ({
  context,
  page,
  request,
  baseURL,
}) => {
  const id = await openDiagram(page); // brand new, nothing stored
  const other = await context.newPage();
  await openDiagram(other, id);
  await expect(page.locator(".UserList")).toBeVisible();
  const share = page.getByRole("button", { name: "Share", exact: true });
  await expect(share).toBeDisabled();

  await drawRectangle(other, 300, 250);
  await expectStoredCount(request, id, 1);

  await expect(share).toBeEnabled();
  await share.click();
  const { viewId } = await stored(request, id);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${baseURL}/${viewId}`,
  );
});

test.describe("on a narrower window", () => {
  test.use({ viewport: { width: 1100, height: 700 } });

  test("the name never runs under the toolbar when collaborators crowd the top bar", async ({
    context,
    page,
    request,
  }) => {
    const { id } = await seedDiagram(request, {
      elements: [rectangle()],
      appState: { name: "A diagram with quite a long name to make the point" },
    });
    await openDiagram(page, id);
    const field = page.getByLabel("Diagram name");
    const fits = async () => {
      const toolbar = await page.locator(".App-toolbar").first().boundingBox();
      const box = await field.boundingBox();
      const hidden = await field.evaluate((element) => getComputedStyle(element).visibility === "hidden");
      return hidden || box.x + box.width <= toolbar.x;
    };
    expect(await fits()).toBe(true);

    const other = await context.newPage();
    await openDiagram(other, id);
    await expect(page.locator(".UserList")).toBeVisible();
    await expect.poll(fits).toBe(true);
  });
});

test.describe("someone on a read-only link", () => {
  /** Collects the pointer messages a page receives over its live connection. */
  function watchPointers(page) {
    const pointers = [];
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(payload);
        if (message.t === "pointer") pointers.push(message);
      }),
    );
    return pointers;
  }

  test("shows their cursor to the editors", async ({ context, page, request }) => {
    const { id, viewId } = await seedDiagram(request, { elements: [rectangle()] });
    const pointers = watchPointers(page);
    await openDiagram(page, id);
    const viewer = await context.newPage();
    await openDiagram(viewer, viewId);
    await expect(page.locator(".UserList")).toBeVisible();

    await viewer.mouse.move(400, 400);
    await viewer.mouse.move(500, 450, { steps: 10 });
    await expect.poll(() => pointers.length).toBeGreaterThan(0);
    expect(pointers.at(-1)).toMatchObject({ tool: "pointer" });
  });

  test("can use the laser pointer, from a button or with K, and still cannot edit", async ({
    context,
    page,
    request,
  }) => {
    const { id, viewId, version } = await seedDiagram(request, { elements: [rectangle()] });
    const pointers = watchPointers(page);
    await openDiagram(page, id);
    const viewer = await context.newPage();
    const saves = [];
    viewer.on("request", (r) => r.method() === "PUT" && saves.push(r.url()));
    await openDiagram(viewer, viewId);
    await expect(page.locator(".UserList")).toBeVisible();

    const laser = viewer.getByRole("button", { name: "Laser" });
    await expect(laser).toHaveAttribute("aria-pressed", "false");
    await laser.click();
    await expect(laser).toHaveAttribute("aria-pressed", "true");

    await viewer.mouse.move(400, 400);
    await viewer.mouse.down();
    await viewer.mouse.move(600, 500, { steps: 10 });
    await viewer.mouse.up();
    // The editor is sent the stroke: several points while drawing, then the release.
    await expect
      .poll(() => pointers.filter((p) => p.tool === "laser" && p.button === "down").length)
      .toBeGreaterThan(3);
    await expect.poll(() => pointers.at(-1)).toMatchObject({ tool: "laser", button: "up" });
    // The drag drew a stroke; it did not pan the viewer's canvas.
    expect(await inkIn(viewer, { x: 500, y: 320, width: 280, height: 160 })).toBeGreaterThan(0);

    // K switches it off and on again, and the button follows.
    await viewer.keyboard.press("k");
    await expect(laser).toHaveAttribute("aria-pressed", "false");
    await viewer.keyboard.press("k");
    await expect(laser).toHaveAttribute("aria-pressed", "true");
    await laser.click();
    await expect(laser).toHaveAttribute("aria-pressed", "false");

    await viewer.waitForTimeout(2500); // longer than the autosave delay
    expect(saves).toEqual([]);
    expect((await stored(request, id)).version).toBe(version);
  });

  test("keeps the diagram's name in view when other people join", async ({
    context,
    page,
    request,
  }) => {
    const { id, viewId } = await seedDiagram(request, {
      elements: [rectangle()],
      appState: { name: "Roadmap" },
    });
    await openDiagram(page, viewId);
    const label = page.locator(".diagram-title--readonly");
    await expect(label).toBeVisible();

    const editor = await context.newPage();
    await openDiagram(editor, id);
    await expect(page.locator(".UserList")).toBeVisible();
    await expect(label).toBeVisible();
    await expect(label).toHaveText("Roadmap");
    // And it stops short of the avatars.
    const avatars = await page.locator(".UserList").boundingBox();
    const box = await label.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(avatars.x);
  });

  test("an editor's page has no separate laser button; the toolbar has its own", async ({
    page,
    request,
  }) => {
    const { id } = await seedDiagram(request, { elements: [rectangle()] });
    await openDiagram(page, id);
    await expect(page.locator(".laser-button")).toHaveCount(0);
  });
});

test("an editor's cursor position is shared with the others", async ({
  context,
  page,
  request,
}) => {
  const { id } = await seedDiagram(request, { elements: [rectangle()] });
  const pointers = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(payload);
      if (message.t === "pointer") pointers.push(message);
    }),
  );
  await openDiagram(page, id);
  const other = await context.newPage();
  await openDiagram(other, id);
  await expect(page.locator(".UserList")).toBeVisible();

  await other.mouse.move(400, 400);
  await other.mouse.move(500, 450, { steps: 10 });
  await expect.poll(() => pointers.length).toBeGreaterThan(0);
  expect(pointers.at(-1)).toMatchObject({ tool: "pointer", button: "up" });
});

test("an image dropped by one editor shows up for the other", async ({
  context,
  page,
  request,
}) => {
  const { id } = await seedDiagram(request);
  const other = await context.newPage();
  await openDiagram(page, id);
  await openDiagram(other, id);
  await expect(other.locator(".UserList")).toBeVisible();

  const canvasArea = { x: 0, y: 100, width: 1280, height: 600 };
  expect(await inkIn(other, canvasArea, "orange")).toBe(0);

  // The element arrives at once; the picture itself follows when the upload has finished.
  await dropImage(page, 650, 300);
  await expect
    .poll(() => inkIn(other, canvasArea, "orange"), { timeout: 15_000 })
    .toBeGreaterThan(1000);
});

test("other people are shown while present and removed when they leave", async ({
  context,
  page,
  request,
}) => {
  const { id, viewId } = await seedDiagram(request, { elements: [rectangle()] });
  await openDiagram(page, id);
  await expect(page.locator(".UserList")).toHaveCount(0);

  // Someone on the read-only link is present like anyone else.
  const viewer = await context.newPage();
  await openDiagram(viewer, viewId);
  await expect(page.locator(".UserList")).toBeVisible();
  await expect(viewer.locator(".UserList")).toBeVisible();

  await viewer.close();
  await expect(page.locator(".UserList")).toHaveCount(0);

  const other = await context.newPage();
  await openDiagram(other, id);
  await expect(page.locator(".UserList")).toBeVisible();
  await other.close();
  await expect(page.locator(".UserList")).toHaveCount(0);
});

test.describe("live connection rules", () => {
  const connect = (baseURL, id, name) => connectLive(baseURL, id, { name });

  test("everyone hears each other, but a read-only connection cannot change the diagram", async ({
    request,
    baseURL,
  }) => {
    const { id, viewId } = await seedDiagram(request, { elements: [rectangle()] });
    const editor = await connect(baseURL, id, "Editor");
    const viewer = await connect(baseURL, viewId, "Viewer");
    const second = await connect(baseURL, id, "Second");

    expect(second.of("welcome")[0].peers.map((peer) => [peer.name, peer.readOnly])).toEqual([
      ["Editor", false],
      ["Viewer", true],
    ]);

    // A viewer's diagram change goes nowhere; their cursor and laser are shared.
    viewer.socket.send(JSON.stringify({ t: "update", elements: [{ id: "evil", version: 99 }] }));
    viewer.socket.send(JSON.stringify({ t: "pointer", x: 1, y: 2, tool: "laser", button: "down" }));
    // What an editor sends reaches everyone else, viewers included.
    editor.socket.send(JSON.stringify({ t: "update", elements: [{ id: "good", version: 1 }] }));

    await expect.poll(() => second.of("update").length).toBe(1);
    await expect.poll(() => viewer.of("update").length).toBe(1);
    expect(second.of("update")[0].elements).toEqual([{ id: "good", version: 1 }]);
    expect(editor.of("update")).toEqual([]);
    for (const connection of [editor, second]) {
      await expect.poll(() => connection.of("pointer").length).toBe(1);
      expect(connection.of("pointer")[0]).toMatchObject({ x: 1, y: 2, tool: "laser", button: "down" });
    }

    // Nothing a viewer receives contains the editing id.
    expect(JSON.stringify(viewer.messages)).not.toContain(id);

    for (const { socket } of [editor, viewer, second]) socket.close();
  });

  test("everyone on a diagram is told when a save lands", async ({ request, baseURL }) => {
    const { id, viewId } = await seedDiagram(request);
    const editor = await connect(baseURL, id);
    const viewer = await connect(baseURL, viewId);

    await request.put(`/api/diagrams/${id}`, {
      data: { baseVersion: 1, key: "fingerprint", elements: [] },
    });
    for (const connection of [editor, viewer]) {
      await expect.poll(() => connection.of("saved")).toEqual([
        { t: "saved", version: 2, key: "fingerprint", viewId },
      ]);
    }
    editor.socket.close();
    viewer.socket.close();
  });

  test("malformed messages are ignored and a bad id is refused", async ({ request, baseURL }) => {
    const { id } = await seedDiagram(request);
    const one = await connect(baseURL, id);
    const two = await connect(baseURL, id);
    for (const junk of ["not json", "[]", '{"t":"update"}', '{"t":"pointer","x":"a","y":1}']) {
      one.socket.send(junk);
    }
    one.socket.send(JSON.stringify({ t: "pointer", x: 5, y: 6, tool: "weird", button: "down" }));
    await expect.poll(() => two.of("pointer").length).toBe(1);
    expect(two.of("pointer")[0]).toMatchObject({ x: 5, y: 6, tool: "pointer", button: "down" });
    expect(two.of("update")).toEqual([]);
    one.socket.close();
    two.socket.close();

    expect(await liveCloseCode(baseURL, "nope")).toBe(1008);
  });
});
