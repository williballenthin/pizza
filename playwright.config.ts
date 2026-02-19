import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3001",
    headless: true,
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro (mobile-first)
  },
  projects: [
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    command:
      "npx tsx src/server/main.ts --port 3001 --sessions-root /tmp/pi-web-e2e-sessions",
    port: 3001,
    reuseExistingServer: false,
    timeout: 15000,
  },
});
