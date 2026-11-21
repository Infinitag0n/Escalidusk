import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { linkTargetOfElement } from "./linkHit.js";

export { linkTargetOfElement };

// A link to another diagram is drawn as a hexagon with the diagram's name in
// it. Excalidraw has no way to add new kinds of shape, so the hexagon is one
// of its own closed lines (which it fills like any shape) grouped with a text
// element. Both carry a marker in `customData` naming the diagram they point
// to by its read-only id. The hexagon's marker may also carry the editing id,
// so that people who can edit this diagram can edit the linked one too; the
// server removes it from anything it sends to a read-only reader.
//
// The hexagon is opened by clicking it (see Editor.jsx), going by that
// marker. It deliberately has no Excalidraw `link` of its own: that would
// put Excalidraw's link icon beside it, and the shape itself is the link.

const FILL = "#d0bfff";
const MIN_WIDTH = 220;
const HEIGHT = 110;
const SIDE_ROOM = 120; // space the slanted sides take away from the label
const FONT_SIZE = 20;
const UNTITLED = "Untitled";

const labelFor = (name) => name.trim() || UNTITLED;

/** An element with some fields changed, as a new version so the change is saved and reaches collaborators. */
const changed = (element, fields) => ({
  ...element,
  ...fields,
  version: element.version + 1,
  versionNonce: crypto.getRandomValues(new Uint32Array(1))[0],
  updated: Date.now(),
});

/** The size a piece of label text takes up, as Excalidraw measures it. */
function measure(text, { fontSize = FONT_SIZE, fontFamily } = {}) {
  const [element] = convertToExcalidrawElements([
    { type: "text", text, x: 0, y: 0, fontSize, ...(fontFamily ? { fontFamily } : {}) },
  ]);
  return { width: element.width, height: element.height };
}

/** The read-only id a link's label element points to, or undefined for any other element. */
const labelTargetOf = (element) => element.customData?.escalidusk?.diagramLinkLabel;

/**
 * Builds the two elements of a link to another diagram, centred on a point.
 * @param {object} options
 * @param {string} options.view the target diagram's read-only id
 * @param {string} [options.edit] its editing id, to let editors of this diagram edit it too
 * @param {string} options.name the target diagram's name
 * @param {{x: number, y: number}} options.centre in scene coordinates
 * @returns {{elements: object[], groupId: string}}
 */
export function createDiagramLink({ view, edit, name, centre }) {
  const text = labelFor(name);
  const measured = measure(text);
  const width = Math.max(MIN_WIDTH, Math.ceil(measured.width) + SIDE_ROOM);
  const quarter = width / 4;
  const half = HEIGHT / 2;
  const groupId = crypto.getRandomValues(new Uint32Array(2)).join("-");

  const elements = convertToExcalidrawElements([
    {
      type: "line",
      // A line's position is its first point: the hexagon's left corner.
      x: centre.x - width / 2,
      y: centre.y,
      // Stated outright: left to itself the conversion assumes a default size.
      width,
      height: HEIGHT,
      points: [
        [0, 0],
        [quarter, -half],
        [3 * quarter, -half],
        [width, 0],
        [3 * quarter, half],
        [quarter, half],
        [0, 0],
      ],
      backgroundColor: FILL,
      fillStyle: "solid",
      groupIds: [groupId],
      customData: { escalidusk: { diagramLink: { view, ...(edit ? { edit } : {}) } } },
    },
    {
      type: "text",
      text,
      x: centre.x - measured.width / 2,
      y: centre.y - measured.height / 2,
      fontSize: FONT_SIZE,
      groupIds: [groupId],
      customData: { escalidusk: { diagramLinkLabel: view } },
    },
  ]);
  return { elements, groupId };
}

/** The read-only ids of every diagram the scene links to. */
export function linkedDiagramIds(elements) {
  const ids = new Set();
  for (const element of elements) {
    const target = labelTargetOf(element);
    if (target && !element.isDeleted) ids.add(target);
  }
  return [...ids];
}

/**
 * Brings link labels up to date with their diagrams' current names.
 * @param {readonly object[]} elements the whole scene
 * @param {Record<string, {name?: string} | null>} summaries by read-only id; diagrams
 *   that are missing or deleted keep whatever label they have
 * @returns {object[] | null} the scene with relabelled elements swapped in, or null if nothing changed
 */
export function withCurrentNames(elements, summaries) {
  let relabelled = false;
  const next = elements.map((element) => {
    const target = labelTargetOf(element);
    const name = target && !element.isDeleted ? summaries[target]?.name : undefined;
    if (name === undefined) return element;
    const text = labelFor(name);
    if (element.text === text) return element;

    const size = measure(text, element);
    relabelled = true;
    return changed(element, {
      text,
      originalText: text,
      ...size,
      // Keep the label centred where it was.
      x: element.x + element.width / 2 - size.width / 2,
      y: element.y + element.height / 2 - size.height / 2,
    });
  });
  return relabelled ? next : null;
}

/**
 * Takes Excalidraw's own `link` off hexagons that have one: those made
 * before the shape itself became the link. With it they would still show
 * Excalidraw's link icon. The elements are otherwise left exactly as they
 * are, version included: this changes how they are shown here, and what is
 * stored catches up the next time the hexagon is saved for another reason.
 * @param {readonly object[]} elements the whole scene
 * @returns {object[] | null} the scene without those links, or null if there were none
 */
export function withoutPlainLinks(elements) {
  let found = false;
  const next = elements.map((element) => {
    if (!element.link || !linkTargetOfElement(element)) return element;
    found = true;
    return { ...element, link: null };
  });
  return found ? next : null;
}
