/**
 * Fixed values for the end-to-end suite.
 *
 * Ports are pinned rather than discovered so that the API process, the Vite dev
 * server and the test process can all be configured from `playwright.config.ts`
 * without coordinating at runtime. Nothing here is production configuration:
 * these are the values a developer's machine happens to use, chosen so nothing
 * collides with a real dev server on :4000 or :5173.
 */

/** The on-chain program the suite writes to. Matches `pda.ts`'s fallback id. */
export const SOLANA_PROGRAM_ID = "AgriTrace418FNVcjry6EMUbiqx5DLTahpw4CKSZgov3";

/** The client dev server, which also proxies `/api` to the API. */
export const CLIENT_PORT = 5173;
export const CLIENT_ORIGIN = `http://localhost:${CLIENT_PORT}`;

/** The Express API. */
export const API_PORT = 4000;
export const API_ORIGIN = `http://localhost:${API_PORT}`;

/** The mock Solana JSON-RPC endpoint the API is pointed at. */
export const MOCK_RPC_PORT = 8899;
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
