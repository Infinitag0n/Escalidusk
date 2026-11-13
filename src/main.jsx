import { createRoot } from "react-dom/client";
import Editor from "./Editor.jsx";
import { isDiagramId, newDiagramId } from "./api.js";
import "./styles.css";

// The whole route table: "/" starts a new diagram, "/<uuid>" opens one.
let id = window.location.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
if (id === "") id = newDiagramId();
if (isDiagramId(id) && window.location.pathname !== `/${id}`) {
  window.history.replaceState(null, "", `/${id}`);
}

createRoot(document.getElementById("root")).render(
  isDiagramId(id) ? (
    <Editor id={id} />
  ) : (
    <div className="notice">
      <h1>No diagram here</h1>
      <p>This address is not a diagram link.</p>
      <a href="/">Start a new diagram</a>
    </div>
  ),
);
