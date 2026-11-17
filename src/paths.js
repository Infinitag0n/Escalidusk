// Every address the app makes goes through here, because the app may be
// served under a path such as /draw (BASE_PATH, applied at build time).

/** The path the app lives under: "" at the root, or e.g. "/draw". */
export const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** An address on this server, from one written as if the app were at the root ("/api/…"). */
export const appPath = (path) => `${BASE}${path}`;

/** The same as a full URL, for links people copy and share. */
export const appUrl = (path) => `${window.location.origin}${BASE}${path}`;

/**
 * What follows the app's own path in a pathname, without slashes at either
 * end ("/draw/abc/" gives "abc"). Null for an address outside the app.
 */
export function routeOf(pathname) {
  if (BASE) {
    if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null;
    pathname = pathname.slice(BASE.length);
  }
  return pathname.replace(/^\/+|\/+$/g, "");
}
