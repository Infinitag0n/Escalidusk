import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { createAddressHasher } from "../server/address.js";
import { openStore } from "../server/store.js";
import {
  connectLive,
  drawRectangle,
  expectStoredCount,
  liveCloseCode,
  newId,
  openDiagram,
  rectangle,
  seedDiagram,
} from "./helpers.js";

const HASH_RE = /^[0-9a-f]{32}$/;
const freshDir = () => mkdtempSync(path.join(tmpdir(), "escalidusk-store-"));

/** Runs a read-only query against the database of the server under test. */
function query(sql, ...params) {
  const db = new DatabaseSync(path.join(process.env.ESCALIDUSK_TEST_DATA, "escalidusk.db"), {
    readOnly: true,
  });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

test.describe("address hashing", () => {
  const hash = createAddressHasher("secret-one");

  test("gives the same hash for the same address, in either notation", () => {
    expect(hash("203.0.113.7")).toMatch(HASH_RE);
    expect(hash("203.0.113.7")).toBe(hash("203.0.113.7"));
    expect(hash("::ffff:203.0.113.7")).toBe(hash("203.0.113.7"));
    expect(hash("2001:DB8::1")).toBe(hash("2001:db8::1"));
  });

  test("differs between addresses and between secrets, and hides the address", () => {
    expect(hash("203.0.113.8")).not.toBe(hash("203.0.113.7"));
    expect(createAddressHasher("secret-two")("203.0.113.7")).not.toBe(hash("203.0.113.7"));
    expect(hash("203.0.113.7")).not.toContain("203");
    expect(hash(undefined)).toBeUndefined();
  });
});

test.describe("user store", () => {
  test("gives each user a public id unrelated to their private one, and keeps it", () => {
    const store = openStore(freshDir());
    const id = randomUUID();
    const first = store.seeUser({ id, name: "Ada" });
    expect(first.publicId).not.toBe(id);
    expect(store.seeUser({ id }).publicId).toBe(first.publicId);
    expect(store.seeUser({ id: randomUUID(), name: "Bob" }).publicId).not.toBe(first.publicId);
    store.close();
  });

  test("follows renames and remembers users across restarts", () => {
    const dir = freshDir();
    const id = randomUUID();
    let store = openStore(dir);
    const { publicId } = store.seeUser({ id, name: "Ada" });
    store.seeUser({ id, name: "Ada Lovelace" });
    store.seeUser({ id }); // no name given: keeps the current one
    store.close();

    store = openStore(dir);
    expect(store.seeUser({ id }).publicId).toBe(publicId);
    store.close();

    const db = new DatabaseSync(path.join(dir, "escalidusk.db"), { readOnly: true });
    expect(db.prepare("SELECT display_name FROM users WHERE id = ?").get(id).display_name).toBe(
      "Ada Lovelace",
    );
    db.close();
  });

  test("links a user to every hashed address they were seen from, and forgets old links", async () => {
    const dir = freshDir();
    const store = openStore(dir);
    const id = randomUUID();
    store.seeUser({ id, name: "Ada", addressHash: "a".repeat(32) });
    store.seeUser({ id, addressHash: "a".repeat(32) });
    store.seeUser({ id, addressHash: "b".repeat(32) });
    store.seeUser({ id: randomUUID(), name: "Bob", addressHash: "a".repeat(32) });

    const db = new DatabaseSync(path.join(dir, "escalidusk.db"), { readOnly: true });
    const links = () =>
      db.prepare("SELECT address_hash FROM user_addresses WHERE user_id = ? ORDER BY 1").all(id);
    expect(links().map((row) => row.address_hash)).toEqual(["a".repeat(32), "b".repeat(32)]);
    // Two users behind one address are both linked to it.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM user_addresses WHERE address_hash = ?").get("a".repeat(32)).n,
    ).toBe(2);

    expect(store.pruneAddresses(30)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.pruneAddresses(0)).toBe(3);
    expect(links()).toEqual([]);
    db.close();
    store.close();
  });

  test("records who created and who last edited a diagram", () => {
    const dir = freshDir();
    const store = openStore(dir);
    const [diagram, ada, bob] = [randomUUID(), randomUUID(), randomUUID()];
    store.saveDiagram(diagram, 0, "{}", ada);
    store.saveDiagram(diagram, 1, "{}", bob);
    store.saveDiagram(diagram, 2, "{}"); // an anonymous save does not erase the last known editor

    const db = new DatabaseSync(path.join(dir, "escalidusk.db"), { readOnly: true });
    expect(db.prepare("SELECT created_by, updated_by, version FROM diagrams").get()).toEqual({
      created_by: ada,
      updated_by: bob,
      version: 3,
    });
    db.close();
    store.close();
  });

  test("keeps the same address secret across restarts", () => {
    const dir = freshDir();
    let store = openStore(dir);
    const secret = store.addressSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    store.close();
    store = openStore(dir);
    expect(store.addressSecret()).toBe(secret);
    store.close();
  });

  test("upgrades a database made before users existed", () => {
    const dir = freshDir();
    const old = new DatabaseSync(path.join(dir, "escalidusk.db"));
    old.exec(`
      CREATE TABLE diagrams (id TEXT PRIMARY KEY, version INTEGER NOT NULL, scene TEXT NOT NULL,
                             created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO diagrams VALUES ('${"1".repeat(8)}-2222-4333-8444-${"5".repeat(12)}', 4, '{"elements":[]}', 1, 1);
    `);
    old.close();

    const store = openStore(dir);
    const found = store.findDiagram(`${"1".repeat(8)}-2222-4333-8444-${"5".repeat(12)}`);
    expect(found.row.version).toBe(4);
    expect(found.row.viewId).toBeTruthy();
    const user = randomUUID();
    expect(store.saveDiagram(found.row.id, 4, "{}", user).ok).toBe(true);
    store.close();
  });
});

test.describe("identity on the server", () => {
  test("a save records the user, the editor and a hashed address only", async ({ request }) => {
    const [id, user] = [newId(), newId()];
    const save = await request.put(`/api/diagrams/${id}`, {
      headers: { "X-User-Id": user },
      data: { baseVersion: 0, elements: [] },
    });
    expect(save.ok()).toBe(true);

    expect(query("SELECT created_by, updated_by FROM diagrams WHERE id = ?", id)).toEqual([
      { created_by: user, updated_by: user },
    ]);
    const [row] = query("SELECT public_id, display_name FROM users WHERE id = ?", user);
    expect(row.display_name).toBe("Guest");
    expect(row.public_id).not.toBe(user);

    const addresses = query("SELECT address_hash FROM user_addresses WHERE user_id = ?", user);
    expect(addresses).toHaveLength(1);
    expect(addresses[0].address_hash).toMatch(HASH_RE);
    // Nothing in the database holds an address in the clear.
    expect(query("SELECT COUNT(*) AS n FROM user_addresses WHERE address_hash LIKE '%.%' OR address_hash LIKE '%:%'")[0].n).toBe(0);
  });

  test("a save without a valid user id still works and records nobody", async ({ request }) => {
    const id = newId();
    const save = await request.put(`/api/diagrams/${id}`, {
      headers: { "X-User-Id": "not-a-uuid" },
      data: { baseVersion: 0, elements: [] },
    });
    expect(save.ok()).toBe(true);
    expect(query("SELECT created_by FROM diagrams WHERE id = ?", id)).toEqual([{ created_by: null }]);
    expect(query("SELECT COUNT(*) AS n FROM users WHERE id = 'not-a-uuid'")[0].n).toBe(0);
  });

  test("a live connection must introduce itself with a valid user id first", async ({
    request,
    baseURL,
  }) => {
    const { id } = await seedDiagram(request);
    expect(await liveCloseCode(baseURL, id, JSON.stringify({ t: "update", elements: [] }))).toBe(1008);
    expect(await liveCloseCode(baseURL, id, JSON.stringify({ t: "hello", user: "nope" }))).toBe(1008);
    expect(await liveCloseCode(baseURL, id, "not json")).toBe(1008);
  });

  test("others see a public id; the private id is never sent to anyone", async ({
    request,
    baseURL,
  }) => {
    const { id, viewId } = await seedDiagram(request);
    const ada = await connectLive(baseURL, id, { name: "Ada" });
    const adaAgain = await connectLive(baseURL, id, { name: "Ada", user: ada.user });
    const bob = await connectLive(baseURL, id, { name: "Bob" });
    const viewer = await connectLive(baseURL, viewId, { name: "Vi" });

    // The same person on two connections has one public id.
    const peers = bob.welcome.peers;
    expect(peers).toHaveLength(2);
    expect(peers[0].user).toBe(peers[1].user);
    expect(peers[0].user).toBe(ada.welcome.user);
    expect(peers[0].user).not.toBe(ada.user);
    expect(peers[0].id).not.toBe(peers[1].id);
    expect(bob.welcome.user).not.toBe(ada.welcome.user);

    ada.send({ t: "name", name: "Ada L." });
    ada.send({ t: "pointer", x: 1, y: 2 });
    await expect.poll(() => bob.of("pointer").length).toBe(1);

    const everythingOthersSaw = JSON.stringify([adaAgain.messages, bob.messages, viewer.messages]);
    for (const secret of [ada.user, bob.user, viewer.user]) {
      expect(everythingOthersSaw).not.toContain(secret);
    }
    expect(JSON.stringify(ada.messages)).not.toContain(bob.user);

    // The public id handed out matches what the database holds for that user.
    expect(query("SELECT public_id FROM users WHERE id = ?", ada.user)).toEqual([
      { public_id: ada.welcome.user },
    ]);
    for (const { socket } of [ada, adaAgain, bob, viewer]) socket.close();
  });

  test("renames are recorded and announced, for viewers too", async ({
    request,
    baseURL,
  }) => {
    const { id, viewId } = await seedDiagram(request);
    const editor = await connectLive(baseURL, id, { name: "Before" });
    const viewer = await connectLive(baseURL, viewId, { name: "Watcher" });
    const nameOf = (user) => query("SELECT display_name FROM users WHERE id = ?", user)[0]?.display_name;
    expect(nameOf(editor.user)).toBe("Before");
    expect(nameOf(viewer.user)).toBe("Watcher");

    editor.send({ t: "name", name: "After" });
    viewer.send({ t: "name", name: "Still watching" });
    await expect.poll(() => nameOf(editor.user)).toBe("After");
    await expect.poll(() => nameOf(viewer.user)).toBe("Still watching");

    await expect
      .poll(() => viewer.of("name"))
      .toEqual([{ t: "name", from: editor.welcome.id, name: "After" }]);
    await expect
      .poll(() => editor.of("name"))
      .toEqual([{ t: "name", from: viewer.welcome.id, name: "Still watching" }]);
    editor.socket.close();
    viewer.socket.close();
  });
});

test.describe("identity in the browser", () => {
  const userId = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("escalidusk:user-id")));

  test("a user id is made up once and kept for every diagram", async ({ page }) => {
    await openDiagram(page);
    const id = await userId(page);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    await page.reload();
    await page.waitForSelector(".excalidraw canvas");
    expect(await userId(page)).toBe(id);
    await openDiagram(page);
    expect(await userId(page)).toBe(id);
  });

  test("saves and renames are attributed to that id", async ({ page, request }) => {
    const id = await openDiagram(page);
    const user = await userId(page);
    await drawRectangle(page, 300, 250);
    await expectStoredCount(request, id, 1);
    expect(query("SELECT created_by, updated_by FROM diagrams WHERE id = ?", id)).toEqual([
      { created_by: user, updated_by: user },
    ]);

    await page.getByLabel("Your name").fill("Grace");
    await expect
      .poll(() => query("SELECT display_name FROM users WHERE id = ?", user)[0]?.display_name)
      .toBe("Grace");
  });

  test("a viewer is recorded as a user too", async ({ page, request }) => {
    const { viewId } = await seedDiagram(request, { elements: [rectangle()] });
    await openDiagram(page, viewId);
    const user = await userId(page);
    await expect.poll(() => query("SELECT COUNT(*) AS n FROM users WHERE id = ?", user)[0].n).toBe(1);
  });

  test("one editor's browser is never sent another editor's private id", async ({
    browser,
    request,
  }) => {
    const { id } = await seedDiagram(request, { elements: [rectangle()] });
    const first = await (await browser.newContext()).newPage();
    const second = await (await browser.newContext()).newPage();
    const received = [];
    second.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => received.push(String(payload))),
    );
    second.on("response", async (response) => {
      if (response.url().includes("/api/")) received.push(await response.text().catch(() => ""));
    });

    await openDiagram(first, id);
    await openDiagram(second, id);
    await expect(second.locator(".UserList")).toBeVisible();
    await drawRectangle(first, 300, 450);
    await expectStoredCount(request, id, 2);

    const secret = await userId(first);
    expect(received.length).toBeGreaterThan(0);
    expect(received.join("\n")).not.toContain(secret);
    await first.context().close();
    await second.context().close();
  });
});
