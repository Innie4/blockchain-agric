import { defineConfig } from "vitest/config";
import { TEST_ENV } from "./tests/helpers/testEnv.js";

/**
 * The integration suite shares one worker process (`singleFork`, no isolation)
 * so the MongoDB connection, the Express app and the chain double started by
 * `tests/setupEnv.ts` are visible to every test file. Unit tests are unaffected
 * by that choice because they touch no shared resource.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setupEnv.ts"],
    globals: false,
    env: { ...TEST_ENV },
    testTimeout: 60_000,
    hookTimeout: 300_000,
    teardownTimeout: 120_000,
    isolate: false,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/types/**"],
    },
  },
});
