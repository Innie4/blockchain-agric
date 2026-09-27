import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { PublicKey } from "@solana/web3.js";
import { api, freshState, testChain } from "../helpers/runtime.js";
import { csrf, dataOf, errorOf, get, post, sign, signInAs } from "../helpers/apiClient.js";
import type { Session } from "../helpers/apiClient.js";
import { CertificateModel, ProcessingLogModel, TransportLogModel } from "../../src/models/index.js";
import { ROLE_ORDINALS } from "../../src/services/solana/layout.js";
import type { Role } from "../../src/lib/roles.js";

/**
 * Processing, transport and certificates.
 *
 * Each of these advances a batch through a real transfer, so the participant
 * recording the event is the one the program says owns it, and the stage a
 * batch reaches is read back from the chain rather than assumed.
 *
 * The chain double's clock is fixed, and the program refuses a timestamp that
 * precedes registration or runs more than a day ahead of cluster time, so the
 * event times below sit inside that window on purpose.
 */

interface PreparedAction {
  transaction: string;
  description: string;
}

interface ProductSummary {
  productId: string;
  status: string;
  ownerWallet: string;
  chainState: string;
}

interface ProcessingLogView {
  logId: string;
  productId: string;
  activity: string;
  statusBefore: string;
  statusAfter: string;
  occurredAt: string;
  dataHash: string;
  onChainTxHash: string | null;
  supportingImages: unknown[];
  supportingDocuments: unknown[];
}

interface PreparedProcessing {
  log: ProcessingLogView;
  prepared: PreparedAction;
}

interface TransportLogView {
  logId: string;
  productId: string;
  origin: string;
  destination: string;
  departedAt: string;
  expectedArrivalAt: string | null;
  deliveredAt: string | null;
  deliveryStatus: string;
  dataHash: string;
  onChainTxHash: string | null;
  supportingDocuments: unknown[];
  transporterWallet: string;
  transporterName: string;
  routeDetails: string;
  vehicleDescription: string;
  createdAt: string;
}

interface PreparedTransport {
  log: TransportLogView;
  prepared: PreparedAction;
}

interface CertificateView {
  certificateId: string;
  productId: string;
  issuingBody: string;
  certificateType: string;
  issuedOn: string | null;
  expiresOn: string | null;
  dataHash: string;
  document: { mediaId: string; contentHash: string; mimeType: string };
  createdAt: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

const REGISTERED_AT = "2023-11-14T22:13:20.000Z";
const PROCESSED_AT = "2023-11-15T09:00:00.000Z";
const PROCESSED_AGAIN_AT = "2023-11-15T11:00:00.000Z";
const DEPARTED_AT = "2023-11-15T06:00:00.000Z";
const LATER_DEPARTURE = "2023-11-15T14:00:00.000Z";
const EXPECTED_ARRIVAL = "2023-11-15T20:00:00.000Z";
const BEFORE_REGISTRATION = "2023-11-01T00:00:00.000Z";

/** Every key a stored transport log is allowed to carry. */
const TRANSPORT_LOG_KEYS = [
  "createdAt",
  "dataHash",
  "deliveredAt",
  "deliveryStatus",
  "departedAt",
  "destination",
  "expectedArrivalAt",
  "logId",
  "onChainTxHash",
  "origin",
  "productId",
  "routeDetails",
  "supportingDocuments",
  "transporterName",
  "transporterWallet",
  "vehicleDescription",
];

const FORBIDDEN_SENSOR_KEYS = [
  "latitude",
  "longitude",
  "gps",
  "temperature",
  "humidity",
  "sensor",
  "telemetry",
];

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8"
);

const REGISTRATION: Record<string, string> = {
  cropType: "Groundnut",
  quantity: "80",
  unit: "bags",
  harvestDate: "2026-03-02",
  farmLocation: "Kaduna State, Nigeria",
  description: "Shelled groundnut from the 2026 planting season.",
};

async function onChainParticipant(role: Role): Promise<Session> {
  const session = await signInAs(api(), role);
  testChain().seedParticipant(new PublicKey(session.wallet.address), ROLE_ORDINALS[role]);
  return session;
}

async function registerBatch(farmer: Session, overrides: Record<string, string> = {}): Promise<string> {
  const draft = dataOf<{ productId: string; prepared: PreparedAction }>(
    await post(api(), farmer, "/api/products", { ...REGISTRATION, ...overrides })
  );
  const submitted = await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
    signedTransaction: sign(draft.prepared, farmer),
  });
  expect(submitted.status).toBe(200);
  return draft.productId;
}

async function handOver(owner: Session, productId: string, recipient: Session): Promise<void> {
  const prepared = dataOf<{ transfer: { transferId: string }; prepared: PreparedAction }>(
    await post(api(), owner, `/api/products/${productId}/transfers`, {
      toWallet: recipient.wallet.address,
    })
  );
  const submitted = await post(
    api(),
    owner,
    `/api/transfers/${prepared.transfer.transferId}/submit`,
    { signedTransaction: sign(prepared.prepared, owner) }
  );
  expect(submitted.status).toBe(200);
}

function recordProcessing(
  session: Session,
  productId: string,
  payload: Record<string, string>
): Promise<request.Response> {
  return post(api(), session, `/api/products/${productId}/processing`, payload);
}

function recordTransport(
  session: Session,
  productId: string,
  payload: Record<string, string>
): Promise<request.Response> {
  return post(api(), session, `/api/products/${productId}/transport`, payload);
}

function attachCertificate(
  session: Session,
  productId: string,
  fields: Record<string, string>,
  file: { buffer: Buffer; filename: string; contentType: string }
): request.Test {
  const call = request(api())
    .post(`/api/products/${productId}/certificates`)
    .set(csrf(session));
  for (const [field, value] of Object.entries(fields)) {
    call.field(field, value);
  }
  call.attach("document", file.buffer, {
    filename: file.filename,
    contentType: file.contentType,
  });
  return call;
}

async function stageOf(viewer: Session, productId: string): Promise<string> {
  const detail = dataOf<{ product: ProductSummary }>(
    await get(api(), viewer, `/api/products/${productId}`)
  );
  return detail.product.status;
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

describe("processing, transport and certificates", () => {
  beforeEach(freshState);

  it("advances a held batch from in processing to processed", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, processor);

    const prepared = await recordProcessing(processor, productId, {
      activity: "Roasting",
      activityDescription: "Drum roasted for forty minutes to reduce moisture.",
      occurredAt: PROCESSED_AT,
      newStatus: "PROCESSED",
    });
    expect(prepared.status).toBe(201);
    const event = dataOf<PreparedProcessing>(prepared);
    expect(event.prepared.transaction.length).toBeGreaterThan(0);
    expect(event.log.statusBefore).toBe("IN_PROCESSING");
    expect(event.log.statusAfter).toBe("PROCESSED");

    const submitted = await post(api(), processor, `/api/products/${productId}/processing/submit`, {
      logId: event.log.logId,
      signedTransaction: sign(event.prepared, processor),
    });
    expect(submitted.status).toBe(200);
    expect(dataOf<ProcessingLogView>(submitted).onChainTxHash).not.toBeNull();
    expect(await stageOf(processor, productId)).toBe("PROCESSED");
    expect((await testChain().fetchProduct(productId))?.status).toBe("PROCESSED");
  });

  it("stores a processing entry that does not move the batch without asking for a signature", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, processor);
    const first = dataOf<PreparedProcessing>(
      (
        await recordProcessing(processor, productId, {
          activity: "Sorting",
          activityDescription: "Sorted by size and hand picked for defects.",
          occurredAt: PROCESSED_AT,
          newStatus: "PROCESSED",
        })
      )
    );
    await post(api(), processor, `/api/products/${productId}/processing/submit`, {
      logId: first.log.logId,
      signedTransaction: sign(first.prepared, processor),
    });

    const again = await recordProcessing(processor, productId, {
      activity: "Grading",
      activityDescription: "Graded against the published size and defect table.",
      occurredAt: PROCESSED_AGAIN_AT,
      newStatus: "PROCESSED",
    });
    expect(again.status).toBe(201);
    const event = dataOf<PreparedProcessing>(again);
    expect(event.prepared.transaction).toBe("");

    const submitted = await post(api(), processor, `/api/products/${productId}/processing/submit`, {
      logId: event.log.logId,
      signedTransaction: "",
    });
    expect(submitted.status).toBe(200);
    expect(dataOf<ProcessingLogView>(submitted).onChainTxHash).toBeNull();
    const stored = await ProcessingLogModel.findOne({ logId: event.log.logId }).lean();
    expect(stored?.onChainTxHash ?? null).toBeNull();
  });

  it("refuses a processing event that would move the batch backwards", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, processor);
    const first = dataOf<PreparedProcessing>(
      (
        await recordProcessing(processor, productId, {
          activity: "Sorting",
          activityDescription: "Sorted by size and hand picked for defects.",
          occurredAt: PROCESSED_AT,
          newStatus: "PROCESSED",
        })
      )
    );
    await post(api(), processor, `/api/products/${productId}/processing/submit`, {
      logId: first.log.logId,
      signedTransaction: sign(first.prepared, processor),
    });

    const response = await recordProcessing(processor, productId, {
      activity: "Reopening",
      activityDescription: "Attempting to reopen a finished batch for more work.",
      occurredAt: PROCESSED_AGAIN_AT,
      newStatus: "IN_PROCESSING",
    });

    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe("PRODUCT_STATE_INVALID");
  });

  it("refuses a status change that skips a stage", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, processor);

    const prepared = await post(api(), processor, `/api/products/${productId}/status/prepare`, {
      status: "LISTED",
      occurredAt: PROCESSED_AT,
    });
    expect(prepared.status).toBe(200);
    const action = dataOf<{ prepared: PreparedAction }>(prepared);

    const submitted = await post(api(), processor, `/api/products/${productId}/status/submit`, {
      signedTransaction: sign(action.prepared, processor),
    });

    expect(submitted.status).toBe(409);
    expect(errorOf(submitted).code).toBe("PRODUCT_STATE_INVALID");
    expect(await stageOf(processor, productId)).toBe("IN_PROCESSING");
  });

  it("refuses a processing event from a farmer, whose role has no processing permission", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, processor);

    const response = await recordProcessing(farmer, productId, {
      activity: "Sorting",
      activityDescription: "Sorting a batch that no longer belongs to the farmer.",
      occurredAt: PROCESSED_AT,
    });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("ROLE_NOT_ALLOWED");
  });

  it("refuses a processing event from a second processor that does not hold the batch", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const otherProcessor = await onChainParticipant("PROCESSOR");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, processor);

    const response = await recordProcessing(otherProcessor, productId, {
      activity: "Sorting",
      activityDescription: "Sorting a batch held by a different processor entirely.",
      occurredAt: PROCESSED_AT,
    });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("FORBIDDEN");
  });

  it("refuses a processing event from a transporter", async () => {
    const farmer = await onChainParticipant("FARMER");
    const transporter = await onChainParticipant("TRANSPORTER");
    const productId = await registerBatch(farmer);

    const response = await recordProcessing(transporter, productId, {
      activity: "Sorting",
      activityDescription: "A transporter has no permission to record processing work.",
      occurredAt: PROCESSED_AT,
    });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("ROLE_NOT_ALLOWED");
  });

  it("refuses a processing event dated before the batch was registered", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, processor);

    const prepared = await recordProcessing(processor, productId, {
      activity: "Sorting",
      activityDescription: "A backdated entry the program will not accept.",
      occurredAt: BEFORE_REGISTRATION,
      newStatus: "PROCESSED",
    });
    expect(prepared.status).toBe(201);
    const event = dataOf<PreparedProcessing>(prepared);

    const submitted = await post(api(), processor, `/api/products/${productId}/processing/submit`, {
      logId: event.log.logId,
      signedTransaction: sign(event.prepared, processor),
    });

    expect(submitted.status).toBe(422);
    expect(errorOf(submitted).code).toBe("VALIDATION_ERROR");
    const stored = await ProcessingLogModel.findOne({ logId: event.log.logId }).lean();
    expect(stored?.onChainTxHash ?? null).toBeNull();
  });

  it("records a journey that does not change the stage without asking for a signature", async () => {
    const farmer = await onChainParticipant("FARMER");
    const transporter = await onChainParticipant("TRANSPORTER");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, transporter);

    const prepared = await recordTransport(transporter, productId, {
      origin: "Kaduna",
      destination: "Lagos",
      routeDetails: "Federal highway A2, one stop for customs in Lokoja.",
      vehicleDescription: "Refrigerated 20 foot container truck.",
      departedAt: DEPARTED_AT,
      expectedArrivalAt: EXPECTED_ARRIVAL,
      deliveryStatus: "IN_TRANSIT",
    });
    expect(prepared.status).toBe(201);
    const journey = dataOf<PreparedTransport>(prepared);
    expect(journey.prepared.transaction).toBe("");

    const submitted = await post(api(), transporter, `/api/products/${productId}/transport/submit`, {
      logId: journey.log.logId,
      signedTransaction: "",
    });
    expect(submitted.status).toBe(200);
    const log = dataOf<TransportLogView>(submitted);
    expect(log.deliveryStatus).toBe("IN_TRANSIT");
    expect(log.onChainTxHash).toBeNull();
    expect(await stageOf(transporter, productId)).toBe("IN_TRANSIT");
  });

  it("advances a delivered batch to at retailer", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const transporter = await onChainParticipant("TRANSPORTER");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, processor);
    const processed = dataOf<PreparedProcessing>(
      (
        await recordProcessing(processor, productId, {
          activity: "Roasting",
          activityDescription: "Drum roasted for forty minutes to reduce moisture.",
          occurredAt: PROCESSED_AT,
          newStatus: "PROCESSED",
        })
      )
    );
    await post(api(), processor, `/api/products/${productId}/processing/submit`, {
      logId: processed.log.logId,
      signedTransaction: sign(processed.prepared, processor),
    });
    await handOver(processor, productId, transporter);

    const prepared = await recordTransport(transporter, productId, {
      origin: "Kaduna",
      destination: "Lagos",
      routeDetails: "Delivered to the central market warehouse in Lagos.",
      vehicleDescription: "Refrigerated 20 foot container truck.",
      departedAt: LATER_DEPARTURE,
      expectedArrivalAt: EXPECTED_ARRIVAL,
      deliveryStatus: "DELIVERED",
    });
    expect(prepared.status).toBe(201);
    const journey = dataOf<PreparedTransport>(prepared);
    expect(journey.prepared.transaction.length).toBeGreaterThan(0);

    const submitted = await post(api(), transporter, `/api/products/${productId}/transport/submit`, {
      logId: journey.log.logId,
      signedTransaction: sign(journey.prepared, transporter),
    });
    expect(submitted.status).toBe(200);
    const log = dataOf<TransportLogView>(submitted);
    expect(log.deliveredAt).not.toBeNull();
    expect(log.onChainTxHash).not.toBeNull();
    expect(await stageOf(transporter, productId)).toBe("AT_RETAILER");
    expect((await testChain().fetchProduct(productId))?.status).toBe("AT_RETAILER");
  });

  it("refuses a journey whose destination is its origin", async () => {
    const farmer = await onChainParticipant("FARMER");
    const transporter = await onChainParticipant("TRANSPORTER");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, transporter);

    const response = await recordTransport(transporter, productId, {
      origin: "Kaduna",
      destination: "kaduna",
      departedAt: DEPARTED_AT,
      deliveryStatus: "IN_TRANSIT",
    });

    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
  });

  it("refuses a journey that is due to arrive before it departs", async () => {
    const farmer = await onChainParticipant("FARMER");
    const transporter = await onChainParticipant("TRANSPORTER");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, transporter);

    const response = await recordTransport(transporter, productId, {
      origin: "Kaduna",
      destination: "Lagos",
      departedAt: LATER_DEPARTURE,
      expectedArrivalAt: DEPARTED_AT,
      deliveryStatus: "IN_TRANSIT",
    });

    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
  });

  it("refuses a transport event from a retailer", async () => {
    const farmer = await onChainParticipant("FARMER");
    const retailer = await onChainParticipant("RETAILER");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, retailer);

    const response = await recordTransport(retailer, productId, {
      origin: "Lagos",
      destination: "Ikeja",
      departedAt: DEPARTED_AT,
      deliveryStatus: "IN_TRANSIT",
    });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("ROLE_NOT_ALLOWED");
  });

  it("stores no GPS coordinates or sensor readings with a transport entry", async () => {
    const farmer = await onChainParticipant("FARMER");
    const transporter = await onChainParticipant("TRANSPORTER");
    const productId = await registerBatch(farmer);
    await handOver(farmer, productId, transporter);
    const prepared = await recordTransport(transporter, productId, {
      origin: "Kaduna",
      destination: "Lagos",
      routeDetails: "Federal highway A2, one stop for customs in Lokoja.",
      vehicleDescription: "Refrigerated 20 foot container truck.",
      departedAt: DEPARTED_AT,
      expectedArrivalAt: EXPECTED_ARRIVAL,
      deliveryStatus: "IN_TRANSIT",
    });
    const journey = dataOf<PreparedTransport>(prepared);

    const served = dataOf<{ logs: TransportLogView[] }>(
      await get(api(), transporter, `/api/products/${productId}/transport`)
    );
    const log = served.logs[0];
    expect(Object.keys(log ?? {}).sort()).toEqual(TRANSPORT_LOG_KEYS);
    for (const forbidden of FORBIDDEN_SENSOR_KEYS) {
      expect(collectKeys(log).has(forbidden)).toBe(false);
    }

    const stored = await TransportLogModel.findOne({ logId: journey.log.logId }).lean();
    expect(stored).not.toBeNull();
    for (const forbidden of FORBIDDEN_SENSOR_KEYS) {
      expect(collectKeys(JSON.parse(JSON.stringify(stored))).has(forbidden)).toBe(false);
    }
  });

  it("attaches a PDF certificate and records a hash of its bytes", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const response = await attachCertificate(
      farmer,
      productId,
      {
        issuingBody: "Kaduna State Ministry of Agriculture",
        certificateType: "Phytosanitary",
        referenceNumber: "PH/2026/0042",
        issuedOn: "2026-03-01",
        expiresOn: "2027-03-01",
      },
      { buffer: PDF_BYTES, filename: "phytosanitary.pdf", contentType: "application/pdf" }
    );

    expect(response.status).toBe(201);
    const certificate = dataOf<CertificateView>(response);
    expect(certificate.dataHash).toMatch(HASH_PATTERN);
    expect(certificate.dataHash).toBe(certificate.document.contentHash);
    expect(certificate.document.mimeType).toBe("application/pdf");
    expect(certificate.expiresOn).toBe("2027-03-01T00:00:00.000Z");
  });

  it("accepts a certificate with no expiry date", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const response = await attachCertificate(
      farmer,
      productId,
      {
        issuingBody: "Nigeria Organic Producers Union",
        certificateType: "Organic",
        referenceNumber: "NOP/2026/118",
        issuedOn: "2026-03-01",
        expiresOn: "",
      },
      { buffer: PDF_BYTES, filename: "organic.pdf", contentType: "application/pdf" }
    );

    expect(response.status).toBe(201);
    expect(dataOf<CertificateView>(response).expiresOn).toBeNull();
  });

  it("refuses a certificate that expires before it was issued", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const response = await attachCertificate(
      farmer,
      productId,
      {
        issuingBody: "Kaduna State Ministry of Agriculture",
        certificateType: "Phytosanitary",
        issuedOn: "2026-03-01",
        expiresOn: "2025-03-01",
      },
      { buffer: PDF_BYTES, filename: "phytosanitary.pdf", contentType: "application/pdf" }
    );

    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
  });

  it("refuses a certificate with no issuing body", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const response = await attachCertificate(
      farmer,
      productId,
      {
        issuingBody: "",
        certificateType: "Phytosanitary",
        issuedOn: "2026-03-01",
      },
      { buffer: PDF_BYTES, filename: "phytosanitary.pdf", contentType: "application/pdf" }
    );

    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
  });

  it("refuses a file that is not a PDF although it is declared as one", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const response = await attachCertificate(
      farmer,
      productId,
      { issuingBody: "Kaduna State Ministry of Agriculture", certificateType: "Organic" },
      { buffer: PNG_BYTES, filename: "certificate.pdf", contentType: "application/pdf" }
    );

    expect(response.status).toBe(415);
    expect(errorOf(response).code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("refuses a certificate attached by a participant with no part in the batch", async () => {
    const farmer = await onChainParticipant("FARMER");
    const stranger = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const response = await attachCertificate(
      stranger,
      productId,
      { issuingBody: "Kaduna State Ministry of Agriculture", certificateType: "Organic" },
      { buffer: PDF_BYTES, filename: "organic.pdf", contentType: "application/pdf" }
    );

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("FORBIDDEN");
  });

  it("lists processing, transport and certificate records per batch, oldest first", async () => {
    const farmer = await onChainParticipant("FARMER");
    const processor = await onChainParticipant("PROCESSOR");
    const transporter = await onChainParticipant("TRANSPORTER");
    const mine = await registerBatch(farmer);
    const other = await registerBatch(farmer, { cropType: "Soya bean" });
    await handOver(farmer, mine, processor);
    await handOver(farmer, other, processor);

    const firstProcessing = dataOf<PreparedProcessing>(
      (
        await recordProcessing(processor, mine, {
          activity: "Sorting",
          activityDescription: "Sorted by size and hand picked for defects.",
          occurredAt: PROCESSED_AT,
          newStatus: "PROCESSED",
        })
      )
    );
    await post(api(), processor, `/api/products/${mine}/processing/submit`, {
      logId: firstProcessing.log.logId,
      signedTransaction: sign(firstProcessing.prepared, processor),
    });
    const secondProcessing = await recordProcessing(processor, mine, {
      activity: "Grading",
      activityDescription: "Graded against the published size and defect table.",
      occurredAt: PROCESSED_AGAIN_AT,
      newStatus: "PROCESSED",
    });
    expect(secondProcessing.status).toBe(201);
    const otherProcessing = await recordProcessing(processor, other, {
      activity: "Sorting",
      activityDescription: "Sorting a different batch entirely.",
      occurredAt: PROCESSED_AT,
      newStatus: "PROCESSED",
    });
    expect(otherProcessing.status).toBe(201);
    await handOver(processor, mine, transporter);
    const firstJourney = dataOf<PreparedTransport>(
      (
        await recordTransport(transporter, mine, {
          origin: "Kaduna",
          destination: "Lagos",
          departedAt: DEPARTED_AT,
          expectedArrivalAt: EXPECTED_ARRIVAL,
          deliveryStatus: "IN_TRANSIT",
        })
      )
    );
    const secondJourney = dataOf<PreparedTransport>(
      await recordTransport(transporter, mine, {
        origin: "Lagos",
        destination: "Ikeja",
        departedAt: LATER_DEPARTURE,
        expectedArrivalAt: EXPECTED_ARRIVAL,
        deliveryStatus: "DELIVERED",
      })
    );
    await attachCertificate(
      transporter,
      mine,
      { issuingBody: "First board", certificateType: "Organic" },
      { buffer: PDF_BYTES, filename: "first.pdf", contentType: "application/pdf" }
    );
    await attachCertificate(
      transporter,
      mine,
      { issuingBody: "Second board", certificateType: "Phytosanitary" },
      { buffer: PDF_BYTES, filename: "second.pdf", contentType: "application/pdf" }
    );

    const processing = dataOf<{ logs: ProcessingLogView[] }>(
      await get(api(), processor, `/api/products/${mine}/processing`)
    );
    expect(processing.logs.map((log) => log.activity)).toEqual(["Sorting", "Grading"]);
    expect(processing.logs.every((log) => log.productId === mine)).toBe(true);

    const transport = dataOf<{ logs: TransportLogView[] }>(
      await get(api(), transporter, `/api/products/${mine}/transport`)
    );
    expect(transport.logs.map((log) => log.logId)).toEqual([
      firstJourney.log.logId,
      secondJourney.log.logId,
    ]);
    expect(transport.logs.every((log) => log.productId === mine)).toBe(true);

    const certificates = dataOf<{ certificates: CertificateView[] }>(
      await get(api(), transporter, `/api/products/${mine}/certificates`)
    );
    expect(certificates.certificates.map((entry) => entry.issuingBody)).toEqual([
      "First board",
      "Second board",
    ]);
    expect(certificates.certificates.every((entry) => entry.productId === mine)).toBe(true);

    expect(await CertificateModel.countDocuments({ productId: other })).toBe(0);
    expect(
      await ProcessingLogModel.countDocuments({ productId: mine, activity: "Sorting" })
    ).toBe(1);
  });

  it("reports the fixed cluster time the program validates event timestamps against", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);
    const onChain = await testChain().fetchProduct(productId);
    expect(new Date((onChain?.registeredAt ?? 0) * 1000).toISOString()).toBe(REGISTERED_AT);
  });
});
