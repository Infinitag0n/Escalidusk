// What this browser knows about diagrams, kept in its local storage:
//
// - the diagrams it has opened, most recent first. The server has no list of
//   diagrams to offer anyone, so this is how people find their way back, and
//   how they pick a diagram to link to;
// - which diagrams it can edit: for a read-only id, the editing id it has
//   seen for the same diagram. This is what lets a read-only page offer
//   "Edit", and it is kept even when a diagram is removed from the list.

const RECENT_KEY = "escalidusk:recent";
const EDIT_IDS_KEY = "escalidusk:edit-ids";
const MAX_RECENT = 50;

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; all of this is a convenience.
  }
}

function readRecent() {
  const list = load(RECENT_KEY, []);
  return Array.isArray(list) ? list.filter((entry) => typeof entry?.id === "string") : [];
}

function readEditIds() {
  const map = load(EDIT_IDS_KEY, {});
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

/**
 * Records that a diagram was just opened here (or brings an existing record
 * up to date and moves it to the top).
 * @param {object} diagram
 * @param {string} diagram.id the id it is worked on with: editing, or read-only
 *   when this browser cannot edit it
 * @param {boolean} diagram.readOnly whether that id is the read-only one
 * @param {string | null} [diagram.viewId] its read-only id, when `id` is the editing one
 * @param {string} [diagram.name]
 */
export function rememberDiagram({ id, readOnly, viewId, name }) {
  const list = readRecent();
  const previous = list.find((entry) => entry.id === id);
  const entry = {
    id,
    readOnly,
    viewId: viewId ?? previous?.viewId ?? null,
    name: name ?? previous?.name ?? "",
    openedAt: Date.now(),
  };
  store(RECENT_KEY, [entry, ...list.filter((other) => other.id !== id)].slice(0, MAX_RECENT));
  if (!readOnly && entry.viewId) rememberEditId(entry.viewId, id);
}

/** Changes details of a diagram already in the list, without moving it. */
export function updateDiagram(id, changes) {
  const list = readRecent();
  if (!list.some((entry) => entry.id === id)) return;
  store(
    RECENT_KEY,
    list.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)),
  );
}

/** Takes a diagram off the list. What this browser may edit is not affected. */
export function forgetDiagram(id) {
  store(
    RECENT_KEY,
    readRecent().filter((entry) => entry.id !== id),
  );
}

/**
 * The list to show. A diagram opened both ways (for editing and through its
 * read-only link) appears once, as the one that can be edited.
 */
export function recentDiagrams() {
  const list = readRecent();
  const editable = new Set(list.filter((entry) => !entry.readOnly).map((entry) => entry.viewId));
  return list.filter((entry) => !(entry.readOnly && editable.has(entry.id)));
}

/** Notes that this browser can edit the diagram with this read-only id. */
export function rememberEditId(viewId, editId) {
  const map = readEditIds();
  if (map[viewId] === editId) return;
  store(EDIT_IDS_KEY, { ...map, [viewId]: editId });
}

/** Drops what is known about editing a diagram, by either of its ids (it was deleted, or the id was wrong). */
export function forgetEditId(anyId) {
  const map = readEditIds();
  store(
    EDIT_IDS_KEY,
    Object.fromEntries(
      Object.entries(map).filter(([viewId, editId]) => viewId !== anyId && editId !== anyId),
    ),
  );
}

/** The editing id this browser knows for a diagram, given its read-only id. */
export function editIdFor(viewId) {
  return readEditIds()[viewId] ?? null;
}

/** The read-only id this browser knows for a diagram, given its editing id. */
export function viewIdFor(editId) {
  const found = Object.entries(readEditIds()).find(([, known]) => known === editId);
  return found ? found[0] : null;
}

/** The read-only id of a diagram from the list, if it has one yet. */
export function linkTargetOf(entry) {
  return entry.readOnly ? entry.id : entry.viewId;
}
