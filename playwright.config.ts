import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true,
    launchOptions: existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] } : {},
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "npm run start -- --port 3100",
    url: "http://127.0.0.1:3100/api/status",
    reuseExistingServer: false,
    env: { LLM_BACKEND: "faq", LLM_API_KEY: "" },
    timeout: 60_000
  }
});
