import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
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
