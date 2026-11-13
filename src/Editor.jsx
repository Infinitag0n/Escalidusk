import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, MainMenu, restoreElements } from "@excalidraw/excalidraw";
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

const STATUS_LABELS = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  error: "Save failed, retrying",
};

export default function Editor({ id }) {
  const [loaded, setLoaded] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [api, setApi] = useState(null);
  const [status, setStatus] = useState("saved");
  const syncRef = useRef(null);
  const themeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadDiagram(id).then(
      (result) => !cancelled && setLoaded(result),
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

  return (
    <div className="editor">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={loaded.initialData}
        onChange={onChange}
        onLinkOpen={onLinkOpen}
        onLibraryChange={(items) => writeLocal(LIBRARY_KEY, items)}
        renderTopRightUI={() => (
          <div className={`save-status save-status--${status}`} role="status">
            {STATUS_LABELS[status]}
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => window.open("/", "_blank")}>New diagram</MainMenu.Item>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
