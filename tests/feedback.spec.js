import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { openStore } from "../server/store.js";
import { openDiagram } from "./helpers.js";

// Must match ADMIN_PASSWORD in playwright.config.js.
const PASSWORD = "test-admin-password";

const unique = (text) => `${text} ${randomUUID().slice(0, 8)}`;
const send = (request, message) => request.post("/api/feedback", { data: { message } });

async function signIn(request) {
  expect((await request.post("/api/admin/login", { data: { password: PASSWORD } })).ok()).toBe(true);
}

/** Everything the backoffice lists, newest first. */
const listed = async (request) =>
  (await (await request.get("/api/admin/feedback", { params: { limit: 200 } })).json()).feedback;

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
      DATA_DIR: mkdtempSync(path.join(tmpdir(), "escalidusk-feedback-")),
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

test.describe("feedback API", () => {
  test("keeps the message and the time, and nothing else", async ({ request }) => {
    const message = unique("Lines stay\n  as written");
    const before = Date.now();
    const response = await request.post("/api/feedback", {
      // Whatever else is sent along is ignored.
      headers: { "X-User-Id": randomUUID() },
      data: { message: `  ${message}\n`, name: "Someone", diagram: randomUUID() },
    });
    expect(response.status()).toBe(204);

    await signIn(request);
    const entry = (await listed(request)).find((item) => item.message === message);
    expect(Object.keys(entry).sort()).toEqual(["createdAt", "id", "message"]);
    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt).toBeLessThanOrEqual(Date.now());
  });

  test("turns away anything that is not a message of sensible length", async ({ request }) => {
    for (const message of ["", "   \n ", "x".repeat(4001), 42, null, ["text"]]) {
      expect((await send(request, message)).status(), JSON.stringify(message).slice(0, 20)).toBe(400);
    }
    expect((await request.post("/api/feedback", { data: {} })).status()).toBe(400);
    expect((await send(request, "x".repeat(4000))).status()).toBe(204);
  });

  test("the backoffice lists it newest first, needs signing in, and can delete it", async ({ request }) => {
    const [first, second] = [unique("First"), unique("Second")];
    await send(request, first);
    await send(request, second);

    expect((await request.get("/api/admin/feedback")).status()).toBe(401);
    expect((await request.get("/api/admin/feedback/export")).status()).toBe(401);
    await signIn(request);

    const messages = (await listed(request)).map((item) => item.message);
    expect(messages.indexOf(second)).toBeGreaterThanOrEqual(0);
    expect(messages.indexOf(second)).toBeLessThan(messages.indexOf(first));
    const page = await (await request.get("/api/admin/feedback", { params: { limit: 1 } })).json();
    expect(page.feedback).toHaveLength(1);
    expect(page.total).toBeGreaterThanOrEqual(2);

    const { id } = (await listed(request)).find((item) => item.message === first);
    expect((await request.delete(`/api/admin/feedback/${id}`)).status()).toBe(204);
    expect((await request.delete(`/api/admin/feedback/${id}`)).status()).toBe(404);
    expect((await request.delete("/api/admin/feedback/abc")).status()).toBe(400);
    expect((await listed(request)).map((item) => item.message)).not.toContain(first);
  });

  test("exports everything as JSON or as text", async ({ request }) => {
    const message = unique("Export me\nsecond line");
    await send(request, message);
    await signIn(request);

    const json = await request.get("/api/admin/feedback/export", { params: { format: "json" } });
    expect(json.headers()["content-type"]).toContain("application/json");
    expect(json.headers()["content-disposition"]).toMatch(
      /^attachment; filename="escalidusk-feedback-\d{4}-\d\d-\d\d\.json"$/,
    );
    const entry = (await json.json()).find((item) => item.message === message);
    expect(Object.keys(entry).sort()).toEqual(["message", "sentAt"]);
    expect(new Date(entry.sentAt).toISOString()).toBe(entry.sentAt);

    const text = await request.get("/api/admin/feedback/export", { params: { format: "text" } });
    expect(text.headers()["content-type"]).toContain("text/plain");
    expect(text.headers()["content-disposition"]).toMatch(/\.txt"$/);
    expect(await text.text()).toContain(`${entry.sentAt}\n${message}\n`);
  });
});

test("a database from before feedback existed gains it, and keeps what it had", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "escalidusk-old-"));
  const old = new DatabaseSync(path.join(dataDir, "escalidusk.db"));
  const id = randomUUID();
  old.exec(`
    CREATE TABLE diagrams (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, scene TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO diagrams VALUES ('${id}', 3, '{"elements":[],"appState":{"name":"Old"}}', 1, 2);
  `);
  old.close();

  const store = openStore(dataDir);
  try {
    expect(store.findDiagram(id).row.version).toBe(3);
    expect(store.listFeedback()).toEqual({ total: 0, feedback: [] });
    store.addFeedback("Still works");
    expect(store.listFeedback().feedback.map((entry) => entry.message)).toEqual(["Still works"]);
  } finally {
    store.close();
  }
  const columns = new DatabaseSync(path.join(dataDir, "escalidusk.db"))
    .prepare("PRAGMA table_info(feedback)")
    .all()
    .map((column) => column.name);
  expect(columns).toEqual(["id", "message", "created_at"]);
});

test.describe("sending feedback from the editor", () => {
  test("the button sits just before Help, and what is written reaches the backoffice", async ({
    page,
    request,
  }) => {
    await openDiagram(page);
    const button = page.getByRole("button", { name: "Send feedback", exact: true });
    const [feedback, help, name] = await Promise.all([
      button.boundingBox(),
      page.locator(".help-icon").boundingBox(),
      page.getByLabel("Your name").boundingBox(),
    ]);
    // Bottom right: after our name, before Help, level with it and the same size.
    expect(feedback.x).toBeGreaterThanOrEqual(name.x + name.width);
    expect(help.x - (feedback.x + feedback.width)).toBeGreaterThan(0);
    expect(help.x - (feedback.x + feedback.width)).toBeLessThan(24);
    expect(Math.abs(feedback.y - help.y)).toBeLessThan(2);
    expect(Math.round(feedback.width)).toBe(Math.round(help.width));

    await button.click();
    const dialog = page.getByRole("dialog", { name: "Send feedback" });
    const box = dialog.getByLabel("Your feedback");
    await expect(box).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Send" })).toBeDisabled();

    // Typing goes into the box: no tool is picked, and a space does not switch to viewing.
    const message = unique("r 2 the hexagons are neat");
    await page.keyboard.type(message);
    await expect(box).toHaveValue(message);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
    await expect(page.locator('[data-testid="toolbar-selection"]')).toBeChecked();

    await dialog.getByRole("button", { name: "Send" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Thank you for your feedback.");
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await expect(dialog).toHaveCount(0);

    await signIn(request);
    expect((await listed(request)).map((item) => item.message)).toContain(message);
  });

  test("a failure says so and keeps what was written", async ({ page }) => {
    await openDiagram(page);
    await page.route("**/api/feedback", (route) => route.abort());
    await page.getByRole("button", { name: "Send feedback", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send feedback" });
    await dialog.getByLabel("Your feedback").fill("Kept");
    await dialog.getByRole("button", { name: "Send" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Could not send. Try again.");
    await expect(dialog.getByLabel("Your feedback")).toHaveValue("Kept");

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("the menu offers it too, which is how a phone gets to it", async ({ browser, baseURL }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, baseURL });
    await openDiagram(page);
    await expect(page.getByRole("button", { name: "Send feedback", exact: true })).toHaveCount(0);
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await page.getByRole("button", { name: "Send feedback…" }).click();
    await expect(page.getByRole("dialog", { name: "Send feedback" })).toBeVisible();
    await page.close();
  });
});

test("the backoffice page shows feedback, exports it and deletes it", async ({ page, request }) => {
  const message = unique("Shown in the backoffice\nwith its second line");
  await send(request, message);

  await page.goto("/admin");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("tab", { name: "Feedback" }).click();
  const row = page.getByRole("row", { name: new RegExp(message.split("\n")[0]) });
  await expect(row).toContainText("with its second line");
  await expect(row).toContainText("just now");

  for (const [name, extension] of [["JSON", "json"], ["Text", "txt"]]) {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name, exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`^escalidusk-feedback-.*\\.${extension}$`));
  }

  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
});

test("a server without a backoffice still takes feedback, to be read once it has one", async ({
  browser,
}) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "escalidusk-feedback-later-"));
  const message = unique("Written before anyone could read it");
  let server = await startServer({ ADMIN_PASSWORD: "", DATA_DIR: dataDir });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/new`);
    await page.waitForSelector(".excalidraw canvas");
    await page.locator('[data-testid="main-menu-trigger"]').click();
    await expect(page.getByRole("button", { name: "Send feedback…" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Send feedback", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send feedback" });
    await dialog.getByLabel("Your feedback").fill(message);
    await dialog.getByRole("button", { name: "Send" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Thank you for your feedback.");
    await page.close();
    // Nobody can read it yet.
    expect((await fetch(`${server.url}/api/admin/feedback`)).status).toBe(404);
  } finally {
    server.stop();
  }

  // The same database, now with a password: the message is there.
  server = await startServer({ ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir });
  try {
    const login = await fetch(`${server.url}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const list = await fetch(`${server.url}/api/admin/feedback`, { headers: { cookie } });
    expect((await list.json()).feedback.map((entry) => entry.message)).toEqual([message]);
  } finally {
    server.stop();
  }
});
