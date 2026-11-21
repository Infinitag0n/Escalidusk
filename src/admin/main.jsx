import { Fragment, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { appPath } from "../paths.js";
import "../banner.css";
import "./admin.css";

const PAGE_SIZE = 50;

/** Thrown when the server says the session is missing or has expired. */
class SignedOut extends Error {}

async function call(path, options = {}) {
  const response = await fetch(appPath(`/api/admin${path}`), {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (response.status === 401 && path !== "/login") throw new SignedOut();
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    error.retryAfter = body?.retryAfter;
    throw error;
  }
  return body;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const UNITS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function When({ time }) {
  const seconds = Math.round((time - Date.now()) / 1000);
  const [unit, size] = UNITS.find(([, s]) => Math.abs(seconds) >= s) ?? ["second", 1];
  const text = unit === "second" ? "just now" : relative.format(Math.round(seconds / size), unit);
  return <time title={new Date(time).toLocaleString()}>{text}</time>;
}

function Login({ onSignedIn }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("/login", { method: "POST", body: JSON.stringify({ password }) });
      onSignedIn();
    } catch (failure) {
      setError(
        failure.status === 429
          ? `Too many wrong attempts. Try again in ${Math.ceil(failure.retryAfter / 60)} min.`
          : failure.status === 401
            ? "Wrong password."
            : failure.message,
      );
      setBusy(false);
    }
  };

  return (
    <form className="login" onSubmit={submit}>
      <h1>Escalidusk backoffice</h1>
      <label htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        autoFocus
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <button type="submit" disabled={busy || !password}>
        Sign in
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * A person as the lists show them: the name they chose, and the start of
 * their public id, which is what tells apart two people with the same name.
 * The whole id is in the tooltip.
 */
function Person({ name, id }) {
  return (
    <>
      {name} <code title={`Id ${id}`}>{id.slice(0, 8)}</code>
    </>
  );
}

/** Loads a paged, searchable list from the API and keeps it in step with the search box. */
function useList(path, field, onSignedOut, initialSearch = "") {
  const [search, setSearch] = useState(initialSearch);
  const [state, setState] = useState({ items: [], total: 0, loading: true, error: null });

  const load = useCallback(
    async (offset) => {
      setState((previous) => ({ ...previous, loading: true, error: null }));
      try {
        const query = new URLSearchParams({ search, offset, limit: PAGE_SIZE });
        const result = await call(`${path}?${query}`);
        setState((previous) => ({
          items: offset === 0 ? result[field] : [...previous.items, ...result[field]],
          total: result.total,
          loading: false,
          error: null,
        }));
      } catch (failure) {
        if (failure instanceof SignedOut) return onSignedOut();
        setState((previous) => ({ ...previous, loading: false, error: failure.message }));
      }
    },
    [path, field, search, onSignedOut],
  );

  // Reload from the top shortly after the search text stops changing.
  useEffect(() => {
    const timer = setTimeout(() => load(0), 250);
    return () => clearTimeout(timer);
  }, [load]);

  return { ...state, search, setSearch, reload: () => load(0), more: () => load(state.items.length) };
}

function ListFooter({ list, noun }) {
  return (
    <div className="list-footer">
      {list.error && (
        <span className="error" role="alert">
          {list.error}
        </span>
      )}
      <span>
        {list.loading ? "Loading…" : `Showing ${list.items.length} of ${list.total} ${noun}`}
      </span>
      {list.items.length < list.total && (
        <button type="button" onClick={list.more} disabled={list.loading}>
          Show more
        </button>
      )}
    </div>
  );
}

/** Everyone who has opened one diagram, shown under its row. */
function Visitors({ diagram, onSignedOut }) {
  const [visitors, setVisitors] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    call(`/diagrams/${diagram.id}/visitors`).then(
      (result) => setVisitors(result.visitors),
      (failure) => (failure instanceof SignedOut ? onSignedOut() : setError(failure.message)),
    );
  }, [diagram.id, onSignedOut]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!visitors) return <p className="muted">Loading…</p>;
  if (visitors.length === 0) return <p className="muted">Nobody has opened it yet.</p>;
  return (
    <table className="visitors" aria-label={`Who opened ${diagram.name || "Untitled"}`}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Access</th>
          <th>Last opened</th>
          <th>First opened</th>
          <th className="number">Visits</th>
        </tr>
      </thead>
      <tbody>
        {visitors.map((visitor) => (
          <tr key={visitor.publicId}>
            <td title={`Public id ${visitor.publicId}`}>{visitor.name}</td>
            <td>{visitor.canEdit ? "Edit" : "View"}</td>
            <td>
              <When time={visitor.lastSeen} />
            </td>
            <td>
              <When time={visitor.firstSeen} />
            </td>
            <td className="number">{visitor.visits}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Diagrams({ onSignedOut, onChanged, initialSearch }) {
  const list = useList("/diagrams", "diagrams", onSignedOut, initialSearch);
  // The diagram whose visitors are shown, if any.
  const [expanded, setExpanded] = useState(null);

  const remove = async (diagram) => {
    const name = diagram.name || "Untitled";
    const warning =
      `Delete "${name}"?\n\nThis removes the diagram and its images for good. ` +
      "Its links will say it was deleted, and anyone who has it open is told so.";
    if (!window.confirm(warning)) return;
    try {
      await call(`/diagrams/${diagram.id}`, { method: "DELETE" });
      list.reload();
      onChanged();
    } catch (failure) {
      if (failure instanceof SignedOut) return onSignedOut();
      window.alert(`Could not delete: ${failure.message}`);
    }
  };

  return (
    <section>
      <input
        className="search"
        type="search"
        placeholder="Search by diagram name or id, or by creator name or id"
        aria-label="Search diagrams"
        value={list.search}
        onChange={(event) => list.setSearch(event.target.value)}
      />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Last changed</th>
              <th>Created</th>
              <th>Created by</th>
              <th className="number">Elements</th>
              <th className="number">Size</th>
              <th className="number">Open now</th>
              <th className="number">Seen by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.items.map((diagram) => (
              <Fragment key={diagram.id}>
              <tr>
                <td>
                  <a href={appPath(`/${diagram.id}`)} target="_blank" rel="noreferrer">
                    {diagram.name || <span className="muted">Untitled</span>}
                  </a>
                </td>
                <td>
                  <When time={diagram.updatedAt} />
                  {diagram.updatedBy && (
                    <span className="muted">
                      {" "}
                      by <Person name={diagram.updatedBy} id={diagram.updatedById} />
                    </span>
                  )}
                </td>
                <td>
                  <When time={diagram.createdAt} />
                </td>
                <td>
                  {diagram.createdBy ? (
                    <button
                      type="button"
                      className="link"
                      title="Show every diagram this person created"
                      onClick={() => list.setSearch(diagram.createdById)}
                    >
                      <Person name={diagram.createdBy} id={diagram.createdById} />
                    </button>
                  ) : (
                    <span className="muted">Unknown</span>
                  )}
                </td>
                <td className="number">{diagram.elementCount}</td>
                <td className="number" title={`${diagram.imageCount} image(s)`}>
                  {formatSize(diagram.sceneSize + diagram.imageSize)}
                </td>
                <td className="number">{diagram.openNow || <span className="muted">-</span>}</td>
                <td className="number">
                  <button
                    type="button"
                    className="link"
                    aria-expanded={expanded === diagram.id}
                    title="Show who opened it"
                    onClick={() => setExpanded(expanded === diagram.id ? null : diagram.id)}
                  >
                    {diagram.seenBy} {diagram.seenBy === 1 ? "person" : "people"}
                  </button>
                </td>
                <td className="actions">
                  <a href={appPath(`/${diagram.viewId}`)} target="_blank" rel="noreferrer">
                    View
                  </a>
                  <button type="button" className="danger" onClick={() => remove(diagram)}>
                    Delete
                  </button>
                </td>
              </tr>
              {expanded === diagram.id && (
                <tr className="details">
                  <td colSpan={9}>
                    <Visitors diagram={diagram} onSignedOut={onSignedOut} />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
            {!list.loading && list.items.length === 0 && (
              <tr>
                <td colSpan={9} className="empty">
                  {list.search ? "No diagrams match." : "No diagrams yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ListFooter list={list} noun="diagrams" />
    </section>
  );
}

function People({ onSignedOut, onShowDiagrams }) {
  const list = useList("/users", "users", onSignedOut);
  return (
    <section>
      <input
        className="search"
        type="search"
        placeholder="Search by name or id"
        aria-label="Search people"
        value={list.search}
        onChange={(event) => list.setSearch(event.target.value)}
      />
      <p className="hint">
        People are browsers, not accounts: a name and an id each browser made up. Anyone can
        change their name, so the id is what identifies a person. Addresses are stored only as
        hashes, so the last two columns count them without showing them.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Id</th>
              <th>Last seen</th>
              <th>First seen</th>
              <th className="number">Created</th>
              <th className="number">Opened</th>
              <th className="number">Last editor of</th>
              <th className="number">Addresses used</th>
              <th className="number">Others on the same address</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((user) => (
              <tr key={user.publicId}>
                <td>{user.name}</td>
                <td>
                  <code>{user.publicId}</code>
                </td>
                <td>
                  <When time={user.lastSeen} />
                </td>
                <td>
                  <When time={user.firstSeen} />
                </td>
                <td className="number">
                  {user.created > 0 ? (
                    <button
                      type="button"
                      className="link"
                      title="Show the diagrams this person created"
                      onClick={() => onShowDiagrams(user.publicId)}
                    >
                      {user.created}
                    </button>
                  ) : (
                    0
                  )}
                </td>
                <td className="number">{user.opened}</td>
                <td className="number">{user.lastEditorOf}</td>
                <td className="number">{user.addressCount}</td>
                <td className="number">{user.sharesAddressWith}</td>
              </tr>
            ))}
            {!list.loading && list.items.length === 0 && (
              <tr>
                <td colSpan={9} className="empty">
                  {list.search ? "Nobody matches." : "Nobody yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ListFooter list={list} noun="people" />
    </section>
  );
}

function Feedback({ onSignedOut }) {
  const list = useList("/feedback", "feedback", onSignedOut);

  const remove = async (entry) => {
    if (!window.confirm("Delete this feedback? This cannot be undone.")) return;
    try {
      await call(`/feedback/${entry.id}`, { method: "DELETE" });
      list.reload();
    } catch (failure) {
      if (failure instanceof SignedOut) return onSignedOut();
      window.alert(`Could not delete: ${failure.message}`);
    }
  };

  return (
    <section>
      <p className="hint">
        What people sent through "Send feedback" in the editor. Only the words and the time are
        kept, not who wrote them.
      </p>
      <p className="export">
        Export all:{" "}
        <a href={appPath("/api/admin/feedback/export?format=json")} download>
          JSON
        </a>{" "}
        <a href={appPath("/api/admin/feedback/export?format=text")} download>
          Text
        </a>
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Sent</th>
              <th>Feedback</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.items.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <When time={entry.createdAt} />
                </td>
                <td className="message">{entry.message}</td>
                <td className="actions">
                  <button type="button" className="danger" onClick={() => remove(entry)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!list.loading && list.items.length === 0 && (
              <tr>
                <td colSpan={3} className="empty">
                  No feedback yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ListFooter list={list} noun="messages" />
    </section>
  );
}

function Overview({ stats, onSignedOut, onChanged }) {
  const [message, setMessage] = useState(null);

  const cleanUp = async () => {
    try {
      const { removed } = await call("/remove-orphaned-images", { method: "POST" });
      setMessage(`Removed ${removed} unused image${removed === 1 ? "" : "s"}.`);
      onChanged();
    } catch (failure) {
      if (failure instanceof SignedOut) return onSignedOut();
      setMessage(`Could not clean up: ${failure.message}`);
    }
  };

  if (!stats) return null;
  return (
    <div className="overview">
      <dl>
        <div>
          <dt>Diagrams</dt>
          <dd>{stats.diagrams}</dd>
        </div>
        <div>
          <dt>People</dt>
          <dd>{stats.users}</dd>
        </div>
        <div>
          <dt>Images</dt>
          <dd title={formatSize(stats.imageSize)}>{stats.images}</dd>
        </div>
        <div>
          <dt>Deleted diagrams</dt>
          <dd>{stats.deletedDiagrams}</dd>
        </div>
        <div>
          <dt>Database file</dt>
          <dd>{formatSize(stats.databaseSize)}</dd>
        </div>
      </dl>
      <p className="cleanup">
        {stats.orphanedImages > 0 ? (
          <>
            {stats.orphanedImages} image{stats.orphanedImages === 1 ? " is" : "s are"} no longer
            used by any diagram ({formatSize(stats.orphanedImageSize)}).{" "}
            <button type="button" onClick={cleanUp}>
              Remove unused images
            </button>
          </>
        ) : (
          <span className="muted">No unused images to clean up.</span>
        )}
        {message && <span role="status"> {message}</span>}
      </p>
    </div>
  );
}

function Backoffice({ onSignedOut }) {
  const [tab, setTab] = useState("diagrams");
  // What the diagram list starts out searching for: set when coming from a person.
  const [diagramSearch, setDiagramSearch] = useState("");
  const showTab = (key, search = "") => {
    setDiagramSearch(search);
    setTab(key);
  };
  const [stats, setStats] = useState(null);

  const loadStats = useCallback(async () => {
    try {
      setStats(await call("/stats"));
    } catch (failure) {
      if (failure instanceof SignedOut) onSignedOut();
    }
  }, [onSignedOut]);
  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const signOut = async () => {
    await call("/logout", { method: "POST" }).catch(() => {});
    onSignedOut();
  };

  return (
    <main>
      <header>
        <h1>Escalidusk backoffice</h1>
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </header>
      <Overview stats={stats} onSignedOut={onSignedOut} onChanged={loadStats} />
      <nav role="tablist">
        {[
          ["diagrams", "Diagrams"],
          ["people", "People"],
          ["feedback", "Feedback"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => showTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "diagrams" && (
        <Diagrams onSignedOut={onSignedOut} onChanged={loadStats} initialSearch={diagramSearch} />
      )}
      {tab === "people" && (
        <People onSignedOut={onSignedOut} onShowDiagrams={(id) => showTab("diagrams", id)} />
      )}
      {tab === "feedback" && <Feedback onSignedOut={onSignedOut} />}
    </main>
  );
}

function App() {
  // null while asking the server; then { signedIn }.
  const [session, setSession] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    call("/session").then(setSession, setFailure);
  }, []);
  const onSignedOut = useCallback(() => setSession({ signedIn: false }), []);

  // A server without a backoffice never serves this page; only the development
  // server does, and then the API answers 404.
  if (failure?.status === 404) return <p className="notice">Page not found.</p>;
  if (failure) return <p className="notice">Could not reach the server.</p>;
  if (!session) return <p className="notice">Loading…</p>;
  if (!session.signedIn) {
    return <Login onSignedIn={() => setSession({ signedIn: true })} />;
  }
  return <Backoffice onSignedOut={onSignedOut} />;
}

createRoot(document.getElementById("root")).render(<App />);
