import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const page = (name) => fileURLToPath(new URL(name, import.meta.url));

// In production the server maps /admin to admin.html; do the same while developing.
const adminPage = {
  name: "escalidusk-admin-page",
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (/^\/admin\/?(\?|$)/.test(request.url)) request.url = "/admin.html";
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), adminPage],
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
      "/api": { target: "http://localhost:3000", ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
    // Two pages: the editor, and the backoffice (which does not load Excalidraw).
    rollupOptions: {
      input: { main: page("index.html"), admin: page("admin.html") },
    },
  },
});
