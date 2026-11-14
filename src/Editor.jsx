import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  Footer,
  MainMenu,
  restoreElements,
  useDevice,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { DiagramPicker } from "./DiagramList.jsx";
import { DeletedError, fetchDiagram, fetchSummaries, isDiagramId, newDiagramId } from "./api.js";
import {
  createDiagramLink,
  linkTargetOfElement,
  linkedDiagramIds,
  withCurrentNames,
} from "./diagramLinks.js";
import { LiveSession } from "./live.js";
import {
  editIdFor,
  forgetDiagram,
  forgetEditId,
  linkTargetOf,
  recentDiagrams,
  rememberDiagram,
  rememberEditId,
  updateDiagram,
  viewIdFor,
} from "./recent.js";
import { DiagramSync, fetchSceneFiles, sceneKey, sharedSettings } from "./sync.js";

// Per-browser preferences; these are not part of the shared diagram.
const THEME_KEY = "escalidusk:theme";
const LIBRARY_KEY = "escalidusk:library";
const USERNAME_KEY = "escalidusk:username";

const USER_ID_KEY = "escalidusk:user-id";
const USERNAME_MAX_LENGTH = 40;
// A space bar press shorter than this is a tap (switch mode); longer is a hold (pan).
const SPACE_TAP_MS = 300;

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
    exists: diagram !== null,
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
  deleted: { label: "Deleted", title: "This diagram was deleted. Changes are no longer saved." },
};

/**
 * Save status, or "Read-only" on a view link. Every possible label is laid
 * out in the same spot with only the current one visible, so the width never
 * changes as the status does.
 */
function SaveStatus({ status, readOnly }) {
  if (readOnly) {
    const gone = status === "deleted";
    return (
      <div
        className={`top-pill save-status${gone ? " save-status--deleted" : ""}`}
        role="status"
        data-status={gone ? "deleted" : "readonly"}
        title={gone ? STATUSES.deleted.title : "You are viewing a read-only link"}
      >
        <span>{gone ? "Deleted" : "Read-only"}</span>
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
      onClick={async (event) => {
        // After a mouse click, hand the keyboard back to the canvas, so the
        // next space bar tap switches mode instead of pressing this again.
        // (A click made from the keyboard has no click count; leave focus be.)
        if (event.detail > 0) focusCanvas();
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
function useTitleRoom(peerCount) {
  const [field, setField] = useState(null);
  const [room, setRoom] = useState(null);
  useLayoutEffect(() => {
    if (!field) return undefined;
    const measure = () => {
      const start = field.getBoundingClientRect().left;
      // The right-hand group, and the avatar list's wrapper inside it, can
      // stretch across the bar (they do on read-only pages), so look at the
      // buttons and avatars themselves.
      const edges = [
        ...document.querySelectorAll(
          ".excalidraw .App-toolbar, " +
            ".excalidraw .layer-ui__wrapper__top-right > *:not(.UserList__wrapper), " +
            ".excalidraw .layer-ui__wrapper__top-right .UserList > *",
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
    // Avatars come and go with the people present, without resizing anything observed.
  }, [field, peerCount]);
  return [room, setField];
}

/**
 * The diagram's name, shown as plain editable text beside the menu button.
 * On a read-only page it is a label, not a text field. Hidden on the phone
 * layout, where the toolbar fills the top bar.
 */
function TitleField({ value, readOnly, peerCount, onEdit, onFocusChange }) {
  const device = useDevice();
  const [room, ref] = useTitleRoom(peerCount);
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

/** Gives keyboard focus to Excalidraw, so its shortcuts (such as K for the laser) work. */
function focusCanvas() {
  document.querySelector(".excalidraw-container")?.focus();
}

/**
 * Laser pointer switch for read-only pages. Editors have Excalidraw's own
 * button in the toolbar; a read-only page has no toolbar, so without this the
 * laser would only be reachable through its keyboard shortcut.
 */
function LaserButton({ active, onToggle }) {
  return (
    <button
      type="button"
      className={`top-pill share-button laser-button${active ? " laser-button--active" : ""}`}
      aria-pressed={active}
      title="Laser pointer: draw attention to something for everyone here (K)"
      onClick={onToggle}
    >
      <span>Laser</span>
    </button>
  );
}

/**
 * Our own display name, as plain editable text in the bottom-right corner
 * just before the help button. Rendered through Excalidraw's footer, which
 * does not exist on the phone layout.
 */
function UserNameField({ value, onEdit, onDone, onLinkDiagram }) {
  return (
    <Footer>
      {onLinkDiagram && (
        <button
          type="button"
          className="top-pill share-button link-diagram-button"
          title="Connect this diagram to another one"
          onClick={onLinkDiagram}
        >
          <span>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M7 4h10l5 8-5 8H7l-5-8z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
            Connect
          </span>
        </button>
      )}
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

/**
 * Opens the diagram named in the address.
 *
 * The address says how the diagram is being used: its editing id while
 * editing, its read-only id while viewing. If the address holds a read-only
 * id and this browser knows the editing id for the same diagram, the diagram
 * is opened with full access but starts in view mode, so "Edit" is one tap away.
 */
export default function Editor({ id }) {
  const [access] = useState(() => {
    const editId = editIdFor(id);
    return editId ? { id: editId, startViewing: true } : { id, startViewing: false };
  });
  return <OpenDiagram id={access.id} addressId={id} startViewing={access.startViewing} />;
}

/**
 * @param {object} props
 * @param {string} props.id the id to work with: the editing id when this browser has it
 * @param {string} props.addressId the id in the address when the page was opened
 * @param {boolean} props.startViewing open in view mode (the address held the read-only id)
 */
function OpenDiagram({ id, addressId, startViewing }) {
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
  // Set if an administrator deletes the diagram while it is open here.
  const [deleted, setDeleted] = useState(false);
  // Whether the laser pointer is the active tool (it can also be switched with K).
  const [laserActive, setLaserActive] = useState(false);
  // How many other people have this diagram open right now.
  const [peerCount, setPeerCount] = useState(0);
  const liveRef = useRef(null);
  const syncRef = useRef(null);
  const themeRef = useRef(null);
  // Excalidraw's theme (its own setting, not the operating system's), so our dialogs can match it.
  const [dark, setDark] = useState(() => readLocal(THEME_KEY, "light") === "dark");

  useEffect(() => {
    let cancelled = false;
    loadDiagram(id).then(
      (result) => {
        if (cancelled) return;
        if (id !== addressId && !result.exists) {
          // The editing id this browser had on record is not a diagram. Forget
          // it and open what the address actually says.
          forgetEditId(id);
          window.location.reload();
          return;
        }
        setLoaded(result);
        setViewId(result.viewId);
        setTitle(result.savedSettings.name);
      },
      (error) => {
        if (cancelled) return;
        // A deleted diagram has no place among the ones to go back to.
        if (error instanceof DeletedError) {
          forgetDiagram(id);
          forgetEditId(id);
        }
        setLoadError(error);
      },
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
      onDeleted: () => setDeleted(true),
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

  // Keep this browser's list of recent diagrams up to date. A diagram joins
  // the list once it exists on the server: when opened, or on its first save
  // (which is when an editor learns its read-only id).
  const exists = loaded ? loaded.readOnly || loaded.exists || viewId !== null : false;
  useEffect(() => {
    if (exists) rememberDiagram({ id, readOnly: loaded.readOnly, viewId });
  }, [exists, id, loaded, viewId]);
  useEffect(() => {
    if (exists) updateDiagram(id, { name: title.trim() });
  }, [exists, id, title]);
  useEffect(() => {
    if (!deleted) return;
    forgetDiagram(id);
    forgetEditId(id);
  }, [deleted, id]);

  // Labels of links to other diagrams follow those diagrams' names. Checked
  // shortly after opening, and again whenever the window regains focus.
  useEffect(() => {
    if (!api || !loaded) return undefined;
    let cancelled = false;
    const refresh = async () => {
      const ids = linkedDiagramIds(api.getSceneElementsIncludingDeleted());
      if (ids.length === 0) return;
      try {
        const summaries = await fetchSummaries(ids);
        if (cancelled) return;
        const elements = withCurrentNames(api.getSceneElementsIncludingDeleted(), summaries);
        if (elements) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
      } catch (error) {
        console.warn("Could not refresh the names of linked diagrams", error);
      }
    };
    const timer = setTimeout(refresh, 800);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [api, loaded]);

  const onChange = useCallback((elements, appState, files) => {
    syncRef.current?.handleChange(elements, appState, files);
    liveRef.current?.handleChange(elements, appState);
    setLaserActive(appState.activeTool.type === "laser");
    // Pick up a name that arrived from elsewhere, but never while the user is
    // typing: an older echo of their own keystrokes would overwrite the field.
    if (!titleFocusedRef.current) setTitle(appState.name ?? "");
    if (appState.theme !== themeRef.current) {
      themeRef.current = appState.theme;
      setDark(appState.theme === "dark");
      writeLocal(THEME_KEY, appState.theme);
    }
  }, []);

  // Links to other diagrams on this server open in place, after saving.
  // Which dialog is open: "open" (go to a recent diagram), "link" (add a link to one), or null.
  const [picker, setPicker] = useState(null);

  // An editor can flip to view mode and back: nothing can be changed by
  // accident, dragging pans, and the laser is at hand. This is local to this
  // window; a read-only page is always in view mode.
  const [viewMode, setViewMode] = useState(startViewing);
  const viewing = Boolean(loaded?.readOnly) || viewMode;
  const canToggleView = Boolean(loaded) && !loaded.readOnly;

  // The address follows the mode: the read-only id while an editor is
  // viewing (once the diagram has one), the editing id otherwise. Whatever is
  // in the address bar is then safe to share for what it shows.
  useEffect(() => {
    if (!loaded) return;
    const shown = viewMode && !loaded.readOnly && viewId ? viewId : id;
    if (window.location.pathname !== `/${shown}`) {
      window.history.replaceState(null, "", `/${shown}`);
    }
  }, [loaded, viewMode, viewId, id]);

  // A tap on the space bar switches between editing and viewing. Excalidraw
  // uses a held space bar for panning, so only a short press with no mouse
  // button in between counts, and never while something is being typed.
  useEffect(() => {
    if (!canToggleView) return undefined;
    let pressedAt = 0;
    let usedForPanning = false;
    const busyElsewhere = (target) =>
      (target instanceof Element &&
        target.closest(
          "textarea, select, button, a[href], [contenteditable='true'], [role='dialog'], " +
            "input:not([type='radio']):not([type='checkbox'])",
        )) ||
      document.querySelector(".picker, .excalidraw .Modal");

    const onKeyDown = (event) => {
      if (event.code !== "Space" || event.repeat) return;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      pressedAt = plain && !busyElsewhere(event.target) ? Date.now() : 0;
      usedForPanning = false;
    };
    const onPointerDown = () => {
      usedForPanning = true;
    };
    const onKeyUp = (event) => {
      if (event.code !== "Space" || !pressedAt) return;
      const tap = Date.now() - pressedAt < SPACE_TAP_MS && !usedForPanning;
      pressedAt = 0;
      if (tap && !busyElsewhere(event.target)) setViewMode((on) => !on);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [canToggleView]);

  /**
   * Goes to another diagram, keeping the current mode where possible:
   * someone editing lands on the editable page if they may edit the target,
   * someone viewing lands on its read-only page.
   * @param {{view?: string, edit?: string}} target the ids known for it
   */
  const goToDiagram = (target, { newTab = false } = {}) => {
    const edit = target.edit ?? (target.view ? editIdFor(target.view) : null);
    // Remember that this browser may edit it, so its read-only page can offer "Edit".
    if (target.view && edit) rememberEditId(target.view, edit);
    const address = `/${(!viewing && edit) || target.view || edit}`;
    if (newTab) {
      window.open(address, "_blank", "noopener");
      return;
    }
    const go = () => window.location.assign(address);
    (syncRef.current?.flush() ?? Promise.resolve()).then(go, go);
  };

  // Links to other diagrams on this server open in place, after saving.
  const onLinkOpen = (element, event) => {
    let url;
    try {
      url = new URL(element.link, window.location.href);
    } catch {
      return;
    }
    const linked = url.pathname.slice(1);
    if (url.origin !== window.location.origin || !isDiagramId(linked)) return;

    // A hexagon says which ids it carries. For a link someone typed in, work
    // out what kind of id it is from what this browser has seen.
    const known = viewIdFor(linked);
    const target =
      linkTargetOfElement(element) ??
      (editIdFor(linked) ? { view: linked } : known ? { view: known, edit: linked } : { edit: linked });

    event.preventDefault();
    const { nativeEvent } = event.detail;
    goToDiagram(target, { newTab: nativeEvent.ctrlKey || nativeEvent.metaKey });
  };

  const openRecent = (entry) => {
    setPicker(null);
    goToDiagram(entry.readOnly ? { view: entry.id } : { view: entry.viewId ?? undefined, edit: entry.id });
  };

  // Whether new links should let this diagram's editors edit the linked one too.
  const [linkForEditing, setLinkForEditing] = useState(true);

  // Adds a link to the chosen diagram in the middle of what is on screen, selected.
  const addDiagramLink = (entry) => {
    setPicker(null);
    if (!api) return;
    const appState = api.getAppState();
    const centre = viewportCoordsToSceneCoords(
      { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 },
      appState,
    );
    const link = createDiagramLink({
      view: linkTargetOf(entry),
      edit: linkForEditing && !entry.readOnly ? entry.id : undefined,
      name: entry.name,
      centre,
    });
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...link.elements],
      appState: {
        selectedElementIds: Object.fromEntries(link.elements.map((element) => [element.id, true])),
        selectedGroupIds: { [link.groupId]: true },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    // Once the dialog is gone, so the new hexagon can be moved or deleted from the keyboard.
    setTimeout(focusCanvas);
  };

  // In view mode Excalidraw turns every drag into panning, laser or
  // not. So while the laser is on, a drag that starts on the canvas is taken
  // over here, before Excalidraw sees it, and drawn through the live session.
  const onPointerDownCapture = (event) => {
    if (!viewing || !laserActive || !api || !liveRef.current) return;
    if (event.button !== 0 || !event.isPrimary || event.target.tagName !== "CANVAS") return;
    event.stopPropagation();
    event.preventDefault();
    focusCanvas(); // Excalidraw would have done this itself on a click it handled

    const live = liveRef.current;
    const point = (e) => viewportCoordsToSceneCoords(e, api.getAppState());
    const move = (e) => live.laserStroke("down", point(e));
    const end = (e) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      live.laserStroke("up", point(e));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    live.laserStroke("down", point(event));
  };

  const toggleLaser = () => {
    api?.setActiveTool({ type: laserActive ? "selection" : "laser" });
    focusCanvas();
  };
  // Excalidraw ignores its tool shortcuts in view mode, so K is handled here.
  const onKeyDown = (event) => {
    if (!viewing || event.key.toLowerCase() !== "k") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest("input, textarea, [contenteditable='true']")) return;
    toggleLaser();
  };

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

  if (loadError instanceof DeletedError) {
    return (
      <div className="notice">
        <h1>This diagram was deleted</h1>
        <p>It was removed by an administrator and can no longer be opened.</p>
        <a href="/">Start a new diagram</a>
      </div>
    );
  }
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
  // Links to a deleted diagram lead nowhere, so they are not offered.
  const readOnlyLink = deleted
    ? null
    : loaded.readOnly
      ? `${window.location.origin}/${id}`
      : viewId && `${window.location.origin}/${viewId}`;

  // Sharing an editing link to a diagram the server has never seen would be
  // odd, so it also waits for the first save (which is when viewId arrives).
  const canEdit = !loaded.readOnly;
  const editLink = canEdit && viewId && !deleted ? `${window.location.origin}/${id}` : null;
  // Every recent diagram except this one (under either of its ids).
  const others = picker
    ? recentDiagrams().filter((entry) => entry.id !== id && linkTargetOf(entry) !== (loaded.readOnly ? id : viewId))
    : [];

  return (
    <div className="editor" onPointerDownCapture={onPointerDownCapture} onKeyDown={onKeyDown}>
      {deleted && (
        <div className="deleted-banner" role="alert">
          This diagram was deleted by an administrator. What you see is your copy; nothing is saved
          any more. Use the menu to export it if you need it.
        </div>
      )}
      {picker === "open" && (
        <DiagramPicker
          dark={dark}
          title="Open a recent diagram"
          entries={others}
          emptyText="No other diagrams opened yet."
          onPick={openRecent}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === "link" && (
        <DiagramPicker
          dark={dark}
          title="Connect to a diagram"
          hint="Adds a hexagon that opens the diagram you pick."
          entries={others.filter(linkTargetOf)}
          emptyText="No other diagrams opened yet. Open the one you want first."
          onPick={addDiagramLink}
          onClose={() => setPicker(null)}
        >
          <fieldset className="picker__choice">
            <legend>Editors of this diagram open it</legend>
            <label>
              <input
                type="radio"
                name="link-mode"
                checked={linkForEditing}
                onChange={() => setLinkForEditing(true)}
              />
              for editing
            </label>
            <label>
              <input
                type="radio"
                name="link-mode"
                checked={!linkForEditing}
                onChange={() => setLinkForEditing(false)}
              />
              read-only
            </label>
            <p>Viewers always get it read-only.</p>
          </fieldset>
        </DiagramPicker>
      )}
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={loaded.initialData}
        viewModeEnabled={viewing}
        onChange={onChange}
        onPointerUpdate={(payload) => liveRef.current?.handlePointer(payload)}
        isCollaborating={peerCount > 0}
        onLinkOpen={onLinkOpen}
        onLibraryChange={(items) => writeLocal(LIBRARY_KEY, items)}
        renderTopRightUI={(isMobile) =>
          isMobile ? null : (
            <>
              {viewMode && (
                <button
                  type="button"
                  className="top-pill share-button"
                  title="Back to editing (Space)"
                  onClick={() => setViewMode(false)}
                >
                  <span>Edit</span>
                </button>
              )}
              {viewing && (
                <LaserButton
                  active={laserActive}
                  onToggle={toggleLaser}
                />
              )}
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
          readOnly={viewing}
          peerCount={peerCount}
          onEdit={onTitleEdit}
          onFocusChange={onTitleFocusChange}
        />
        <UserNameField
          value={username}
          onEdit={onUsernameEdit}
          onDone={onUsernameDone}
          onLinkDiagram={canEdit && !deleted && !viewMode ? () => setPicker("link") : null}
        />
        <MainMenu>
          <MainMenu.Item onSelect={() => window.open("/new", "_blank")}>New diagram</MainMenu.Item>
          <MainMenu.Item onSelect={() => setPicker("open")}>Open recent…</MainMenu.Item>
          {canToggleView && (
            <MainMenu.Item shortcut="Space" onSelect={() => setViewMode((on) => !on)}>
              {viewMode ? "Edit mode" : "View mode"}
            </MainMenu.Item>
          )}
          {canEdit && !deleted && !viewMode && (
            <MainMenu.Item onSelect={() => setPicker("link")}>Connect to a diagram…</MainMenu.Item>
          )}
          <ShareMenuItems viewLink={readOnlyLink} editLink={editLink} canEdit={canEdit} />
          {!viewing && <MainMenu.DefaultItems.LoadScene />}
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          {!viewing && <MainMenu.DefaultItems.ClearCanvas />}
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
