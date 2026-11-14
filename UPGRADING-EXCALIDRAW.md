# Upgrading Excalidraw

Escalidusk embeds `@excalidraw/excalidraw` and, in several places, depends on things Excalidraw does not promise to keep: class names, internal behaviour, the layout of its toolbar. This file lists every such place, so an upgrade can be checked instead of discovered.

Written against **0.18.1**. Update the version here after each upgrade.

## How to upgrade

1. Bump `@excalidraw/excalidraw` in `package.json` and run `npm install`.
2. Run `npm test`. Most of the items below have a test that fails when they break.
3. Go through the checklist. For each item, the "Check" column says what to look at; "Tests" names the test file that covers it. Items marked **by hand** have no test.
4. Read Excalidraw's release notes for anything under "Might become unnecessary" below. Removing our workaround is better than keeping it.
5. Re-read the font licences (last section) and update the table in `README.md`.
6. Update the version at the top of this file.

## Things we work around

These exist only because of how 0.18.1 behaves. A newer version may make them unnecessary or break them.

| What | Where | Why it exists | Check | Tests |
| --- | --- | --- | --- | --- |
| Laser strokes on view-mode pages are drawn by us | `onPointerDownCapture` in `src/Editor.jsx`; `laserStroke` in `src/live.js` | In view mode Excalidraw turns every left-button drag into panning, even with the laser tool selected | Does a drag with the laser draw a trail in view mode without our code? If so, delete ours | `live.spec.js`, `viewmode.spec.js` |
| Our own laser trail is shown by listing ourselves as a collaborator | `#publishPeers` in `src/live.js`; `.UserList .is-current-user` in `src/styles.css` | Excalidraw's local laser trail cannot be started from outside; its collaborator trails can, through `collaborators` with `pointer.tool: "laser"`, `renderCursor: false` and `button` | Trail still appears for the person drawing; no extra avatar flickers in the top bar | `live.spec.js` (stroke drawn on the viewer's canvas) |
| The K shortcut on view-mode pages is handled by us | `onKeyDown` in `src/Editor.jsx` | Excalidraw's key handler returns early when `viewModeEnabled` is set | Does K toggle the laser in view mode on its own? If so, ours would toggle twice: delete it | `live.spec.js` |
| Draw, Insert image and Eraser are moved under "More tools" | `src/MovedTools.jsx`; the `:has(...)` rules at the end of `src/styles.css` | Excalidraw has no setting for rearranging its toolbar | The class names and test ids in the next table; that clicking the menu button still closes the menu | `tools.spec.js` |
| A tap on the space bar switches mode | the space-bar effect in `src/Editor.jsx` | Excalidraw uses a *held* space bar for panning, so only a short tap counts | Holding space still pans; a tap still switches; `.excalidraw .Modal` still matches Excalidraw's dialogs | `viewmode.spec.js` |
| The hexagon link is a closed `line` grouped with a `text` | `src/diagramLinks.js` | Excalidraw has no custom element types | See "The hexagon" below | `diagram-links.spec.js` |
| The diagram name is an `<input>` with no `type` attribute | `TitleField` in `src/Editor.jsx` | Excalidraw styles every `input[type=text]` with a border and background | The name still looks like plain text | `title.spec.js` |
| The Library button shows only its icon | `.default-sidebar-trigger.sidebar-trigger .sidebar-trigger__label` in `src/styles.css` | To save room in the top bar. The selector is that specific to out-rank Excalidraw's own rule | Button is still icon-only and still opens the library | `topbar.spec.js` |
| `process.env.IS_PREACT` is defined at build time | `vite.config.js` | Without it the browser build fails with "process is not defined" | Remove it and see whether the build and the app still work | **by hand** |

## Class names, test ids and DOM structure we rely on

If any of these is renamed, the feature next to it stops working, usually silently.

| Selector | Used for | Where |
| --- | --- | --- |
| `.App-toolbar`, `[data-testid="toolbar-freedraw"]`, `[data-testid="toolbar-image"]`, `[data-testid="toolbar-eraser"]` (each inside a `label`) | Hiding the three moved tools | `src/styles.css` |
| `.App-toolbar__extra-tools-trigger`, `.App-toolbar__extra-tools-dropdown .dropdown-menu-container` | Finding the "More tools" button and its open menu | `src/MovedTools.jsx` |
| `.dropdown-menu-item`, `.dropdown-menu-item-base`, `.dropdown-menu-item--selected`, `.dropdown-menu-item__icon`, `__text`, `__shortcut` | Making our menu entries look like Excalidraw's | `src/MovedTools.jsx` |
| `.App-toolbar`, `.layer-ui__wrapper__top-right` (its children, except `.UserList__wrapper`), `.UserList` (its children), `.App-menu_top` | Measuring how much room the diagram name has | `useTitleRoom` in `src/Editor.jsx` |
| `.excalidraw-container` | Giving keyboard focus back to the canvas | `focusCanvas` in `src/Editor.jsx` |
| `.excalidraw .Modal` | Knowing an Excalidraw dialog is open | space-bar effect in `src/Editor.jsx` |
| `.UserList .is-current-user` | Hiding our own avatar during a laser stroke | `src/styles.css` |
| `.sidebar-trigger__label` | Icon-only Library button | `src/styles.css` |

The diagram name is positioned with fixed offsets (`top: 1rem; left: 3.75rem` in `src/styles.css`) that assume the menu button's size and the editor's padding. If the top-left corner changes, the name will overlap or drift. Covered by `title.spec.js`.

Our buttons borrow Excalidraw's CSS variables for colours, with fallbacks: `--island-bg-color`, `--shadow-island`, `--color-primary`, `--color-primary-darker`, `--color-primary-light`, `--color-surface-primary-container`, `--color-on-primary-container`, `--color-surface-lowest`, `--color-on-surface`, `--default-border-color`, `--button-hover-bg`, `--ui-font`. If one is renamed, the fallback colour shows instead: check the top bar in both themes **by hand**.

The tests additionally use `[data-testid="main-menu-trigger"]`, `toolbar-selection`, `toolbar-rectangle`, `toolbar-text`, `.excalidraw-hyperlinkContainer-link`, `canvas.excalidraw__canvas.static`, `.sidebar`, `.sidebar-trigger`, `.help-icon` and `.UserList`. A renamed one fails tests without breaking the app.

## Behaviour we rely on

| Behaviour | Where | Tests |
| --- | --- | --- |
| A `line` whose last point equals its first is filled like a shape | `src/diagramLinks.js` | `diagram-links.spec.js` |
| `convertToExcalidrawElements` accepts `points`, `groupIds`, `link` and `customData` on a line. It does **not** work out width and height from the points, so we pass them | `createDiagramLink` | `diagram-links.spec.js` |
| `customData` is kept through save, load and collaboration | `src/diagramLinks.js`, `server/links.js` | `diagram-links.spec.js` |
| An element `link` may be a relative path (`/<id>`), and opening it fires `onLinkOpen` | `onLinkOpen` in `src/Editor.jsx` | `diagram-links.spec.js`, `links.spec.js` |
| The link icon is drawn just outside an element's top-right corner (the tests click 7px right and 9px above it) | tests only | `diagram-links.spec.js`, `modes.spec.js` |
| Merging by `version` and `versionNonce` through `reconcileElements`; deleted elements kept with `isDeleted` | `src/sync.js` | `editor.spec.js`, `live.spec.js` |
| `hashElementsVersion` gives the same value for the same elements in every browser | `sceneKey` in `src/sync.js` | `live.spec.js` ("never conflict") |
| `updateScene({ collaborators })` draws cursors, selections, laser trails and avatars; `onPointerUpdate` reports our pointer | `src/live.js` | `live.spec.js` |
| Passing `viewModeEnabled` hides Excalidraw's own view-mode switch, leaving ours as the only one | `src/Editor.jsx` | `viewmode.spec.js` |
| `appState.name` holds the diagram's name and is the default export file name | `src/sync.js`, `src/Editor.jsx` | `title.spec.js` |
| `MainMenu.DefaultItems.*`, `Footer`, `useDevice().editor.isMobile`, `renderTopRightUI(isMobile)` | `src/Editor.jsx` | `topbar.spec.js`, `username.spec.js` |
| Images are kept by file id in `getFiles()` / `addFiles()`, separate from elements | `src/sync.js` | `editor.spec.js` |
| The package's fonts are in `dist/prod/fonts`, and `window.EXCALIDRAW_ASSET_PATH = "/"` makes it load them from us | `scripts/copy-assets.mjs`, `index.html` | `editor.spec.js` (fonts served locally) |
| The stylesheet is imported as `@excalidraw/excalidraw/index.css` | `src/Editor.jsx` | any browser test |

### The hexagon

Newer Excalidraw versions may give closed lines an explicit "polygon" property, or add real custom shapes. If so:

- Check that hexagons saved by 0.18.1 still render filled and closed.
- Check that new hexagons are created the way the new version expects (it may want the polygon property set).
- If custom shapes exist, consider replacing the line-plus-text pair, with a migration for existing diagrams. Both parts carry a marker in `customData.escalidusk` (`diagramLink` on the line, `diagramLinkLabel` on the text), which is how to find them.

## Might become unnecessary

Look for these in the release notes:

- Laser pointer usable in view mode, and tool shortcuts working there.
- A way to configure or extend the toolbar and the "More tools" menu.
- Custom element types or a polygon shape.
- A top-left slot for app content (we position the diagram name by hand).
- Updated dependencies. `npm audit` reports issues in mermaid, katex and lodash-es that come in through Excalidraw and can only be fixed by it.

## Fonts and licences

The build copies Excalidraw's fonts into the app, so a built image redistributes them. After an upgrade, check whether the set of fonts or their versions changed, and update the table in `README.md`.

In 0.18.1 all fonts are under the SIL Open Font License 1.1 or MIT, except **Liberation Sans 1.05**, which is the older release under GPL v2 with a font exception. Versions 2 and later of Liberation Sans are under the Open Font License, so an upgrade may clear this.

The licence text is embedded in most of the font files (name table, entries 13 and 14); Excalifont and Xiaolai carry none and were checked against their projects' own statements.
