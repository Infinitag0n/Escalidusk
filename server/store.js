import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite-backed storage for diagrams and their image files.
 *
 * A diagram's scene (elements + shared app state) is stored as one JSON
 * string. Each save must name the version it was based on; a mismatch is
 * reported as a conflict so the client can merge and retry.
 */
export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "excalidawn.db"));

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS diagrams (
      id         TEXT PRIMARY KEY,
      version    INTEGER NOT NULL,
      scene      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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

  const selectDiagram = db.prepare(
    "SELECT id, version, scene, updated_at AS updatedAt FROM diagrams WHERE id = ?",
  );
  const insertDiagram = db.prepare(
    `INSERT INTO diagrams (id, version, scene, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
  );
  const updateDiagram = db.prepare(
    `UPDATE diagrams SET version = version + 1, scene = ?, updated_at = ?
     WHERE id = ? AND version = ?`,
  );
  const selectFile = db.prepare(
    "SELECT mime_type AS mimeType, data FROM files WHERE diagram_id = ? AND file_id = ?",
  );
  const insertFile = db.prepare(
    `INSERT INTO files (diagram_id, file_id, mime_type, data, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );

  return {
    /** @returns {{id: string, version: number, scene: string, updatedAt: number} | undefined} */
    getDiagram(id) {
      return selectDiagram.get(id);
    },

    /**
     * Saves a scene if `baseVersion` still matches what is stored
     * (0 means "this diagram does not exist yet").
     * @returns {{ok: true, version: number, updatedAt: number} | {ok: false, current: object | undefined}}
     */
    saveDiagram(id, baseVersion, sceneJson) {
      const now = Date.now();
      const result =
        baseVersion === 0
          ? insertDiagram.run(id, sceneJson, now, now)
          : updateDiagram.run(sceneJson, now, id, baseVersion);
      if (result.changes === 1) {
        return { ok: true, version: baseVersion + 1, updatedAt: now };
      }
      return { ok: false, current: selectDiagram.get(id) };
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
