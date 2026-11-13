# Escalidusk

Self-hosted [Excalidraw](https://github.com/excalidraw/excalidraw) with server-side storage and permanent links. Every diagram lives at `<url>/<diagram-uuid>`.

- Opening `/` starts a new diagram and puts its UUID in the address bar.
- Changes autosave about a second after you stop drawing.
- Give a diagram a name by typing next to the menu button. It becomes the browser tab title and the default file name for exports.
- Images are stored separately from the scene, so saves stay small.
- Every diagram also has a read-only link: a second UUID that opens the same diagram for viewing only. The **Share** button (top right) copies it once the diagram has been saved; **Share Edit** copies the editing link. On phones both are in the menu. The read-only link cannot be turned back into the editing link.
- A link on an element that points to another diagram on the same server opens it in place.
- Live collaboration: everyone with a diagram open sees each other's changes and cursors as they happen. People on the read-only link follow along live too, without being able to change anything.
- If the live connection drops, editing and saving carry on; changes are merged when saving or when the connection returns, never overwritten.

Escalidusk is an unofficial community project. It is not affiliated with or endorsed by Excalidraw; it embeds the open-source `@excalidraw/excalidraw` editor.

Anyone who has a diagram's editing URL can view and edit it, and anyone with its read-only URL can view it. There is no login and no way to list diagrams; put the service behind a reverse proxy with authentication if it is reachable by people you don't trust.

## Run with Docker

```sh
docker compose up -d --build
```

Then open <http://localhost:3000>. Diagrams are kept in the `escalidusk-data` volume (a single SQLite database under `/data`).

| Variable   | Default   | Meaning                         |
| ---------- | --------- | ------------------------------- |
| `PORT`     | `3000`    | Port the server listens on      |
| `HOST`     | `0.0.0.0` | Address the server binds to     |
| `DATA_DIR` | `/data`   | Folder holding the database     |

Live collaboration uses a WebSocket at `/api/diagrams/<id>/live`. Behind a reverse proxy, make sure WebSocket upgrades are passed through, or people will only see each other's changes after a save.

## Develop

Needs Node 22.13 or newer.

```sh
npm install
npm run dev
```

This runs the API on port 3000 and the Vite dev server on <http://localhost:5173>, which proxies `/api` to it. Data goes to `./data`.

`npm run build && npm start` runs the production setup without Docker.

## Test

```sh
npx playwright install chromium   # once, downloads a browser
npm test
```

The tests build the app, start it on a spare port with an empty temporary database, and drive it through the API and a real browser. To use a browser you already have instead of downloading one, set `PW_CHANNEL` to `msedge` or `chrome`.

Running `docker compose watch` instead of `docker compose up` rebuilds and restarts the container whenever the source changes.

## Layout

- `server/` — Fastify server: diagram and image API, serves the built frontend. `store.js` is the SQLite layer, `live.js` the collaboration rooms.
- `src/` — React app around the `@excalidraw/excalidraw` editor. `sync.js` holds autosave, image upload and merging; `live.js` the collaboration connection.
- `tests/` — Playwright tests for the API and the editor.
- `scripts/copy-assets.mjs` — copies Excalidraw's fonts into `public/` so nothing is fetched from a CDN.

## API

| Request                                   | Result                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/diagrams/:id`                   | `{ id, readOnly, viewId, version, updatedAt, scene: { elements, appState } }` or 404. `:id` may be the editing id or the read-only id; with the read-only id, `readOnly` is true and `viewId` is omitted |
| `PUT /api/diagrams/:id`                   | Body `{ baseVersion, elements, appState }`. 409 with the stored copy if `baseVersion` is out of date; use `0` to create. 403 through a read-only id |
| `GET /api/diagrams/:id/files/:fileId`     | Image bytes                                                               |
| `PUT /api/diagrams/:id/files/:fileId`     | Raw image body with its `Content-Type`. 403 through a read-only id        |
| `GET /api/diagrams/:id/live` (WebSocket)  | Collaboration room for the diagram; listen-only through a read-only id    |
| `GET /api/health`                         | `{ ok: true }`                                                            |

## License

[MIT](LICENSE). Excalidraw, which this project embeds, is also MIT licensed. The fonts bundled into the built app come from the Excalidraw package and keep their own licenses.
