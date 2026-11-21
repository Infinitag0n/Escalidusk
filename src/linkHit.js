// Working out whether a point on the canvas is on a link to another diagram
// (a hexagon; see diagramLinks.js). Excalidraw does not tell us what was
// clicked, so the hexagon's own outline is tested. Plain geometry, kept
// apart from anything that needs a browser.

/** The diagram a link element points to, as `{ view, edit? }`, or null for any other element. */
export function linkTargetOfElement(element) {
  const marker = element.customData?.escalidusk?.diagramLink;
  if (typeof marker === "string") return { view: marker }; // links made before editing ids could be carried
  return typeof marker?.view === "string" ? { view: marker.view, edit: marker.edit } : null;
}

/** Whether a point is inside a closed outline given as [x, y] corners. */
function insideOutline(corners, x, y) {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const [xi, yi] = corners[i];
    const [xj, yj] = corners[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Whether a point (in scene coordinates) is inside a line element's outline,
 * wherever it has been moved, stretched or turned to.
 */
export function outlineContains(element, point) {
  const points = element.points;
  if (!Array.isArray(points) || points.length < 3) return false;
  // A line's points are relative to its position; it turns about the middle of their bounds.
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const centreX = element.x + (Math.min(...xs) + Math.max(...xs)) / 2;
  const centreY = element.y + (Math.min(...ys) + Math.max(...ys)) / 2;
  // Turn the point back by the element's angle rather than turning every corner.
  const angle = -(element.angle ?? 0);
  const dx = point.x - centreX;
  const dy = point.y - centreY;
  const x = centreX + dx * Math.cos(angle) - dy * Math.sin(angle);
  const y = centreY + dx * Math.sin(angle) + dy * Math.cos(angle);
  return insideOutline(
    points.map(([px, py]) => [element.x + px, element.y + py]),
    x,
    y,
  );
}

/**
 * The link under a point, if any: the topmost one when several overlap.
 * @param {readonly object[]} elements the scene, bottom first
 * @param {{x: number, y: number}} point in scene coordinates
 * @returns {{element: object, target: {view: string, edit?: string}} | null}
 */
export function diagramLinkAt(elements, point) {
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index];
    if (element.isDeleted) continue;
    const target = linkTargetOfElement(element);
    if (target && outlineContains(element, point)) return { element, target };
  }
  return null;
}

/**
 * Whether everything selected is part of one link: its hexagon, its label,
 * or both. False when nothing is selected, or when the link is selected as
 * part of something larger, such as a group someone put it in.
 * @param {readonly object[]} elements the scene
 * @param {Record<string, boolean>} selectedIds as in Excalidraw's app state
 * @param {object} hexagon the link's hexagon element
 */
export function onlyLinkSelected(elements, selectedIds, hexagon) {
  // The hexagon and its label were grouped when the link was made; that group comes first.
  const group = hexagon.groupIds?.[0];
  const selected = elements.filter((element) => selectedIds[element.id] && !element.isDeleted);
  return (
    selected.length > 0 &&
    selected.every((element) => element.id === hexagon.id || (group && element.groupIds?.includes(group)))
  );
}
