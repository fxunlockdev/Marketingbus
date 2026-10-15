import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";
export default defineConfig({testDir:"./e2e",workers:1,use:{baseURL:"http://127.0.0.1:3000",channel:"chrome",trace:"retain-on-failure"},reporter:"list",
  webServer: process.env.CI ? { command: "npx next start --hostname 127.0.0.1", url: "http://127.0.0.1:3000/api/health", reuseExistingServer: false, timeout: 60000, env: { SECRET_ENCRYPTION_KEYS_JSON: JSON.stringify({ browser_fixture: randomBytes(32).toString("base64") }), SECRET_ENCRYPTION_ACTIVE_KEY: "browser_fixture" } } : undefined,
});
