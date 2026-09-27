import { describe, expect, it } from "vitest";
import { sessionTokenDigest, sha256Hex, generateSessionToken } from "../../src/lib/crypto.js";

/**
 * Session token digests are keyed with the deployment secret. The property that
 * matters is operational rather than cryptographic: rotating the secret must end
 * every existing session immediately, so an operator responding to an incident
 * does not have to touch the database.
 */
describe("session token digests", () => {
  const secret = "a-secret-value-of-sufficient-length-for-hmac";

  it("is stable for the same token and secret", () => {
    const token = generateSessionToken();
    expect(sessionTokenDigest(token, secret)).toBe(sessionTokenDigest(token, secret));
  });

  it("differs from an unkeyed digest of the same token", () => {
    const token = generateSessionToken();
    expect(sessionTokenDigest(token, secret)).not.toBe(sha256Hex(token));
  });

  it("differs for a different secret, so rotating the secret invalidates every session", () => {
    const token = generateSessionToken();
    const rotated = "a-completely-different-secret-of-sufficient-length";
    expect(sessionTokenDigest(token, secret)).not.toBe(sessionTokenDigest(token, rotated));
  });

  it("differs for a different token", () => {
    expect(sessionTokenDigest(generateSessionToken(), secret)).not.toBe(
      sessionTokenDigest(generateSessionToken(), secret)
    );
  });

  it("is a 64 character lowercase hex digest", () => {
    expect(sessionTokenDigest(generateSessionToken(), secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never reveals the token itself", () => {
    const token = generateSessionToken();
    expect(sessionTokenDigest(token, secret)).not.toContain(token);
  });
});
