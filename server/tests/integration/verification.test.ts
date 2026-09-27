import { beforeEach, describe, expect, it } from "vitest";
import { api, freshState, testChain } from "../helpers/runtime.js";
import { dataOf, errorOf, get, post, postPublic, sign, signInAs } from "../helpers/apiClient.js";
import type { Session } from "../helpers/apiClient.js";
import {
  ProductMetadataModel,
  VerificationEventModel,
} from "../../src/models/index.js";
import { PublicKey } from "@solana/web3.js";
import { ROLE_ORDINALS } from "../../src/services/solana/layout.js";
import type { Role } from "../../src/lib/roles.js";

/**
 * Public verification and the provenance it returns.
 *
 * The claim under test is that a consumer can check a batch without an account
 * and that the answer is derived from the chain rather than from whatever the
 * database currently holds. Tampering is simulated by editing the stored record
 * directly, which is exactly what an attacker with database access would do.
 */

interface PreparedAction {
  transaction: string;
  description: string;
}

interface VerificationBody {
  result: string;
  productId: string;
  headline: string;
  explanation: string;
  chainReachable: boolean;
  recordPresent: boolean;
  dataHash: { onChain: string | null; stored: string | null; computed: string | null };
  mismatch: {
    reason: string;
    explanation: string;
    expected: string;
    actual: string;
  } | null;
  verificationId: string;
}

interface PublicProductView {
  productId: string;
  cropType: string;
  status: string;
  currentOwnerCategory: string | null;
  registrantCategory: string;
  provenance: Array<{ sequence: number; kind: string; occurredAt: string }>;
  verificationCount: number;
  lastVerificationResult: string;
}

interface VerificationOutcome {
  verification: VerificationBody;
  product: PublicProductView | null;
}

interface ProductHistory {
  productId: string;
  status: string;
  chainState: string;
  integrity: { status: string; detail: string };
  provenance: Array<{ sequence: number; kind: string; occurredAt: string; title: string }>;
  counts: {
    transfers: number;
    processingEvents: number;
    transportEvents: number;
    certificates: number;
    verifications: number;
  };
}

interface SearchResultRow {
  productId: string;
  cropType: string;
  statusLabel: string;
  lastVerificationResult: string;
}

const REGISTRATION: Record<string, string> = {
  cropType: "Cocoa",
  quantity: "60",
  unit: "kg",
  harvestDate: "2026-04-18",
  farmLocation: "Owo, Ondo State",
  description: "Cocoa beans dried on raised beds at the Owo drying station.",
};

const UNKNOWN_PRODUCT_ID = "AGT-COCOA-2026-ZZZ999";
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const PRIVATE_WALLET_KEYS = ["ownerWallet", "registeredByWallet"];
const PRIVATE_SEARCH_KEYS = [...PRIVATE_WALLET_KEYS, "description"];

async function onChainParticipant(role: Role): Promise<Session> {
  const session = await signInAs(api(), role);
  testChain().seedParticipant(new PublicKey(session.wallet.address), ROLE_ORDINALS[role]);
  return session;
}

async function registerBatch(farmer: Session): Promise<string> {
  const draft = dataOf<{ productId: string; prepared: PreparedAction }>(
    await post(api(), farmer, "/api/products", REGISTRATION)
  );
  const submitted = await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
    signedTransaction: sign(draft.prepared, farmer),
  });
  expect(submitted.status).toBe(200);
  return draft.productId;
}

function verify(productId: string, session: Session | null = null) {
  return get(api(), session, `/api/verify/${productId}`);
}

function collectKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}

const TAMPERED_FIELDS: Array<{ label: string; update: Record<string, unknown> }> = [
  { label: "description", update: { description: "substituted text" } },
  { label: "quantity", update: { quantity: 61 } },
  { label: "farm location", update: { farmLocation: "Somewhere else entirely" } },
];

describe("public verification", () => {
  beforeEach(freshState);

  it("verifies a confirmed, untampered batch for a caller with no session", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const response = await verify(productId);

    expect(response.status).toBe(200);
    const outcome = dataOf<VerificationOutcome>(response);
    expect(outcome.verification.result).toBe("VERIFIED");
    expect(outcome.verification.chainReachable).toBe(true);
    expect(outcome.verification.recordPresent).toBe(true);
    expect(outcome.verification.mismatch).toBeNull();
    expect(outcome.verification.dataHash.onChain).toMatch(HASH_PATTERN);
    expect(outcome.verification.dataHash.stored).toBe(outcome.verification.dataHash.onChain);
    expect(outcome.verification.dataHash.computed).toBe(outcome.verification.dataHash.onChain);
    expect(outcome.product?.productId).toBe(productId);
  });

  it("still verifies a batch after ownership has passed to someone else", async () => {
    // The anchored fingerprint covers immutable registration facts only. If the
    // current owner were part of it, every batch that changed hands along the
    // supply chain would be reported to its owner as having been altered, which
    // is the defect this test guards against.
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);
    const before = dataOf<VerificationOutcome>(await verify(productId));
    expect(before.verification.result).toBe("VERIFIED");

    // What a transfer does to the stored record.
    await ProductMetadataModel.updateOne(
      { productId },
      { $set: { ownerWallet: "9rMw3dY2Q7uVnLp5Kb1yHc2XgRt8ZsWvC6NeJkA4uBdM" } }
    );

    const after = dataOf<VerificationOutcome>(await verify(productId));
    expect(after.verification.result).toBe("VERIFIED");
    expect(after.verification.mismatch).toBeNull();
    expect(after.verification.dataHash.computed).toBe(after.verification.dataHash.onChain);
  });

  it("publishes a consumer view with no wallet addresses in it", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const outcome = dataOf<VerificationOutcome>(await verify(productId));

    const keys = collectKeys(outcome.product);
    for (const key of PRIVATE_WALLET_KEYS) {
      expect(keys.has(key)).toBe(false);
    }
    expect(outcome.product?.currentOwnerCategory).toBe("FARMER");
    expect(outcome.product?.registrantCategory).toBe("FARMER");
  });

  for (const tampered of TAMPERED_FIELDS) {
    it(`reports a mismatch after the stored ${tampered.label} is changed`, async () => {
      const farmer = await onChainParticipant("FARMER");
      const productId = await registerBatch(farmer);
      await ProductMetadataModel.updateOne(
        { productId },
        { $set: tampered.update }
      );

      const outcome = dataOf<VerificationOutcome>(await verify(productId));

      expect(outcome.verification.result).toBe("MISMATCH");
      expect(outcome.verification.mismatch).not.toBeNull();
      const mismatch = outcome.verification.mismatch;
      expect(mismatch?.expected).toMatch(HASH_PATTERN);
      expect(mismatch?.actual).toMatch(HASH_PATTERN);
      expect(mismatch?.expected).not.toBe(mismatch?.actual);
      expect(mismatch?.explanation.toLowerCase()).toContain("do not match");
      expect(outcome.verification.headline.toLowerCase()).toContain("do not match");
      const stored = await ProductMetadataModel.findOne({ productId }).lean();
      expect(stored?.lastVerificationResult).toBe("MISMATCH");
    });
  }

  it("records no audit event when a batch is merely read", async () => {
    // Reading is not a deliberate check, so a page load must not inflate the
    // regulator's count of who has inspected a batch.
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    await verify(productId);
    await verify(productId);

    expect(await VerificationEventModel.countDocuments({ productId })).toBe(0);
  });

  it("still updates the batch's last result when it is merely read", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);
    await ProductMetadataModel.updateOne(
      { productId },
      { $set: { description: "substituted text" } }
    );

    await verify(productId);

    const stored = await ProductMetadataModel.findOne({ productId }).lean();
    expect(stored?.lastVerificationResult).toBe("MISMATCH");
  });

  it("records a verification event when a public visitor checks a batch", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const logged = await postPublic(api(), `/api/verify/${productId}/log`, {
      requestChannel: "DIRECT_URL",
    });
    expect(logged.status).toBe(200);
    const recorded = dataOf<{ verificationId: string; result: string }>(logged);

    const event = await VerificationEventModel.findOne({
      verificationId: recorded.verificationId,
    }).lean();
    expect(event?.verificationResult).toBe("VERIFIED");
    expect(event?.requester).toBe("PUBLIC");
    expect(event?.requesterRole).toBe("PUBLIC");
    expect(event?.requestChannel).toBe("DIRECT_URL");
    expect(event?.chainReachable).toBe(true);
    expect(event?.recordPresent).toBe(true);
  });

  it("records a verification event for a signed-in regulator", async () => {
    const farmer = await onChainParticipant("FARMER");
    const regulator = await onChainParticipant("REGULATOR");
    const productId = await registerBatch(farmer);

    const logged = await post(api(), regulator, `/api/verify/${productId}/log`, {
      requestChannel: "REGULATOR_REVIEW",
    });
    expect(logged.status).toBe(200);
    const recorded = dataOf<{ verificationId: string }>(logged);

    const event = await VerificationEventModel.findOne({
      verificationId: recorded.verificationId,
    }).lean();
    expect(event?.verificationResult).toBe("VERIFIED");
    expect(event?.requester).toBe(regulator.wallet.address);
    expect(event?.requesterRole).toBe("REGULATOR");
    expect(event?.requestChannel).toBe("REGULATOR_REVIEW");
  });

  it("reports NOT_FOUND for a well-formed identifier the chain does not hold", async () => {
    const outcome = dataOf<VerificationOutcome>(await verify(UNKNOWN_PRODUCT_ID));

    expect(outcome.verification.result).toBe("NOT_FOUND");
    expect(outcome.verification.recordPresent).toBe(false);
    expect(outcome.product).toBeNull();
    expect(outcome.verification.headline).toContain("No batch is registered");
  });

  it("refuses a malformed identifier with an explanation of the expected format", async () => {
    const response = await verify("not-a-batch-identifier");

    expect(response.status).toBe(422);
    const failure = errorOf(response);
    expect(failure.code).toBe("VALIDATION_ERROR");
    expect(failure.message).toContain("AGT-COCOA-2026-A1B2C3");
  });

  it("reports INCOMPLETE when the cluster cannot be reached", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    testChain().reachable = false;
    let response: Awaited<ReturnType<typeof verify>>;
    try {
      response = await verify(productId);
    } finally {
      testChain().reachable = true;
    }

    const outcome = dataOf<VerificationOutcome>(response);
    expect(outcome.verification.result).toBe("INCOMPLETE");
    expect(outcome.verification.chainReachable).toBe(false);
    expect(outcome.verification.recordPresent).toBe(true);
    expect(outcome.product).toBeNull();
  });

  it("reports INCOMPLETE when the chain holds the batch but the record is missing", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);
    await ProductMetadataModel.deleteOne({ productId });

    const outcome = dataOf<VerificationOutcome>(await verify(productId));

    expect(outcome.verification.result).toBe("INCOMPLETE");
    expect(outcome.verification.recordPresent).toBe(false);
    expect(outcome.verification.chainReachable).toBe(true);
    expect(outcome.product).toBeNull();
  });

  it("reports INCOMPLETE while a confirmed chain write is not finalised in the database", async () => {
    const farmer = await onChainParticipant("FARMER");
    const draft = dataOf<{ productId: string; prepared: PreparedAction }>(
      await post(api(), farmer, "/api/products", REGISTRATION)
    );
    testChain().neverConfirms = true;
    try {
      const submitted = await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
        signedTransaction: sign(draft.prepared, farmer),
      });
      expect(submitted.status).toBe(504);
    } finally {
      testChain().neverConfirms = false;
    }

    const record = await ProductMetadataModel.findOne({ productId: draft.productId }).lean();
    expect(record?.chainState).toBe("SUBMITTED");

    const outcome = dataOf<VerificationOutcome>(await verify(draft.productId));
    expect(outcome.verification.result).toBe("INCOMPLETE");
    expect(outcome.verification.recordPresent).toBe(true);
    expect(outcome.product).toBeNull();
  });

  it("reports NOT_FOUND for a batch that was prepared but never reached the chain", async () => {
    const farmer = await onChainParticipant("FARMER");
    const draft = dataOf<{ productId: string }>(
      await post(api(), farmer, "/api/products", REGISTRATION)
    );

    const outcome = dataOf<VerificationOutcome>(await verify(draft.productId));

    expect(outcome.verification.result).toBe("NOT_FOUND");
    expect(outcome.verification.chainReachable).toBe(true);
    expect(outcome.verification.recordPresent).toBe(true);
    expect(outcome.product).toBeNull();
  });

  it("returns the provenance in chronological order with counts that match what was recorded", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerBatch(farmer);
    const transfer = dataOf<{ transfer: { transferId: string }; prepared: PreparedAction }>(
      await post(api(), farmer, `/api/products/${productId}/transfers`, {
        toWallet: processor.wallet.address,
      })
    );
    await post(api(), farmer, `/api/transfers/${transfer.transfer.transferId}/submit`, {
      signedTransaction: sign(transfer.prepared, farmer),
    });
    // A deliberate check is recorded, which is what puts a VERIFICATION entry
    // on the timeline; a plain read would not.
    await postPublic(api(), `/api/verify/${productId}/log`, {
      requestChannel: "DIRECT_URL",
    });
    await verify(productId);

    const response = await get(api(), null, `/api/products/${productId}/history`);

    expect(response.status).toBe(200);
    const history = dataOf<ProductHistory>(response);
    expect(history.productId).toBe(productId);
    expect(history.chainState).toBe("CONFIRMED");
    expect(history.integrity.status).toBe("MATCH");
    expect(history.integrity.detail).toContain("matches");
    expect(history.counts).toEqual({
      transfers: 1,
      processingEvents: 0,
      transportEvents: 0,
      certificates: 0,
      verifications: 1,
    });

    const occurredAt = history.provenance.map((event) => event.occurredAt);
    expect([...occurredAt].sort()).toEqual(occurredAt);
    expect(history.provenance.map((event) => event.sequence)).toEqual(
      history.provenance.map((_event, index) => index + 1)
    );
    expect(history.provenance.map((event) => event.kind)).toEqual([
      "REGISTERED",
      "TRANSFER",
      "VERIFICATION",
    ]);
  });

  it("reports the stored fingerprint as not matching once the anchored hash is altered", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);
    await ProductMetadataModel.updateOne(
      { productId },
      { $set: { onChainDataHash: "0".repeat(64) } }
    );

    const history = dataOf<ProductHistory>(
      await get(api(), null, `/api/products/${productId}/history`)
    );

    expect(history.integrity.status).toBe("MISMATCH");
    expect(history.integrity.detail).toContain("does not match");
  });

  it("returns summary rows only from a public search", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const response = await get(api(), null, "/api/search?q=Cocoa");

    expect(response.status).toBe(200);
    const results = dataOf<{ results: SearchResultRow[]; term: string }>(response);
    expect(results.term).toBe("Cocoa");
    expect(results.results.map((row) => row.productId)).toContain(productId);
    const row = results.results.find((entry) => entry.productId === productId);
    expect(row?.statusLabel).toBe("Registered");
    expect(row?.lastVerificationResult).toBe("VERIFIED");

    const keys = collectKeys(results);
    for (const key of PRIVATE_SEARCH_KEYS) {
      expect(keys.has(key)).toBe(false);
    }
  });

  it("refuses a search term of a single character", async () => {
    const response = await get(api(), null, "/api/search?q=c");

    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
  });
});
