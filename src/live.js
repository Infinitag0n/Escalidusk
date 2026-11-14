import { sharedSettings } from "./sync.js";

const POINTER_INTERVAL_MS = 50;
const LASER_INTERVAL_MS = 16; // a laser stroke needs more points than a cursor does
const LASER_FADE_MS = 1500; // how long a finished stroke is left to fade out
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/**
 * Live collaboration for one open diagram, over a WebSocket to this server.
 *
 * Sends our element and settings changes to everyone else on the diagram as
 * they happen, applies theirs, and shows their cursors. It never stores
 * anything: saving stays with DiagramSync, which this class keeps informed.
 *
 * People on a read-only link take part too: they are seen, with their
 * cursor and laser pointer, and they follow every change. What they never do
 * is send changes to the diagram.
 */
export class LiveSession {
  #id;
  #api;
  #sync;
  #readOnly;
  #username;
  #userId;
  #onPeers;
  #socket = null;
  #ready = false; // connected and welcomed by the server
  #everReady = false;
  #disposed = false;
  #retryDelay = RECONNECT_MIN_MS;
  #retryTimer = null;
  #sent = new Map(); // element id -> highest version sent to or received from the room
  #sentSettings; // JSON of the settings last sent to or received from the room
  #peers = new Map(); // client id -> { name, readOnly, pointer?, button?, selected? }
  #lastPointerAt = 0;
  #lastButton = "up";
  #selfId = null; // our connection's id, as the others know it
  #selfUser = null; // our public user id, as the others know it
  #laserStroke = null; // { x, y, button } while we draw a laser stroke ourselves
  #laserFadeTimer = null;

  /**
   * @param {object} options
   * @param {string} options.id the id the diagram was opened with (editing or read-only)
   * @param {object} options.api Excalidraw imperative API
   * @param {import("./sync.js").DiagramSync} options.sync
   * @param {boolean} options.readOnly
   * @param {string} options.username shown next to our cursor on other people's screens
   * @param {string} options.userId this browser's private user id; told to the server only
   * @param {readonly object[]} options.elements the scene as loaded
   * @param {object} options.settings sharedSettings() of the scene as loaded
   * @param {(count: number) => void} [options.onPeers] told how many other people are present
   */
  constructor({ id, api, sync, readOnly, username, userId, elements, settings, onPeers }) {
    this.#id = id;
    this.#api = api;
    this.#sync = sync;
    this.#readOnly = readOnly;
    this.#username = username;
    this.#userId = userId;
    this.#onPeers = onPeers;
    // What we loaded is what the server has; none of it needs sending.
    for (const element of elements) this.#sent.set(element.id, element.version);
    this.#sentSettings = JSON.stringify(settings);
    this.#connect();
  }

  /** Call from Excalidraw's onChange: sends whatever changed since last time. */
  handleChange(elements, appState) {
    if (this.#disposed || this.#readOnly || !this.#ready) return;

    const changed = [];
    for (const element of elements) {
      if ((this.#sent.get(element.id) ?? -1) < element.version) {
        changed.push(element);
        this.#sent.set(element.id, element.version);
      }
    }
    const settings = sharedSettings(appState);
    const settingsJson = JSON.stringify(settings);
    const settingsChanged = settingsJson !== this.#sentSettings;
    this.#sentSettings = settingsJson;

    // With nobody else here there is no one to tell. Anyone who joins later
    // loads the saved diagram, and we save promptly when they arrive.
    if (this.#peers.size === 0) return;
    if (changed.length === 0 && !settingsChanged) return;
    this.#send({
      t: "update",
      ...(changed.length ? { elements: changed } : {}),
      ...(settingsChanged ? { settings } : {}),
    });
  }

  /** Call from Excalidraw's onPointerUpdate: shares our cursor with the others. */
  handlePointer({ pointer, button }) {
    if (this.#disposed || !this.#ready || this.#peers.size === 0) return;
    // While we draw a laser stroke ourselves, Excalidraw still reports the
    // pointer as "up", which would cut the stroke short on other screens.
    if (this.#laserStroke?.button === "down") return;
    const now = Date.now();
    if (button === this.#lastButton && now - this.#lastPointerAt < POINTER_INTERVAL_MS) return;
    this.#lastPointerAt = now;
    this.#lastButton = button;
    this.#send({
      t: "pointer",
      x: pointer.x,
      y: pointer.y,
      tool: pointer.tool,
      button,
      selected: this.#api.getAppState().selectedElementIds,
    });
  }

  /**
   * Draws one point of a laser stroke on our own behalf. Used on read-only
   * pages, where Excalidraw turns every drag into panning and so never draws
   * the laser itself. The stroke is shown to the others as usual, and to us
   * by listing ourselves as a collaborator whose cursor is not drawn, which
   * makes Excalidraw render our trail exactly like everyone else's.
   * @param {"down" | "up"} button "down" for each point while drawing, "up" to finish
   * @param {{x: number, y: number}} point in scene coordinates
   */
  laserStroke(button, { x, y }) {
    if (this.#disposed) return;
    const now = Date.now();
    const sameButton = this.#laserStroke?.button === button;
    if (sameButton && now - this.#lastPointerAt < LASER_INTERVAL_MS) return;
    this.#lastPointerAt = now;
    this.#lastButton = button;

    clearTimeout(this.#laserFadeTimer);
    this.#laserStroke = { x, y, button };
    this.#publishPeers();
    if (this.#ready && this.#peers.size > 0) {
      this.#send({ t: "pointer", x, y, tool: "laser", button, selected: {} });
    }
    if (button === "up") {
      this.#laserFadeTimer = setTimeout(() => {
        this.#laserStroke = null;
        this.#publishPeers();
      }, LASER_FADE_MS);
    }
  }

  /** Changes the name other people see for us, from now on and after a reconnect. */
  setUsername(username) {
    this.#username = username;
    if (!this.#disposed && this.#ready) this.#send({ t: "name", name: username });
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#laserFadeTimer);
    this.#socket?.close();
  }

  #connect() {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/api/diagrams/${this.#id}/live`,
    );
    this.#socket = socket;
    // Introduce ourselves in a message, not in the address: addresses end up in logs.
    socket.onopen = () => {
      socket.send(JSON.stringify({ t: "hello", user: this.#userId, name: this.#username }));
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket || this.#disposed) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#receive(message);
    };
    socket.onclose = () => {
      if (this.#socket !== socket || this.#disposed) return;
      this.#ready = false;
      this.#peers.clear();
      this.#publishPeers();
      // Collaboration is an extra: keep working (and saving) and retry quietly.
      this.#retryTimer = setTimeout(() => this.#connect(), this.#retryDelay);
      this.#retryDelay = Math.min(this.#retryDelay * 2, RECONNECT_MAX_MS);
    };
  }

  #send(message) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #receive(message) {
    switch (message.t) {
      case "welcome": {
        this.#ready = true;
        this.#selfId = message.id;
        this.#selfUser = message.user;
        this.#retryDelay = RECONNECT_MIN_MS;
        this.#peers = new Map(message.peers.map((peer) => [peer.id, peer]));
        this.#publishPeers();
        // Others may hold changes made before we were listening. On a first
        // connection to an empty room the scene we just loaded is current.
        if (this.#everReady || this.#peers.size > 0) this.#sync.refresh();
        this.#everReady = true;
        // Send anything we changed while disconnected.
        this.handleChange(this.#api.getSceneElementsIncludingDeleted(), this.#api.getAppState());
        break;
      }
      case "join":
        this.#peers.set(message.peer.id, message.peer);
        this.#publishPeers();
        // The newcomer loads the saved diagram, so get ours saved right away.
        this.#sync.flush();
        break;
      case "leave":
        this.#peers.delete(message.id);
        this.#publishPeers();
        break;
      case "update": {
        for (const element of message.elements ?? []) {
          if ((this.#sent.get(element.id) ?? -1) < element.version) {
            this.#sent.set(element.id, element.version);
          }
        }
        if (message.settings) {
          this.#sentSettings = JSON.stringify({
            ...sharedSettings(this.#api.getAppState()),
            ...message.settings,
          });
        }
        this.#sync.applyRemote(message);
        break;
      }
      case "name": {
        const peer = this.#peers.get(message.from);
        if (!peer) break;
        peer.name = message.name;
        this.#publishPeers();
        break;
      }
      case "pointer": {
        const peer = this.#peers.get(message.from);
        if (!peer) break;
        peer.pointer = { x: message.x, y: message.y, tool: message.tool };
        peer.button = message.button;
        peer.selected = message.selected;
        this.#publishPeers();
        break;
      }
      case "saved":
        this.#sync.noteRemoteSave(message.version, message.key, message.viewId);
        break;
      default:
    }
  }

  /** Hands the other people to Excalidraw, which draws their cursors and avatars. */
  #publishPeers() {
    const collaborators = new Map();
    for (const [id, peer] of this.#peers) {
      collaborators.set(id, {
        // The same person in two tabs has one public user id and two connections.
        id: peer.user ?? id,
        socketId: id,
        username: peer.name,
        pointer: peer.pointer,
        button: peer.button,
        selectedElementIds: peer.selected,
      });
    }
    if (this.#laserStroke) {
      // Same ids as the others have for us, so our trail has the colour they see.
      const self = this.#selfId ?? "self";
      collaborators.set(self, {
        id: this.#selfUser ?? self,
        socketId: self,
        isCurrentUser: true,
        username: this.#username,
        pointer: { x: this.#laserStroke.x, y: this.#laserStroke.y, tool: "laser", renderCursor: false },
        button: this.#laserStroke.button,
      });
    }
    this.#api.updateScene({ collaborators });
    this.#onPeers?.(this.#peers.size);
  }
}
