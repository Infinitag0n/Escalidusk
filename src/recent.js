// The diagrams this browser has opened, most recent first. Kept in the
// browser only: the server has no list of diagrams to offer anyone, so this
// is how people find their way back, and how they pick a diagram to link to.

const KEY = "escalidusk:recent";
const MAX = 50;

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(list) ? list.filter((entry) => typeof entry?.id === "string") : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Storage can be full or blocked; the list is a convenience.
  }
}

/**
 * Records that a diagram was just opened here (or brings an existing record
 * up to date and moves it to the top).
 * @param {object} diagram
 * @param {string} diagram.id the id it was opened with: editing or read-only
 * @param {boolean} diagram.readOnly whether that id is the read-only one
 * @param {string | null} [diagram.viewId] its read-only id, when opened for editing
 * @param {string} [diagram.name]
 */
export function rememberDiagram({ id, readOnly, viewId, name }) {
  const list = read();
  const previous = list.find((entry) => entry.id === id);
  const entry = {
    id,
    readOnly,
    viewId: viewId ?? previous?.viewId ?? null,
    name: name ?? previous?.name ?? "",
    openedAt: Date.now(),
  };
  write([entry, ...list.filter((other) => other.id !== id)]);
}

/** Changes details of a diagram already in the list, without moving it. */
export function updateDiagram(id, changes) {
  const list = read();
  if (!list.some((entry) => entry.id === id)) return;
  write(list.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)));
}

export function forgetDiagram(id) {
  write(read().filter((entry) => entry.id !== id));
}

/**
 * The list to show. A diagram opened both ways (for editing and through its
 * read-only link) appears once, as the one that can be edited.
 */
export function recentDiagrams() {
  const list = read();
  const editable = new Set(list.filter((entry) => !entry.readOnly).map((entry) => entry.viewId));
  return list.filter((entry) => !(entry.readOnly && editable.has(entry.id)));
}

/**
 * The editing id this browser knows for a diagram, given its read-only id.
 * Links between diagrams always carry the read-only id, so that they never
 * hand out edit access; this is how someone who can already edit the target
 * still lands on the editable page.
 */
export function editIdFor(viewId) {
  return read().find((entry) => !entry.readOnly && entry.viewId === viewId)?.id ?? null;
}

/** The read-only id to use when linking to a diagram from the list, if it has one. */
export function linkTargetOf(entry) {
  return entry.readOnly ? entry.id : entry.viewId;
}
