const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isDiagramId(value) {
  return UUID_RE.test(value);
}

/** A fresh random UUID: used for new diagrams and for a browser's user id. */
export function newDiagramId() {
  // crypto.randomUUID only exists on HTTPS/localhost; self-hosted setups are
  // often plain HTTP on a LAN, so fall back to building a v4 UUID by hand.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function failure(response) {
  return new Error(`Request failed: ${response.status} ${response.statusText}`);
}

/**
 * @returns the stored diagram `{ id, readOnly, viewId?, version, updatedAt, scene }`,
 * or null if it does not exist yet. `viewId` (the read-only id) is only
 * present when the diagram was opened through its editing id.
 */
export async function fetchDiagram(id) {
  const response = await fetch(`/api/diagrams/${id}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response);
  return response.json();
}

/**
 * `key` is our own fingerprint of the scene; the server passes it on to
 * anyone else who has the diagram open. `userId` is this browser's private
 * user id, recorded as the diagram's latest editor.
 * @returns `{ ok: true, version, viewId }` when saved, or `{ ok: false, current }`
 * when the server holds a different version (`current` is null if the diagram vanished).
 */
export async function saveDiagram(id, baseVersion, scene, key, userId) {
  const response = await fetch(`/api/diagrams/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(userId ? { "X-User-Id": userId } : {}) },
    body: JSON.stringify({ baseVersion, key, ...scene }),
  });
  if (response.status === 409) {
    const { current } = await response.json();
    return { ok: false, current };
  }
  if (!response.ok) throw await failure(response);
  const { version, viewId } = await response.json();
  return { ok: true, version, viewId };
}

/** Uploads one Excalidraw file record (`{ id, mimeType, dataURL }`) as raw bytes. */
export async function uploadFile(diagramId, file) {
  const blob = await (await fetch(file.dataURL)).blob();
  const response = await fetch(`/api/diagrams/${diagramId}/files/${file.id}`, {
    method: "PUT",
    headers: { "Content-Type": file.mimeType },
    body: blob,
  });
  if (!response.ok) throw await failure(response);
}

/** Downloads a stored image and returns it in Excalidraw's file record shape. */
export async function fetchFile(diagramId, fileId) {
  const response = await fetch(`/api/diagrams/${diagramId}/files/${fileId}`);
  if (!response.ok) throw await failure(response);
  const blob = await response.blob();
  const dataURL = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { id: fileId, mimeType: blob.type, dataURL, created: Date.now() };
}
