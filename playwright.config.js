// Playwright drives the popup page in real Chromium with the unpacked extension
// loaded (see tests/fixtures.js). Each test gets a fresh browser profile.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
});
