// Copies Excalidraw's fonts into public/ so the app serves them itself
// instead of fetching them from a CDN at runtime.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageDir = new URL("../node_modules/@excalidraw/excalidraw/", import.meta.url);
const from = fileURLToPath(new URL("dist/prod/fonts", packageDir));
const to = fileURLToPath(new URL("../public/fonts", import.meta.url));
const marker = fileURLToPath(new URL("../public/fonts/.excalidraw-version", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("package.json", packageDir), "utf8"));

// Skip when this version's fonts are already in place. Rewriting hundreds of
// files on every build makes a running dev server reload them all each time.
if (existsSync(marker) && readFileSync(marker, "utf8") === version) {
  console.log(`Excalidraw ${version} fonts already in ${to}`);
} else {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  writeFileSync(marker, version);
  console.log(`Copied Excalidraw ${version} fonts to ${to}`);
}
