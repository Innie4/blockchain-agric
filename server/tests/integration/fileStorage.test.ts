import { beforeEach, describe, expect, it } from "vitest";
import { api, freshState } from "../helpers/runtime.js";
import { dataOf, errorOf, get, post, sign, signInAs, signInRegistered, type Session } from "../helpers/apiClient.js";
import { CertificateModel, ProductMetadataModel } from "../../src/models/index.js";

/**
 * File storage.
 *
 * The point of these tests is that a stored file is retrievable under the
 * identifier the application recorded, and that documents are not readable by
 * anyone who merely guesses that identifier.
 */

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7b1b1a40000000049454e44ae426082",
  "hex"
);

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n",
  "utf8"
);

async function registerWithFile(
  session: Session,
  attach: (call: ReturnType<typeof post>) => ReturnType<typeof post>
): Promise<string> {
  const fields = {
    cropType: "Cocoa",
    quantity: "120",
    unit: "kg",
    harvestDate: "2026-03-02",
    farmLocation: "Ugep, Cross River State",
    description: "Cocoa beans dried on platforms and sorted by hand.",
    additionalNotes: "",
  };
  const prepared = await attach(post(api(), session, "/api/products").field(fields));
  const draft = dataOf<{ productId: string; prepared: { transaction: string; description: string } }>(
    prepared
  );
  const submitted = await post(api(), session, `/api/products/${draft.productId}/submit`, {
    signedTransaction: sign(draft.prepared, session),
  });
  expect(submitted.status).toBe(200);
  return draft.productId;
}


describe("file storage", () => {
  beforeEach(freshState);

  it("serves a stored image under the identifier recorded on the product", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const productId = await registerWithFile(farmer, (call) =>
      call.attach("images", PNG, { filename: "batch.png", contentType: "image/png" })
    );

    const record = await ProductMetadataModel.findOne({ productId }).lean();
    const mediaId = String(record?.images?.[0]?.["mediaId"]);
    expect(mediaId).toMatch(/^[0-9a-f]{24}$/);

    const response = await get(api(), null, `/api/media/${mediaId}`);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(response.body as Buffer, PNG)).toBe(0);
  });

  it("returns not found for an identifier that does not exist", async () => {
    const response = await get(api(), null, "/api/media/0123456789abcdef01234567");
    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe("NOT_FOUND");
  });

  it("returns not found for an identifier that is not a valid object id", async () => {
    const response = await get(api(), null, "/api/media/not-an-object-id");
    expect(response.status).toBe(404);
  });

  it("records the digest of the bytes it stored", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const productId = await registerWithFile(farmer, (call) =>
      call.attach("images", PNG, { filename: "batch.png", contentType: "image/png" })
    );
    const record = await ProductMetadataModel.findOne({ productId }).lean();
    const stored = record?.images?.[0];
    expect(stored?.["contentHash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.["sizeBytes"]).toBe(PNG.length);
    expect(stored?.["fileName"]).toMatch(/^batch-[0-9a-f]{8}\.png$/);
  });

  it("does not let a stored certificate be read by an unrelated participant", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const productId = await registerWithFile(farmer, (call) => call);

    const attached = await post(api(), farmer, `/api/products/${productId}/certificates`)
      .field("issuingBody", "Standards Organisation for Nigeria")
      .field("certificateType", "Organic")
      .field("referenceNumber", "SON-2026-1001")
      .field("issuedOn", "2026-01-10")
      .attach("document", PDF, { filename: "organic.pdf", contentType: "application/pdf" });
    expect(attached.status).toBe(201);

    const certificateId = dataOf<{ certificateId: string }>(attached).certificateId;
    const certificate = await CertificateModel.findOne({ certificateId }).lean();
    const mediaId = String(certificate?.document?.["mediaId"]);

    const stranger = await signInAs(api(), "PROCESSOR");
    const denied = await get(api(), stranger, `/api/media/${mediaId}`);
    expect(denied.status).toBe(403);

    const owner = await get(api(), farmer, `/api/media/${mediaId}`);
    expect(owner.status).toBe(200);
    expect(owner.headers["content-type"]).toBe("application/pdf");
  });

  it("does not let an anonymous requester read a certificate", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const productId = await registerWithFile(farmer, (call) => call);
    const attached = await post(api(), farmer, `/api/products/${productId}/certificates`)
      .field("issuingBody", "Corporate Affairs Commission")
      .field("certificateType", "Registration")
      .attach("document", PDF, { filename: "cac.pdf", contentType: "application/pdf" });
    const certificate = await CertificateModel.findOne({
      certificateId: dataOf<{ certificateId: string }>(attached).certificateId,
    }).lean();
    const mediaId = String(certificate?.document?.["mediaId"]);

    const anonymous = await get(api(), null, `/api/media/${mediaId}`);
    expect(anonymous.status).toBe(401);
  });

  it("lets a regulator read any certificate", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const productId = await registerWithFile(farmer, (call) => call);
    const attached = await post(api(), farmer, `/api/products/${productId}/certificates`)
      .field("issuingBody", "Nigerian Accreditation System")
      .field("certificateType", "Laboratory")
      .attach("document", PDF, { filename: "nal.pdf", contentType: "application/pdf" });
    const certificate = await CertificateModel.findOne({
      certificateId: dataOf<{ certificateId: string }>(attached).certificateId,
    }).lean();
    const mediaId = String(certificate?.document?.["mediaId"]);

    const regulator = await signInRegistered(api(), "REGULATOR");
    const response = await get(api(), regulator, `/api/media/${mediaId}`);
    expect(response.status).toBe(200);
  });

  it("renames the stored file so the caller's name is never used as a path", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const productId = await registerWithFile(farmer, (call) =>
      call.attach("images", PNG, {
        filename: "../../../../etc/passwd.png",
        contentType: "image/png",
      })
    );
    const record = await ProductMetadataModel.findOne({ productId }).lean();
    const stored = String(record?.images?.[0]?.["fileName"]);
    expect(stored).not.toContain("/");
    expect(stored).not.toContain("..");
    expect(stored).toMatch(/^[a-z0-9-]+\.png$/);
  });

  it("keeps the original image digest matchable after storage", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const productId = await registerWithFile(farmer, (call) =>
      call.attach("images", PNG, { filename: "batch.png", contentType: "image/png" })
    );
    const record = await ProductMetadataModel.findOne({ productId }).lean();
    const mediaId = String(record?.images?.[0]?.["mediaId"]);
    const response = await get(api(), null, `/api/media/${mediaId}`);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(response.body as Buffer).digest("hex");
    expect(digest).toBe(record?.images?.[0]?.["contentHash"]);
  });
});
