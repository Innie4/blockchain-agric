import { afterAll } from "vitest";
import { TEST_ENV, MONGODB_TEST_PORT } from "./helpers/testEnv.js";
import { startEnvironment, stopEnvironment } from "./helpers/environment.js";

/**
 * Runs once in the worker before any test module is imported.
 *
 * The API validates its configuration the moment `config/env` is evaluated, so
 * the values have to be in `process.env` before the first `src/` import. The
 * environment is then started here rather than in `globalSetup` because the
 * app, the database connection and the chain double all live in this process's
 * memory, and a forked test worker cannot see the globalSetup process.
 *
 * This relies on the suite running in a single non-isolated fork
 * (`poolOptions.forks.singleFork: true`, `isolate: false`), which is what makes
 * the started environment visible to every test file.
 */
for (const [key, value] of Object.entries(TEST_ENV)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

await startEnvironment(MONGODB_TEST_PORT);

afterAll(async () => {
  await stopEnvironment();
}, 120_000);
