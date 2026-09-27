import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { PublicKey } from "@solana/web3.js";
import { api, freshState, testChain } from "../helpers/runtime.js";
import { csrf, dataOf, errorOf, get, post, sign, signInAs } from "../helpers/apiClient.js";
import type { Session } from "../helpers/apiClient.js";
import { ProductMetadataModel } from "../../src/models/index.js";
import { ROLE_ORDINALS } from "../../src/services/solana/layout.js";
import type { Role } from "../../src/lib/roles.js";
import { garbageTransaction, stripSignature } from "../helpers/signing.js";

/**
 * Batch registration, end to end.
 *
 * Registration is the clearest example of the two-phase chain flow: the first
 * call saves the details and returns an unsigned transaction, and nothing is
 * reported as registered until the second call has a wallet signature back and
 * the cluster has confirmed it. These tests hold both halves to that rule.
 */

interface PreparedAction {
  transaction: string;
  description: string;
  targetAddress: string;
  blockhash: string;
}

interface ProductSummary {
  productId: string;
  dataHash: string;
  chainState: string;
  status: string;
  ownerWallet: string;
  registrantRole: string;
  onChainTxHash: string | null;
  images: Array<{ mediaId: string; mimeType: string; contentHash: string }>;
}

interface RegistrationDraft {
  productId: string;
  dataHash: string;
  chainState: string;
  prepared: PreparedAction;
  product: ProductSummary;
}

interface RegistrationConfirmation {
  product: ProductSummary;
  signature: string;
  verificationUrl: string;
  qrPayload: string;
}

interface VerificationOutcome {
  verification: { result: string; chainReachable: boolean; recordPresent: boolean };
  product: { productId: string } | null;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PRODUCT_ID_PATTERN = /^AGT-[A-Z0-9]{3,6}-\d{4}-[A-Z0-9]{6}$/;

const REGISTRATION: Record<string, string> = {
  cropType: "Cassava",
  quantity: "50",
  unit: "kg",
  harvestDate: "2026-01-05",
  farmLocation: "Ibadan, Oyo State",
  description: "A batch of cassava harvested on the Ibara family farm.",
  additionalNotes: "Stored in the north barn.",
};

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** A session whose wallet also holds a registry entry in the chain double. */
async function onChainParticipant(role: Role): Promise<Session> {
  const session = await signInAs(api(), role);
  testChain().seedParticipant(new PublicKey(session.wallet.address), ROLE_ORDINALS[role]);
  return session;
}

function registrationWith(overrides: Record<string, string>): Record<string, string> {
  return { ...REGISTRATION, ...overrides };
}

function registerProduct(
  session: Session,
  overrides: Record<string, string> = {}
): request.Test {
  return request(api()).post("/api/products").set(csrf(session)).send(registrationWith(overrides));
}

function registerProductWithFiles(
  session: Session,
  file: { field: string; buffer: Buffer; filename: string; contentType: string }
): request.Test {
  const call = request(api()).post("/api/products").set(csrf(session));
  for (const [field, value] of Object.entries(REGISTRATION)) {
    call.field(field, value);
  }
  call.attach(file.field, file.buffer, {
    filename: file.filename,
    contentType: file.contentType,
  });
  return call;
}

async function submitRegistration(
  session: Session,
  productId: string,
  signedTransaction: string
): Promise<{ status: number; body: unknown }> {
  const response = await post(api(), session, `/api/products/${productId}/submit`, {
    signedTransaction,
  });
  return { status: response.status, body: response.body };
}

async function chainStateOf(productId: string): Promise<string | null> {
  const record = await ProductMetadataModel.findOne({ productId }).lean();
  return record?.chainState ?? null;
}

const REJECTED_FIELDS: Array<{ label: string; overrides: Record<string, string> }> = [
  { label: "no crop type", overrides: { cropType: "" } },
  { label: "a quantity of zero", overrides: { quantity: "0" } },
  { label: "a negative quantity", overrides: { quantity: "-12" } },
  { label: "no unit", overrides: { unit: "" } },
  { label: "an unreadable harvest date", overrides: { harvestDate: "the day before" } },
  { label: "no farm location", overrides: { farmLocation: "" } },
  { label: "a description under ten characters", overrides: { description: "Too short" } },
  { label: "a malformed product identifier", overrides: { productId: "BATCH-1" } },
];

describe("product registration", () => {
  beforeEach(freshState);

  it("prepares a registration for a farmer who holds an on-chain participant registration", async () => {
    const farmer = await onChainParticipant("FARMER");
    const response = await registerProduct(farmer);

    expect(response.status).toBe(201);
    const draft = dataOf<RegistrationDraft>(response);
    expect(draft.chainState).toBe("AWAITING_SIGNATURE");
    expect(draft.prepared.transaction.length).toBeGreaterThan(0);
    expect(draft.prepared.description).toContain(draft.productId);
    expect(draft.dataHash).toMatch(HASH_PATTERN);
    expect(draft.product.productId).toMatch(PRODUCT_ID_PATTERN);
  });

  it("records the batch on the chain once the wallet signature is submitted", async () => {
    const farmer = await onChainParticipant("FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));

    const response = await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
      signedTransaction: sign(draft.prepared, farmer),
    });

    expect(response.status).toBe(200);
    const confirmation = dataOf<RegistrationConfirmation>(response);
    expect(confirmation.product.chainState).toBe("CONFIRMED");
    expect(confirmation.signature.length).toBeGreaterThan(0);
    expect(confirmation.product.onChainTxHash).toBe(confirmation.signature);
    expect(confirmation.verificationUrl).toContain(`/verify/${draft.productId}`);
    expect(confirmation.qrPayload).toBe(confirmation.verificationUrl);

    const onChain = await testChain().fetchProduct(draft.productId);
    expect(onChain?.offChainDataHash).toBe(draft.dataHash);
    expect(onChain?.registrant).toBe(farmer.wallet.address);
  });

  it("leaves the batch off the chain and unconfirmed until the signature is submitted", async () => {
    const farmer = await onChainParticipant("FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));

    expect(await testChain().fetchProduct(draft.productId)).toBeNull();
    expect(await chainStateOf(draft.productId)).toBe("AWAITING_SIGNATURE");
  });

  it("refuses a second registration of an identifier that is already confirmed", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = "AGT-CASSAV-2026-DUP001";
    const draft = dataOf<RegistrationDraft>(
      await registerProduct(farmer, { productId })
    );
    await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
      signedTransaction: sign(draft.prepared, farmer),
    });

    const again = await registerProduct(farmer, { productId });
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe("PRODUCT_ALREADY_EXISTS");
  });

  it("refuses an identifier that exists on-chain but not in the database", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = "AGT-CASSAV-2026-GONE01";
    const draft = dataOf<RegistrationDraft>(
      await registerProduct(farmer, { productId })
    );
    await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
      signedTransaction: sign(draft.prepared, farmer),
    });
    await ProductMetadataModel.deleteOne({ productId });

    const again = await registerProduct(farmer, { productId });
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe("PRODUCT_ALREADY_EXISTS");
  });

  for (const role of ["PROCESSOR", "TRANSPORTER", "RETAILER"] as const) {
    it(`refuses a registration from a ${role.toLowerCase()}`, async () => {
      const session = await onChainParticipant(role);
      const response = await registerProduct(session);
      expect(response.status).toBe(403);
      expect(errorOf(response).code).toBe("ROLE_NOT_ALLOWED");
    });
  }

  it("allows a regulator to register a batch, as the program permits", async () => {
    const regulator = await onChainParticipant("REGULATOR");
    const response = await registerProduct(regulator, {
      cropType: "Yam",
      unit: "tubers",
    });
    expect(response.status).toBe(201);
    expect(dataOf<RegistrationDraft>(response).product.registrantRole).toBe("REGULATOR");
  });

  it("refuses a wallet that holds no on-chain participant registration", async () => {
    const farmer = await signInAs(api(), "FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));
    expect(draft.chainState).toBe("AWAITING_SIGNATURE");

    const response = await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
      signedTransaction: sign(draft.prepared, farmer),
    });

    // The program has no registry account for this wallet, which Anchor reports
    // as AccountNotInitialized.
    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("RECIPIENT_NOT_REGISTERED");
    expect(await testChain().fetchProduct(draft.productId)).toBeNull();
    expect(await chainStateOf(draft.productId)).not.toBe("CONFIRMED");
  });

  for (const rejected of REJECTED_FIELDS) {
    it(`rejects a registration with ${rejected.label}`, async () => {
      const farmer = await onChainParticipant("FARMER");
      const response = await registerProduct(farmer, rejected.overrides);
      expect(response.status).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_ERROR");
      expect(await ProductMetadataModel.countDocuments({})).toBe(0);
    });
  }

  it("refuses a registration submitted by a wallet that did not prepare it", async () => {
    const farmer = await onChainParticipant("FARMER");
    const other = await onChainParticipant("FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));

    const response = await post(api(), other, `/api/products/${draft.productId}/submit`, {
      signedTransaction: sign(draft.prepared, farmer),
    });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("FORBIDDEN");
    expect(await chainStateOf(draft.productId)).not.toBe("CONFIRMED");
    expect(await testChain().fetchProduct(draft.productId)).toBeNull();
  });

  it("refuses a transaction that is not a transaction at all", async () => {
    const farmer = await onChainParticipant("FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));

    const response = await submitRegistration(farmer, draft.productId, garbageTransaction());

    expect([422, 403]).toContain(response.status);
    expect(await chainStateOf(draft.productId)).not.toBe("CONFIRMED");
    expect(await testChain().fetchProduct(draft.productId)).toBeNull();
  });

  it("refuses a transaction that carries no wallet signature", async () => {
    const farmer = await onChainParticipant("FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));

    const response = await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
      signedTransaction: stripSignature(draft.prepared.transaction),
    });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("FORBIDDEN");
    expect(await chainStateOf(draft.productId)).not.toBe("CONFIRMED");
    expect(await testChain().fetchProduct(draft.productId)).toBeNull();
  });

  it("surfaces a duplicate product reported by the program and leaves the batch unconfirmed", async () => {
    const farmer = await onChainParticipant("FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));
    testChain().failNextSend = { code: 6000, name: "DuplicateProduct" };

    const response = await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
      signedTransaction: sign(draft.prepared, farmer),
    });

    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe("PRODUCT_ALREADY_EXISTS");
    expect(await chainStateOf(draft.productId)).not.toBe("CONFIRMED");
    expect(await testChain().fetchProduct(draft.productId)).toBeNull();
  });

  it("marks a prepared draft as cancelled", async () => {
    const farmer = await onChainParticipant("FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));

    const response = await post(api(), farmer, `/api/products/${draft.productId}/cancel`);

    expect(response.status).toBe(200);
    expect(dataOf<{ chainState: string }>(response).chainState).toBe("CANCELLED");
    expect(await chainStateOf(draft.productId)).toBe("CANCELLED");
  });

  it("refuses to cancel a batch that is already confirmed on-chain", async () => {
    const farmer = await onChainParticipant("FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));
    await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
      signedTransaction: sign(draft.prepared, farmer),
    });

    const response = await post(api(), farmer, `/api/products/${draft.productId}/cancel`);

    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe("PRODUCT_STATE_INVALID");
    expect(await chainStateOf(draft.productId)).toBe("CONFIRMED");
  });

  it("refuses to cancel a draft prepared by another wallet", async () => {
    const farmer = await onChainParticipant("FARMER");
    const other = await onChainParticipant("FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));

    const response = await post(api(), other, `/api/products/${draft.productId}/cancel`);

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("FORBIDDEN");
    expect(await chainStateOf(draft.productId)).toBe("AWAITING_SIGNATURE");
  });

  it("stores an attached PNG and records a SHA-256 of its bytes", async () => {
    const farmer = await onChainParticipant("FARMER");
    const response = await registerProductWithFiles(farmer, {
      field: "images",
      buffer: PNG_BYTES,
      filename: "barn.png",
      contentType: "image/png",
    });

    expect(response.status).toBe(201);
    const draft = dataOf<RegistrationDraft>(response);
    const stored = draft.product.images[0];
    expect(stored?.mimeType).toBe("image/png");
    expect(stored?.contentHash).toMatch(HASH_PATTERN);
    expect(draft.product.images).toHaveLength(1);
  });

  it("refuses a file whose bytes are not the type it declares", async () => {
    const farmer = await onChainParticipant("FARMER");
    const response = await registerProductWithFiles(farmer, {
      field: "images",
      buffer: Buffer.alloc(64, 0x41),
      filename: "not-really.png",
      contentType: "image/png",
    });

    expect(response.status).toBe(415);
    expect(errorOf(response).code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("refuses an executable", async () => {
    const farmer = await onChainParticipant("FARMER");
    const response = await registerProductWithFiles(farmer, {
      field: "images",
      buffer: Buffer.alloc(64, 0x4d),
      filename: "harvest.exe",
      contentType: "application/x-msdownload",
    });

    expect(response.status).toBe(415);
    expect(errorOf(response).code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("refuses a file larger than the permitted size", async () => {
    const farmer = await onChainParticipant("FARMER");
    const response = await registerProductWithFiles(farmer, {
      field: "images",
      buffer: Buffer.concat([PNG_BYTES, Buffer.alloc(1_100_000, 0)]),
      filename: "enormous.png",
      contentType: "image/png",
    });

    expect(response.status).toBe(413);
    expect(errorOf(response).code).toBe("FILE_TOO_LARGE");
  });

  it("replays the stored response when a request is repeated with the same Idempotency-Key", async () => {
    const farmer = await onChainParticipant("FARMER");
    const key = "registration-key-0001";

    const first = await registerProduct(farmer).set("idempotency-key", key);
    const second = await registerProduct(farmer).set("idempotency-key", key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(dataOf<{ productId: string }>(second).productId).toBe(
      dataOf<{ productId: string }>(first).productId
    );
    expect(await ProductMetadataModel.countDocuments({})).toBe(1);
  });

  it("verifies a confirmed batch as matching its blockchain record", async () => {
    const farmer = await onChainParticipant("FARMER");
    const draft = dataOf<RegistrationDraft>(await registerProduct(farmer));
    await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
      signedTransaction: sign(draft.prepared, farmer),
    });

    const response = await get(api(), null, `/api/products/${draft.productId}/verify`);

    expect(response.status).toBe(200);
    const outcome = dataOf<VerificationOutcome>(response);
    expect(outcome.verification.result).toBe("VERIFIED");
    expect(outcome.verification.chainReachable).toBe(true);
    expect(outcome.verification.recordPresent).toBe(true);
    expect(outcome.product?.productId).toBe(draft.productId);
  });
});
