/**
 * The environment the test suite runs under.
 *
 * The API validates its configuration the instant `config/env` is imported, so
 * these values must be in `process.env` before any source module loads. This
 * module deliberately imports nothing, so both `vitest.config.ts` and
 * `tests/globalSetup.ts` can use it safely.
 *
 * The MongoDB URI names a fixed loopback port because the in-memory server is
 * started on that port by `tests/globalSetup.ts`; a random port would not be
 * knowable this early.
 */
export const TEST_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MONGODB_URI: "mongodb://127.0.0.1:27017/agri_trace_test",
  MONGODB_DB_NAME: "agri_trace_test",
  MONGODB_MAX_POOL_SIZE: "10",
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_URL: "http://127.0.0.1:8899",
  SOLANA_WS_URL: "ws://127.0.0.1:8900",
  SOLANA_PROGRAM_ID: "CTKBH9KnbTd8zL4sHNpj4CBPPQcHu2uZk613WpA1ZiDm",
  SOLANA_COMMITMENT: "confirmed",
  SOLANA_PREFETCH_COMMITMENT: "confirmed",
  // The lowest value the schema accepts; a confirmation-timeout test waits this
  // long, so it is kept as small as the configuration permits.
  SOLANA_TX_TIMEOUT_MS: "5000",
  SOLANA_RETRY_ATTEMPTS: "0",
  SESSION_SECRET: "test-session-secret-value-of-sufficient-length-for-hmac",
  AUTH_NONCE_TTL_SECONDS: "300",
  SESSION_TTL_SECONDS: "3600",
  COOKIE_SECURE: "false",
  COOKIE_SAME_SITE: "lax",
  CLIENT_URL: "http://localhost:5173",
  API_BASE_URL: "http://localhost:4000",
  CORS_ORIGINS: "http://localhost:5173",
  UPLOAD_MAX_FILE_BYTES: "1048576",
  UPLOAD_MAX_FILES_PER_REQUEST: "6",
  RECONCILIATION_ENABLED: "true",
} as const;

/** Loopback port the in-memory MongoDB listens on during tests. */
export const MONGODB_TEST_PORT = 27_017;

/** Cluster time the chain double reports, fixed so hashes are reproducible. */
export const CLUSTER_TIME = 1_700_000_000;
