import { createHmac } from "node:crypto";

/**
 * Turns network addresses into keyed hashes, so the database can tell
 * "same address as before" without holding the address itself.
 *
 * This is pseudonymisation, not anonymisation: whoever has both the hashes
 * and the secret could test candidate addresses against them. It keeps
 * addresses out of backups and casual view, which is the point.
 *
 * @param {string} secret key for the hash; a different secret gives unrelated hashes
 * @returns {(address: string | undefined) => string | undefined}
 */
export function createAddressHasher(secret) {
  return (address) => {
    if (!address) return undefined;
    // The same IPv4 client can show up as "1.2.3.4" or "::ffff:1.2.3.4".
    const normalised = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
    return createHmac("sha256", secret).update(normalised).digest("hex").slice(0, 32);
  };
}
