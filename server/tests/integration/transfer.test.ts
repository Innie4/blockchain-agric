import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { PublicKey } from "@solana/web3.js";
import { api, freshState, testChain } from "../helpers/runtime.js";
import { CookieJar, createWallet } from "../helpers/environment.js";
import {
  dataOf,
  errorOf,
  get,
  post,
  sign,
  signIn,
  signInAs,
} from "../helpers/apiClient.js";
import type { Session } from "../helpers/apiClient.js";
import { TransferModel } from "../../src/models/index.js";
import { ROLE_ORDINALS } from "../../src/services/solana/layout.js";
import type { Role } from "../../src/lib/roles.js";
import { stripSignature } from "../helpers/signing.js";

/**
 * Ownership transfers, walked through the whole chain.
 *
 * Each test starts from a batch the farmer has actually registered, because the
 * program refuses to transfer anything it has not recorded itself. The status
 * a batch lands in is decided on-chain by the recipient's role, so the tests
 * read the status back from the chain rather than from the database.
 */

interface PreparedAction {
  transaction: string;
  description: string;
}

interface TransferView {
  transferId: string;
  productId: string;
  fromWallet: string;
  toWallet: string;
  status: string;
  transactionSignature: string | null;
  acknowledgedAt: string | null;
}

interface PreparedTransfer {
  transfer: TransferView;
  prepared: PreparedAction;
}

interface ProductSummary {
  productId: string;
  status: string;
  ownerWallet: string;
  chainState: string;
}

const REGISTRATION: Record<string, string> = {
  cropType: "Cocoa",
  quantity: "120",
  unit: "kg",
  harvestDate: "2026-02-11",
  farmLocation: "Ondo State, Nigeria",
  description: "Fermented cocoa beans from the 2026 main harvest.",
};

async function onChainParticipant(role: Role): Promise<Session> {
  const session = await signInAs(api(), role);
  testChain().seedParticipant(new PublicKey(session.wallet.address), ROLE_ORDINALS[role]);
  return session;
}

/** Registers a batch and carries it through to a confirmed on-chain record. */
async function registerProduct(
  farmer: Session,
  overrides: Record<string, string> = {}
): Promise<string> {
  const draft = dataOf<{ productId: string; prepared: PreparedAction }>(
    await post(api(), farmer, "/api/products", { ...REGISTRATION, ...overrides })
  );
  const submitted = await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
    signedTransaction: sign(draft.prepared, farmer),
  });
  expect(submitted.status).toBe(200);
  return draft.productId;
}

function prepareTransfer(
  owner: Session,
  productId: string,
  toWallet: string
): Promise<PreparedTransfer> {
  return post(api(), owner, `/api/products/${productId}/transfers`, { toWallet }).then(
    (response) => {
      expect(response.status).toBe(201);
      return dataOf<PreparedTransfer>(response);
    }
  );
}

function submitTransfer(
  owner: Session,
  _productId: string,
  transferId: string,
  signedTransaction: string
): Promise<{ status: number; body: unknown }> {
  return post(api(), owner, `/api/transfers/${transferId}/submit`, {
    signedTransaction,
  }).then((response) => ({ status: response.status, body: response.body }));
}

async function transferTo(
  owner: Session,
  productId: string,
  recipient: Session
): Promise<TransferView> {
  const prepared = await prepareTransfer(owner, productId, recipient.wallet.address);
  const response = await post(api(), owner, `/api/transfers/${prepared.transfer.transferId}/submit`, {
    signedTransaction: sign(prepared.prepared, owner),
  });
  expect(response.status).toBe(200);
  return dataOf<TransferView>(response);
}

describe("ownership transfers", () => {
  beforeEach(freshState);

  it("hands a batch to a registered processor and records the new owner", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);

    const prepared = await prepareTransfer(farmer, productId, processor.wallet.address);
    expect(prepared.transfer.status).toBe("PREPARED");
    expect(prepared.prepared.transaction.length).toBeGreaterThan(0);

    const response = await post(
      api(),
      farmer,
      `/api/transfers/${prepared.transfer.transferId}/submit`,
      { signedTransaction: sign(prepared.prepared, farmer) }
    );
    expect(response.status).toBe(200);
    const transfer = dataOf<TransferView>(response);
    expect(transfer.status).toBe("COMPLETED");
    expect(transfer.transactionSignature).not.toBeNull();

    const detail = dataOf<{ product: ProductSummary }>(
      await get(api(), processor, `/api/products/${productId}`)
    );
    expect(detail.product.ownerWallet).toBe(processor.wallet.address);
    expect(detail.product.status).toBe("IN_PROCESSING");
  });

  it("moves the on-chain status to IN_PROCESSING when a processor takes the batch", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);

    await transferTo(farmer, productId, processor);

    expect((await testChain().fetchProduct(productId))?.status).toBe("IN_PROCESSING");
  });

  it("moves the on-chain status to IN_TRANSIT when a transporter takes the batch", async () => {
    const farmer = await onChainParticipant("FARMER");
    const transporter = await onChainParticipant("TRANSPORTER");
    const productId = await registerProduct(farmer);

    await transferTo(farmer, productId, transporter);

    expect((await testChain().fetchProduct(productId))?.status).toBe("IN_TRANSIT");
  });

  it("moves the on-chain status to AT_RETAILER when a retailer takes the batch", async () => {
    const farmer = await onChainParticipant("FARMER");
    const retailer = await onChainParticipant("RETAILER");
    const productId = await registerProduct(farmer);

    await transferTo(farmer, productId, retailer);

    expect((await testChain().fetchProduct(productId))?.status).toBe("AT_RETAILER");
  });

  it("refuses a transfer from a wallet that does not hold the batch", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const otherProcessor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    await transferTo(farmer, productId, processor);

    const response = await post(api(), farmer, `/api/products/${productId}/transfers`, {
      toWallet: otherProcessor.wallet.address,
    });

    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe("TRANSFER_NOT_ALLOWED");
  });

  it("refuses a transfer to a wallet with no on-chain registration", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const outsider = await signInAs(api(), "PROCESSOR", { onChainRegistered: false });
    const productId = await registerProduct(farmer);
    await transferTo(farmer, productId, processor);

    const response = await post(api(), processor, `/api/products/${productId}/transfers`, {
      toWallet: outsider.wallet.address,
    });

    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("RECIPIENT_NOT_REGISTERED");
  });

  it("refuses a transfer to a farmer, reporting it as not allowed rather than unregistered", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const otherFarmer = await onChainParticipant("FARMER");
    const productId = await registerProduct(farmer);
    await transferTo(farmer, productId, processor);

    const response = await post(api(), processor, `/api/products/${productId}/transfers`, {
      toWallet: otherFarmer.wallet.address,
    });

    // The pre-check cannot tell a farmer from a wallet with no registry entry,
    // so it answers with the code for a transfer that is not allowed.
    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe("TRANSFER_NOT_ALLOWED");
  });

  it("refuses a transfer to the wallet that already holds the batch", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    await transferTo(farmer, productId, processor);

    const response = await post(api(), processor, `/api/products/${productId}/transfers`, {
      toWallet: processor.wallet.address,
    });

    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe("TRANSFER_NOT_ALLOWED");
  });

  it("refuses a transfer when the program finds the recipient holds the wrong on-chain role", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    // The account says PROCESSOR; the chain registry says FARMER.
    const mismatched = await signInAs(api(), "PROCESSOR");
    testChain().seedParticipant(
      new PublicKey(mismatched.wallet.address),
      ROLE_ORDINALS.FARMER
    );
    const productId = await registerProduct(farmer);
    await transferTo(farmer, productId, processor);

    const prepared = await prepareTransfer(processor, productId, mismatched.wallet.address);
    const response = await post(
      api(),
      processor,
      `/api/transfers/${prepared.transfer.transferId}/submit`,
      { signedTransaction: sign(prepared.prepared, processor) }
    );

    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("RECIPIENT_ROLE_NOT_ALLOWED");
    expect((await testChain().fetchProduct(productId))?.owner).toBe(processor.wallet.address);
  });

  it("refuses a transfer from a request with no connected wallet", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);

    const response = await request(api())
      .post(`/api/products/${productId}/transfers`)
      .send({ toWallet: processor.wallet.address });

    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe("UNAUTHORIZED");
  });

  it("refuses a transfer submitted by a wallet that did not prepare it", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const other = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    const prepared = await prepareTransfer(farmer, productId, processor.wallet.address);

    const response = await submitTransfer(
      other,
      productId,
      prepared.transfer.transferId,
      sign(prepared.prepared, farmer)
    );

    expect(response.status).toBe(403);
    const stored = await TransferModel.findOne({ transferId: prepared.transfer.transferId })
      .lean();
    expect(stored?.status).toBe("PREPARED");
  });

  it("refuses a transfer whose transaction carries no wallet signature", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    const prepared = await prepareTransfer(farmer, productId, processor.wallet.address);

    const response = await submitTransfer(
      farmer,
      productId,
      prepared.transfer.transferId,
      stripSignature(prepared.prepared.transaction)
    );

    expect(response.status).toBe(403);
    const stored = await TransferModel.findOne({ transferId: prepared.transfer.transferId })
      .lean();
    expect(stored?.status).not.toBe("COMPLETED");
    expect(stored?.transactionSignature).toBeNull();
  });

  it("reports a confirmation timeout and leaves the transfer incomplete", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    const prepared = await prepareTransfer(farmer, productId, processor.wallet.address);
    const signed = sign(prepared.prepared, farmer);

    testChain().neverConfirms = true;
    let response: { status: number; body: unknown };
    try {
      response = await submitTransfer(farmer, productId, prepared.transfer.transferId, signed);
    } finally {
      testChain().neverConfirms = false;
    }

    expect(response.status).toBe(504);
    expect(errorOf(response).code).toBe("BLOCKCHAIN_CONFIRMATION_TIMEOUT");
    const stored = await TransferModel.findOne({ transferId: prepared.transfer.transferId })
      .lean();
    expect(stored?.status).not.toBe("COMPLETED");
    expect(stored?.transactionSignature).toBeNull();
  });

  it("reports an unreachable cluster and marks nothing confirmed", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    const prepared = await prepareTransfer(farmer, productId, processor.wallet.address);
    const signed = sign(prepared.prepared, farmer);

    testChain().reachable = false;
    let response: { status: number; body: unknown };
    try {
      response = await submitTransfer(farmer, productId, prepared.transfer.transferId, signed);
    } finally {
      testChain().reachable = true;
    }

    expect(response.status).toBe(503);
    expect(errorOf(response).code).toBe("BLOCKCHAIN_RPC_UNAVAILABLE");
    const stored = await TransferModel.findOne({ transferId: prepared.transfer.transferId })
      .lean();
    expect(stored?.status).not.toBe("COMPLETED");
    expect((await testChain().fetchProduct(productId))?.owner).toBe(farmer.wallet.address);
  });

  it("shows the transfer to the recipient as incoming and to the sender as outgoing", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    const transfer = await transferTo(farmer, productId, processor);

    const incoming = dataOf<{ transfers: TransferView[] }>(
      await get(api(), processor, "/api/transfers?direction=incoming")
    );
    expect(incoming.transfers.map((entry) => entry.transferId)).toContain(transfer.transferId);

    const outgoing = dataOf<{ transfers: TransferView[] }>(
      await get(api(), farmer, "/api/transfers?direction=outgoing")
    );
    expect(outgoing.transfers.map((entry) => entry.transferId)).toContain(transfer.transferId);
  });

  it("refuses to list transfers for a participant who is neither sender nor recipient", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    await transferTo(farmer, productId, processor);
    const outsider = createWallet();
    const bystander = await signIn(api(), outsider, new CookieJar());

    const response = await get(api(), bystander, "/api/transfers");

    expect(response.status).toBe(403);
    expect(dataOf<{ transfers: TransferView[] }>(await get(api(), farmer, "/api/transfers"))
      .transfers).toHaveLength(1);
  });

  it("lists an unacknowledged transfer in the recipient's pending queue", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    const transfer = await transferTo(farmer, productId, processor);

    const pending = dataOf<{ transfers: TransferView[] }>(
      await get(api(), processor, "/api/transfers/pending")
    );
    expect(pending.transfers.map((entry) => entry.transferId)).toContain(transfer.transferId);
  });

  it("records the recipient's acknowledgement and is idempotent about it", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    const transfer = await transferTo(farmer, productId, processor);

    const first = await post(
      api(),
      processor,
      `/api/transfers/${transfer.transferId}/acknowledge`
    );
    expect(first.status).toBe(200);
    const acknowledged = dataOf<TransferView>(first).acknowledgedAt;
    expect(acknowledged).not.toBeNull();

    const second = await post(
      api(),
      processor,
      `/api/transfers/${transfer.transferId}/acknowledge`
    );
    expect(second.status).toBe(200);
    expect(dataOf<TransferView>(second).acknowledgedAt).toBe(acknowledged);
  });

  it("refuses an acknowledgement from a wallet that is not the recipient", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    const transfer = await transferTo(farmer, productId, processor);

    const response = await post(
      api(),
      farmer,
      `/api/transfers/${transfer.transferId}/acknowledge`
    );

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("FORBIDDEN");
  });

  it("cancels a prepared transfer and refuses to cancel a completed one", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const nextProcessor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    const completed = await transferTo(farmer, productId, processor);
    const pending = await prepareTransfer(processor, productId, nextProcessor.wallet.address);

    const cancelled = await post(
      api(),
      processor,
      `/api/transfers/${pending.transfer.transferId}/cancel`
    );
    expect(cancelled.status).toBe(200);
    expect(dataOf<TransferView>(cancelled).status).toBe("CANCELLED");

    const refused = await post(
      api(),
      farmer,
      `/api/transfers/${completed.transferId}/cancel`
    );
    expect(refused.status).toBe(409);
    expect(errorOf(refused).code).toBe("TRANSFER_NOT_ALLOWED");
  });

  it("returns the same completed transfer when the same signed transaction is submitted again", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerProduct(farmer);
    const prepared = await prepareTransfer(farmer, productId, processor.wallet.address);
    const signed = sign(prepared.prepared, farmer);

    const first = await submitTransfer(farmer, productId, prepared.transfer.transferId, signed);
    const second = await submitTransfer(farmer, productId, prepared.transfer.transferId, signed);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const body = second.body as { data: TransferView };
    expect(body.data.transferId).toBe(prepared.transfer.transferId);
    expect(body.data.status).toBe("COMPLETED");
    expect(body.data.transactionSignature).toBe(
      (first.body as { data: TransferView }).data.transactionSignature
    );
    expect(await TransferModel.countDocuments({ productId })).toBe(1);
  });
});
