import { useState } from "react";
import { DiagramList } from "./DiagramList.jsx";
import { forgetDiagram, recentDiagrams } from "./recent.js";

/**
 * The page at "/" for a browser that has opened diagrams before: start a new
 * one, or go back to a recent one. A browser with no history skips this and
 * goes straight to a new diagram.
 */
export default function Home() {
  const [entries, setEntries] = useState(recentDiagrams);
  return (
    <main className="home">
      <header>
        <h1>Escalidusk</h1>
        <a className="home__new" href="/new">
          New diagram
        </a>
      </header>
      <h2>Recently opened in this browser</h2>
      <DiagramList
        entries={entries}
        emptyText="Nothing here any more. Start a new diagram."
        onPick={(entry) => window.location.assign(`/${entry.id}`)}
        onForget={(entry) => {
          forgetDiagram(entry.id);
          setEntries(recentDiagrams());
        }}
      />
    </main>
  );
}
