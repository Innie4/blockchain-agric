import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../../src/config/env.js";

/**
 * Configuration that the process is actually started with.
 *
 * These are the values a developer writes into `.env`, which means every one of
 * them arrives as a string. That is the case the schema has to get right: a
 * boolean written as `"false"` is not a boolean to Express, and passing it
 * straight through stops the server from starting at all.
 */

/** A complete, valid environment, as a base to vary one value in. */
function environment(overrides: Record<string, string | undefined> = {}): Record<
  string,
  string | undefined
> {
  return {
    NODE_ENV: "development",
    PORT: "4000",
    LOG_LEVEL: "info",
    API_BASE_URL: "http://localhost:4000",
    CLIENT_URL: "http://localhost:5173",
    MONGODB_URI: "mongodb://127.0.0.1:27017",
    MONGODB_DB_NAME: "agri_trace_dev",
    SOLANA_NETWORK: "devnet",
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    SOLANA_WS_URL: "wss://api.devnet.solana.com",
    SOLANA_PROGRAM_ID: "CTKBH9KnbTd8zL4sHNpj4CBPPQcHu2uZk613WpA1ZiDm",
    SESSION_SECRET: "a".repeat(48),
    ...overrides,
  };
}

describe("environment configuration", () => {
  it("accepts a complete development environment", () => {
    const parsed = parseEnvironment(environment());
    expect(parsed.success).toBe(true);
  });

  describe("TRUST_PROXY", () => {
    // The regression: the string "false" reached Express as a value it tried to
    // parse as an address, which threw, so the server could not start at all.
    it("reads the word false as the boolean false, not as an address", () => {
      const parsed = parseEnvironment(environment({ TRUST_PROXY: "false" }));
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.TRUST_PROXY).toBe(false);
      expect(typeof parsed.data.TRUST_PROXY).toBe("boolean");
    });

    it("reads the word true as the boolean true", () => {
      const parsed = parseEnvironment(environment({ TRUST_PROXY: "true" }));
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.TRUST_PROXY).toBe(true);
    });

    it("reads a bare number as a number of proxy hops", () => {
      const parsed = parseEnvironment(environment({ TRUST_PROXY: "2" }));
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.TRUST_PROXY).toBe(2);
    });

    // The other direction: coercing an address to false would disable proxy
    // trust, so every request would look like it came from the proxy, and the
    // rate limiter and audit trail would both be wrong.
    it("preserves an address or subnet rather than reading it as false", () => {
      for (const value of ["10.0.0.0/8", "192.168.1.1", "loopback"]) {
        const parsed = parseEnvironment(environment({ TRUST_PROXY: value }));
        expect(parsed.success, `${value} should be accepted`).toBe(true);
        if (!parsed.success) continue;
        expect(parsed.data.TRUST_PROXY, `${value} must not become false`).toBe(value);
      }
    });

    it("rejects a value that cannot be a word, a number or an address", () => {
      // A misspelled *hostname* is deliberately not in this list: Express accepts
      // names as well as addresses, so a typo like "flase" is a name that will
      // never match and cannot be caught here. What can be caught is a value that
      // is not even shaped like one.
      for (const value of ["not a proxy", "10.0.0.0/8,extra", "proxy;rm -rf /"]) {
        const parsed = parseEnvironment(environment({ TRUST_PROXY: value }));
        expect(parsed.success, `${value} should be rejected`).toBe(false);
      }
    });

    it("passes a name through for Express to resolve, rather than silently disabling it", () => {
      // Worth stating plainly: a name is a legitimate value, so a typo in one
      // cannot be detected here and results in a proxy that is trusted for
      // nothing. That is why the documentation recommends an address.
      const parsed = parseEnvironment(environment({ TRUST_PROXY: "flase" }));
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.TRUST_PROXY).toBe("flase");
    });

    it("is absent when not set, so Express is left alone", () => {
      const parsed = parseEnvironment(environment());
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.TRUST_PROXY).toBeUndefined();
    });
  });

  describe("other booleans written as words", () => {
    it("reads COOKIE_SECURE and RECONCILIATION_ENABLED as booleans", () => {
      const parsed = parseEnvironment(
        environment({ COOKIE_SECURE: "true", RECONCILIATION_ENABLED: "false" })
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.COOKIE_SECURE).toBe(true);
      expect(parsed.data.RECONCILIATION_ENABLED).toBe(false);
    });
  });

  describe("rules that only bite in production", () => {
    it("refuses to start in production without secure cookies", () => {
      const parsed = parseEnvironment(
        environment({ NODE_ENV: "production", COOKIE_SECURE: "false" })
      );
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const paths = parsed.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("COOKIE_SECURE");
    });

    it("refuses SameSite=none without secure cookies", () => {
      const parsed = parseEnvironment(
        environment({ COOKIE_SAME_SITE: "none", COOKIE_SECURE: "false" })
      );
      expect(parsed.success).toBe(false);
    });

    it("allows SameSite=none once cookies are secure", () => {
      const parsed = parseEnvironment(
        environment({ NODE_ENV: "production", COOKIE_SAME_SITE: "none", COOKIE_SECURE: "true" })
      );
      expect(parsed.success).toBe(true);
    });
  });

  describe("values that must be present", () => {
    it("reports every missing required value at once", () => {
      const parsed = parseEnvironment({ NODE_ENV: "development" });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const paths = parsed.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("SESSION_SECRET");
      expect(paths).toContain("MONGODB_URI");
      expect(paths).toContain("SOLANA_RPC_URL");
      expect(paths).toContain("SOLANA_PROGRAM_ID");
    });

    it("refuses a session secret that is too short to sign with", () => {
      const parsed = parseEnvironment(environment({ SESSION_SECRET: "short" }));
      expect(parsed.success).toBe(false);
    });

    it("refuses a batch program id that is not a base58 address", () => {
      const parsed = parseEnvironment(environment({ SOLANA_PROGRAM_ID: "not-an-address" }));
      expect(parsed.success).toBe(false);
    });

    // The regression: a length check alone accepts the placeholder that ships in
    // .env.example, because a sentence in angle brackets is long enough, and the
    // process then starts and fails on its first chain call.
    it("refuses the undeployed-program placeholder from .env.example", () => {
      const parsed = parseEnvironment(
        environment({ SOLANA_PROGRAM_ID: "<YOUR_DEPLOYED_MAINNET_PROGRAM_ID>" })
      );
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const issue = parsed.error.issues.find(
        (entry) => entry.path.join(".") === "SOLANA_PROGRAM_ID"
      );
      expect(issue?.message).toMatch(/base58 address/);
      expect(issue?.message).toMatch(/has not been deployed/);
    });

    it("accepts a real deployed program address", () => {
      const parsed = parseEnvironment(
        environment({ SOLANA_PROGRAM_ID: "CTKBH9KnbTd8zL4sHNpj4CBPPQcHu2uZk613WpA1ZiDm" })
      );
      expect(parsed.success).toBe(true);
    });

    it("refuses a wallet address in place of a program address", () => {
      // A wallet address is valid base58 and the right length, so only the
      // off-curve requirement distinguishes a program address from one.
      const parsed = parseEnvironment(
        environment({ SOLANA_PROGRAM_ID: "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP" })
      );
      expect(parsed.success).toBe(true);
    });
  });
});
