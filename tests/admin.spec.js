import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { openStore } from "../server/store.js";
import {
  connectLive,
  drawRectangle,
  expectStatus,
  liveCloseCode,
  newId,
  openDiagram,
  rectangle,
  seedDiagram,
  stored,
} from "./helpers.js";

// Must match ADMIN_PASSWORD in playwright.config.js.
const PASSWORD = "test-admin-password";
const PNG = Buffer.from("89504e470d0a1a0a66616b6564617461", "hex");

async function signIn(request) {
  const response = await request.post("/api/admin/login", { data: { password: PASSWORD } });
  expect(response.ok()).toBe(true);
  return response;
}

const find = async (request, search) =>
  (await (await request.get("/api/admin/diagrams", { params: { search } })).json()).diagrams;

/** Starts a separate server with its own empty database and the given environment. */
async function startServer(env) {
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: mkdtempSync(path.join(tmpdir(), "escalidusk-admin-")),
      ...env,
    },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  await expect
    .poll(() => fetch(`${url}/api/health`).then((r) => r.ok, () => false), { timeout: 15_000 })
    .toBe(true);
  return { url, stop: () => child.kill() };
}

test.describe("backoffice sign-in", () => {
  test("nothing but the session question is answered without signing in", async ({ request }) => {
    expect(await (await request.get("/api/admin/session")).json()).toEqual({
      enabled: true,
      signedIn: false,
    });
    const { id } = await seedDiagram(request);
    const attempts = [
      request.get("/api/admin/diagrams"),
      request.get("/api/admin/users"),
      request.get("/api/admin/stats"),
      request.delete(`/api/admin/diagrams/${id}`),
      request.post("/api/admin/remove-orphaned-images"),
    ];
    for (const response of await Promise.all(attempts)) expect(response.status()).toBe(401);
    expect(await stored(request, id)).not.toBeNull();
  });

  test("the right password opens a session, kept in a locked-down cookie", async ({ request }) => {
    const wrong = await request.post("/api/admin/login", { data: { password: "guess" } });
    expect(wrong.status()).toBe(401);
    expect(wrong.headers()["set-cookie"]).toBeUndefined();

    const cookie = (await signIn(request)).headers()["set-cookie"];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/admin");
    expect(cookie).not.toContain(PASSWORD);

    expect((await (await request.get("/api/admin/session")).json()).signedIn).toBe(true);
    expect((await request.get("/api/admin/stats")).status()).toBe(200);

    await request.post("/api/admin/logout");
    expect((await request.get("/api/admin/stats")).status()).toBe(401);
  });

  test("answers are never cached", async ({ request }) => {
    await signIn(request);
    const response = await request.get("/api/admin/diagrams");
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("repeated wrong passwords lock sign-in for a while, even for the right one", async () => {
    const server = await startServer({ ADMIN_PASSWORD: PASSWORD });
    try {
      const login = (password) =>
        fetch(`${server.url}/api/admin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
      for (let attempt = 0; attempt < 5; attempt++) expect((await login("guess")).status).toBe(401);

      const locked = await login(PASSWORD);
      expect(locked.status).toBe(429);
      const body = await locked.json();
      expect(body.retryAfter).toBeGreaterThan(0);
      expect(body.retryAfter).toBeLessThanOrEqual(300);
    } finally {
      server.stop();
    }
  });

  test("without a password on the server there is no backoffice at all", async ({ browser }) => {
    const server = await startServer({ ADMIN_PASSWORD: "" });
    try {
      const get = (route, init) => fetch(`${server.url}${route}`, init);
      expect(await (await get("/api/admin/session")).json()).toEqual({
        enabled: false,
        signedIn: false,
      });
      expect((await get("/api/admin/diagrams")).status).toBe(404);
      const login = await get("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "" }),
      });
      expect(login.status).toBe(404);

      const page = await browser.newPage();
      await page.goto(`${server.url}/admin`);
      await expect(page.getByText("The backoffice is switched off")).toBeVisible();
      await page.close();
    } finally {
      server.stop();
    }
  });
});

test.describe("backoffice data", () => {
  test("lists diagrams with who made them and how big they are, and finds them by name or id", async ({
    request,
  }) => {
    const [id, user] = [newId(), newId()];
    const name = `Network plan ${id.slice(0, 8)}`;
    const save = await request.put(`/api/diagrams/${id}`, {
      headers: { "X-User-Id": user },
      data: { baseVersion: 0, elements: [rectangle(), rectangle()], appState: { name } },
    });
    const { viewId } = await save.json();
    await request.put(`/api/diagrams/${id}/files/abc123`, {
      headers: { "Content-Type": "image/png" },
      data: PNG,
    });
    await signIn(request);

    const [byName] = await find(request, name.toLowerCase().slice(3));
    expect(byName).toMatchObject({
      id,
      viewId,
      name,
      version: 1,
      elementCount: 2,
      imageCount: 1,
      imageSize: PNG.length,
      createdBy: "Guest",
      updatedBy: "Guest",
      openNow: 0,
    });
    expect(byName.sceneSize).toBeGreaterThan(100);
    expect((await find(request, id)).map((d) => d.id)).toEqual([id]);
    expect((await find(request, viewId)).map((d) => d.id)).toEqual([id]);
    expect(await find(request, `no such diagram ${randomUUID()}`)).toEqual([]);

    // Listing people never exposes anyone's private id.
    const people = await (await request.get("/api/admin/users", { params: { limit: 200 } })).text();
    expect(people).not.toContain(user);
  });

  test("shows how many connections a diagram has right now", async ({ request, baseURL }) => {
    const { id } = await seedDiagram(request);
    const one = await connectLive(baseURL, id);
    const two = await connectLive(baseURL, id);
    await signIn(request);
    expect((await find(request, id))[0].openNow).toBe(2);
    one.socket.close();
    two.socket.close();
    await expect.poll(async () => (await find(request, id))[0].openNow).toBe(0);
  });

  test("lists people with their activity and how many others share their address", async ({
    request,
    baseURL,
  }) => {
    const { id } = await seedDiagram(request);
    const name = `Ada ${randomUUID().slice(0, 8)}`;
    const ada = await connectLive(baseURL, id, { name });
    const other = await connectLive(baseURL, id, { name: "Someone else" });
    await request.put(`/api/diagrams/${newId()}`, {
      headers: { "X-User-Id": ada.user },
      data: { baseVersion: 0, elements: [] },
    });
    await signIn(request);

    const { users, total } = await (
      await request.get("/api/admin/users", { params: { search: name } })
    ).json();
    expect(total).toBe(1);
    expect(users[0]).toMatchObject({
      publicId: ada.welcome.user,
      name,
      created: 1,
      lastEditorOf: 1,
      addressCount: 1,
    });
    // Every test connection comes from this machine, so Ada shares her address with others.
    expect(users[0].sharesAddressWith).toBeGreaterThanOrEqual(1);
    ada.socket.close();
    other.socket.close();
  });

  test("pages through long lists", async ({ request }) => {
    for (let i = 0; i < 3; i++) await seedDiagram(request);
    await signIn(request);
    const page = async (params) => (await request.get("/api/admin/diagrams", { params })).json();
    const first = await page({ limit: 2 });
    expect(first.diagrams).toHaveLength(2);
    expect(first.total).toBeGreaterThanOrEqual(3);
    const second = await page({ limit: 2, offset: 2 });
    expect(second.diagrams.length).toBeGreaterThanOrEqual(1);
    expect(second.diagrams[0].id).not.toBe(first.diagrams[0].id);
  });
});

test.describe("deleting a diagram", () => {
  test("removes it for good: its links say deleted and it cannot be saved back", async ({
    request,
  }) => {
    const { id, viewId } = await seedDiagram(request, { elements: [rectangle()] });
    await request.put(`/api/diagrams/${id}/files/abc123`, {
      headers: { "Content-Type": "image/png" },
      data: PNG,
    });
    await signIn(request);

    expect((await request.delete(`/api/admin/diagrams/${id}`)).status()).toBe(204);
    expect(await find(request, id)).toEqual([]);

    for (const link of [id, viewId]) {
      const response = await request.get(`/api/diagrams/${link}`);
      expect(response.status()).toBe(410);
      expect(await response.json()).toEqual({ error: "deleted" });
    }
    for (const baseVersion of [0, 1]) {
      const save = await request.put(`/api/diagrams/${id}`, { data: { baseVersion, elements: [] } });
      expect(save.status()).toBe(410);
    }
    const upload = await request.put(`/api/diagrams/${id}/files/other`, {
      headers: { "Content-Type": "image/png" },
      data: PNG,
    });
    expect(upload.status()).toBe(410);
    expect((await request.get(`/api/diagrams/${id}/files/abc123`)).status()).toBe(404);

    expect((await request.delete(`/api/admin/diagrams/${id}`)).status()).toBe(404);
    expect((await request.delete("/api/admin/diagrams/nope")).status()).toBe(400);
  });

  test("tells everyone who has it open and disconnects them", async ({ request, baseURL }) => {
    const { id, viewId } = await seedDiagram(request);
    const editor = await connectLive(baseURL, id);
    const viewer = await connectLive(baseURL, viewId);
    const closed = [editor, viewer].map(
      ({ socket }) => new Promise((resolve) => socket.addEventListener("close", (e) => resolve(e.code))),
    );
    await signIn(request);
    await request.delete(`/api/admin/diagrams/${id}`);

    expect(await Promise.all(closed)).toEqual([4410, 4410]);
    expect(editor.of("deleted")).toHaveLength(1);
    expect(viewer.of("deleted")).toHaveLength(1);
    // Nobody can connect to it afterwards either.
    expect(await liveCloseCode(baseURL, id)).toBe(4410);
    expect(await liveCloseCode(baseURL, viewId)).toBe(4410);
  });

  test("someone editing it is told, keeps their copy, and cannot bring it back", async ({
    page,
    request,
  }) => {
    const { id } = await seedDiagram(request, { elements: [rectangle()] });
    await openDiagram(page, id);
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeEnabled();
    await signIn(request);
    await request.delete(`/api/admin/diagrams/${id}`);

    await expect(page.getByRole("alert")).toContainText("deleted by an administrator");
    await expectStatus(page, "deleted");
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Share Edit", exact: true })).toBeDisabled();

    await drawRectangle(page, 300, 250);
    await page.waitForTimeout(2500); // longer than the autosave delay
    await expectStatus(page, "deleted");
    expect((await request.get(`/api/diagrams/${id}`)).status()).toBe(410);
  });

  test("opening a deleted link says so", async ({ page, request }) => {
    const { id, viewId } = await seedDiagram(request, { elements: [rectangle()] });
    await signIn(request);
    await request.delete(`/api/admin/diagrams/${id}`);

    for (const link of [id, viewId]) {
      await page.goto(`/${link}`);
      await expect(page.getByRole("heading", { name: "This diagram was deleted" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Start a new diagram" })).toBeVisible();
    }
  });
});

test.describe("unused images", () => {
  test("only old images that no element refers to are removed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "escalidusk-store-"));
    const store = openStore(dir);
    const diagram = randomUUID();
    const scene = JSON.stringify({
      elements: [
        { id: "a", type: "image", fileId: "used" },
        { id: "b", type: "image", fileId: "used-by-deleted", isDeleted: true },
      ],
    });
    store.saveDiagram(diagram, 0, scene);
    const data = Buffer.from("x".repeat(100));
    for (const fileId of ["used", "used-by-deleted", "unused-old", "unused-new"]) {
      store.putFile(diagram, fileId, "image/png", data);
    }
    store.putFile(randomUUID(), "no-diagram-old", "image/png", data);

    // Age everything except "unused-new" by two days.
    const db = new DatabaseSync(path.join(dir, "escalidusk.db"));
    db.prepare("UPDATE files SET created_at = created_at - ? WHERE file_id <> 'unused-new'").run(
      2 * 24 * 60 * 60 * 1000,
    );

    expect(store.stats()).toMatchObject({ images: 5, orphanedImages: 2, orphanedImageSize: 200 });
    expect(store.removeOrphanedImages()).toBe(2);
    expect(
      db.prepare("SELECT file_id FROM files ORDER BY 1").all().map((row) => row.file_id),
    ).toEqual(["unused-new", "used", "used-by-deleted"]);
    expect(store.stats().orphanedImages).toBe(0);
    db.close();
    store.close();
  });
});

test.describe("backoffice page", () => {
  test("signs in, finds a diagram, and deletes it", async ({ page, request }) => {
    const name = `Quarterly roadmap ${randomUUID().slice(0, 8)}`;
    const { id } = await seedDiagram(request, { elements: [rectangle()], appState: { name } });

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Escalidusk backoffice" })).toBeVisible();
    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Wrong password.");

    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Database file")).toBeVisible();

    await page.getByLabel("Search diagrams").fill(name);
    const row = page.getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await expect(page.getByText("Showing 1 of 1 diagrams")).toBeVisible();
    await expect(row.getByRole("link", { name })).toHaveAttribute("href", `/${id}`);

    // Declining the confirmation keeps the diagram.
    page.once("dialog", (dialog) => dialog.dismiss());
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(row).toBeVisible();
    expect((await request.get(`/api/diagrams/${id}`)).status()).toBe(200);

    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain(name);
      dialog.accept();
    });
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("No diagrams match.")).toBeVisible();
    expect((await request.get(`/api/diagrams/${id}`)).status()).toBe(410);
  });

  test("shows people, and signing out returns to the password prompt", async ({ page, request }) => {
    const name = `Grace ${randomUUID().slice(0, 8)}`;
    await request.put(`/api/diagrams/${newId()}`, {
      headers: { "X-User-Id": newId() },
      data: { baseVersion: 0, elements: [] },
    });
    const { id } = await seedDiagram(request);
    await page.goto("/admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    const live = await connectLive(new URL(page.url()).origin, id, { name });
    await page.getByRole("tab", { name: "People" }).click();
    await page.getByLabel("Search people").fill(name);
    await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();
    live.socket.close();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Password")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Password")).toBeVisible();
  });
});
