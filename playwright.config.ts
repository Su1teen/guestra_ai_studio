import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PLAYWRIGHT_CHANNEL
          ? { channel: process.env.PLAYWRIGHT_CHANNEL }
          : {}),
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "chromium",
        ...(process.env.PLAYWRIGHT_CHANNEL
          ? { channel: process.env.PLAYWRIGHT_CHANNEL }
          : {}),
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173/api/ready",
    reuseExistingServer: false,
    env: {
      DATABASE_URL: "",
      LOCAL_DATA_DIR:
        process.env.STUDIO_BROWSER_DATA_DIR ?? ".local/browser-tests",
      STUDIO_SANDBOX: "false",
      CRM_API_URL: "",
      CRM_API_KEY: "",
      PMS_API_URL: "",
      PMS_API_KEY: "",
      N8N_WEBHOOK_URL: "",
      N8N_CAPABILITIES_URL: "",
      MEDIA_SCANNER_URL: "",
      MEDIA_SCANNER_TOKEN: "",
    },
    timeout: 60000,
  },
});
