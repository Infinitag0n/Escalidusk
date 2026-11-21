// Sizes set in .env: MAX_DATABASE_SIZE (how large the database may grow; see
// openStore() for how it is enforced) and MAX_DIAGRAM_SIZE (how large one
// diagram may be).

const UNITS = { "": 1, B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
// Below this the database could not hold its own tables, let alone a diagram.
const SMALLEST_DATABASE = 1024 ** 2;

/**
 * A size as written in .env ("5GB", "500 MB", "1.5gb", or a plain number of
 * bytes) in bytes. Empty gives null: the setting was left out.
 * @param {string | undefined} value
 * @param {object} [setting]
 * @param {string} [setting.name] what to call it when complaining
 * @param {number} [setting.smallest] the least that can have been meant, in bytes
 * @param {string} [setting.smallestText] the same, as written
 * @throws {Error} when it is not a size, or too small to be meant
 */
export function parseSize(
  value,
  { name = "MAX_DATABASE_SIZE", smallest = SMALLEST_DATABASE, smallestText = "1MB" } = {},
) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?B?)$/i.exec(text);
  const unit = match && UNITS[match[2].toUpperCase().replace(/^([KMGT])$/, "$1B")];
  if (!unit) {
    throw new Error(`${name}: "${text}" is not a size. Write it like 5GB or 500MB.`);
  }
  const bytes = Math.floor(Number(match[1]) * unit);
  if (bytes < smallest) {
    throw new Error(`${name}: "${text}" is too small. The least that works is ${smallestText}.`);
  }
  return bytes;
}
