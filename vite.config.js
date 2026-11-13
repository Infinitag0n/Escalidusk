import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // Excalidraw reads this at runtime; without it the browser build
    // fails with "process is not defined".
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  server: {
    proxy: {
      // ws: live collaboration uses a WebSocket under /api.
      "/api": { target: "http://localhost:3000", ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
  },
});
