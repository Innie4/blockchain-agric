import request from "supertest";
import type { Application } from "express";
import { CookieJar, createWallet, type TestWallet } from "./environment.js";
import { UserModel } from "../../src/models/index.js";
import type { ParticipantRoleValue } from "../../src/lib/roles.js";
import { signTransactionFrom } from "./signing.js";

/**
 * Helpers that drive the API the way the browser client does, including the
 * cookie pair and the CSRF header, so the tests exercise the real request
 * contract rather than a simplified one.
 */

export interface Session {
  wallet: TestWallet;
  jar: CookieJar;
  role: ParticipantRoleValue;
  userId: string;
}

export function client(app: Application): request.Agent {
  return request.agent(app);
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  message?: string;
}

/** Requests a challenge, signs it, and opens a session. */
export async function signIn(
  app: Application,
  wallet: TestWallet,
  jar: CookieJar
): Promise<Session> {
  const nonce = await request(app)
    .post("/api/auth/nonce")
    .send({ walletAddress: wallet.address });
  if (nonce.status !== 201) {
    throw new Error(`nonce request failed: ${nonce.status} ${JSON.stringify(nonce.body)}`);
  }
  const challenge = nonce.body.data as { nonce: string; message: string };

  const verify = await request(app)
    .post("/api/auth/verify")
    .set("cookie", jar.header())
    .send({
      walletAddress: wallet.address,
      nonce: challenge.nonce,
      signature: wallet.signMessage(challenge.message),
    });
  jar.capture(verify);
  if (verify.status !== 200) {
    throw new Error(`verify failed: ${verify.status} ${JSON.stringify(verify.body)}`);
  }
  const payload = verify.body.data as { user: { userId: string; role: ParticipantRoleValue } };
  return {
    wallet,
    jar,
    role: payload.user.role,
    userId: payload.user.userId,
  };
}

/** Creates a session and gives the participant a specific business role. */
export async function signInAs(
  app: Application,
  role: Exclude<ParticipantRoleValue, "CONSUMER">,
  options: { onChainRegistered?: boolean; fullName?: string; organisation?: string } = {}
): Promise<Session> {
  const wallet = createWallet();
  const jar = new CookieJar();
  const session = await signIn(app, wallet, jar);
  await UserModel.updateOne(
    { walletAddress: wallet.address },
    {
      $set: {
        role,
        fullName: options.fullName ?? defaultName(role),
        organisation: options.organisation ?? "",
        onChainRegistered: options.onChainRegistered ?? true,
        status: "ACTIVE",
      },
    }
  );
  return { ...session, role };
}

/**
 * Completes the real on-chain participant registration for a session.
 *
 * Every business role needs an entry in the on-chain registry before it can
 * register a batch or receive a transfer, because the program requires it. This
 * drives the production two-phase flow rather than seeding the double, so the
 * tests exercise the same code a participant would.
 */
export async function registerOnChain(app: Application, session: Session): Promise<void> {
  const prepared = await post(app, session, "/api/participant/register/prepare", {
    role: session.role,
    fullName: "Registered Participant",
    contactEmail: "",
    contactPhone: "",
    organisation: "",
  });
  if (prepared.status !== 200) {
    throw new Error(
      `participant registration prepare failed: ${prepared.status} ${JSON.stringify(prepared.body)}`
    );
  }
  const draft = dataOf<{ prepared: PreparedPayload }>(prepared);
  const submitted = await post(app, session, "/api/participant/register/submit", {
    signedTransaction: sign(draft.prepared, session),
  });
  if (submitted.status !== 200) {
    throw new Error(
      `participant registration submit failed: ${submitted.status} ${JSON.stringify(submitted.body)}`
    );
  }
}

/** A business participant whose wallet is registered in the on-chain registry. */
export async function signInRegistered(
  app: Application,
  role: Exclude<ParticipantRoleValue, "CONSUMER">,
  options: { fullName?: string; organisation?: string } = {}
): Promise<Session> {
  // The account starts as not-yet-registered so the real registration flow can
  // be driven; `registerOnChain` then sets the flag from the confirmed result.
  const session = await signInAs(app, role, { ...options, onChainRegistered: false });
  await registerOnChain(app, session);
  return session;
}

function defaultName(role: string): string {
  return `Test ${role.charAt(0)}${role.slice(1).toLowerCase()}`;
}

/** Adds the CSRF header a state-changing request needs. */
export function csrf(session: Session): Record<string, string> {
  const token = session.jar.get("agri_csrf");
  if (token === undefined) {
    throw new Error("The session has no CSRF token; sign in again.");
  }
  return { cookie: session.jar.header(), "x-csrf-token": token };
}

export function post(
  app: Application,
  session: Session,
  path: string,
  body?: unknown
): request.Test {
  const call = request(app).post(path).set(csrf(session));
  return body === undefined ? call : call.send(body as object);
}

export function patch(
  app: Application,
  session: Session,
  path: string,
  body?: unknown
): request.Test {
  const call = request(app).patch(path).set(csrf(session));
  return body === undefined ? call : call.send(body as object);
}

export function get(
  app: Application,
  session: Session | null,
  path: string
): request.Test {
  if (session === null) return request(app).get(path);
  return request(app).get(path).set({ cookie: session.jar.header() });
}

/** A POST that needs no session, such as recording a public verification. */
export function postPublic(app: Application, path: string, body?: unknown): request.Test {
  const call = request(app).post(path);
  return body === undefined ? call : call.send(body as object);
}

export interface PreparedPayload {
  transaction: string;
  description: string;
}

/** Signs the transaction a prepare step returned, as a wallet would. */
export function sign(prepared: PreparedPayload, session: Session): string {
  return signTransactionFrom(prepared.transaction, session.wallet);
}

export function dataOf<T>(response: { body: unknown }): T {
  const body = response.body as Envelope<T>;
  if (!body.success || body.data === undefined) {
    throw new Error(`expected a success envelope, received ${JSON.stringify(body)}`);
  }
  return body.data;
}

export function errorOf(response: { body: unknown }): {
  code: string;
  message: string;
  details?: unknown;
} {
  const body = response.body as Envelope<unknown>;
  if (body.success || body.error === undefined) {
    throw new Error(`expected a failure envelope, received ${JSON.stringify(body)}`);
  }
  return body.error;
}
