import { defineConfig } from "@playwright/test";

import {
  API_ORIGIN,
  API_PORT,
  CLIENT_ORIGIN,
  CLIENT_PORT,
  INFRA_CONTROL_ORIGIN,
  INFRA_READY_TIMEOUT_MS,
  MOCK_RPC_ORIGIN,
  SOLANA_NETWORK,
  SOLANA_PROGRAM_ID,
} from "./support/constants";

/**
 * The three processes the suite needs, started in this order and waited for in
 * this order. Playwright brings them up before it runs `globalSetup`, so the
 * environment file the API launcher reads is always written first.
 *
 *   1. `support/infra.ts`   MongoDB (mongodb-memory-server) and the mock Solana
 *                           JSON-RPC node, plus a small control port.
 *   2. `support/startApi.ts`  the repository's own `server/src`, unmodified.
 *   3. the Vite dev server  the repository's own `client`, with `/api` proxied.
 *
 * The client is told the cluster is `localnet` so its "wrong network" check has
 * no genesis hash to compare and never reaches out to a public endpoint; the
 * mock node is what it would have talked to anyway.
 *
 * `workers` is 1 because the flows share one database and one mock ledger, and
 * the fixture that clears them runs per test rather than per worker.
 */
export default defineConfig({
  testDir: "./specs",
  outputDir: "./.artifacts/test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: process.env["CI"] === undefined ? 0 : 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  globalSetup: "./support/globalSetup.ts",
  reporter: process.env["CI"] === undefined ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: CLIENT_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],

  webServer: [
    {
      command: "node node_modules/tsx/dist/cli.mjs tests/e2e/support/infra.ts",
      cwd: "../..",
      url: `${INFRA_CONTROL_ORIGIN}/ready`,
      timeout: INFRA_READY_TIMEOUT_MS,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node node_modules/tsx/dist/cli.mjs tests/e2e/support/startApi.ts",
      cwd: "../..",
      url: `${API_ORIGIN}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npm run dev --workspace @agri-trace/client -- --host 127.0.0.1 --port ${CLIENT_PORT} --strictPort`,
      cwd: "../..",
      url: `http://127.0.0.1:${CLIENT_PORT}`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        VITE_SOLANA_NETWORK: SOLANA_NETWORK,
        VITE_SOLANA_PROGRAM_ID: SOLANA_PROGRAM_ID,
        VITE_SOLANA_RPC_URL: MOCK_RPC_ORIGIN,
        VITE_API_BASE_URL: "/api",
        // The dev server's proxy target has to follow the API port, or the
        // browser is proxied to whatever else happens to be on the default one.
        API_PORT: String(API_PORT),
        CLIENT_PORT: String(CLIENT_PORT),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
