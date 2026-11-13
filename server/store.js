import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite-backed storage for diagrams and their image files.
 *
 * A diagram's scene (elements + shared app state) is stored as one JSON
 * string. Each save must name the version it was based on; a mismatch is
 * reported as a conflict so the client can merge and retry.
 *
 * Every diagram has two ids: `id` grants editing, `view_id` grants reading
 * only. Neither can be derived from the other.
 */
export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "escalidusk.db"));

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS diagrams (
      id         TEXT PRIMARY KEY,
      version    INTEGER NOT NULL,
      scene      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      view_id    TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      diagram_id TEXT NOT NULL,
      file_id    TEXT NOT NULL,
      mime_type  TEXT NOT NULL,
      data       BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (diagram_id, file_id)
    ) WITHOUT ROWID;
  `);

  // Databases created before read-only links existed lack the column.
  const columns = db.prepare("PRAGMA table_info(diagrams)").all();
  if (!columns.some((column) => column.name === "view_id")) {
    db.exec("ALTER TABLE diagrams ADD COLUMN view_id TEXT");
  }
  const setViewId = db.prepare("UPDATE diagrams SET view_id = ? WHERE id = ?");
  for (const { id } of db.prepare("SELECT id FROM diagrams WHERE view_id IS NULL").all()) {
    setViewId.run(randomUUID(), id);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS diagrams_view_id ON diagrams (view_id)");

  const DIAGRAM_COLUMNS = "id, view_id AS viewId, version, scene, updated_at AS updatedAt";
  const selectById = db.prepare(`SELECT ${DIAGRAM_COLUMNS} FROM diagrams WHERE id = ?`);
  const selectByViewId = db.prepare(`SELECT ${DIAGRAM_COLUMNS} FROM diagrams WHERE view_id = ?`);
  const insertDiagram = db.prepare(
    `INSERT INTO diagrams (id, view_id, version, scene, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING view_id AS viewId`,
  );
  const updateDiagram = db.prepare(
    `UPDATE diagrams SET version = version + 1, scene = ?, updated_at = ?
     WHERE id = ? AND version = ? RETURNING view_id AS viewId`,
  );
  const selectFile = db.prepare(
    "SELECT mime_type AS mimeType, data FROM files WHERE diagram_id = ? AND file_id = ?",
  );
  const insertFile = db.prepare(
    `INSERT INTO files (diagram_id, file_id, mime_type, data, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );

  return {
    /**
     * Looks a diagram up by either of its ids.
     * @returns {{row: {id: string, viewId: string, version: number, scene: string, updatedAt: number}, readOnly: boolean} | undefined}
     */
    findDiagram(anyId) {
      const editable = selectById.get(anyId);
      if (editable) return { row: editable, readOnly: false };
      const viewable = selectByViewId.get(anyId);
      return viewable && { row: viewable, readOnly: true };
    },

    /** True if this id is some diagram's read-only id. */
    isViewId(anyId) {
      return selectByViewId.get(anyId) !== undefined;
    },

    /**
     * Saves a scene if `baseVersion` still matches what is stored
     * (0 means "this diagram does not exist yet").
     * @returns {{ok: true, version: number, updatedAt: number, viewId: string} | {ok: false, current: object | undefined}}
     */
    saveDiagram(id, baseVersion, sceneJson) {
      const now = Date.now();
      const saved =
        baseVersion === 0
          ? insertDiagram.get(id, randomUUID(), sceneJson, now, now)
          : updateDiagram.get(sceneJson, now, id, baseVersion);
      if (saved) {
        return { ok: true, version: baseVersion + 1, updatedAt: now, viewId: saved.viewId };
      }
      return { ok: false, current: selectById.get(id) };
    },

    /** @returns {{mimeType: string, data: Uint8Array} | undefined} */
    getFile(diagramId, fileId) {
      return selectFile.get(diagramId, fileId);
    },

    /** Files are immutable: storing an existing id again is a no-op. */
    putFile(diagramId, fileId, mimeType, data) {
      insertFile.run(diagramId, fileId, mimeType, data, Date.now());
    },

    close() {
      db.close();
    },
  };
}
