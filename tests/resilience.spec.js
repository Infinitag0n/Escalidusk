import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { expect, test } from "@playwright/test";
import { createLiveRooms } from "../server/live.js";

// Live messages are handled outside any request. An error thrown there that
// nobody catches would stop the whole server, so each of these must end with
// the server still standing: only the connection concerned is closed.

/** Stands in for a WebSocket: records what it is sent and how it is closed. */
function fakeSocket({ failSend = false } = {}) {
  const socket = new EventEmitter();
  Object.assign(socket, {
    readyState: 1,
    sent: [],
    closedWith: null,
    terminated: false,
    send(text) {
      if (failSend) throw new Error("socket broke");
      socket.sent.push(JSON.parse(text));
    },
    close(code) {
      socket.closedWith = code;
      socket.readyState = 3;
    },
    terminate() {
      socket.terminated = true;
      socket.readyState = 3;
    },
    ping() {},
  });
  return socket;
}

const say = (socket, message) => socket.emit("message", Buffer.from(JSON.stringify(message)));
const hello = (socket, name = "Someone") => say(socket, { t: "hello", user: randomUUID(), name });

test("a database failure while someone joins closes their connection, not the server", () => {
  const errors = [];
  const live = createLiveRooms({ onError: (error, what) => errors.push([error.message, what]) });
  const room = randomUUID();
  try {
    const healthy = fakeSocket();
    live.join(room, healthy, { readOnly: false, identify: () => "public-a" });
    hello(healthy);

    const unlucky = fakeSocket();
    live.join(room, unlucky, {
      readOnly: false,
      identify: () => {
        throw new Error("disk I/O error");
      },
    });
    expect(() => hello(unlucky)).not.toThrow();
    expect(unlucky.closedWith).toBe(1011);
    expect(errors).toEqual([["disk I/O error", "handling a live message"]]);

    // The person already there is undisturbed, and never heard of the other.
    expect(healthy.closedWith).toBeNull();
    expect(healthy.sent.map((message) => message.t)).toEqual(["welcome"]);
    expect(live.presence().get(room)).toBe(1);
  } finally {
    live.close();
  }
});

test("a failure while someone is renamed closes their connection only", () => {
  const errors = [];
  const live = createLiveRooms({ onError: (error) => errors.push(error.message) });
  const room = randomUUID();
  try {
    let failing = false;
    const [one, two] = [fakeSocket(), fakeSocket()];
    live.join(room, one, { readOnly: false, identify: () => "public-a" });
    live.join(room, two, {
      readOnly: false,
      identify: () => {
        if (failing) throw new Error("database is locked");
        return "public-b";
      },
    });
    hello(one);
    hello(two);
    failing = true;
    expect(() => say(two, { t: "name", name: "New name" })).not.toThrow();
    expect(two.closedWith).toBe(1011);
    expect(errors).toEqual(["database is locked"]);
    expect(one.closedWith).toBeNull();
  } finally {
    live.close();
  }
});

test("one connection that cannot be written to does not keep a message from the others", () => {
  const errors = [];
  const live = createLiveRooms({ onError: (error, what) => errors.push(what) });
  const room = randomUUID();
  try {
    const sender = fakeSocket();
    const broken = fakeSocket();
    const fine = fakeSocket();
    for (const [index, socket] of [sender, broken, fine].entries()) {
      live.join(room, socket, { readOnly: false, identify: () => `public-${index}` });
      hello(socket);
    }
    broken.send = () => {
      throw new Error("socket broke");
    };

    expect(() => say(sender, { t: "pointer", x: 1, y: 2 })).not.toThrow();
    expect(fine.sent.at(-1)).toMatchObject({ t: "pointer", x: 1, y: 2 });
    expect(broken.terminated).toBe(true);
    expect(sender.closedWith).toBeNull();
    expect(errors).toEqual(["sending a live message"]);

    // Its leaving is announced without tripping over it again.
    expect(() => broken.emit("close")).not.toThrow();
    expect(fine.sent.at(-1).t).toBe("leave");
  } finally {
    live.close();
  }
});

test("nonsense on a connection is ignored or turned away, never thrown", () => {
  const errors = [];
  const live = createLiveRooms({ onError: (error) => errors.push(error.message) });
  try {
    const socket = fakeSocket();
    live.join(randomUUID(), socket, { readOnly: false, identify: () => "public" });
    hello(socket);
    for (const raw of ["", "not json", "null", "[]", '{"t":"update","elements":"x"}', '{"t":"pointer"}', '{"t":"name"}']) {
      expect(() => socket.emit("message", Buffer.from(raw)), raw).not.toThrow();
    }
    expect(errors).toEqual([]);
    expect(socket.closedWith).toBeNull();

    const stranger = fakeSocket();
    live.join(randomUUID(), stranger, { readOnly: false, identify: () => "public" });
    expect(() => stranger.emit("message", Buffer.from('{"t":"update"}'))).not.toThrow();
    expect(stranger.closedWith).toBe(1008);
  } finally {
    live.close();
  }
});
