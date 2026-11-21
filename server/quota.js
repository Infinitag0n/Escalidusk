// MAX_DATABASE_SIZE: how large the database may grow. See openStore() for
// how it is enforced.

const UNITS = { "": 1, B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
// Below this the database could not hold its own tables, let alone a diagram.
const SMALLEST = 1024 ** 2;

/**
 * A size as written in .env ("5GB", "500 MB", "1.5gb", or a plain number of
 * bytes) in bytes. Empty means no limit, and gives null.
 * @throws {Error} when it is not a size, or too small to be meant
 */
export function parseSize(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?B?)$/i.exec(text);
  const unit = match && UNITS[match[2].toUpperCase().replace(/^([KMGT])$/, "$1B")];
  if (!unit) {
    throw new Error(`MAX_DATABASE_SIZE: "${text}" is not a size. Write it like 5GB or 500MB.`);
  }
  const bytes = Math.floor(Number(match[1]) * unit);
  if (bytes < SMALLEST) {
    throw new Error(`MAX_DATABASE_SIZE: "${text}" is too small. The least that works is 1MB.`);
  }
  return bytes;
}
