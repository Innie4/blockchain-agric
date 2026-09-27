import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

import {
  API_ORIGIN,
  API_PORT,
  CLIENT_ORIGIN,
  RATE_LIMIT_MAX_AUTHENTICATED,
  RATE_LIMIT_MAX_AUTH_ATTEMPTS,
  RATE_LIMIT_MAX_PUBLIC,
  RATE_LIMIT_MAX_UPLOADS,
  RUNTIME_ENV_FILE,
} from "./constants";

/**
 * Starts the real API against the end-to-end infrastructure.
 *
 * The API is the repository's own `server/src`, run unmodified. Every value it
 * needs is supplied here; none of it is written into `.env`, so a developer's own
 * configuration is never touched and the suite cannot accidentally read it.
 *
 * `NODE_ENV` is `development` rather than `test` on purpose: the rate limiters
 * are skipped only under `test`, and the point of these tests is to exercise
 * the middleware as it actually runs. Their ceilings are raised instead, since
 * every request in the suite arrives from the same loopback address.
 *
 * This process exists as its own `webServer` entry because it must stay alive
 * for the whole run: it owns the API child process's lifetime, and Playwright
 * takes the child down with it when the run ends.
 *
 * WHY THE API IS BUNDLED BEFORE IT RUNS
 * `server/src` is ESM, and on this machine's Node 24 `tsx` cannot load it: the
 * API's own `npm run dev:server` fails with "The requested module 'mongoose'
 * does not provide an export named 'models'", because `mongoose` is CommonJS and
 * Node's static analysis of a CommonJS module cannot see its named exports. That
 * is a pre-existing toolchain problem, not something these tests introduce, and
 * `server/src` must not be changed to work around it.
 *
 * So this launcher bundles the repository's own sources with the `esbuild` that
 * Vite already depends on, leaving every third-party package external, and runs
 * the result as CommonJS. The bundle is a build of `server/src` exactly as it
 * stands: same modules, same code, same dependencies, and every Solana and
 * database call is made by the real API. The bundle is written under
 * `tests/e2e/.artifacts/`, never into `server/dist`, so nothing in the
 * repository's own build output is touched.
 */

interface RuntimeEnvironment {
  mongoUri: string;
  mongoDbName: string;
  mockRpcUrl: string;
  programId: string;
  network: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

function readRuntimeEnvironment(): RuntimeEnvironment {
  const file = resolve(REPO_ROOT, RUNTIME_ENV_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `${RUNTIME_ENV_FILE} has not been written. The infrastructure process must be started before the API; it is listed first in playwright.config.ts.`,
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as RuntimeEnvironment;
}

function serverEnvironment(environment: RuntimeEnvironment): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(API_PORT),
    LOG_LEVEL: process.env["LOG_LEVEL"] ?? "warn",
    API_BASE_URL: API_ORIGIN,
    CLIENT_URL: CLIENT_ORIGIN,
    CORS_ORIGINS: CLIENT_ORIGIN,

    MONGODB_URI: environment.mongoUri,
    MONGODB_DB_NAME: environment.mongoDbName,

    SOLANA_NETWORK: environment.network,
    SOLANA_RPC_URL: environment.mockRpcUrl,
    // Never used: nothing in these flows opens a subscription, and there is no
    // websocket here to open one to. The schema requires a URL regardless.
    SOLANA_WS_URL: "ws://127.0.0.1:8899",
    SOLANA_PROGRAM_ID: environment.programId,
    SOLANA_COMMITMENT: "confirmed",
    SOLANA_PREFETCH_COMMITMENT: "confirmed",
    SOLANA_TX_TIMEOUT_MS: "30000",
    SOLANA_RETRY_ATTEMPTS: "1",

    SESSION_SECRET: "end-to-end-suite-session-secret-0123456789",
    AUTH_NONCE_TTL_SECONDS: "300",
    // A KNOWN SERVER DEFECT, WHICH THE TEST CONFIGURATION WORKS AROUND
    // `res.cookie`'s `maxAge` is in MILLISECONDS (Express divides it by 1000
    // before writing `Max-Age`), but `sessionCookieOptions` is handed
    // `env.SESSION_TTL_SECONDS`, which is in seconds, by
    // `server/src/routes/auth.ts`. The browser is therefore told the session
    // cookie lasts `SESSION_TTL_SECONDS / 1000` seconds, so with the documented
    // default of a week a session expires after about ten minutes.
    //
    // The schema caps this value at 2_592_000, so the largest value it accepts
    // is used here: the browser is then told 2_592 seconds, which is far longer
    // than any flow needs, and the server-side session record still behaves
    // correctly because `expiresAt` is computed in seconds. `server/src` is not
    // modified. See the suite's final report for the production change needed.
    SESSION_TTL_SECONDS: "2592000",
    COOKIE_SECURE: "false",
    COOKIE_SAME_SITE: "lax",

    UPLOAD_MAX_FILE_BYTES: String(5 * 1024 * 1024),
    UPLOAD_MAX_FILES_PER_REQUEST: "10",

    RATE_LIMIT_WINDOW_MS: "60000",
    RATE_LIMIT_MAX_PUBLIC: String(RATE_LIMIT_MAX_PUBLIC),
    RATE_LIMIT_MAX_AUTHENTICATED: String(RATE_LIMIT_MAX_AUTHENTICATED),
    RATE_LIMIT_MAX_AUTH_ATTEMPTS: String(RATE_LIMIT_MAX_AUTH_ATTEMPTS),
    RATE_LIMIT_MAX_UPLOADS: String(RATE_LIMIT_MAX_UPLOADS),

    IDEMPOTENCY_TTL_SECONDS: "600",
    RECONCILIATION_ENABLED: "false",
  };
}

function bundleApi(): string {
  const entry = resolve(REPO_ROOT, "server", "src", "index.ts");
  const output = resolve(REPO_ROOT, "tests", "e2e", ".artifacts", "api-bundle.cjs");
  mkdirSync(dirname(output), { recursive: true });

  try {
    buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      // Every third-party package stays a `require`, so the CommonJS interop is
      // the real one those packages were written for.
      packages: "external",
      logLevel: "warning",
      outfile: output,
      absWorkingDir: REPO_ROOT,
    });
  } catch (error) {
    throw new Error(
      `The API could not be bundled for the test run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return output;
}

function main(): void {
  const environment = readRuntimeEnvironment();
  const entry = bundleApi();

  const child: ChildProcess = spawn(process.execPath, [entry], {
    cwd: REPO_ROOT,
    env: serverEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[api] ${chunk.toString("utf8")}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[api] ${chunk.toString("utf8")}`);
  });

  const stop = (): void => {
    if (child.exitCode === null) child.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  child.on("exit", (code, signal) => {
    process.stdout.write(`[api] the API exited (code ${code ?? "none"}, signal ${signal ?? "none"})\n`);
    process.exit(code ?? 0);
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `The end-to-end API could not be started: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
}
