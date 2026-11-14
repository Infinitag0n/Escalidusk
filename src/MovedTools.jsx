import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Draw, Insert image and Eraser live under "More tools" instead of taking up
// room in the toolbar. Excalidraw has no setting for this, so it is done from
// the outside: the three toolbar buttons are hidden with CSS (see styles.css)
// and matching entries are added to the "More tools" menu whenever it opens.
// The tools themselves are untouched, so their keyboard shortcuts still work.
//
// This leans on Excalidraw's class names; check it when upgrading Excalidraw.

const icon = (paths) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);

export const MOVED_TOOLS = [
  {
    type: "freedraw",
    label: "Draw",
    shortcut: "P",
    icon: icon([
      "M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4",
      "M13.5 6.5l4 4",
    ]),
  },
  {
    type: "image",
    label: "Insert image",
    shortcut: "9",
    icon: icon([
      "M15 8h.01",
      "M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12z",
      "M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5",
      "M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3",
    ]),
  },
  {
    type: "eraser",
    label: "Eraser",
    shortcut: "E",
    icon: icon([
      "M19 20h-10.5l-4.21 -4.3a1 1 0 0 1 0 -1.41l10 -10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3",
      "M18 13.3l-6.3 -6.3",
    ]),
  },
];

const MOVED_TYPES = new Set(MOVED_TOOLS.map((tool) => tool.type));

/** Whether a tool is one of those moved under "More tools". */
export const isMovedTool = (type) => MOVED_TYPES.has(type);

const MENU = ".excalidraw .App-toolbar__extra-tools-dropdown .dropdown-menu-container";
const TRIGGER = ".excalidraw .App-toolbar__extra-tools-trigger";

/**
 * Adds the moved tools to Excalidraw's "More tools" menu while it is open.
 * @param {object} props
 * @param {object} props.api Excalidraw imperative API
 * @param {string} props.activeTool the type of the tool currently selected
 */
export function MovedTools({ api, activeTool }) {
  // A holder of our own, put at the top of the open menu, to render into.
  const [holder, setHolder] = useState(null);

  useEffect(() => {
    const root = document.querySelector(".excalidraw");
    if (!root) return undefined;
    const sync = () => {
      const menu = document.querySelector(MENU);
      setHolder((current) => {
        if (!menu) return null;
        if (current && menu.contains(current)) return current;
        const element = document.createElement("div");
        element.className = "moved-tools";
        menu.prepend(element);
        return element;
      });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  if (!holder) return null;
  return createPortal(
    MOVED_TOOLS.map((tool) => (
      <button
        key={tool.type}
        type="button"
        className={`dropdown-menu-item dropdown-menu-item-base${
          activeTool === tool.type ? " dropdown-menu-item--selected" : ""
        }`}
        data-testid={`moved-tool-${tool.type}`}
        title={tool.label}
        onClick={() => {
          api.setActiveTool({ type: tool.type });
          // The menu's open state is Excalidraw's; its button toggles it shut.
          document.querySelector(TRIGGER)?.click();
        }}
      >
        <div className="dropdown-menu-item__icon">{tool.icon}</div>
        <div className="dropdown-menu-item__text">{tool.label}</div>
        <div className="dropdown-menu-item__shortcut">{tool.shortcut}</div>
      </button>
    )),
    holder,
  );
}
