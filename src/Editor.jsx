import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, MainMenu, restoreElements, useDevice } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { fetchDiagram, isDiagramId } from "./api.js";
import { DEFAULT_BACKGROUND, DiagramSync, fetchSceneFiles, sceneKey } from "./sync.js";

// Per-browser preferences; these are not part of the shared diagram.
const THEME_KEY = "escalidusk:theme";
const LIBRARY_KEY = "escalidusk:library";

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; preferences are best-effort.
  }
}

async function loadDiagram(id) {
  const diagram = await fetchDiagram(id);
  const elements = restoreElements(diagram?.scene.elements ?? [], null);
  const background = diagram?.scene.appState?.viewBackgroundColor ?? DEFAULT_BACKGROUND;
  const files = await fetchSceneFiles(id, elements);
  return {
    readOnly: diagram?.readOnly ?? false,
    viewId: diagram?.viewId ?? null,
    version: diagram?.version ?? 0,
    savedKey: sceneKey(elements, background),
    initialData: {
      elements,
      files,
      appState: { viewBackgroundColor: background, theme: readLocal(THEME_KEY, "light") },
      libraryItems: readLocal(LIBRARY_KEY, []),
      scrollToContent: true,
    },
  };
}

const SHARE_TITLE = "Copy a link that lets people view this diagram";
const SHARE_EDIT_TITLE = "Copy a link that lets people edit this diagram";
const NOT_SAVED_TITLE = "Available once the diagram has been saved";

// Short labels keep the top bar compact; the hover text carries the detail.
const STATUSES = {
  saved: { label: "Saved", title: "All changes are saved" },
  unsaved: { label: "Unsaved", title: "Changes will be saved in a moment" },
  saving: { label: "Saving…", title: "Saving changes" },
  error: { label: "Save failed", title: "Saving failed. Retrying automatically." },
};

/**
 * Save status, or "Read-only" on a view link. Every possible label is laid
 * out in the same spot with only the current one visible, so the width never
 * changes as the status does.
 */
function SaveStatus({ status, readOnly }) {
  if (readOnly) {
    return (
      <div className="top-pill save-status" role="status" title="You are viewing a read-only link">
        <span>Read-only</span>
      </div>
    );
  }
  return (
    <div
      className={`top-pill save-status save-status--${status}`}
      role="status"
      data-status={status}
      title={STATUSES[status].title}
    >
      {Object.entries(STATUSES).map(([key, { label }]) => (
        <span
          key={key}
          className={key === status ? undefined : "top-pill__text--hidden"}
          aria-hidden={key !== status}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // The clipboard needs HTTPS or localhost; otherwise show the link to copy by hand.
    window.prompt("Copy this link", url);
  }
}

/** Copies a link when clicked. Stays visible but disabled while there is no link yet. */
function CopyLinkButton({ label, link, title, primary = false }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={`top-pill share-button${primary ? " share-button--primary" : ""}`}
      disabled={!link}
      title={link ? title : NOT_SAVED_TITLE}
      onClick={async () => {
        await copyLink(link);
        setCopied(true);
      }}
    >
      {/* Both texts always take up space, so the button keeps one width. */}
      <span className={copied ? "top-pill__text--hidden" : undefined}>{label}</span>
      <span className={copied ? undefined : "top-pill__text--hidden"} aria-hidden={!copied}>
        Copied
      </span>
    </button>
  );
}

/**
 * The phone layout has no room for buttons in the top bar, so there the two
 * share actions live in the menu instead. Renders nothing on larger screens.
 */
function ShareMenuItems({ viewLink, editLink, canEdit }) {
  const device = useDevice();
  if (!device.editor.isMobile) return null;
  return (
    <>
      <MainMenu.Item
        disabled={!viewLink}
        className={viewLink ? undefined : "menu-item--disabled"}
        title={viewLink ? SHARE_TITLE : NOT_SAVED_TITLE}
        onSelect={() => copyLink(viewLink)}
      >
        Share
      </MainMenu.Item>
      {canEdit && (
        <MainMenu.Item
          disabled={!editLink}
          className={editLink ? undefined : "menu-item--disabled"}
          title={editLink ? SHARE_EDIT_TITLE : NOT_SAVED_TITLE}
          onSelect={() => copyLink(editLink)}
        >
          Share Edit
        </MainMenu.Item>
      )}
    </>
  );
}

export default function Editor({ id }) {
  const [loaded, setLoaded] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [api, setApi] = useState(null);
  const [status, setStatus] = useState("saved");
  // The diagram's read-only id. Unknown until the diagram has been saved once.
  const [viewId, setViewId] = useState(null);
  const syncRef = useRef(null);
  const themeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadDiagram(id).then(
      (result) => {
        if (cancelled) return;
        setLoaded(result);
        setViewId(result.viewId);
      },
      (error) => !cancelled && setLoadError(error),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!api || !loaded) return;
    const sync = new DiagramSync({
      id,
      api,
      version: loaded.version,
      savedKey: loaded.savedKey,
      syncedFileIds: Object.keys(loaded.initialData.files),
      onStatus: setStatus,
      readOnly: loaded.readOnly,
      onViewId: setViewId,
    });
    syncRef.current = sync;

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") sync.flush();
      else sync.refresh();
    };
    const onFocus = () => sync.refresh();
    const onBeforeUnload = (event) => {
      if (!sync.hasUnsaved()) return;
      sync.flush();
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("beforeunload", onBeforeUnload);
      sync.dispose();
      syncRef.current = null;
    };
  }, [id, api, loaded]);

  const onChange = useCallback((elements, appState, files) => {
    syncRef.current?.handleChange(elements, appState, files);
    if (appState.theme !== themeRef.current) {
      themeRef.current = appState.theme;
      writeLocal(THEME_KEY, appState.theme);
    }
  }, []);

  // Links to other diagrams on this server open in place, after saving.
  const onLinkOpen = useCallback((element, event) => {
    let url;
    try {
      url = new URL(element.link, window.location.href);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin || !isDiagramId(url.pathname.slice(1))) return;

    event.preventDefault();
    const { nativeEvent } = event.detail;
    if (nativeEvent.ctrlKey || nativeEvent.metaKey) {
      window.open(url.href, "_blank", "noopener");
      return;
    }
    const go = () => window.location.assign(url.href);
    (syncRef.current?.flush() ?? Promise.resolve()).then(go, go);
  }, []);

  if (loadError) {
    return (
      <div className="notice">
        <h1>Could not load this diagram</h1>
        <p>{loadError.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  }
  if (!loaded) {
    return <div className="notice">Loading…</div>;
  }

  // A viewer is already on the read-only link. An editor gets one after the first save.
  const readOnlyLink = loaded.readOnly
    ? window.location.href
    : viewId && `${window.location.origin}/${viewId}`;

  // Sharing an editing link to a diagram the server has never seen would be
  // odd, so it also waits for the first save (which is when viewId arrives).
  const canEdit = !loaded.readOnly;
  const editLink = canEdit && viewId ? window.location.href : null;

  return (
    <div className="editor">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={loaded.initialData}
        viewModeEnabled={loaded.readOnly}
        onChange={onChange}
        onLinkOpen={onLinkOpen}
        onLibraryChange={(items) => writeLocal(LIBRARY_KEY, items)}
        renderTopRightUI={(isMobile) =>
          isMobile ? null : (
            <>
              <CopyLinkButton primary label="Share" link={readOnlyLink} title={SHARE_TITLE} />
              {canEdit && (
                <CopyLinkButton label="Share Edit" link={editLink} title={SHARE_EDIT_TITLE} />
              )}
              <SaveStatus status={status} readOnly={loaded.readOnly} />
            </>
          )
        }
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => window.open("/", "_blank")}>New diagram</MainMenu.Item>
          <ShareMenuItems viewLink={readOnlyLink} editLink={editLink} canEdit={canEdit} />
          {!loaded.readOnly && <MainMenu.DefaultItems.LoadScene />}
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          {!loaded.readOnly && <MainMenu.DefaultItems.ClearCanvas />}
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
