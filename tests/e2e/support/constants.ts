/**
 * Fixed values for the end-to-end suite.
 *
 * Ports are pinned rather than discovered so that the API process, the Vite dev
 * server and the test process can all be configured from `playwright.config.ts`
 * without coordinating at runtime. Nothing here is production configuration:
 * these are the values a developer's machine happens to use, chosen so nothing
 * collides with a real dev server on :4000 or :5173.
 *
 * Each port can be overridden with an environment variable. That matters because
 * the suite starts a real API on the API port, so anything else already holding
 * it — another project's service, or a dev server left running — stops the suite
 * from starting with a bare "port already in use" rather than anything to do with
 * the code under test. The defaults are unchanged.
 */
function port(variable: string, fallback: number): number {
  const raw = process.env[variable];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${variable} must be a port number between 1 and 65535, got "${raw}".`);
  }
  return parsed;
}

/** The on-chain program the suite writes to. Matches `pda.ts`'s fallback id. */
export const SOLANA_PROGRAM_ID = "CTKBH9KnbTd8zL4sHNpj4CBPPQcHu2uZk613WpA1ZiDm";

/** The client dev server, which also proxies `/api` to the API. */
export const CLIENT_PORT = port("E2E_CLIENT_PORT", 5173);
export const CLIENT_ORIGIN = `http://localhost:${CLIENT_PORT}`;

/** The Express API. */
export const API_PORT = port("E2E_API_PORT", 4000);
export const API_ORIGIN = `http://localhost:${API_PORT}`;

/** The mock Solana JSON-RPC endpoint the API is pointed at. */
export const MOCK_RPC_PORT = port("E2E_MOCK_RPC_PORT", 8899);
export const MOCK_RPC_ORIGIN = `http://127.0.0.1:${MOCK_RPC_PORT}`;

/**
 * The infrastructure process (MongoDB + the mock RPC) also answers HTTP on this
 * port with a readiness document and a single control route used by the fixture
 * to clear the mock ledger between tests.
 */
export const INFRA_CONTROL_PORT = 8898;
export const INFRA_CONTROL_ORIGIN = `http://127.0.0.1:${INFRA_CONTROL_PORT}`;

/**
 * MongoDB, started by `mongodb-memory-server` on a free port it picks itself, so
 * two checkouts on one machine never collide.
 */
export const MONGO_DB_NAME = "agri_trace_e2e";

/** Where the infrastructure process records the connection details it chose. */
export const RUNTIME_ENV_FILE = "tests/e2e/.runtime/environment.json";

/**
 * `localnet` is the honest cluster name for the mock RPC: there is no public
 * explorer for it and no genesis hash to check a wallet against, so the client
 * skips the "wrong network" comparison and never reaches out to devnet.
 */
export const SOLANA_NETWORK = "localnet";

/**
 * Raised from the documented defaults. The rate limiters are *active* (the API
 * runs with `NODE_ENV=development`, not `test`, precisely so they are not
 * skipped) but the whole suite shares one loopback IP and would otherwise trip
 * the sign-in limit part-way through a multi-participant flow.
 */
export const RATE_LIMIT_MAX_PUBLIC = 5000;
export const RATE_LIMIT_MAX_AUTHENTICATED = 20000;
export const RATE_LIMIT_MAX_AUTH_ATTEMPTS = 2000;
export const RATE_LIMIT_MAX_UPLOADS = 2000;

/** Long enough for `mongodb-memory-server` to start a mongod on a cold machine. */
export const INFRA_READY_TIMEOUT_MS = 180_000;
