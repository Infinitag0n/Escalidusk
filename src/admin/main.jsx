import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./admin.css";

const PAGE_SIZE = 50;

/** Thrown when the server says the session is missing or has expired. */
class SignedOut extends Error {}

async function call(path, options = {}) {
  const response = await fetch(`/api/admin${path}`, {
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

/** Loads a paged, searchable list from the API and keeps it in step with the search box. */
function useList(path, field, onSignedOut) {
  const [search, setSearch] = useState("");
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

function Diagrams({ onSignedOut, onChanged }) {
  const list = useList("/diagrams", "diagrams", onSignedOut);

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
        placeholder="Search by name, or paste a diagram id"
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
              <th className="number">Elements</th>
              <th className="number">Size</th>
              <th className="number">Open now</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.items.map((diagram) => (
              <tr key={diagram.id}>
                <td>
                  <a href={`/${diagram.id}`} target="_blank" rel="noreferrer">
                    {diagram.name || <span className="muted">Untitled</span>}
                  </a>
                </td>
                <td>
                  <When time={diagram.updatedAt} />
                  {diagram.updatedBy && <span className="muted"> by {diagram.updatedBy}</span>}
                </td>
                <td>
                  <When time={diagram.createdAt} />
                  {diagram.createdBy && <span className="muted"> by {diagram.createdBy}</span>}
                </td>
                <td className="number">{diagram.elementCount}</td>
                <td className="number" title={`${diagram.imageCount} image(s)`}>
                  {formatSize(diagram.sceneSize + diagram.imageSize)}
                </td>
                <td className="number">{diagram.openNow || <span className="muted">-</span>}</td>
                <td className="actions">
                  <a href={`/${diagram.viewId}`} target="_blank" rel="noreferrer">
                    View
                  </a>
                  <button type="button" className="danger" onClick={() => remove(diagram)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!list.loading && list.items.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
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

function People({ onSignedOut }) {
  const list = useList("/users", "users", onSignedOut);
  return (
    <section>
      <input
        className="search"
        type="search"
        placeholder="Search by name"
        aria-label="Search people"
        value={list.search}
        onChange={(event) => list.setSearch(event.target.value)}
      />
      <p className="hint">
        People are browsers, not accounts: a name and an id each browser made up. Addresses are
        stored only as hashes, so the last two columns count them without showing them.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Last seen</th>
              <th>First seen</th>
              <th className="number">Created</th>
              <th className="number">Last editor of</th>
              <th className="number">Addresses used</th>
              <th className="number">Others on the same address</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((user) => (
              <tr key={user.publicId}>
                <td title={`Public id ${user.publicId}`}>{user.name}</td>
                <td>
                  <When time={user.lastSeen} />
                </td>
                <td>
                  <When time={user.firstSeen} />
                </td>
                <td className="number">{user.created}</td>
                <td className="number">{user.lastEditorOf}</td>
                <td className="number">{user.addressCount}</td>
                <td className="number">{user.sharesAddressWith}</td>
              </tr>
            ))}
            {!list.loading && list.items.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
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
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "diagrams" ? (
        <Diagrams onSignedOut={onSignedOut} onChanged={loadStats} />
      ) : (
        <People onSignedOut={onSignedOut} />
      )}
    </main>
  );
}

function App() {
  // null while asking the server; then { enabled, signedIn }.
  const [session, setSession] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    call("/session").then(setSession, () => setFailed(true));
  }, []);
  const onSignedOut = useCallback(() => setSession({ enabled: true, signedIn: false }), []);

  if (failed) return <p className="notice">Could not reach the server.</p>;
  if (!session) return <p className="notice">Loading…</p>;
  if (!session.enabled) {
    return (
      <div className="notice">
        <h1>The backoffice is switched off</h1>
        <p>
          Set the <code>ADMIN_PASSWORD</code> environment variable on the server and restart it to
          switch it on.
        </p>
      </div>
    );
  }
  if (!session.signedIn) {
    return <Login onSignedIn={() => setSession({ enabled: true, signedIn: true })} />;
  }
  return <Backoffice onSignedOut={onSignedOut} />;
}

createRoot(document.getElementById("root")).render(<App />);
