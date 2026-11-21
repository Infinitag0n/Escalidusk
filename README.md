# Escalidusk

Self-hosted [Excalidraw](https://github.com/excalidraw/excalidraw) with server-side storage and permanent links. Every diagram lives at `<url>/<diagram-uuid>`.

- Opening `/` starts a new diagram and puts its UUID in the address bar. Once your browser has opened some diagrams, `/` lists them so you can go back to one, with a button for a new one (`/new` always starts a new one). The menu has the same list under **Open recent…**. The list is kept in your browser; the server offers no list of diagrams to anyone.
- Changes autosave about a second after you stop drawing.
- Tap the space bar to switch between editing and viewing (also in the menu). While viewing, nothing can be changed by accident, dragging pans, and the laser pointer is available. Holding the space bar still pans, as in Excalidraw.
- The address follows the mode: the editing link while editing, the read-only link while viewing. Your browser remembers which diagrams it can edit, so opening one of them through its read-only link starts in view mode with **Edit** one tap away. Anyone else gets the plain read-only page.
- The toolbar is a little shorter than stock Excalidraw's: Insert image and Eraser are under **More tools** (the last toolbar button). Their keyboard shortcuts (9, and E or 0) work as usual.
- Give a diagram a name by typing next to the menu button. It becomes the browser tab title and the default file name for exports.
- Images are stored separately from the scene, so saves stay small.
- Every diagram also has a read-only link: a second UUID that opens the same diagram for viewing only. The **Share** button (top right) copies it once the diagram has been saved; **Share Edit** copies the editing link. On phones both are in the menu. The read-only link cannot be turned back into the editing link.
- Link diagrams to each other: **Connect** (left of the toolbar, or in the menu) adds a hexagon that opens a diagram you pick from your recent ones. It shows that diagram's name and follows it when the diagram is renamed. You choose whether people who can edit this diagram get the linked one for editing (the default) or read-only. People viewing through the read-only link always get the linked diagram read-only: the server leaves the editing link out of everything it sends them.
- Moving between diagrams keeps your mode: from editing you land on the editable page when you may edit the target, from viewing you land on its read-only page.
- Any other link on an element that points to a diagram on the same server also opens in place.
- Live collaboration: everyone with a diagram open sees each other's changes and cursors as they happen. People on the read-only link take part too: they follow along live, are seen by the others, and can point at things with the laser pointer (the **Laser** button, or K), without being able to change anything.
- Others see you under the name in the bottom-right corner. It starts as a made-up "Guest" name; type over it to change it. It is remembered by your browser.
- If the live connection drops, editing and saving carry on; changes are merged when saving or when the connection returns, never overwritten.

Escalidusk is an unofficial community project. It is not affiliated with or endorsed by Excalidraw; it embeds the open-source `@excalidraw/excalidraw` editor.

Anyone who has a diagram's editing URL can view and edit it, and anyone with its read-only URL can view it. There is no login and no way to list diagrams. To keep out people you don't trust, put a sign-in in front of it, such as [Entra ID](#sign-in-with-entra-id).

## Run with Docker

```sh
docker compose up -d --build
```

Then open <http://localhost:3000>. Diagrams are kept in the `escalidusk-data` volume (a single SQLite database under `/data`).

| Variable   | Default   | Meaning                         |
| ---------- | --------- | ------------------------------- |
| `PORT`     | `3000`    | Port the server listens on. With Compose, the port on the host |
| `HOST`     | `0.0.0.0` | Address the server binds to     |
| `DATA_DIR` | `/data`   | Folder holding the database     |
| `BANNER` | unset | A thin yellow notice across the top of every page, such as `Experimental build 2026-11-18`. Plain text. Changing it needs only a restart |
| `BASE_PATH` | unset | Serve the app under a path, such as `/draw`, instead of at the root. With Docker, set it as a build argument; see below |
| `ADMIN_PASSWORD` | unset | Switches on the backoffice at `/admin`, and with it **Send feedback** in the editor. Without it neither exists |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy, so the visitor's address is read from `X-Forwarded-For` |
| `ADDRESS_RETENTION_DAYS` | `90` | How long user-to-address links are kept |
| `ADDRESS_SECRET` | generated | Key for hashing addresses. By default one is made up and stored in the database |

Live collaboration uses a WebSocket at `/api/diagrams/<id>/live`. Behind a reverse proxy, make sure WebSocket upgrades are passed through, or people will only see each other's changes after a save.

### Serving under a path

To serve the app at `https://example.com/draw` rather than at the root of a host, set `BASE_PATH=/draw`. The path is baked into the frontend when it is built, so with Docker it is a build argument, which the image also hands to the server:

```sh
docker build --build-arg BASE_PATH=/draw -t escalidusk .
```

or, with Compose, put it in `.env` (see `.env.example`). Changing it means rebuilding the image (`--build`). Without Docker, set it for both `npm run build` and `npm start`. The server logs a warning if the two differ.

The proxy may forward requests with the path (`/draw/api/...`) or with it stripped (`/api/...`); the server accepts both. With nginx, for example:

```nginx
location /draw/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Changing the path changes every diagram's address, so links shared before then stop working. Connections between diagrams (the hexagons) keep working: they open by the ids they carry, not by their address, and the address they show is moved to the new path the next time someone edits the diagram.

## Sign in with Entra ID

`docker-compose.entra.yml` puts a Microsoft Entra ID sign-in in front of Escalidusk, using [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/). Only people who can sign in to your tenant get in. Once in, everything works as it does without it: links, sharing and the backoffice are unchanged.

Nobody's name or email is stored or logged. The sign-in asks Microsoft only for an opaque id, which oauth2-proxy keeps in an encrypted cookie in the browser and does not pass on, so Escalidusk itself never learns who anyone is.

**1. Register the app in Entra** (Entra admin center, *App registrations*, *New registration*):

- Accounts in this organizational directory only.
- Redirect URI: platform *Web*, `https://<host><BASE_PATH>/oauth2/callback`, for example `https://example.com/draw/oauth2/callback`.
- Under *Certificates & secrets*, add a client secret. It expires (at most after two years); note the date, and replace it before then.
- To let in only some people: under *Enterprise applications*, open the app, set *Assignment required* to *Yes* in *Properties*, and add them under *Users and groups*.

**2. Put the settings in a `.env` file** next to the compose files:

```sh
BASE_PATH=/draw                                   # or leave empty for the root
PUBLIC_URL=https://example.com/draw               # where people open it, without a trailing slash
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_CLIENT_SECRET=<the secret's Value>
OAUTH2_PROXY_COOKIE_SECRET=<output of: openssl rand -hex 16>
```

**3. Start it:**

```sh
docker compose -f docker-compose.yml -f docker-compose.entra.yml up -d --build
```

The port (`PORT`, 3000 by default) now leads to oauth2-proxy, so a reverse proxy in front keeps pointing there (the nginx example above works as it is). Escalidusk is no longer reachable directly. The site must be served over HTTPS: Entra and the sign-in cookie require it.

Good to know:

- A sign-in lasts 12 hours (`OAUTH2_PROXY_COOKIE_EXPIRE`). When it runs out while someone is drawing, the editor says so and offers to sign in again in a new tab. Nothing is lost, and saving resumes once they have. Someone removed in Entra keeps access until their sign-in runs out.
- The server must be able to reach `login.microsoftonline.com`. If it goes out through an HTTP proxy, give the `oauth2-proxy` service `HTTPS_PROXY` and `NO_PROXY=escalidusk`.
- oauth2-proxy's log has no addresses or user names. A successful sign-in is logged with Microsoft's opaque id for the person.
- The server's clock must be right (use NTP), or sign-ins fail.

## Backoffice

Setting `ADMIN_PASSWORD` switches on a backoffice at `<url>/admin`. Without it there is no such page and no backoffice API: `/admin` behaves like any other address that is not a diagram. After signing in with that password you can:

- see every diagram, with who created and last changed it, its size, how many people have it open, and who has ever opened it (with view or edit access, when, and how often), and open any of them;
- delete a diagram. This is permanent. Its links then say it was deleted, and anyone who has it open is told and keeps their copy on screen, but can no longer save it;
- see the people the server knows about (see below), with how many addresses each was seen from and how many other people share one;
- read what people sent through **Send feedback** (the speech-bubble button at the bottom right of the editor, or in its menu), delete it, and export all of it as JSON or text. Only the message and the time it was sent are stored, not who sent it or from which diagram. A message is at most 4000 characters; nothing limits how many are sent;
- remove images that no diagram uses any more.

The password is the only protection, and whoever has it can open and delete everything, so use a long one and serve the site over HTTPS. Five wrong passwords lock sign-in for five minutes. A session lasts twelve hours and is lost when the server restarts.

## What is recorded about people

There are no accounts. To give some continuity, and a way to deal with gross misuse, the server keeps:

- **A user id per browser.** Each browser makes up a random id on first use and keeps it in its local storage. It is sent to the server only. Other people on a diagram see a different, public id.
- **The current display name** for that id, so someone who renames themselves is still the same user.
- **Who created and who last edited each diagram**, by user id.
- **Who opened each diagram**: per diagram and user id, whether they came through the editing or the read-only link, when they first and last opened it, and how many visits (coming back within half an hour counts as the same visit). Deleted along with the diagram.
- **Which network addresses a user id was seen from**, stored only as keyed hashes, never the address itself, and deleted after `ADDRESS_RETENTION_DAYS` without being seen. Addresses are also kept out of the server log.

This identity is a soft one. Clearing browser storage creates a new user, and nothing stops two people from sharing an id on purpose, so it is never used to decide what someone may do. The address hashes are pseudonymous rather than anonymous: someone holding both the database and the hashing key could test a specific address against them. The backoffice shows names, activity and address counts; it never shows a private id or an address hash.

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

## Upgrading Excalidraw

Several features depend on Excalidraw internals (class names, view-mode behaviour, the toolbar's structure). [UPGRADING-EXCALIDRAW.md](UPGRADING-EXCALIDRAW.md) lists each one, where it lives, and what to check after an upgrade.

## Layout

- `server/` — Fastify server: diagram and image API, serves the built frontend. `store.js` is the SQLite layer, `live.js` the collaboration rooms, `address.js` the address hashing, `admin.js` the backoffice API.
- `src/` — React app around the `@excalidraw/excalidraw` editor. `sync.js` holds autosave, image upload and merging; `live.js` the collaboration connection; `recent.js` the browser's list of opened diagrams; `diagramLinks.js` the hexagon links. `src/admin/` is the backoffice page, built separately so it does not load the editor.
- `tests/` — Playwright tests for the API and the editor.
- `scripts/copy-assets.mjs` — copies Excalidraw's fonts into `public/` so nothing is fetched from a CDN.

## API

| Request                                   | Result                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/diagrams/:id`                   | `{ id, readOnly, viewId, version, updatedAt, scene: { elements, appState } }` or 404. `:id` may be the editing id or the read-only id; with the read-only id, `readOnly` is true and `viewId` is omitted |
| `PUT /api/diagrams/:id`                   | Body `{ baseVersion, elements, appState }`. 409 with the stored copy if `baseVersion` is out of date; use `0` to create. 403 through a read-only id |
| `GET /api/diagrams/:id/files/:fileId`     | Image bytes                                                               |
| `PUT /api/diagrams/:id/files/:fileId`     | Raw image body with its `Content-Type`. 403 through a read-only id        |
| `POST /api/diagrams/summaries`             | Body `{ ids }` (editing or read-only ids). Returns each one's `{ name }`, `{ deleted: true }`, or `null` |
| `GET /api/diagrams/:id/live` (WebSocket)  | Collaboration room for the diagram; listen-only through a read-only id    |
| `GET /api/health`                         | `{ ok: true }`                                                            |

## License

[MIT](LICENSE). Excalidraw, which this project embeds, is also MIT licensed.

This repository contains no fonts. The build copies the fonts that ship inside the `@excalidraw/excalidraw` package into the app, so a built container image does contain them, each under its own licence:

| Font | Licence |
| --- | --- |
| Assistant, Cascadia Code, Excalifont, Lilita One, Nunito, Virgil, Xiaolai | SIL Open Font License 1.1 |
| Comic Shanns | MIT |
| Liberation Sans (version 1.05) | GPL v2 with font exception |

All of them allow commercial use. If you pass a built image on to others, the font licences apply to that: keep the copyright and licence notices with the fonts, and note that Liberation Sans 1.05 is the older GPL-licensed release (version 2 and later are under the Open Font License).
