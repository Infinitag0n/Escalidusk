import { useEffect, useRef } from "react";

const UNITS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function when(time) {
  const seconds = Math.round((time - Date.now()) / 1000);
  const [unit, size] = UNITS.find(([, s]) => Math.abs(seconds) >= s) ?? ["second", 1];
  return unit === "second" ? "just now" : relative.format(Math.round(seconds / size), unit);
}

/**
 * The diagrams this browser has opened, as a list of buttons.
 * @param {object} props
 * @param {object[]} props.entries from recentDiagrams()
 * @param {(entry: object) => void} props.onPick
 * @param {(entry: object) => void} [props.onForget] adds a "remove from this list" button
 * @param {string} props.emptyText shown when there is nothing to list
 */
export function DiagramList({ entries, onPick, onForget, emptyText }) {
  if (entries.length === 0) return <p className="diagram-list__empty">{emptyText}</p>;
  return (
    <ul className="diagram-list">
      {entries.map((entry) => (
        <li key={entry.id}>
          <button type="button" className="diagram-list__item" onClick={() => onPick(entry)}>
            <span className={`diagram-list__name${entry.name ? "" : " diagram-list__name--untitled"}`}>
              {entry.name || "Untitled"}
            </span>
            {entry.readOnly && <span className="diagram-list__badge">Read-only</span>}
            <span className="diagram-list__when">{when(entry.openedAt)}</span>
          </button>
          {onForget && (
            <button
              type="button"
              className="diagram-list__forget"
              aria-label={`Remove ${entry.name || "Untitled"} from this list`}
              title="Remove from this list (the diagram itself is kept)"
              onClick={() => onForget(entry)}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A small dialog over the editor for picking one of the recently opened diagrams. */
export function DiagramPicker({ title, hint, entries, emptyText, onPick, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);

  return (
    <div className="picker-backdrop" onPointerDown={onClose}>
      <div
        ref={ref}
        className="picker"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation(); // keep Excalidraw's shortcuts out of it
          if (event.key === "Escape") onClose();
        }}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" className="picker__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {hint && <p className="picker__hint">{hint}</p>}
        <DiagramList entries={entries} onPick={onPick} emptyText={emptyText} />
      </div>
    </div>
  );
}
