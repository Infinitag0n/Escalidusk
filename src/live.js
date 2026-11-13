import { sharedSettings } from "./sync.js";

const POINTER_INTERVAL_MS = 50;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/**
 * Live collaboration for one open diagram, over a WebSocket to this server.
 *
 * Sends our element and settings changes to everyone else on the diagram as
 * they happen, applies theirs, and shows their cursors. It never stores
 * anything: saving stays with DiagramSync, which this class keeps informed.
 *
 * People on a read-only link receive everything but send nothing.
 */
export class LiveSession {
  #id;
  #api;
  #sync;
  #readOnly;
  #username;
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

  /**
   * @param {object} options
   * @param {string} options.id the id the diagram was opened with (editing or read-only)
   * @param {object} options.api Excalidraw imperative API
   * @param {import("./sync.js").DiagramSync} options.sync
   * @param {boolean} options.readOnly
   * @param {string} options.username shown next to our cursor on other people's screens
   * @param {readonly object[]} options.elements the scene as loaded
   * @param {object} options.settings sharedSettings() of the scene as loaded
   * @param {(count: number) => void} [options.onPeers] told how many other editors are present
   */
  constructor({ id, api, sync, readOnly, username, elements, settings, onPeers }) {
    this.#id = id;
    this.#api = api;
    this.#sync = sync;
    this.#readOnly = readOnly;
    this.#username = username;
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
    if (this.#disposed || this.#readOnly || !this.#ready || this.#peers.size === 0) return;
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

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#retryTimer);
    this.#socket?.close();
  }

  #connect() {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/api/diagrams/${this.#id}/live` +
        `?name=${encodeURIComponent(this.#username)}`,
    );
    this.#socket = socket;
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

  /** Hands the other editors to Excalidraw, which draws their cursors and avatars. */
  #publishPeers() {
    const collaborators = new Map();
    for (const [id, peer] of this.#peers) {
      if (peer.readOnly) continue; // viewers have no cursor to show
      collaborators.set(id, {
        id,
        socketId: id,
        username: peer.name,
        pointer: peer.pointer,
        button: peer.button,
        selectedElementIds: peer.selected,
      });
    }
    this.#api.updateScene({ collaborators });
    this.#onPeers?.(collaborators.size);
  }
}
