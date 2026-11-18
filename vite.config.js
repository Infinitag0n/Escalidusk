import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { bannerText, withBanner } from "./server/banner.js";
import { normaliseBasePath } from "./server/basePath.js";

const page = (name) => fileURLToPath(new URL(name, import.meta.url));

// Serve the app under a path such as /draw instead of at the root. The built
// pages carry it in their asset addresses, so the server must be started with
// the same BASE_PATH.
const BASE_PATH = normaliseBasePath(process.env.BASE_PATH);

// In production the server maps /admin to admin.html; do the same while developing.
const adminPage = {
  name: "escalidusk-admin-page",
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      const route = request.url.startsWith(BASE_PATH) ? request.url.slice(BASE_PATH.length) : request.url;
      if (/^\/admin\/?(\?|$)/.test(route)) request.url = `${BASE_PATH}/admin.html`;
      next();
    });
  },
};

// The server writes BANNER into the pages it serves; do the same while developing.
const devBanner = {
  name: "escalidusk-banner",
  apply: "serve",
  transformIndexHtml: (html) => withBanner(html, bannerText(process.env.BANNER)),
};

export default defineConfig({
  base: `${BASE_PATH}/`,
  plugins: [react(), adminPage, devBanner],
  define: {
    // Excalidraw reads this at runtime; without it the browser build
    // fails with "process is not defined".
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  server: {
    // Builds and test runs write here; the dev server has no reason to react to them.
    watch: {
      ignored: ["**/dist/**", "**/data/**", "**/test-results/**", "**/playwright-report/**"],
    },
    proxy: {
      // ws: live collaboration uses a WebSocket under /api.
      [`${BASE_PATH}/api`]: { target: "http://localhost:3000", ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
    // The editor, the backoffice (which does not load Excalidraw), and a tiny page for signing in again.
    rollupOptions: {
      input: {
        main: page("index.html"),
        admin: page("admin.html"),
        // Where "Sign in again" lands after a sign-in proxy has done its work.
        signedIn: page("signed-in.html"),
      },
    },
  },
});
