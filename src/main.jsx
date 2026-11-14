import { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import Home from "./Home.jsx";
import { isDiagramId, newDiagramId } from "./api.js";
import { recentDiagrams } from "./recent.js";
import "./styles.css";

// The editor is by far the largest part of the app; the home page does not need it.
const Editor = lazy(() => import("./Editor.jsx"));

// The whole route table:
//   /         the home page if this browser has opened diagrams before, else a new diagram
//   /new      a new diagram, always
//   /<uuid>   that diagram
let path = window.location.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
const showHome = path === "" && recentDiagrams().length > 0;
if (path === "new" || (path === "" && !showHome)) path = newDiagramId();
if (isDiagramId(path) && window.location.pathname !== `/${path}`) {
  window.history.replaceState(null, "", `/${path}`);
}

function Page() {
  if (showHome) return <Home />;
  if (isDiagramId(path)) {
    return (
      <Suspense fallback={<div className="notice">Loading…</div>}>
        <Editor id={path} />
      </Suspense>
    );
  }
  return (
    <div className="notice">
      <h1>No diagram here</h1>
      <p>This address is not a diagram link.</p>
      <a href="/">Start a new diagram</a>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Page />);
