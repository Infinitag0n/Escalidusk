import { randomUUID } from "node:crypto";

const HEARTBEAT_MS = 30_000;
const OPEN = 1; // WebSocket.readyState of an open socket

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Live collaboration rooms: one per diagram, holding everyone who has it open.
 *
 * The server only relays. Editors send element and settings changes and their
 * cursor position, and everyone else in the room receives them. Nothing sent
 * here is stored; diagrams are still saved through the HTTP API, and the room
 * is told when a save lands.
 *
 * People on a read-only link are in the same room but anything they send is
 * dropped, and they are never told the editing id (rooms are keyed by it, but
 * no message contains it).
 */
export function createLiveRooms() {
  const rooms = new Map(); // room id -> Set of clients

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

  const describe = (client) => ({ id: client.id, name: client.name, readOnly: client.readOnly });

  function relay(roomId, client, raw) {
    if (client.readOnly) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!isPlainObject(message)) return;

    if (message.t === "update") {
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
      if (out.elements || out.settings) broadcast(roomId, out, client);
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

  // Drop connections that silently went away (closed laptop, lost network).
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const client of room) {
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
    /** Adds a freshly connected socket to a diagram's room. */
    join(roomId, socket, { name, readOnly }) {
      const client = { id: randomUUID(), socket, name, readOnly, alive: true };
      let room = rooms.get(roomId);
      if (!room) {
        room = new Set();
        rooms.set(roomId, room);
      }
      send(client, JSON.stringify({ t: "welcome", id: client.id, peers: [...room].map(describe) }));
      broadcast(roomId, { t: "join", peer: describe(client) });
      room.add(client);

      socket.on("pong", () => {
        client.alive = true;
      });
      socket.on("message", (raw) => relay(roomId, client, raw));
      socket.on("error", () => socket.terminate());
      socket.on("close", () => {
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

    close() {
      clearInterval(heartbeat);
    },
  };
}
