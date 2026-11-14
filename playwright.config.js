import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = 3217;

// Every run gets its own empty database. Worker processes load this file too;
// the environment variable makes them reuse the folder the main process made.
process.env.ESCALIDUSK_TEST_DATA ??= mkdtempSync(path.join(tmpdir(), "escalidusk-test-"));

// Some tests open the database directly through Node's built-in SQLite
// module, which is still flagged experimental; keep that out of the output.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"]
  .filter(Boolean)
  .join(" ");

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Set PW_CHANNEL=msedge (or chrome) to use an installed browser instead of
    // downloading one with `npx playwright install chromium`.
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 1280, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
  // The tests run against the production build, served the same way as in the container.
  webServer: {
    command: "npm run build && node --disable-warning=ExperimentalWarning server/index.js",
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: {
      PORT: String(PORT),
      DATA_DIR: process.env.ESCALIDUSK_TEST_DATA,
      // Switches the backoffice on. tests/admin.spec.js signs in with the same value.
      ADMIN_PASSWORD: "test-admin-password",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
