import { monitorEventLoopDelay } from "node:perf_hooks";

const MINUTE_MS = 60_000;
// An hour of per-minute readings, and the last few hundred saves. Both are
// fixed in size: nothing here grows with time, and nothing is written to
// the database.
const MINUTES_KEPT = 60;
const SAVES_KEPT = 500;

const NS_PER_MS = 1e6;
const round = (ms) => Math.round(ms * 10) / 10;

/** The value below which `share` (0 to 1) of the sorted numbers fall. */
function percentile(sorted, share) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

/**
 * How the server is doing right now, measured in the process and kept in
 * memory only: it starts again from nothing when the server restarts.
 *
 * The one number that matters most is the event-loop delay. Everything here
 * runs on one thread, database included, so anything slow holds up every
 * save and every live message alike; the delay says by how much.
 *
 * @param {object} options
 * @param {() => number} options.connections how many live connections are open
 * @param {() => number} options.messages how many live messages were relayed since start
 */
export function createHealth({ connections, messages }) {
  const startedAt = Date.now();
  // The histogram reports how late a 20 ms timer fires, so 20 ms is "no delay".
  const resolution = 20;
  const delay = monitorEventLoopDelay({ resolution });
  delay.enable();
  const late = (ns) => Math.max(0, ns / NS_PER_MS - resolution);

  const minutes = []; // { typical, worst } in ms, oldest first
  let messagesAtLastMinute = 0;
  let messagesLastMinute = 0;
  const saves = []; // durations in ms, oldest first
  let serverErrors = 0;

  const current = () =>
    delay.count > 0 ? { typical: late(delay.mean), worst: late(delay.max) } : null;

  const timer = setInterval(() => {
    const reading = current();
    if (reading) minutes.push(reading);
    if (minutes.length > MINUTES_KEPT) minutes.shift();
    delay.reset();
    const total = messages();
    messagesLastMinute = total - messagesAtLastMinute;
    messagesAtLastMinute = total;
  }, MINUTE_MS);
  timer.unref();

  return {
    /** Notes how long a save took, start to finish. */
    recordSave(ms) {
      saves.push(ms);
      if (saves.length > SAVES_KEPT) saves.shift();
    },

    /** Notes a request the server failed to answer (a 5xx). */
    recordServerError() {
      serverErrors++;
    },

    report() {
      const readings = [...minutes, current()].filter(Boolean);
      const sortedSaves = [...saves].sort((a, b) => a - b);
      const typicalSave = percentile(sortedSaves, 0.5);
      const slowSave = percentile(sortedSaves, 0.95);
      return {
        startedAt,
        uptimeSeconds: Math.round(process.uptime()),
        memoryBytes: process.memoryUsage.rss(),
        // Over the last hour, or since the start if that is more recent.
        eventLoopDelay: {
          typicalMs: readings.length
            ? round(readings.reduce((sum, reading) => sum + reading.typical, 0) / readings.length)
            : 0,
          worstMs: readings.length ? round(Math.max(...readings.map((reading) => reading.worst))) : 0,
        },
        connections: connections(),
        messagesLastMinute,
        // Over the last few hundred saves.
        saves: {
          count: saves.length,
          typicalMs: typicalSave === null ? null : round(typicalSave),
          slowMs: slowSave === null ? null : round(slowSave),
        },
        serverErrors,
      };
    },

    close() {
      clearInterval(timer);
      delay.disable();
    },
  };
}
