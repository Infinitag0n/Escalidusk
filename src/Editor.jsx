import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  Footer,
  MainMenu,
  restoreElements,
  useDevice,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { fetchDiagram, isDiagramId, newDiagramId } from "./api.js";
import { LiveSession } from "./live.js";
import { DiagramSync, fetchSceneFiles, sceneKey, sharedSettings } from "./sync.js";

// Per-browser preferences; these are not part of the shared diagram.
const THEME_KEY = "escalidusk:theme";
const LIBRARY_KEY = "escalidusk:library";
const USERNAME_KEY = "escalidusk:username";

const USER_ID_KEY = "escalidusk:user-id";
const USERNAME_MAX_LENGTH = 40;

/**
 * This browser's private user id, made up on first use. It is a soft
 * identity ("probably the same browser as before"), not a login. Only the
 * server is ever told; other people see a different, public id.
 */
function localUserId() {
  let userId = readLocal(USER_ID_KEY, null);
  if (!isDiagramId(userId)) {
    userId = newDiagramId();
    writeLocal(USER_ID_KEY, userId);
  }
  return userId;
}

/**
 * The name other people see next to our cursor. Made up once per browser,
 * editable from the bottom-right corner, and kept in the browser's storage.
 */
function localUsername() {
  let name = readLocal(USERNAME_KEY, null);
  if (typeof name !== "string" || !name) {
    name = `Guest ${100 + Math.floor(Math.random() * 900)}`;
    writeLocal(USERNAME_KEY, name);
  }
  return name;
}

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
  const settings = sharedSettings(diagram?.scene.appState);
  const files = await fetchSceneFiles(id, elements);
  return {
    readOnly: diagram?.readOnly ?? false,
    viewId: diagram?.viewId ?? null,
    version: diagram?.version ?? 0,
    savedKey: sceneKey(elements, settings),
    savedSettings: settings,
    initialData: {
      elements,
      files,
      appState: { ...settings, theme: readLocal(THEME_KEY, "light") },
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

const TITLE_GAP_PX = 12;
const TITLE_MIN_PX = 60;

/**
 * How wide the name may be: from where it starts to whatever comes next in
 * the top bar (the toolbar, or the buttons on the right when there is no
 * toolbar). Excalidraw moves its toolbar around as the bar fills up, for
 * example when collaborators' avatars appear, so this is measured, not assumed.
 * Returns the room (0 while there is none worth using, null before the first
 * measurement) and a ref callback for the element. The label on a read-only
 * page comes and goes with the name, so measuring follows the element itself.
 */
function useTitleRoom() {
  const [field, setField] = useState(null);
  const [room, setRoom] = useState(null);
  useLayoutEffect(() => {
    if (!field) return undefined;
    const measure = () => {
      const start = field.getBoundingClientRect().left;
      // The right-hand group can stretch across the bar (it does on read-only
      // pages), so look at the things inside it, not at the group itself.
      const edges = [
        ...document.querySelectorAll(
          ".excalidraw .App-toolbar, .excalidraw .layer-ui__wrapper__top-right > *",
        ),
      ]
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.left > start)
        .map((box) => box.left);
      const available = Math.floor(Math.min(...edges, window.innerWidth) - start - TITLE_GAP_PX);
      setRoom(available >= TITLE_MIN_PX ? available : 0);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    // The toolbar shifts when its neighbours change size, so watch those too.
    const observer = new ResizeObserver(measure);
    for (const selector of [".App-menu_top", ".App-toolbar", ".layer-ui__wrapper__top-right"]) {
      const element = document.querySelector(`.excalidraw ${selector}`);
      if (element) observer.observe(element);
    }
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [field]);
  return [room, setField];
}

/**
 * The diagram's name, shown as plain editable text beside the menu button.
 * On a read-only page it is a label, not a text field. Hidden on the phone
 * layout, where the toolbar fills the top bar.
 */
function TitleField({ value, readOnly, onEdit, onFocusChange }) {
  const device = useDevice();
  const [room, ref] = useTitleRoom();
  if (device.editor.isMobile) return null;
  const fit = room ? { visibility: "visible" } : { visibility: "hidden" };
  if (readOnly) {
    return value ? (
      <div
        ref={ref}
        className="diagram-title diagram-title--readonly"
        style={{ ...fit, maxWidth: room ?? 0 }}
        title={value}
      >
        {value}
      </div>
    ) : null;
  }
  return (
    // No type attribute on purpose: Excalidraw styles every input[type=text]
    // with a border and background, and a bare input is still a text field.
    <input
      ref={ref}
      className="diagram-title"
      style={{ ...fit, width: room ?? 0 }}
      value={value}
      placeholder="Untitled"
      aria-label="Diagram name"
      maxLength={120}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => onEdit(event.target.value)}
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
      }}
    />
  );
}

/**
 * Our own display name, as plain editable text in the bottom-right corner
 * just before the help button. Rendered through Excalidraw's footer, which
 * does not exist on the phone layout.
 */
function UserNameField({ value, onEdit, onDone }) {
  return (
    <Footer>
      {/* No type attribute, for the same reason as the diagram name. */}
      <input
        className="user-name"
        value={value}
        placeholder="Your name"
        aria-label="Your name"
        title="Your name, as other people on this diagram see it"
        maxLength={USERNAME_MAX_LENGTH}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onEdit(event.target.value)}
        onBlur={onDone}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
        }}
      />
    </Footer>
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
  // The diagram's name. Excalidraw's app state holds the saved value (it is
  // also the default file name for exports); this mirrors it for the text field.
  const [title, setTitle] = useState("");
  const titleFocusedRef = useRef(false);
  // Our display name as typed. Empty while being retyped; storage and the
  // other people only ever get a non-empty name.
  const [username, setUsername] = useState(localUsername);
  // How many other people are editing this diagram right now.
  const [peerCount, setPeerCount] = useState(0);
  const liveRef = useRef(null);
  const syncRef = useRef(null);
  const themeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadDiagram(id).then(
      (result) => {
        if (cancelled) return;
        setLoaded(result);
        setViewId(result.viewId);
        setTitle(result.savedSettings.name);
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
      savedSettings: loaded.savedSettings,
      syncedFileIds: Object.keys(loaded.initialData.files),
      onStatus: setStatus,
      readOnly: loaded.readOnly,
      onViewId: setViewId,
      userId: localUserId(),
    });
    syncRef.current = sync;
    const live = new LiveSession({
      id,
      api,
      sync,
      readOnly: loaded.readOnly,
      username: localUsername(),
      userId: localUserId(),
      elements: loaded.initialData.elements,
      settings: loaded.savedSettings,
      onPeers: setPeerCount,
    });
    liveRef.current = live;

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
      live.dispose();
      liveRef.current = null;
      sync.dispose();
      syncRef.current = null;
    };
  }, [id, api, loaded]);

  useEffect(() => {
    document.title = title.trim() ? `${title.trim()} - Escalidusk` : "Escalidusk";
  }, [title]);

  const onChange = useCallback((elements, appState, files) => {
    syncRef.current?.handleChange(elements, appState, files);
    liveRef.current?.handleChange(elements, appState);
    // Pick up a name that arrived from elsewhere, but never while the user is
    // typing: an older echo of their own keystrokes would overwrite the field.
    if (!titleFocusedRef.current) setTitle(appState.name ?? "");
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

  const onTitleEdit = (name) => {
    setTitle(name);
    api?.updateScene({ appState: { name }, captureUpdate: CaptureUpdateAction.NEVER });
  };
  const onUsernameEdit = (value) => {
    setUsername(value);
    const name = value.trim();
    if (!name) return;
    writeLocal(USERNAME_KEY, name);
    liveRef.current?.setUsername(name);
  };
  // Leaving the field empty falls back to the last name that was in use.
  const onUsernameDone = () => setUsername(localUsername());

  const onTitleFocusChange = (focused) => {
    titleFocusedRef.current = focused;
    if (!focused && api) setTitle(api.getAppState().name ?? "");
  };

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
        onPointerUpdate={(payload) => liveRef.current?.handlePointer(payload)}
        isCollaborating={peerCount > 0}
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
        <TitleField
          value={title}
          readOnly={loaded.readOnly}
          onEdit={onTitleEdit}
          onFocusChange={onTitleFocusChange}
        />
        {!loaded.readOnly && (
          <UserNameField value={username} onEdit={onUsernameEdit} onDone={onUsernameDone} />
        )}
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
