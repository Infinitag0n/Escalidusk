import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;
// How often one user's "last seen" is written at most; saves happen every second or so.
const SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * SQLite-backed storage for diagrams, their image files, and the people who
 * use them.
 *
 * A diagram's scene (elements + shared app state) is stored as one JSON
 * string. Each save must name the version it was based on; a mismatch is
 * reported as a conflict so the client can merge and retry.
 *
 * Every diagram has two ids: `id` grants editing, `view_id` grants reading
 * only. Neither can be derived from the other.
 *
 * People are known by an id their browser made up. It is a soft identity,
 * not a login: it says "probably the same browser as before" and must never
 * decide what someone may do. The id is private to that person and the
 * server; everyone else only ever sees the unrelated `public_id`.
 */
export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "escalidusk.db");
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS diagrams (
      id         TEXT PRIMARY KEY,
      version    INTEGER NOT NULL,
      scene      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      view_id    TEXT,
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      diagram_id TEXT NOT NULL,
      file_id    TEXT NOT NULL,
      mime_type  TEXT NOT NULL,
      data       BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (diagram_id, file_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      public_id    TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      first_seen   INTEGER NOT NULL,
      last_seen    INTEGER NOT NULL
    );

    -- Which network addresses a user has been seen from. Addresses are stored
    -- only as keyed hashes (see address.js), never in the clear.
    CREATE TABLE IF NOT EXISTS user_addresses (
      user_id      TEXT NOT NULL,
      address_hash TEXT NOT NULL,
      first_seen   INTEGER NOT NULL,
      last_seen    INTEGER NOT NULL,
      PRIMARY KEY (user_id, address_hash)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS user_addresses_by_hash ON user_addresses (address_hash);

    -- Ids of diagrams an administrator deleted. Kept so that their links say
    -- "deleted" and an editor who still has one open cannot bring it back.
    CREATE TABLE IF NOT EXISTS deleted_diagrams (
      id         TEXT PRIMARY KEY,
      view_id    TEXT,
      deleted_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS deleted_diagrams_view_id ON deleted_diagrams (view_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
  `);

  // Bring databases from earlier versions up to date.
  const diagramColumns = new Set(
    db.prepare("PRAGMA table_info(diagrams)").all().map((column) => column.name),
  );
  for (const column of ["view_id", "created_by", "updated_by"]) {
    if (!diagramColumns.has(column)) db.exec(`ALTER TABLE diagrams ADD COLUMN ${column} TEXT`);
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
    `INSERT INTO diagrams (id, view_id, version, scene, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING view_id AS viewId`,
  );
  const updateDiagram = db.prepare(
    `UPDATE diagrams
     SET version = version + 1, scene = ?, updated_at = ?, updated_by = COALESCE(?, updated_by)
     WHERE id = ? AND version = ? RETURNING view_id AS viewId`,
  );
  const selectFile = db.prepare(
    "SELECT mime_type AS mimeType, data FROM files WHERE diagram_id = ? AND file_id = ?",
  );
  const insertFile = db.prepare(
    `INSERT INTO files (diagram_id, file_id, mime_type, data, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );

  const selectUser = db.prepare(
    "SELECT public_id AS publicId, display_name AS displayName FROM users WHERE id = ?",
  );
  const insertUser = db.prepare(
    `INSERT INTO users (id, public_id, display_name, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const touchUser = db.prepare(
    "UPDATE users SET last_seen = ?, display_name = COALESCE(?, display_name) WHERE id = ?",
  );
  const upsertAddress = db.prepare(
    `INSERT INTO user_addresses (user_id, address_hash, first_seen, last_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, address_hash) DO UPDATE SET last_seen = excluded.last_seen`,
  );
  const deleteOldAddresses = db.prepare("DELETE FROM user_addresses WHERE last_seen < ?");
  const selectSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const insertSetting = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
  );

  // --- Backoffice queries ---------------------------------------------------

  const selectDeleted = db.prepare("SELECT 1 FROM deleted_diagrams WHERE id = ? OR view_id = ?");
  const insertDeleted = db.prepare(
    `INSERT INTO deleted_diagrams (id, view_id, deleted_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  );
  const deleteDiagramRow = db.prepare("DELETE FROM diagrams WHERE id = ?");
  const deleteDiagramFiles = db.prepare("DELETE FROM files WHERE diagram_id = ?");

  // The name lives inside the scene JSON; SQLite reads it out for listing and search.
  const DIAGRAM_NAME = "COALESCE(json_extract(d.scene, '$.appState.name'), '')";
  const DIAGRAM_MATCH = `($search = '' OR instr(lower(${DIAGRAM_NAME}), lower($search)) > 0 OR d.id = $search OR d.view_id = $search)`;
  const selectDiagramList = db.prepare(
    `SELECT d.id, d.view_id AS viewId, d.version,
            d.created_at AS createdAt, d.updated_at AS updatedAt,
            ${DIAGRAM_NAME} AS name,
            json_array_length(d.scene, '$.elements') AS elementCount,
            length(d.scene) AS sceneSize,
            (SELECT COUNT(*) FROM files f WHERE f.diagram_id = d.id) AS imageCount,
            (SELECT COALESCE(SUM(length(f.data)), 0) FROM files f WHERE f.diagram_id = d.id) AS imageSize,
            creator.display_name AS createdBy, editor.display_name AS updatedBy
     FROM diagrams d
     LEFT JOIN users creator ON creator.id = d.created_by
     LEFT JOIN users editor ON editor.id = d.updated_by
     WHERE ${DIAGRAM_MATCH}
     ORDER BY d.updated_at DESC, d.id
     LIMIT $limit OFFSET $offset`,
  );
  const countDiagramList = db.prepare(`SELECT COUNT(*) AS total FROM diagrams d WHERE ${DIAGRAM_MATCH}`);

  const USER_MATCH = "($search = '' OR instr(lower(u.display_name), lower($search)) > 0 OR u.public_id = $search)";
  const selectUserList = db.prepare(
    `SELECT u.public_id AS publicId, u.display_name AS name,
            u.first_seen AS firstSeen, u.last_seen AS lastSeen,
            (SELECT COUNT(*) FROM diagrams d WHERE d.created_by = u.id) AS created,
            (SELECT COUNT(*) FROM diagrams d WHERE d.updated_by = u.id) AS lastEditorOf,
            (SELECT COUNT(*) FROM user_addresses a WHERE a.user_id = u.id) AS addressCount,
            (SELECT COUNT(DISTINCT other.user_id)
               FROM user_addresses mine
               JOIN user_addresses other
                 ON other.address_hash = mine.address_hash AND other.user_id <> mine.user_id
              WHERE mine.user_id = u.id) AS sharesAddressWith
     FROM users u
     WHERE ${USER_MATCH}
     ORDER BY u.last_seen DESC, u.id
     LIMIT $limit OFFSET $offset`,
  );
  const countUserList = db.prepare(`SELECT COUNT(*) AS total FROM users u WHERE ${USER_MATCH}`);

  // An image is orphaned when no element of its diagram mentions it any more
  // (deleted elements still count while they are kept, so undo keeps working),
  // or when its diagram does not exist. Recent uploads are left alone: an
  // image is uploaded moments before the save that first refers to it.
  const ORPHANED_IMAGE = `files.created_at < $before AND NOT EXISTS (
      SELECT 1 FROM diagrams d, json_each(d.scene, '$.elements') element
      WHERE d.id = files.diagram_id AND json_extract(element.value, '$.fileId') = files.file_id)`;
  const selectOrphanedImages = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(length(data)), 0) AS size FROM files WHERE ${ORPHANED_IMAGE}`,
  );
  const deleteOrphanedImages = db.prepare(`DELETE FROM files WHERE ${ORPHANED_IMAGE}`);
  const selectTotals = db.prepare(
    `SELECT (SELECT COUNT(*) FROM diagrams) AS diagrams,
            (SELECT COUNT(*) FROM deleted_diagrams) AS deletedDiagrams,
            (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM files) AS images,
            (SELECT COALESCE(SUM(length(data)), 0) FROM files) AS imageSize`,
  );

  // user id -> { publicId, name, addresses: Map(address hash -> time last written) }
  const recentlySeen = new Map();

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
     * (0 means "this diagram does not exist yet"). `userId`, when known, is
     * recorded as the diagram's creator and/or latest editor.
     * @returns {{ok: true, version: number, updatedAt: number, viewId: string} | {ok: false, current: object | undefined}}
     */
    saveDiagram(id, baseVersion, sceneJson, userId = null) {
      const now = Date.now();
      const saved =
        baseVersion === 0
          ? insertDiagram.get(id, randomUUID(), sceneJson, now, now, userId, userId)
          : updateDiagram.get(sceneJson, now, userId, id, baseVersion);
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

    /** True if an administrator deleted the diagram with this editing or read-only id. */
    isDeleted(anyId) {
      return selectDeleted.get(anyId, anyId) !== undefined;
    },

    /**
     * Deletes a diagram and its images for good, remembering its ids as deleted.
     * @returns {boolean} false if there was no such diagram
     */
    deleteDiagram(id) {
      const row = selectById.get(id);
      if (!row) return false;
      db.exec("BEGIN");
      try {
        insertDeleted.run(id, row.viewId, Date.now());
        deleteDiagramFiles.run(id);
        deleteDiagramRow.run(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return true;
    },

    /**
     * Diagrams for the backoffice, most recently changed first. `search`
     * matches part of the name, or a whole editing or read-only id.
     * @returns {{total: number, diagrams: object[]}}
     */
    listDiagrams({ search = "", limit = 50, offset = 0 } = {}) {
      return {
        total: countDiagramList.get({ $search: search }).total,
        diagrams: selectDiagramList.all({ $search: search, $limit: limit, $offset: offset }),
      };
    },

    /**
     * People for the backoffice, most recently seen first. Private ids are
     * left out; `search` matches part of the name or a whole public id.
     * @returns {{total: number, users: object[]}}
     */
    listUsers({ search = "", limit = 50, offset = 0 } = {}) {
      return {
        total: countUserList.get({ $search: search }).total,
        users: selectUserList.all({ $search: search, $limit: limit, $offset: offset }),
      };
    },

    /** Totals for the backoffice, plus what removeOrphanedImages() would free. */
    stats() {
      const orphaned = selectOrphanedImages.get({ $before: Date.now() - DAY_MS });
      return {
        ...selectTotals.get(),
        orphanedImages: orphaned.count,
        orphanedImageSize: orphaned.size,
        databaseSize: statSync(dbPath).size,
      };
    },

    /** Deletes images nothing refers to any more. Returns how many were removed. */
    removeOrphanedImages() {
      return Number(deleteOrphanedImages.run({ $before: Date.now() - DAY_MS }).changes);
    },

    /**
     * Records that a user was just active: creates them if new, updates their
     * display name when one is given, and notes the (hashed) address they
     * came from.
     * @param {object} sighting
     * @param {string} sighting.id the user's private id
     * @param {string} [sighting.name] their current display name, if known
     * @param {string} [sighting.addressHash] keyed hash of their network address
     * @returns {{publicId: string}} the id other people may see for this user
     */
    seeUser({ id, name, addressHash }) {
      const now = Date.now();
      let known = recentlySeen.get(id);
      if (!known) {
        const row = selectUser.get(id);
        known = row
          ? { publicId: row.publicId, name: row.displayName, addresses: new Map(), writtenAt: 0 }
          : { publicId: randomUUID(), name: name ?? "Guest", addresses: new Map(), writtenAt: now };
        if (!row) insertUser.run(id, known.publicId, known.name, now, now);
        recentlySeen.set(id, known);
      }

      const renamed = name !== undefined && name !== known.name;
      if (renamed || now - known.writtenAt >= SEEN_WRITE_INTERVAL_MS) {
        touchUser.run(now, renamed ? name : null, id);
        known.writtenAt = now;
        if (renamed) known.name = name;
      }
      if (addressHash && now - (known.addresses.get(addressHash) ?? 0) >= SEEN_WRITE_INTERVAL_MS) {
        upsertAddress.run(id, addressHash, now, now);
        known.addresses.set(addressHash, now);
      }
      return { publicId: known.publicId };
    },

    /** Forgets user-to-address links not seen for `days` days. Returns how many were removed. */
    pruneAddresses(days) {
      const result = deleteOldAddresses.run(Date.now() - days * DAY_MS);
      for (const known of recentlySeen.values()) known.addresses.clear();
      return Number(result.changes);
    },

    /**
     * The secret that address hashes are keyed with. Made up on first use and
     * kept in the database, so hashes stay comparable across restarts.
     */
    addressSecret() {
      insertSetting.run("address_secret", randomBytes(32).toString("hex"));
      return selectSetting.get("address_secret").value;
    },

    close() {
      db.close();
    },
  };
}
