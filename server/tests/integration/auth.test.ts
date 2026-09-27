import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { api, freshState } from "../helpers/runtime.js";
import { CookieJar, createWallet } from "../helpers/environment.js";
import { dataOf, errorOf, signIn } from "../helpers/apiClient.js";
import { UserModel } from "../../src/models/index.js";

/**
 * Wallet authentication.
 *
 * The central claim under test is that a wallet public key in a request body is
 * not proof of anything: only a signature over a server-issued, single-use,
 * expiring challenge opens a session.
 */
describe("wallet authentication", () => {
  beforeEach(freshState);

  it("issues a challenge for a valid wallet address", async () => {
    const wallet = createWallet();
    const response = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: wallet.address });

    expect(response.status).toBe(201);
    const challenge = dataOf<{ nonce: string; message: string; expiresAt: string }>(response);
    expect(challenge.nonce.length).toBeGreaterThanOrEqual(32);
    expect(challenge.message).toContain(wallet.address);
    expect(challenge.message).toContain(challenge.nonce);
    expect(new Date(challenge.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a challenge request for an address that is not a Solana wallet", async () => {
    const response = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: "definitely-not-a-wallet" });
    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
  });

  it("opens a session only when the signature verifies", async () => {
    const wallet = createWallet();
    const jar = new CookieJar();
    const session = await signIn(api(), wallet, jar);
    expect(session.wallet.address).toBe(wallet.address);
    expect(jar.get("agri_session")).toBeDefined();
    expect(jar.get("agri_csrf")).toBeDefined();
  });

  it("never sets the session cookie without a valid signature", async () => {
    const wallet = createWallet();
    const nonce = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: wallet.address });
    const challenge = nonce.body.data as { nonce: string; message: string };

    const response = await request(api())
      .post("/api/auth/verify")
      .send({
        walletAddress: wallet.address,
        nonce: challenge.nonce,
        signature: Buffer.alloc(64).toString("base64"),
      });

    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe("AUTH_SIGNATURE_INVALID");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a signature made by a different wallet", async () => {
    const wallet = createWallet();
    const impostor = createWallet();
    const nonce = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: wallet.address });
    const challenge = nonce.body.data as { nonce: string; message: string };

    const response = await request(api())
      .post("/api/auth/verify")
      .send({
        walletAddress: wallet.address,
        nonce: challenge.nonce,
        signature: impostor.signMessage(challenge.message),
      });

    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe("AUTH_SIGNATURE_INVALID");
  });

  it("refuses to replay a challenge that has already been used", async () => {
    const wallet = createWallet();
    const nonce = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: wallet.address });
    const challenge = nonce.body.data as { nonce: string; message: string };
    const signature = wallet.signMessage(challenge.message);

    const first = await request(api())
      .post("/api/auth/verify")
      .send({ walletAddress: wallet.address, nonce: challenge.nonce, signature });
    expect(first.status).toBe(200);

    const replay = await request(api())
      .post("/api/auth/verify")
      .send({ walletAddress: wallet.address, nonce: challenge.nonce, signature });
    expect(replay.status).toBe(401);
    expect(errorOf(replay).code).toBe("AUTH_NONCE_INVALID");
  });

  it("refuses a challenge issued for a different wallet", async () => {
    const wallet = createWallet();
    const other = createWallet();
    const nonce = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: other.address });
    const challenge = nonce.body.data as { nonce: string; message: string };

    const response = await request(api())
      .post("/api/auth/verify")
      .send({
        walletAddress: wallet.address,
        nonce: challenge.nonce,
        signature: wallet.signMessage(challenge.message),
      });

    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe("AUTH_NONCE_INVALID");
  });

  it("refuses a challenge that has expired", async () => {
    const wallet = createWallet();
    const nonce = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: wallet.address });
    const challenge = nonce.body.data as { nonce: string; message: string };

    const { AuthNonceModel } = await import("../../src/models/index.js");
    await AuthNonceModel.updateOne(
      { nonce: challenge.nonce },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const response = await request(api())
      .post("/api/auth/verify")
      .send({
        walletAddress: wallet.address,
        nonce: challenge.nonce,
        signature: wallet.signMessage(challenge.message),
      });

    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe("AUTH_NONCE_EXPIRED");
  });

  it("refuses an unknown challenge identifier", async () => {
    const wallet = createWallet();
    const response = await request(api())
      .post("/api/auth/verify")
      .send({
        walletAddress: wallet.address,
        nonce: "a-nonce-that-was-never-issued",
        signature: Buffer.alloc(64).toString("base64"),
      });
    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe("AUTH_NONCE_INVALID");
  });

  it("creates a consumer record on the first sign-in", async () => {
    const wallet = createWallet();
    const jar = new CookieJar();
    const session = await signIn(api(), wallet, jar);
    expect(session.role).toBe("CONSUMER");

    const user = await UserModel.findOne({ walletAddress: wallet.address }).lean();
    expect(user?.role).toBe("CONSUMER");
    expect(user?.status).toBe("ACTIVE");
    expect(user?.onChainRegistered).toBe(false);
  });

  it("reports the session and its permissions", async () => {
    const wallet = createWallet();
    const jar = new CookieJar();
    await signIn(api(), wallet, jar);

    const response = await request(api())
      .get("/api/auth/me")
      .set({ cookie: jar.header() });

    const me = dataOf<{ authenticated: boolean; user: { walletAddress: string }; permissions: string[] }>(
      response
    );
    expect(me.authenticated).toBe(true);
    expect(me.user.walletAddress).toBe(wallet.address);
    expect(me.permissions).toContain("product:read:any");
    expect(me.permissions).not.toContain("product:register");
  });

  it("reports no session when no cookie is presented", async () => {
    const response = await request(api()).get("/api/auth/me");
    const me = dataOf<{ authenticated: boolean; user: null; permissions: string[] }>(response);
    expect(me.authenticated).toBe(false);
    expect(me.user).toBeNull();
    expect(me.permissions).toEqual([]);
  });

  it("rejects a session token that was never issued", async () => {
    const response = await request(api())
      .get("/api/auth/me")
      .set({ cookie: "agri_session=not-a-real-session-token" });
    const me = dataOf<{ authenticated: boolean }>(response);
    expect(me.authenticated).toBe(false);
  });

  it("requires the CSRF token on a state-changing request", async () => {
    const wallet = createWallet();
    const jar = new CookieJar();
    await signIn(api(), wallet, jar);

    const withoutHeader = await request(api())
      .post("/api/auth/logout")
      .set({ cookie: jar.header() });
    expect(withoutHeader.status).toBe(403);
    expect(errorOf(withoutHeader).code).toBe("CSRF_TOKEN_INVALID");
  });

  it("rejects a CSRF token that does not match the cookie", async () => {
    const wallet = createWallet();
    const jar = new CookieJar();
    await signIn(api(), wallet, jar);

    const response = await request(api())
      .post("/api/auth/logout")
      .set({ cookie: jar.header(), "x-csrf-token": "a-different-token" });
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("CSRF_TOKEN_INVALID");
  });

  it("does not require CSRF on a safe request", async () => {
    const wallet = createWallet();
    const jar = new CookieJar();
    await signIn(api(), wallet, jar);
    const response = await request(api())
      .get("/api/auth/me")
      .set({ cookie: jar.header() });
    expect(response.status).toBe(200);
  });

  it("ends the session on logout and refuses the old cookie afterwards", async () => {
    const wallet = createWallet();
    const jar = new CookieJar();
    await signIn(api(), wallet, jar);
    const csrf = jar.get("agri_csrf") as string;

    const loggedOut = await request(api())
      .post("/api/auth/logout")
      .set({ cookie: jar.header(), "x-csrf-token": csrf });
    expect(loggedOut.status).toBe(200);

    const afterwards = await request(api())
      .get("/api/auth/me")
      .set({ cookie: jar.header() });
    const me = dataOf<{ authenticated: boolean }>(afterwards);
    expect(me.authenticated).toBe(false);
  });

  it("refuses an action from a suspended account", async () => {
    const wallet = createWallet();
    const jar = new CookieJar();
    const session = await signIn(api(), wallet, jar);
    await UserModel.updateOne(
      { walletAddress: wallet.address },
      { $set: { role: "FARMER", status: "SUSPENDED" } }
    );

    const response = await request(api())
      .get("/api/dashboard")
      .set({ cookie: session.jar.header() });
    expect(response.status).toBe(401);
  });

  it("keeps the keypair secret out of the challenge message", async () => {
    const wallet = createWallet();
    const nonce = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: wallet.address });
    const challenge = nonce.body.data as { message: string };
    const secret = Buffer.from(wallet.keypair.secretKey).toString("base64");
    expect(challenge.message).not.toContain(secret);
    expect(challenge.message.toLowerCase()).not.toContain("seed");
  });

  it("does not trust a role supplied in the request body", async () => {
    const wallet = createWallet();
    const jar = new CookieJar();
    const nonce = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: wallet.address });
    const challenge = nonce.body.data as { nonce: string; message: string };

    const response = await request(api())
      .post("/api/auth/verify")
      .send({
        walletAddress: wallet.address,
        nonce: challenge.nonce,
        signature: wallet.signMessage(challenge.message),
        role: "REGULATOR",
      });
    jar.capture(response);

    const me = dataOf<{ user: { role: string } }>(
      await request(api()).get("/api/auth/me").set({ cookie: jar.header() })
    );
    expect(me.user.role).toBe("CONSUMER");
  });

  it("records the sign-in in the audit trail", async () => {
    const wallet = createWallet();
    await signIn(api(), wallet, new CookieJar());
    const { AuditLogModel } = await import("../../src/models/index.js");
    const entry = await AuditLogModel.findOne({ actorWallet: wallet.address }).lean();
    expect(entry?.action).toBe("auth.session.created");
    expect(entry?.outcome).toBe("SUCCESS");
  });

  it("locks a wallet after repeated signature failures", async () => {
    const wallet = createWallet();
    // A lockout only applies to a wallet that has a record, which it acquires by
    // signing in once. Before that there is nothing to lock and nothing to gain:
    // every challenge is single-use and a wrong signature simply fails.
    await signIn(api(), wallet, new CookieJar());

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const nonce = await request(api())
        .post("/api/auth/nonce")
        .send({ walletAddress: wallet.address });
      const challenge = nonce.body.data as { nonce: string; message: string };
      await request(api())
        .post("/api/auth/verify")
        .send({
          walletAddress: wallet.address,
          nonce: challenge.nonce,
          signature: Buffer.alloc(64).toString("base64"),
        });
    }

    const user = await UserModel.findOne({ walletAddress: wallet.address }).lean();
    expect(user?.failedAuthAttempts).toBeGreaterThanOrEqual(5);
    expect(user?.lockedUntil).toBeInstanceOf(Date);

    const blocked = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: wallet.address });
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked).code).toBe("RATE_LIMITED");
  });

  it("refuses further attempts against a single exhausted challenge", async () => {
    const wallet = createWallet();
    const nonce = await request(api())
      .post("/api/auth/nonce")
      .send({ walletAddress: wallet.address });
    const challenge = nonce.body.data as { nonce: string; message: string };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(api())
        .post("/api/auth/verify")
        .send({
          walletAddress: wallet.address,
          nonce: challenge.nonce,
          signature: Buffer.alloc(64).toString("base64"),
        });
    }

    const { AuthNonceModel } = await import("../../src/models/index.js");
    const record = await AuthNonceModel.findOne({ nonce: challenge.nonce }).lean();
    expect(record?.attempts).toBe(5);

    const refused = await request(api())
      .post("/api/auth/verify")
      .send({
        walletAddress: wallet.address,
        nonce: challenge.nonce,
        signature: wallet.signMessage(challenge.message),
      });
    expect(refused.status).toBe(429);
  });
});
