// The app can live under a path prefix, such as https://example.com/draw,
// when a reverse proxy forwards only that path to it. BASE_PATH names the
// prefix. The build (vite.config.js) and the server both read it, because the
// built pages have the prefix baked into their asset addresses.

/**
 * BASE_PATH in one canonical form: "" for the root, otherwise a leading slash
 * and no trailing one ("draw", "/draw/" and "/draw" all become "/draw").
 */
export function normaliseBasePath(value = "") {
  const trimmed = String(value).trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  const segments = trimmed.split("/");
  const plain = /^[A-Za-z0-9._~-]+$/;
  if (!segments.every((part) => plain.test(part) && part !== "." && part !== "..")) {
    throw new Error(`BASE_PATH must be a plain path such as /draw, not ${JSON.stringify(value)}`);
  }
  return `/${trimmed}`;
}

/**
 * Removes the prefix from a request's URL, so routes can be written as if the
 * app were at the root. A URL without the prefix is left as it is: some
 * proxies strip the prefix before forwarding, and either way works.
 */
export function withoutBasePath(url, basePath) {
  if (!basePath || !url.startsWith(basePath)) return url;
  const rest = url.slice(basePath.length);
  if (rest === "") return "/";
  if (rest[0] === "/") return rest;
  if (rest[0] === "?") return `/${rest}`;
  return url; // "/drawing" is not under "/draw"
}
