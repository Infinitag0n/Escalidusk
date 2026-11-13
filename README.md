# Escalidusk

Self-hosted [Excalidraw](https://github.com/excalidraw/excalidraw) with server-side storage and permanent links. Every diagram lives at `<url>/<diagram-uuid>`.

- Opening `/` starts a new diagram and puts its UUID in the address bar.
- Changes autosave about a second after you stop drawing.
- Images are stored separately from the scene, so saves stay small.
- A link on an element that points to another diagram on the same server opens it in place.
- Two tabs on the same diagram merge their changes when saving or regaining focus. This is not live collaboration: the other tab's edits show up on its next save or when you switch back.

Escalidusk is an unofficial community project. It is not affiliated with or endorsed by Excalidraw; it embeds the open-source `@excalidraw/excalidraw` editor.

Anyone who has a diagram's URL can view and edit it. There is no login; put the service behind a reverse proxy with authentication if it is reachable by people you don't trust.

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

## Develop

Needs Node 22.13 or newer.

```sh
npm install
npm run dev
```

This runs the API on port 3000 and the Vite dev server on <http://localhost:5173>, which proxies `/api` to it. Data goes to `./data`.

`npm run build && npm start` runs the production setup without Docker.

## Layout

- `server/` — Fastify server: diagram and image API, serves the built frontend. `store.js` is the SQLite layer.
- `src/` — React app around the `@excalidraw/excalidraw` editor. `sync.js` holds autosave, image upload and merging.
- `scripts/copy-assets.mjs` — copies Excalidraw's fonts into `public/` so nothing is fetched from a CDN.

## API

| Request                                   | Result                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/diagrams/:id`                   | `{ id, version, updatedAt, scene: { elements, appState } }` or 404        |
| `PUT /api/diagrams/:id`                   | Body `{ baseVersion, elements, appState }`. 409 with the stored copy if `baseVersion` is out of date; use `0` to create |
| `GET /api/diagrams/:id/files/:fileId`     | Image bytes                                                               |
| `PUT /api/diagrams/:id/files/:fileId`     | Raw image body with its `Content-Type`                                    |
| `GET /api/health`                         | `{ ok: true }`                                                            |

## License

[MIT](LICENSE). Excalidraw, which this project embeds, is also MIT licensed. The fonts bundled into the built app come from the Excalidraw package and keep their own licenses.
