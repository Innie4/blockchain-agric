import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Environment loading for the API. Values are read from the process
 * environment first and from the repository `.env` files as a fallback, so the
 * documented `npm run dev` flow works without a separate export step.
 */
function loadDotEnv(): void {
  const files = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  for (const file of files) {
    try {
      const raw = readFileSync(file, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        const separator = trimmed.indexOf("=");
        if (separator === -1) continue;
        const key = trimmed.slice(0, separator).trim();
        let value = trimmed.slice(separator + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // A missing file is the normal case in CI and production.
    }
  }
}

loadDotEnv();

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(value.toLowerCase())
  );

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    API_BASE_URL: z.string().url().default("http://localhost:4000"),
    CLIENT_URL: z.string().url().default("http://localhost:5173"),
    CORS_ORIGINS: z.string().default("http://localhost:5173"),

    MONGODB_URI: z.string().min(1, "MONGODB_URI is required, for example mongodb://127.0.0.1:27017/agri_trace"),
    MONGODB_DB_NAME: z.string().min(1).default("agri_trace"),
    MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(500).default(20),

    SOLANA_NETWORK: z.enum(["devnet", "testnet", "mainnet-beta", "localnet"]).default("devnet"),
    SOLANA_RPC_URL: z.string().url(),
    SOLANA_WS_URL: z.string().url(),
    SOLANA_PROGRAM_ID: z.string().min(32, "SOLANA_PROGRAM_ID must be the deployed program address"),
    SOLANA_COMMITMENT: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
    SOLANA_PREFETCH_COMMITMENT: z.enum(["none", "processed", "confirmed", "finalized"]).default("confirmed"),
    SOLANA_TX_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(90_000),
    SOLANA_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),

    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    AUTH_NONCE_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(300),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(604_800),
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: booleanish.default(false),
    COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
    TRUST_PROXY: z.union([z.string(), z.boolean()]).optional(),

    UPLOAD_MAX_FILE_BYTES: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(5 * 1024 * 1024),
    UPLOAD_MAX_FILES_PER_REQUEST: z.coerce.number().int().min(1).max(50).default(10),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
    RATE_LIMIT_MAX_PUBLIC: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_MAX_AUTHENTICATED: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_MAX_AUTH_ATTEMPTS: z.coerce.number().int().min(1).default(20),
    RATE_LIMIT_MAX_UPLOADS: z.coerce.number().int().min(1).default(60),

    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(60).default(86_400),
    RECONCILIATION_ENABLED: booleanish.default(true),
  })
  .superRefine((value, ctx) => {
    if (value.COOKIE_SAME_SITE === "none" && !value.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_SAME_SITE"],
        message: 'COOKIE_SAME_SITE=none requires COOKIE_SECURE=true',
      });
    }
    if (value.NODE_ENV === "production" && !value.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_SECURE"],
        message: "COOKIE_SECURE must be true in production",
      });
    }
  });

export type Env = z.infer<typeof schema>;

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

let cached: Env | undefined;

/**
 * Reads and validates configuration. Throws with a precise, actionable list of
 * what is missing rather than starting in a half-configured state.
 */
export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = describeIssues(parsed.error);
    throw new Error(
      `Cannot start the API because the environment is not configured correctly:\n${details}\n\n` +
        "Copy .env.example to .env and fill in the values, then restart. " +
        "Every variable listed above is required by the code that reads it."
    );
  }
  cached = parsed.data;
  return cached;
}

export const env: Env = loadEnv();

export function corsOrigins(): string[] {
  return env.CORS_ORIGINS.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function publicRuntimeConfig() {
  return {
    apiBaseUrl: env.API_BASE_URL,
    solanaNetwork: env.SOLANA_NETWORK,
    solanaClusterLabel: env.SOLANA_NETWORK === "localnet" ? "Local validator" : env.SOLANA_NETWORK,
    solanaProgramId: env.SOLANA_PROGRAM_ID,
    solanaCommitment: env.SOLANA_COMMITMENT,
    uploadMaxFileBytes: env.UPLOAD_MAX_FILE_BYTES,
  };
}

/** Test helper: allows a suite to load configuration with a synthetic env. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
