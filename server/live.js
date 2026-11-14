import { randomUUID } from "node:crypto";
import { withoutEditLinks } from "./links.js";

const HEARTBEAT_MS = 30_000;
const HELLO_TIMEOUT_MS = 10_000;
const OPEN = 1; // WebSocket.readyState of an open socket
const POLICY_VIOLATION = 1008; // WebSocket close code
export const DIAGRAM_DELETED = 4410; // our own close code: the diagram no longer exists
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A display name as shown to other people: trimmed, bounded, never empty. */
export function cleanName(raw) {
  return String(raw ?? "").trim().slice(0, 40) || "Guest";
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(raw) {
  try {
    const message = JSON.parse(raw.toString());
    return isPlainObject(message) ? message : null;
  } catch {
    return null;
  }
}

/**
 * Live collaboration rooms: one per diagram, holding everyone who has it open.
 *
 * A connection first says who it is ({ t: "hello", user, name }) and only
 * then joins the room. `user` is the person's private id; it is handed to the
 * `identify` callback and never sent to anyone. Other people see the public
 * id that callback returns.
 *
 * After that the server only relays. Everyone sends their cursor position
 * (which is also how the laser pointer travels) and their display name;
 * editors also send element and settings changes. Everyone else in the room
 * receives them. Nothing sent here is stored as diagram content; diagrams are
 * still saved through the HTTP API, and the room is told when a save lands.
 *
 * People on a read-only link are in the same room and are seen by the
 * others, but any diagram change they send is dropped, and they are never
 * told the editing id (rooms are keyed by it, but no message contains it).
 */
export function createLiveRooms() {
  const rooms = new Map(); // room id -> Set of clients
  const pending = new Set(); // connected, but not yet introduced

  function send(client, text) {
    if (client.socket.readyState === OPEN) client.socket.send(text);
  }

  function broadcast(roomId, message, except) {
    const room = rooms.get(roomId);
    if (!room) return;
    const text = JSON.stringify(message);
    for (const client of room) {
      if (client !== except) send(client, text);
    }
  }

  // What other people are told about someone. Never includes the private id.
  const describe = (client) => ({
    id: client.id,
    user: client.publicUser,
    name: client.name,
    readOnly: client.readOnly,
  });

  function relay(client, message) {
    const { roomId } = client;
    if (message.t === "name") {
      client.name = cleanName(message.name);
      client.identify({ user: client.privateUser, name: client.name });
      broadcast(roomId, { t: "name", from: client.id, name: client.name }, client);
    } else if (message.t === "update") {
      // The one thing a read-only connection may never do.
      if (client.readOnly) return;
      const out = { t: "update", from: client.id };
      if (Array.isArray(message.elements) && message.elements.length > 0) {
        out.elements = message.elements;
      }
      if (isPlainObject(message.settings)) {
        const { name, viewBackgroundColor } = message.settings;
        out.settings = {
          ...(typeof name === "string" ? { name: name.slice(0, 200) } : {}),
          ...(typeof viewBackgroundColor === "string"
            ? { viewBackgroundColor: viewBackgroundColor.slice(0, 64) }
            : {}),
        };
      }
      if (!out.elements && !out.settings) return;
      // Read-only connections get the same update minus any editing ids
      // carried by links to other diagrams.
      const safe = out.elements ? { ...out, elements: withoutEditLinks(out.elements) } : out;
      if (safe.elements === out.elements) {
        broadcast(roomId, out, client);
      } else {
        const [full, stripped] = [JSON.stringify(out), JSON.stringify(safe)];
        for (const other of rooms.get(roomId) ?? []) {
          if (other !== client) send(other, other.readOnly ? stripped : full);
        }
      }
    } else if (message.t === "pointer") {
      if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) return;
      broadcast(
        roomId,
        {
          t: "pointer",
          from: client.id,
          x: message.x,
          y: message.y,
          tool: message.tool === "laser" ? "laser" : "pointer",
          button: message.button === "down" ? "down" : "up",
          selected: isPlainObject(message.selected) ? message.selected : {},
        },
        client,
      );
    }
  }

  /** Handles the first message, which must be the introduction. */
  function introduce(client, message) {
    if (message?.t !== "hello" || typeof message.user !== "string" || !UUID_RE.test(message.user)) {
      client.socket.close(POLICY_VIOLATION, "expected hello");
      return;
    }
    clearTimeout(client.helloTimer);
    pending.delete(client);
    client.privateUser = message.user;
    client.name = cleanName(message.name);
    client.publicUser = client.identify({ user: client.privateUser, name: client.name });

    const { roomId } = client;
    let room = rooms.get(roomId);
    if (!room) {
      room = new Set();
      rooms.set(roomId, room);
    }
    send(
      client,
      JSON.stringify({
        t: "welcome",
        id: client.id,
        user: client.publicUser,
        peers: [...room].map(describe),
      }),
    );
    broadcast(roomId, { t: "join", peer: describe(client) });
    room.add(client);
    client.room = room;
  }

  // Drop connections that silently went away (closed laptop, lost network).
  const heartbeat = setInterval(() => {
    for (const clients of [pending, ...rooms.values()]) {
      for (const client of clients) {
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        client.socket.ping();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    /**
     * Takes a freshly connected socket for a diagram. It joins the room once
     * it has introduced itself.
     * @param {string} roomId the diagram's editing id
     * @param {object} socket
     * @param {object} options
     * @param {boolean} options.readOnly connected through a read-only id
     * @param {(who: {user: string, name: string}) => string} options.identify
     *   records the person (private id and display name) and returns their public id
     */
    join(roomId, socket, { readOnly, identify }) {
      const client = {
        id: randomUUID(),
        socket,
        roomId,
        room: null,
        readOnly,
        identify,
        privateUser: null,
        publicUser: null,
        name: "Guest",
        alive: true,
      };
      pending.add(client);
      client.helloTimer = setTimeout(
        () => socket.close(POLICY_VIOLATION, "no hello"),
        HELLO_TIMEOUT_MS,
      );

      socket.on("pong", () => {
        client.alive = true;
      });
      socket.on("message", (raw) => {
        const message = parse(raw);
        if (!client.room) introduce(client, message);
        else if (message) relay(client, message);
      });
      socket.on("error", () => socket.terminate());
      socket.on("close", () => {
        clearTimeout(client.helloTimer);
        pending.delete(client);
        const { room } = client;
        if (!room) return;
        room.delete(client);
        if (room.size === 0 && rooms.get(roomId) === room) rooms.delete(roomId);
        broadcast(roomId, { t: "leave", id: client.id });
      });
    },

    /**
     * Tells a diagram's room that a save landed. `key` is the saver's own
     * fingerprint of what it saved, so the others can tell whether they
     * already hold the same thing. The read-only id is included because an
     * editor who has not saved yet does not know it (viewers already do).
     */
    notifySaved(roomId, version, key, viewId) {
      broadcast(roomId, { t: "saved", version, key, viewId });
    },

    /** How many connections each diagram with anyone on it has right now. */
    presence() {
      return new Map([...rooms].map(([roomId, room]) => [roomId, room.size]));
    },

    /** Tells everyone on a diagram that it was deleted, and disconnects them. */
    closeRoom(roomId) {
      const room = rooms.get(roomId);
      if (!room) return;
      broadcast(roomId, { t: "deleted" });
      for (const client of [...room]) client.socket.close(DIAGRAM_DELETED, "diagram deleted");
    },

    close() {
      clearInterval(heartbeat);
    },
  };
}
