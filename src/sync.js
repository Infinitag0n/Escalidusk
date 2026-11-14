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
// Changes that arrived live from a collaborator are normally saved by that
// collaborator. Everyone else waits this long (plus some jitter, so they do
// not all act at once) before saving them as a fallback.
const REMOTE_SAVE_DELAY_MS = 5000;
const REMOTE_SAVE_JITTER_MS = 2000;
// After an image could not be fetched (usually: not uploaded yet), wait before trying again.
const FILE_RETRY_MS = 2000;
// Deleted elements are kept as markers so a merge with an out-of-date copy
// cannot bring them back. After this long they are dropped from saves.
const DELETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_BACKGROUND = "#ffffff";

/**
 * The part of Excalidraw's app state that belongs to the diagram and is
 * saved with it. Everything else (zoom, theme, selection...) is per viewer.
 */
export function sharedSettings(appState) {
  return {
    viewBackgroundColor: appState?.viewBackgroundColor ?? DEFAULT_BACKGROUND,
    name: appState?.name ?? "",
  };
}

/** Fingerprint of everything that gets saved; equal keys mean nothing to save. */
export function sceneKey(elements, settings) {
  return `${hashElementsVersion(elements)}:${JSON.stringify(settings)}`;
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
 * A read-only diagram never saves; it only pulls in remote changes.
 *
 * With live collaboration (see live.js) changes also arrive directly from
 * other people. Saving stays the job of whoever made a change; the others
 * are told when that save lands and only save themselves as a fallback.
 */
export class DiagramSync {
  #id;
  #api;
  #version;
  #savedKey;
  #savedSettings; // shared settings as last known to be on the server
  #remoteKey = null; // sceneKey right after applying a live update, if there were no local edits
  #lastKey = null; // sceneKey seen by the previous handleChange that scheduled a save
  #onStatus;
  #onViewId;
  #userId;
  #readOnly;
  #status = "saved";
  #syncedFiles;
  #loadingFiles = new Set();
  #fileRetryAt = new Map();
  #dirty = false;
  #remoteOnly = false; // dirty only because of collaborators' live changes
  #dirtySince = 0;
  #saving = false;
  #failed = false; // the last save failed and a retry is scheduled
  #refreshing = false;
  #disposed = false;
  #timer = null;

  /**
   * @param {object} options
   * @param {string} options.id diagram UUID
   * @param {object} options.api Excalidraw imperative API
   * @param {number} options.version server version the scene was loaded at (0 = not stored yet)
   * @param {string} options.savedKey sceneKey() of the scene as loaded
   * @param {object} options.savedSettings sharedSettings() of the scene as loaded
   * @param {Iterable<string>} options.syncedFileIds image ids already on the server
   * @param {(status: "saved" | "unsaved" | "saving" | "error") => void} options.onStatus
   * @param {boolean} [options.readOnly] opened through a read-only link
   * @param {(viewId: string) => void} [options.onViewId] told the read-only id after each save
   * @param {string} [options.userId] this browser's private user id, sent with saves
   */
  constructor({
    id,
    api,
    version,
    savedKey,
    savedSettings,
    syncedFileIds,
    onStatus,
    readOnly = false,
    onViewId,
    userId,
  }) {
    this.#id = id;
    this.#api = api;
    this.#version = version;
    this.#savedKey = savedKey;
    this.#savedSettings = savedSettings;
    this.#syncedFiles = new Set(syncedFileIds);
    this.#onStatus = onStatus;
    this.#readOnly = readOnly;
    this.#onViewId = onViewId;
    this.#userId = userId;
  }

  /** Call from Excalidraw's onChange. Cheap when nothing relevant changed. */
  handleChange(elements, appState, files) {
    if (this.#disposed || this.#readOnly) return;
    const key = sceneKey(elements, sharedSettings(appState));
    const changed = key !== this.#savedKey;
    if (!changed && !this.#hasFilesToUpload(elements, files)) return;

    if (!this.#dirty) {
      this.#dirty = true;
      this.#dirtySince = Date.now();
    }
    // The scene is exactly what a collaborator's live update left behind:
    // nothing of our own to save.
    this.#remoteOnly = changed && key === this.#remoteKey;

    // While a failed save waits for its retry, leave the error showing and the
    // retry timer alone; otherwise every further change would retry at once.
    if (this.#failed) return;
    // onChange also fires when nothing we save has changed (selection, zoom...).
    // Only a real change may push the pending save back.
    if (key === this.#lastKey && this.#timer) return;
    this.#lastKey = key;

    if (this.#remoteOnly) {
      this.#schedule(REMOTE_SAVE_DELAY_MS + Math.random() * REMOTE_SAVE_JITTER_MS);
      return;
    }
    if (!this.#saving) this.#setStatus("unsaved");
    const maxWait = this.#dirtySince + MAX_SAVE_WAIT_MS - Date.now();
    this.#schedule(Math.max(0, Math.min(SAVE_DELAY_MS, maxWait)));
  }

  /** True while there are changes of our own that the server does not have yet. */
  hasUnsaved() {
    return this.#saving || (this.#dirty && !this.#remoteOnly);
  }

  /** Saves now if there is anything to save. Safe to call at any time. */
  async flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    // A save already in flight re-checks #dirty when it finishes.
    if (this.#saving || this.#disposed || !this.#dirty) return;

    this.#saving = true;
    this.#failed = false;
    try {
      while (this.#dirty && !this.#disposed) {
        this.#dirty = false;
        if (!this.#remoteOnly) this.#setStatus("saving");
        await this.#saveOnce();
      }
      this.#remoteOnly = false;
      this.#setStatus("saved");
    } catch (error) {
      console.error("Saving the diagram failed", error);
      this.#dirty = true;
      this.#remoteOnly = false;
      this.#failed = true;
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

      const wasClean = !this.#dirty && this.#currentKey() === this.#savedKey;
      const { key, identical } = this.#merge(remote);
      // Nothing of our own to add, so what we now hold is what is stored.
      if (wasClean || identical) this.#markSaved(key);
    } catch (error) {
      console.warn("Could not check for remote changes", error);
    } finally {
      this.#refreshing = false;
    }
  }

  /**
   * Applies a collaborator's live update: changed elements and/or settings.
   * Works on read-only pages too, which is how viewers follow along.
   */
  applyRemote({ elements, settings }) {
    if (this.#disposed) return;
    const api = this.#api;
    const local = api.getSceneElementsIncludingDeleted();
    const localSettings = sharedSettings(api.getAppState());
    const before = sceneKey(local, localSettings);
    const hadNoLocalEdits = before === this.#savedKey || before === this.#remoteKey;

    const merged = elements?.length
      ? reconcileElements(local, restoreElements(elements, null), api.getAppState())
      : local;
    const mergedSettings = { ...localSettings, ...settings };
    api.updateScene({
      ...(elements?.length ? { elements: merged } : {}),
      ...(settings ? { appState: mergedSettings } : {}),
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.#remoteKey = hadNoLocalEdits ? sceneKey(merged, mergedSettings) : null;
    this.#loadMissingFiles(merged);
  }

  /**
   * A collaborator's save landed on the server as `version`. `key` is the
   * sceneKey of what they saved. If we hold exactly that, we are up to date
   * and have nothing left to save; otherwise we fetch what we are missing.
   */
  noteRemoteSave(version, key, viewId) {
    if (this.#disposed) return;
    if (viewId) this.#onViewId?.(viewId);
    if (version <= this.#version) return;
    if (this.#currentKey() === key) {
      this.#version = version;
      this.#savedSettings = sharedSettings(this.#api.getAppState());
      this.#markSaved(key);
    } else if (!this.hasUnsaved()) {
      this.refresh();
    }
    // Images are uploaded just before a save, so any we failed to fetch earlier exist now.
    this.#fileRetryAt.clear();
    this.#loadMissingFiles(this.#api.getSceneElementsIncludingDeleted());
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#timer);
  }

  #currentKey() {
    return sceneKey(
      this.#api.getSceneElementsIncludingDeleted(),
      sharedSettings(this.#api.getAppState()),
    );
  }

  /** Records that the scene with this key is what the server holds. */
  #markSaved(key) {
    this.#savedKey = key;
    if (this.#saving) return; // the save loop notices on its next pass
    this.#dirty = false;
    this.#remoteOnly = false;
    this.#failed = false;
    clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#readOnly) this.#setStatus("saved");
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
    const settings = sharedSettings(this.#api.getAppState());
    const key = sceneKey(elements, settings);

    // Images first, so a stored scene never points at an image the server lacks.
    const files = this.#api.getFiles();
    for (const fileId of usedFileIds(elements)) {
      if (this.#syncedFiles.has(fileId) || !files[fileId]) continue;
      await uploadFile(this.#id, files[fileId]);
      this.#syncedFiles.add(fileId);
    }
    if (key === this.#savedKey) return;

    const cutoff = Date.now() - DELETED_TTL_MS;
    const result = await saveDiagram(
      this.#id,
      this.#version,
      {
        elements: elements.filter((element) => !element.isDeleted || element.updated > cutoff),
        appState: settings,
      },
      key,
      this.#userId,
    );

    if (result.ok) {
      this.#version = result.version;
      this.#savedKey = key;
      this.#savedSettings = settings;
      this.#onViewId?.(result.viewId);
      return;
    }

    // The server copy moved on. Merge it into the canvas and, unless that
    // leaves us holding exactly what is stored, let the save loop try again
    // on top of the new version.
    if (!result.current) {
      this.#version = 0;
      this.#dirty = true;
      return;
    }
    const merged = this.#merge(result.current);
    if (merged.identical) this.#savedKey = merged.key;
    else this.#dirty = true;
  }

  /**
   * Merges a stored diagram into the canvas.
   * @returns `key`: sceneKey of the merged scene; `identical`: whether the
   * merged scene is exactly the stored one (nothing of ours was added).
   */
  #merge(remote) {
    const api = this.#api;

    // Settings merge field by field: a value changed here since the last save
    // wins, anything untouched here takes the server's value.
    const local = sharedSettings(api.getAppState());
    const remoteSettings = sharedSettings(remote.scene.appState);
    const settings = {};
    for (const field of Object.keys(remoteSettings)) {
      settings[field] =
        local[field] === this.#savedSettings[field] ? remoteSettings[field] : local[field];
    }
    this.#savedSettings = remoteSettings;

    const remoteElements = restoreElements(remote.scene.elements, null);
    const merged = reconcileElements(
      api.getSceneElementsIncludingDeleted(),
      remoteElements,
      api.getAppState(),
    );
    api.updateScene({
      elements: merged,
      appState: settings,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.#version = remote.version;
    this.#remoteKey = null;
    this.#loadMissingFiles(merged);

    const key = sceneKey(merged, settings);
    return { key, identical: key === sceneKey(remoteElements, remoteSettings) };
  }

  #loadMissingFiles(elements) {
    const have = this.#api.getFiles();
    const now = Date.now();
    for (const fileId of usedFileIds(elements)) {
      if (have[fileId] || this.#loadingFiles.has(fileId)) continue;
      if ((this.#fileRetryAt.get(fileId) ?? 0) > now) continue;
      this.#loadingFiles.add(fileId);
      fetchFile(this.#id, fileId)
        .then((file) => {
          if (this.#disposed) return;
          this.#syncedFiles.add(fileId);
          this.#fileRetryAt.delete(fileId);
          this.#api.addFiles([file]);
        })
        .catch(() => {
          // Usually the image has not been uploaded yet; it is fetched again
          // on a later update or once its owner's save lands.
          this.#fileRetryAt.set(fileId, Date.now() + FILE_RETRY_MS);
        })
        .finally(() => this.#loadingFiles.delete(fileId));
    }
  }
}
