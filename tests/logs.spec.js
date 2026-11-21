import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

/** Starts a separate server, runs `use` against it, and returns the lines it logged. */
async function logOf(env, use) {
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: mkdtempSync(path.join(tmpdir(), "escalidusk-logs-")),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const url = `http://127.0.0.1:${port}`;
  try {
    await expect
      .poll(() => fetch(`${url}/api/health`).then((r) => r.ok, () => false), { timeout: 15_000 })
      .toBe(true);
    await use(url);
    // Let the last lines through before stopping.
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    child.kill();
  }
  return output.split("\n").filter(Boolean);
}

/** A hundred health checks and a save: what a quiet day is made of. */
async function ordinaryUse(url, id) {
  for (let i = 0; i < 100; i++) await fetch(`${url}/api/health`);
  const save = await fetch(`${url}/api/diagrams/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseVersion: 0, elements: [], appState: {} }),
  });
  expect(save.status).toBe(200);
}

test("requests are not logged, so the log does not grow with use; starting and failures are", async () => {
  const id = randomUUID();
  const lines = await logOf({}, async (url) => {
    await ordinaryUse(url, id);
    // A request the server cannot answer is still worth a line.
    const broken = await fetch(`${url}/api/diagrams/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(broken.status).toBe(400);
  });
  expect(lines.some((line) => line.includes("Server listening"))).toBe(true);
  expect(lines.length).toBeLessThan(15);
  expect(lines.filter((line) => line.includes("/api/health"))).toEqual([]);
  // Diagram ids, which are what lets someone edit, stay out of the log.
  expect(lines.filter((line) => line.includes(id))).toEqual([]);
});

test("LOG_REQUESTS=true logs each request", async () => {
  const id = randomUUID();
  const lines = await logOf({ LOG_REQUESTS: "true" }, (url) => ordinaryUse(url, id));
  expect(lines.filter((line) => line.includes("/api/health")).length).toBeGreaterThanOrEqual(100);
  expect(lines.some((line) => line.includes("request completed"))).toBe(true);
});
