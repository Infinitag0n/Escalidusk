import {
  CaptureUpdateAction,
  hashElementsVersion,
  reconcileElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import { fetchDiagram, fetchFile, saveDiagram, uploadFile } from "./api.js";

const SAVE_DELAY_MS = 1000; // quiet time after the last change before saving
const MAX_SAVE_WAIT_MS = 5000; // ...but never hold unsaved changes longer than this
const RETRY_DELAY_MS = 5000;
// Deleted elements are kept as markers so a merge with an out-of-date copy
// cannot bring them back. After this long they are dropped from saves.
const DELETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_BACKGROUND = "#ffffff";

/** Fingerprint of everything that gets saved; equal keys mean nothing to save. */
export function sceneKey(elements, background) {
  return `${hashElementsVersion(elements)}:${background}`;
}

function usedFileIds(elements) {
  const ids = new Set();
  for (const element of elements) {
    if (element.type === "image" && element.fileId && !element.isDeleted) {
      ids.add(element.fileId);
    }
  }
  return ids;
}

/** Downloads every image the scene uses. Failures are logged and skipped. */
export async function fetchSceneFiles(diagramId, elements) {
  const files = {};
  await Promise.all(
    [...usedFileIds(elements)].map(async (fileId) => {
      try {
        files[fileId] = await fetchFile(diagramId, fileId);
      } catch (error) {
        console.warn(`Could not load image ${fileId}`, error);
      }
    }),
  );
  return files;
}

/**
 * Keeps one open diagram in step with the server: debounced autosave,
 * image upload, and merging when the server copy has moved on.
 */
export class DiagramSync {
  #id;
  #api;
  #version;
  #savedKey;
  #onStatus;
  #status = "saved";
  #syncedFiles;
  #loadingFiles = new Set();
  #dirty = false;
  #dirtySince = 0;
  #saving = false;
  #refreshing = false;
  #disposed = false;
  #timer = null;

  /**
   * @param {object} options
   * @param {string} options.id diagram UUID
   * @param {object} options.api Excalidraw imperative API
   * @param {number} options.version server version the scene was loaded at (0 = not stored yet)
   * @param {string} options.savedKey sceneKey() of the scene as loaded
   * @param {Iterable<string>} options.syncedFileIds image ids already on the server
   * @param {(status: "saved" | "unsaved" | "saving" | "error") => void} options.onStatus
   */
  constructor({ id, api, version, savedKey, syncedFileIds, onStatus }) {
    this.#id = id;
    this.#api = api;
    this.#version = version;
    this.#savedKey = savedKey;
    this.#syncedFiles = new Set(syncedFileIds);
    this.#onStatus = onStatus;
  }

  /** Call from Excalidraw's onChange. Cheap when nothing relevant changed. */
  handleChange(elements, appState, files) {
    if (this.#disposed) return;
    const changed = sceneKey(elements, appState.viewBackgroundColor) !== this.#savedKey;
    if (!changed && !this.#hasFilesToUpload(elements, files)) return;

    if (!this.#dirty) {
      this.#dirty = true;
      this.#dirtySince = Date.now();
    }
    if (!this.#saving) this.#setStatus("unsaved");
    const maxWait = this.#dirtySince + MAX_SAVE_WAIT_MS - Date.now();
    this.#schedule(Math.max(0, Math.min(SAVE_DELAY_MS, maxWait)));
  }

  hasUnsaved() {
    return this.#dirty || this.#saving;
  }

  /** Saves now if there is anything to save. Safe to call at any time. */
  async flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    // A save already in flight re-checks #dirty when it finishes.
    if (this.#saving || this.#disposed || !this.#dirty) return;

    this.#saving = true;
    try {
      while (this.#dirty && !this.#disposed) {
        this.#dirty = false;
        this.#setStatus("saving");
        await this.#saveOnce();
      }
      this.#setStatus("saved");
    } catch (error) {
      console.error("Saving the diagram failed", error);
      this.#dirty = true;
      this.#setStatus("error");
      this.#schedule(RETRY_DELAY_MS);
    } finally {
      this.#saving = false;
    }
  }

  /** Pulls in changes saved from elsewhere (another tab or person). */
  async refresh() {
    if (this.#saving || this.#refreshing || this.#disposed) return;
    this.#refreshing = true;
    try {
      const remote = await fetchDiagram(this.#id);
      if (!remote || remote.version <= this.#version || this.#saving || this.#disposed) return;

      const background = this.#api.getAppState().viewBackgroundColor;
      const clean =
        !this.#dirty &&
        sceneKey(this.#api.getSceneElementsIncludingDeleted(), background) === this.#savedKey;
      const merged = this.#merge(remote, { adoptAppState: clean });
      if (clean) {
        // Nothing local to add, so the merged scene is exactly what is stored.
        const remoteBackground = remote.scene.appState?.viewBackgroundColor ?? background;
        this.#savedKey = sceneKey(merged, remoteBackground);
      }
    } catch (error) {
      console.warn("Could not check for remote changes", error);
    } finally {
      this.#refreshing = false;
    }
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#timer);
  }

  #schedule(delay) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), delay);
  }

  #setStatus(status) {
    if (status === this.#status) return;
    this.#status = status;
    this.#onStatus(status);
  }

  #hasFilesToUpload(elements, files) {
    for (const fileId of usedFileIds(elements)) {
      if (!this.#syncedFiles.has(fileId) && files[fileId]) return true;
    }
    return false;
  }

  async #saveOnce() {
    const elements = this.#api.getSceneElementsIncludingDeleted();
    const background = this.#api.getAppState().viewBackgroundColor;
    const key = sceneKey(elements, background);

    // Images first, so a stored scene never points at an image the server lacks.
    const files = this.#api.getFiles();
    for (const fileId of usedFileIds(elements)) {
      if (this.#syncedFiles.has(fileId) || !files[fileId]) continue;
      await uploadFile(this.#id, files[fileId]);
      this.#syncedFiles.add(fileId);
    }
    if (key === this.#savedKey) return;

    const cutoff = Date.now() - DELETED_TTL_MS;
    const result = await saveDiagram(this.#id, this.#version, {
      elements: elements.filter((element) => !element.isDeleted || element.updated > cutoff),
      appState: { viewBackgroundColor: background },
    });

    if (result.ok) {
      this.#version = result.version;
      this.#savedKey = key;
      return;
    }

    // The server copy moved on. Merge it into the canvas and let the save
    // loop try again on top of the new version.
    if (result.current) {
      this.#merge(result.current, { adoptAppState: false });
    } else {
      this.#version = 0;
    }
    this.#dirty = true;
  }

  #merge(remote, { adoptAppState }) {
    const api = this.#api;
    const merged = reconcileElements(
      api.getSceneElementsIncludingDeleted(),
      restoreElements(remote.scene.elements, null),
      api.getAppState(),
    );
    const background = remote.scene.appState?.viewBackgroundColor;
    api.updateScene({
      elements: merged,
      ...(adoptAppState && background ? { appState: { viewBackgroundColor: background } } : {}),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.#version = remote.version;
    this.#loadMissingFiles(merged);
    return merged;
  }

  #loadMissingFiles(elements) {
    const have = this.#api.getFiles();
    for (const fileId of usedFileIds(elements)) {
      if (have[fileId] || this.#loadingFiles.has(fileId)) continue;
      this.#loadingFiles.add(fileId);
      fetchFile(this.#id, fileId)
        .then((file) => {
          if (this.#disposed) return;
          this.#syncedFiles.add(fileId);
          this.#api.addFiles([file]);
        })
        .catch((error) => console.warn(`Could not load image ${fileId}`, error))
        .finally(() => this.#loadingFiles.delete(fileId));
    }
  }
}
