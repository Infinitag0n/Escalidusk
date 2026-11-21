import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { openStore } from "../server/store.js";

// Listing and searching diagrams must never read the scenes themselves:
// those can be megabytes each, and reading them holds up everyone.

const tempDir = () => mkdtempSync(path.join(tmpdir(), "escalidusk-listing-"));
const scene = (name, elements = 0, padding = 0) =>
  JSON.stringify({
    elements: Array.from({ length: elements }, (_, index) => ({ id: `e${index}`, pad: "x".repeat(padding) })),
    appState: name === undefined ? {} : { name },
  });

test("what the lists show of a diagram follows each save", () => {
  const store = openStore(tempDir());
  try {
    const [id, user] = [randomUUID(), randomUUID()];
    store.seeUser({ id: user, name: "Ada" });
    const first = scene("First name", 3);
    store.saveDiagram(id, 0, first, user);
    expect(store.listDiagrams().diagrams[0]).toMatchObject({
      id,
      name: "First name",
      elementCount: 3,
      sceneSize: first.length,
      version: 1,
      createdBy: "Ada",
    });
    expect(store.diagramName(id)).toBe("First name");

    const second = scene("Renamed", 5);
    store.saveDiagram(id, 1, second, user);
    expect(store.listDiagrams({ search: "renam" }).diagrams[0]).toMatchObject({
      name: "Renamed",
      elementCount: 5,
      sceneSize: second.length,
      version: 2,
    });
    expect(store.listDiagrams({ search: "first" }).total).toBe(0);

    // A save that loses to a newer version changes nothing.
    expect(store.saveDiagram(id, 1, scene("Too late", 9)).ok).toBe(false);
    expect(store.diagramName(id)).toBe("Renamed");

    // Scenes without a name, or that are not what we expect, still list.
    const [unnamed, odd] = [randomUUID(), randomUUID()];
    store.saveDiagram(unnamed, 0, scene(undefined, 1));
    store.saveDiagram(odd, 0, "{}");
    const byId = Object.fromEntries(store.listDiagrams().diagrams.map((diagram) => [diagram.id, diagram]));
    expect(byId[unnamed]).toMatchObject({ name: "", elementCount: 1 });
    expect(byId[odd]).toMatchObject({ name: "", elementCount: 0, sceneSize: 2 });
    expect(store.diagramName(unnamed)).toBe("");

    // An enormous name, or one that is not text, is kept short in the list and its index.
    const [huge, numeric] = [randomUUID(), randomUUID()];
    store.saveDiagram(huge, 0, scene("n".repeat(50_000)));
    store.saveDiagram(numeric, 0, JSON.stringify({ elements: [], appState: { name: 12345 } }));
    expect(store.diagramName(huge)).toBe("n".repeat(200));
    expect(store.diagramName(numeric)).toBe("12345");
    // The scene itself is stored as it was sent.
    expect(JSON.parse(store.findDiagram(huge).row.scene).appState.name).toHaveLength(50_000);
  } finally {
    store.close();
  }
});

test("a database from before these columns existed is filled in once, keeping every date", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, "escalidusk.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE diagrams (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, scene TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      view_id TEXT, created_by TEXT, updated_by TEXT
    );
  `);
  const insert = old.prepare("INSERT INTO diagrams VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)");
  const rows = [
    [randomUUID(), 4, scene("Older plan", 2), 100, 200],
    [randomUUID(), 1, scene("Newer plan", 7), 300, 400],
    [randomUUID(), 2, scene(undefined, 0), 50, 60],
  ];
  for (const [id, version, json, created, updated] of rows) insert.run(id, version, json, created, updated, randomUUID());
  old.close();

  let store = openStore(dataDir);
  const listed = store.listDiagrams().diagrams;
  expect(listed.map((diagram) => [diagram.name, diagram.elementCount, diagram.version, diagram.createdAt, diagram.updatedAt])).toEqual([
    ["Newer plan", 7, 1, 300, 400],
    ["Older plan", 2, 4, 100, 200],
    ["", 0, 2, 50, 60],
  ]);
  expect(listed[0].sceneSize).toBe(rows[1][2].length);
  expect(store.listDiagrams({ search: "older" }).diagrams.map((diagram) => diagram.id)).toEqual([rows[0][0]]);
  expect(store.findDiagram(rows[0][0]).row.scene).toBe(rows[0][2]);
  store.close();

  // Starting again finds nothing left to fill in, and changes nothing.
  const before = new DatabaseSync(file);
  const snapshot = () => JSON.stringify(before.prepare("SELECT * FROM diagrams ORDER BY id").all());
  const stored = snapshot();
  expect(before.prepare("SELECT COUNT(*) AS n FROM diagrams WHERE scene_size IS NULL").get().n).toBe(0);
  store = openStore(dataDir);
  store.close();
  expect(snapshot()).toBe(stored);
  before.close();
});

test("listing, searching and counting read the index, never the scenes", () => {
  const dataDir = tempDir();
  const store = openStore(dataDir);
  const user = randomUUID();
  store.seeUser({ id: user, name: "Grace" });
  for (let index = 0; index < 30; index++) store.saveDiagram(randomUUID(), 0, scene(`Diagram ${index}`, 2), user);
  store.close();

  const db = new DatabaseSync(path.join(dataDir, "escalidusk.db"));
  const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((step) => step.detail);
  const diagramSteps = (sql) => plan(sql).filter((detail) => /\bdiagrams\b| d\b/.test(detail));

  // The same shapes the store uses: a page of the list, a search, and their counts.
  const match = `(instr(lower(COALESCE(d.name, '')), 'plan') > 0 OR d.id = 'x' OR d.view_id = 'x'
     OR instr(lower(creator.display_name), 'plan') > 0 OR creator.public_id = 'x')`;
  const page = (where) => `
    SELECT d.id, d.view_id, d.version, d.created_at, d.updated_at, COALESCE(d.name, ''),
           COALESCE(d.element_count, 0), COALESCE(d.scene_size, 0),
           creator.display_name, editor.display_name
    FROM diagrams d
    LEFT JOIN users creator ON creator.id = d.created_by
    LEFT JOIN users editor ON editor.id = d.updated_by
    WHERE ${where} ORDER BY d.updated_at DESC, d.id LIMIT 50 OFFSET 0`;
  const count = (where) => `
    SELECT COUNT(*) FROM diagrams d LEFT JOIN users creator ON creator.id = d.created_by WHERE ${where}`;

  for (const sql of [page("1"), page(match), count("1"), count(match)]) {
    const steps = diagramSteps(sql);
    expect(steps.length, sql).toBeGreaterThan(0);
    for (const step of steps) expect(step, sql).toMatch(/USING COVERING INDEX/);
  }
  // In the order shown, so a page is the first fifty entries of the index, with no sorting.
  expect(plan(page("1")).join("\n")).not.toMatch(/TEMP B-TREE/);
  // How many diagrams a person created or last changed is looked up, not counted by reading them all.
  expect(plan("SELECT COUNT(*) FROM diagrams d WHERE d.created_by = 'x'").join()).toMatch(/diagrams_created_by/);
  expect(plan("SELECT COUNT(*) FROM diagrams d WHERE d.updated_by = 'x'").join()).toMatch(/diagrams_updated_by/);
  db.close();
});

test("the store's own list queries are the ones checked above", () => {
  // Guards the test above against drifting from the real queries: the real
  // ones must return the same rows in the same order as those shapes would.
  const store = openStore(tempDir());
  try {
    const user = randomUUID();
    store.seeUser({ id: user, name: "Plan maker" });
    const ids = [];
    for (let index = 0; index < 5; index++) {
      const id = randomUUID();
      ids.push(id);
      store.saveDiagram(id, 0, scene(index % 2 ? `Plan ${index}` : `Sketch ${index}`), index === 0 ? user : null);
    }
    const all = store.listDiagrams();
    expect(all.total).toBe(5);
    expect(new Set(all.diagrams.map((diagram) => diagram.id))).toEqual(new Set(ids));
    const updated = all.diagrams.map((diagram) => diagram.updatedAt);
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
    // "plan" matches two names and the one diagram made by "Plan maker".
    const found = store.listDiagrams({ search: "plan" });
    expect(found.total).toBe(3);
    expect(found.diagrams).toHaveLength(3);
    expect(store.listDiagrams({ search: "plan", limit: 1 }).diagrams).toHaveLength(1);
  } finally {
    store.close();
  }
});
