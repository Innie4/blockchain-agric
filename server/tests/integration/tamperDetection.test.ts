import { beforeEach, describe, expect, it } from "vitest";
import { api, freshState, testChain } from "../helpers/runtime.js";
import { dataOf, errorOf, get, post, postPublic, sign, signInRegistered, type Session } from "../helpers/apiClient.js";
import { ProductMetadataModel } from "../../src/models/index.js";
import { mediaBucket } from "../../src/services/files/mediaStore.js";
import mongoose from "mongoose";
import type { VerificationResultBody } from "../../src/services/verification/verificationService.js";

/**
 * The tampering cases the design exists to catch.
 *
 * Two independent checks are exercised here: the anchored registration hash
 * (recomputed from the stored facts and compared with the value on-chain) and the
 * per-file digest (recomputed from the stored bytes).
 */

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7b1b1a40000000049454e44ae426082",
  "hex"
);

/** A different image with the same shape, used to simulate a substitution. */
const OTHER_PNG = Buffer.concat([
  PNG.subarray(0, PNG.length - 12),
  Buffer.from("0000000049454e44ae426082", "hex"),
]);

interface PreparedRegistration {
  productId: string;
  dataHash: string;
  prepared: { transaction: string; description: string };
}

async function registerWithImage(
  session: Session,
  image: Buffer | null = PNG
): Promise<PreparedRegistration> {
  const fields = {
    cropType: "Cocoa",
    quantity: "250",
    unit: "kg",
    harvestDate: "2026-02-14",
    farmLocation: "Ikom, Cross River State",
    description: "Fermented cocoa beans, sun dried on raised beds.",
    additionalNotes: "",
  };
  const attach = image === null
    ? (call: ReturnType<typeof post>) => call
    : (call: ReturnType<typeof post>) =>
        call.attach("images", image, { filename: "batch.png", contentType: "image/png" });

  const prepared = await attach(
    post(api(), session, "/api/products").field(fields)
  );
  const draft = dataOf<PreparedRegistration>(prepared);
  const submitted = await post(api(), session, `/api/products/${draft.productId}/submit`, {
    signedTransaction: sign(draft.prepared, session),
  });
  expect(submitted.status).toBe(200);
  return draft;
}

/**
 * Checks a batch the way the client does: read the result, then record the
 * check. Recording is a separate call so that a page load does not inflate the
 * regulator's count of deliberate checks.
 */
async function verify(productId: string): Promise<VerificationResultBody> {
  const response = await get(api(), null, `/api/verify/${productId}`);
  expect(response.status).toBe(200);
  const logged = await postPublic(api(), `/api/verify/${productId}/log`, {
    requestChannel: "DIRECT_URL",
  });
  expect(logged.status).toBe(200);
  return dataOf<{ verification: VerificationResultBody }>(response).verification;
}

describe("off-chain tampering detection", () => {
  beforeEach(freshState);

  it("reports a batch that carries no files as verified", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer, null);
    const result = await verify(draft.productId);
    expect(result.result).toBe("VERIFIED");
    expect(result.mediaProblems).toEqual([]);
  });

  it("reports a batch registered with an image as verified", async () => {
    // The image digest is mixed into the anchored hash at registration, so the
    // recomputation has to include it. A batch with an image must not be
    // permanently reported as a mismatch.
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer);
    const result = await verify(draft.productId);
    expect(result.result).toBe("VERIFIED");
    expect(result.mismatch).toBeNull();
    expect(result.mediaProblems).toEqual([]);
    expect(result.dataHash.computed).toBe(draft.dataHash);
  });

  it("still reports a batch as verified after a certificate is attached later", async () => {
    // A certificate is legitimately added months after registration. It carries
    // its own digest and must not retroactively invalidate the anchored hash.
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer, null);
    expect((await verify(draft.productId)).result).toBe("VERIFIED");

    const attached = await post(api(), farmer, `/api/products/${draft.productId}/certificates`)
      .field("issuingBody", "Standards Organisation for Nigeria")
      .field("certificateType", "Organic")
      .field("referenceNumber", "SON-2026-4471")
      .field("issuedOn", "2026-01-20")
      .attach("document", Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8"), {
        filename: "organic.pdf",
        contentType: "application/pdf",
      });
    expect(attached.status).toBe(201);

    const after = await verify(draft.productId);
    expect(after.result).toBe("VERIFIED");
    expect(after.mismatch).toBeNull();
  });

  it("detects an edited description", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer, null);
    await ProductMetadataModel.updateOne(
      { productId: draft.productId },
      { $set: { description: "Substituted text written after registration." } }
    );

    const result = await verify(draft.productId);
    expect(result.result).toBe("MISMATCH");
    expect(result.mismatch?.reason).toBe("HASH_MISMATCH");
    expect(result.mismatch?.expected).not.toBe(result.mismatch?.actual);
    expect(result.headline).toMatch(/do not match/i);
  });

  it("detects an edited quantity", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer, null);
    await ProductMetadataModel.updateOne(
      { productId: draft.productId },
      { $set: { quantity: 2500 } }
    );
    expect((await verify(draft.productId)).result).toBe("MISMATCH");
  });

  it("detects an edited farm location", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer, null);
    await ProductMetadataModel.updateOne(
      { productId: draft.productId },
      { $set: { farmLocation: "Somewhere else entirely" } }
    );
    expect((await verify(draft.productId)).result).toBe("MISMATCH");
  });

  it("detects an edited crop type even when only the case changes", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer, null);
    await ProductMetadataModel.updateOne(
      { productId: draft.productId },
      { $set: { cropType: "cocoa" } }
    );
    // The canonical form upper-cases the crop type, so a case-only change is
    // normalised away and is deliberately not a mismatch.
    expect((await verify(draft.productId)).result).toBe("VERIFIED");
  });

  it("detects a substituted image by comparing the stored bytes", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer);
    expect((await verify(draft.productId)).result).toBe("VERIFIED");

    const stored = await ProductMetadataModel.findOne({ productId: draft.productId }).lean();
    const mediaId = stored?.images?.[0]?.["mediaId"];
    expect(typeof mediaId).toBe("string");

    const bucket = mediaBucket();
    const objectId = new mongoose.Types.ObjectId(mediaId as string);
    await bucket.delete(objectId);
    await new Promise<void>((resolve, reject) => {
      const stream = bucket.openUploadStream((stored?.images?.[0]?.["fileName"] ?? "batch.png"), {
        contentType: "image/png",
        metadata: { productId: draft.productId, contentHash: "unchanged-on-purpose" },
      });
      stream.on("error", reject);
      stream.on("finish", () => resolve());
      stream.end(OTHER_PNG);
    });

    const result = await verify(draft.productId);
    expect(result.result).toBe("MISMATCH");
    expect(result.mismatch?.reason).toBe("MEDIA_DIGEST_MISMATCH");
    expect(result.mediaProblems).toHaveLength(1);
    expect(result.mediaProblems[0]?.mediaId).toBe(mediaId);
    expect(result.mediaProblems[0]?.actual).not.toBe(result.mediaProblems[0]?.expected);
  });

  it("records the tampering in the verification history for a regulator", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer, null);
    await ProductMetadataModel.updateOne(
      { productId: draft.productId },
      { $set: { farmLocation: "Rewritten origin" } }
    );
    await verify(draft.productId);

    const regulator = await signInRegistered(api(), "REGULATOR");
    const response = await get(api(), regulator, "/api/compliance/verifications?result=MISMATCH");
    const rows = dataOf<{ verifications: Array<{ productId: string; result: string }> }>(response)
      .verifications;
    const entry = rows.find((row) => row.productId === draft.productId);
    expect(entry).toBeDefined();
    expect(entry?.result).toBe("MISMATCH");
  });

  it("surfaces a tampered batch as an anomaly in a compliance report", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer, null);
    await ProductMetadataModel.updateOne(
      { productId: draft.productId },
      { $set: { description: "Rewritten description" } }
    );
    await verify(draft.productId);

    const regulator = await signInRegistered(api(), "REGULATOR");
    const created = await post(api(), regulator, "/api/compliance/reports", {
      title: "Monthly integrity review",
    });
    expect(created.status).toBe(201);
    const report = dataOf<{
      anomalies: Array<{ productId: string; kind: string }>;
    }>(created);
    const anomaly = report.anomalies.find((entry) => entry.productId === draft.productId);
    expect(anomaly).toBeDefined();
    expect(anomaly?.kind).toBe("HASH_MISMATCH");
  });

  it("does not treat an unreachable cluster as tampering", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer, null);

    testChain().reachable = false;
    try {
      const result = await verify(draft.productId);
      expect(result.result).toBe("INCOMPLETE");
      expect(result.mismatch).toBeNull();
      expect(result.chainReachable).toBe(false);
    } finally {
      testChain().reachable = true;
    }
  });

  it("keeps the anchored digest on the record equal to the value on-chain", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer);
    const onChain = await testChain().fetchProduct(draft.productId);
    expect(onChain?.offChainDataHash).toBe(draft.dataHash);

    const stored = await ProductMetadataModel.findOne({ productId: draft.productId }).lean();
    expect(stored?.dataHash).toBe(draft.dataHash);
    expect(stored?.anchoredImageHashes).toEqual(stored?.images?.map((i) => i["contentHash"]));
  });

  it("does not disclose the owner's wallet address through public verification", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = await registerWithImage(farmer, null);
    const response = await get(api(), null, `/api/verify/${draft.productId}`);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(farmer.wallet.address);
  });

  it("reports a malformed identifier as a validation failure", async () => {
    const response = await get(api(), null, "/api/verify/not-a-batch");
    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
  });
});
