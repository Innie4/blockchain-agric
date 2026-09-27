import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { PublicKey } from "@solana/web3.js";
import { api, freshState, testChain } from "../helpers/runtime.js";
import { csrf, dataOf, errorOf, get, post, postPublic, sign, signInAs } from "../helpers/apiClient.js";
import type { Session } from "../helpers/apiClient.js";
import {
  ComplianceReportModel,
  ProductMetadataModel,
  ReconciliationTaskModel,
  VerificationEventModel,
} from "../../src/models/index.js";
import { ROLE_ORDINALS } from "../../src/services/solana/layout.js";
import type { Role } from "../../src/lib/roles.js";

/**
 * Regulator compliance, operations and the health surface.
 *
 * The regulator's figures are only worth anything if they are computed from
 * stored records, so the overview tests register real batches, tamper with one
 * directly in MongoDB and then check the numbers the API reports back.
 */

interface PreparedAction {
  transaction: string;
  description: string;
}

interface OverviewMetric {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}

interface ComplianceOverview {
  metrics: OverviewMetric[];
  statusCounts: Array<{ status: string; label: string; count: number }>;
  cropTypeCounts: Array<{ cropType: string; count: number }>;
  recentVerifications: Array<{ productId: string; result: string }>;
  anomalies: Array<{ taskId: string; kind: string; productId: string }>;
}

interface ComplianceReport {
  reportId: string;
  title: string;
  generatedBy: string;
  generatedByName: string;
  filters: { cropTypes: string[]; statuses: string[]; dateFrom?: string; dateTo?: string };
  summary: {
    productCount: number;
    verifiedCount: number;
    mismatchCount: number;
    anomalyCount: number;
  };
  anomalies: Array<{ productId: string; kind: string; detail: string }>;
  includedProducts: Array<{
    productId: string;
    cropType: string;
    dataHash: string;
    onChainTxHash: string | null;
    lastVerificationResult: string;
  }>;
  exportMetadata: {
    formats: string[];
    lastExportedFormat: string | null;
    downloadCount: number;
  };
}

interface VerificationQueueRow {
  verificationId: string;
  productId: string;
  result: string;
  requester: string;
  requesterRole: string;
  chainReachable: boolean;
}

const REGISTERED_BATCHES = "Registered batches";
const MISMATCHES = "Verification mismatches";
const AWAITING = "Awaiting registration";
const ALL_BATCHES = "All batches tracked";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

const REGISTRATION: Record<string, string> = {
  cropType: "Cocoa",
  quantity: "60",
  unit: "kg",
  harvestDate: "2026-04-18",
  farmLocation: "Owo, Ondo State",
  description: "Cocoa beans dried on raised beds at the Owo drying station.",
};

const ATTESTED_AT = "2023-11-15T09:00:00.000Z";

/** The cluster time the program accepts, since the chain double's clock is fixed. */
const WINDOW_FROM = new Date(Date.now() - 86_400_000).toISOString();
const WINDOW_TO = new Date(Date.now() + 86_400_000).toISOString();

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

function metricValue(overview: ComplianceOverview, label: string): string {
  const metric = overview.metrics.find((entry) => entry.label === label);
  if (metric === undefined) {
    throw new Error(`The overview has no metric labelled "${label}".`);
  }
  return metric.value;
}

describe("compliance, operations and health", () => {
  beforeEach(freshState);

  it("refuses the compliance overview to a farmer", async () => {
    const farmer = await onChainParticipant("FARMER");

    const response = await get(api(), farmer, "/api/compliance/overview");

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("ROLE_NOT_ALLOWED");
  });

  it("refuses the compliance overview to an anonymous caller", async () => {
    const response = await get(api(), null, "/api/compliance/overview");

    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe("UNAUTHORIZED");
  });

  it("refuses the compliance reports to a farmer", async () => {
    const farmer = await onChainParticipant("FARMER");

    const list = await get(api(), farmer, "/api/compliance/reports");
    const generated = await post(api(), farmer, "/api/compliance/reports", {
      title: "Quarterly review",
    });

    expect(list.status).toBe(403);
    expect(generated.status).toBe(403);
    expect(errorOf(list).code).toBe("ROLE_NOT_ALLOWED");
    expect(errorOf(generated).code).toBe("ROLE_NOT_ALLOWED");
  });

  it("reports overview figures computed from the stored records", async () => {
    const farmer = await onChainParticipant("FARMER");
    const regulator = await onChainParticipant("REGULATOR");
    const cocoa = await registerBatch(farmer);
    const soya = await registerBatch(farmer, { cropType: "Soya bean" });
    await ProductMetadataModel.updateOne(
      { productId: soya },
      { $set: { description: "substituted text" } }
    );
    await get(api(), null, `/api/verify/${cocoa}`);
    await get(api(), null, `/api/verify/${soya}`);

    const overview = dataOf<ComplianceOverview>(
      await get(api(), regulator, "/api/compliance/overview")
    );

    expect(metricValue(overview, REGISTERED_BATCHES)).toBe("2");
    expect(metricValue(overview, MISMATCHES)).toBe("1");
    expect(metricValue(overview, AWAITING)).toBe("0");
    expect(metricValue(overview, ALL_BATCHES)).toBe("2");
    const mismatched = overview.metrics.find((entry) => entry.label === MISMATCHES);
    expect(mismatched?.tone).toBe("danger");
    expect(overview.statusCounts.find((row) => row.status === "REGISTERED")?.count).toBe(2);
    expect(overview.statusCounts.reduce((total, row) => total + row.count, 0)).toBe(2);
    expect(overview.cropTypeCounts).toHaveLength(2);
  });

  it("builds a report from a date range, crop type and stage", async () => {
    const farmer = await onChainParticipant("FARMER");
    const regulator = await onChainParticipant("REGULATOR");
    await registerBatch(farmer, { cropType: "Cocoa" });
    await registerBatch(farmer, { cropType: "Soya bean" });

    const response = await post(api(), regulator, "/api/compliance/reports", {
      title: "Soya bean review",
      dateFrom: WINDOW_FROM,
      dateTo: WINDOW_TO,
      cropTypes: ["Soya bean"],
      statuses: ["REGISTERED"],
    });

    expect(response.status).toBe(201);
    const report = dataOf<ComplianceReport>(response);
    expect(report.summary.productCount).toBe(1);
    expect(report.includedProducts).toHaveLength(1);
    expect(report.includedProducts[0]?.cropType).toBe("Soya bean");
    expect(report.includedProducts[0]?.dataHash).toMatch(HASH_PATTERN);
    expect(report.includedProducts[0]?.onChainTxHash).not.toBeNull();
    expect(report.filters.cropTypes).toEqual(["Soya bean"]);
    expect(report.generatedBy).toBe(regulator.wallet.address);
  });

  it("builds an empty report rather than an error when nothing matches", async () => {
    const regulator = await onChainParticipant("REGULATOR");
    const farmer = await onChainParticipant("FARMER");
    await registerBatch(farmer);

    const response = await post(api(), regulator, "/api/compliance/reports", {
      title: "Rubber review",
      dateFrom: WINDOW_FROM,
      dateTo: WINDOW_TO,
      cropTypes: ["Rubber"],
    });

    expect(response.status).toBe(201);
    const report = dataOf<ComplianceReport>(response);
    expect(report.summary.productCount).toBe(0);
    expect(report.includedProducts).toEqual([]);
    expect(report.anomalies).toEqual([]);
  });

  it("lists a tampered batch in the report anomalies as a hash mismatch", async () => {
    const farmer = await onChainParticipant("FARMER");
    const regulator = await onChainParticipant("REGULATOR");
    const productId = await registerBatch(farmer);
    await ProductMetadataModel.updateOne(
      { productId },
      { $set: { description: "substituted text" } }
    );
    await postPublic(api(), `/api/verify/${productId}/log`, { requestChannel: "REGULATOR_REVIEW" });

    const report = dataOf<ComplianceReport>(
      await post(api(), regulator, "/api/compliance/reports", {
        title: "Integrity review",
        dateFrom: WINDOW_FROM,
        dateTo: WINDOW_TO,
      })
    );

    expect(report.summary.mismatchCount).toBe(1);
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]?.productId).toBe(productId);
    expect(report.anomalies[0]?.kind).toBe("HASH_MISMATCH");
    expect(report.anomalies[0]?.detail).toContain("did not match");
  });

  it("lists a batch awaiting reconciliation as a reconciliation anomaly", async () => {
    const farmer = await onChainParticipant("FARMER");
    const regulator = await onChainParticipant("REGULATOR");
    const productId = await registerBatch(farmer);
    await ProductMetadataModel.updateOne(
      { productId },
      { $set: { chainState: "NEEDS_RECONCILIATION" } }
    );

    const report = dataOf<ComplianceReport>(
      await post(api(), regulator, "/api/compliance/reports", {
        title: "Reconciliation review",
        dateFrom: WINDOW_FROM,
        dateTo: WINDOW_TO,
      })
    );

    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]?.productId).toBe(productId);
    expect(report.anomalies[0]?.kind).toBe("RECONCILIATION_REQUIRED");
    expect(report.includedProducts[0]?.lastVerificationResult).toBe("VERIFIED");
  });

  it("exports a report as CSV and records the download", async () => {
    const farmer = await onChainParticipant("FARMER");
    const regulator = await onChainParticipant("REGULATOR");
    await registerBatch(farmer);
    const report = dataOf<ComplianceReport>(
      await post(api(), regulator, "/api/compliance/reports", {
        title: "Export review",
        dateFrom: WINDOW_FROM,
        dateTo: WINDOW_TO,
      })
    );

    const response = await get(api(), regulator, `/api/compliance/reports/${report.reportId}/export?format=csv`);

    expect(response.status).toBe(200);
    expect(String(response.headers["content-type"])).toContain("text/csv");
    const body = response.text;
    expect(body.startsWith("productId,cropType,quantity,unit,status,statusLabel")).toBe(true);

    const stored = await ComplianceReportModel.findOne({ reportId: report.reportId }).lean();
    expect(stored?.exportMetadata?.downloadCount).toBe(1);
    expect(stored?.exportMetadata?.formats).toEqual(["csv"]);
  });

  it("exports a report as PDF and records the download", async () => {
    const farmer = await onChainParticipant("FARMER");
    const regulator = await onChainParticipant("REGULATOR");
    await registerBatch(farmer);
    const report = dataOf<ComplianceReport>(
      await post(api(), regulator, "/api/compliance/reports", {
        title: "Export review",
        dateFrom: WINDOW_FROM,
        dateTo: WINDOW_TO,
      })
    );

    const response = await request(api())
      .get(`/api/compliance/reports/${report.reportId}/export?format=pdf`)
      .set({ cookie: regulator.jar.header() })
      .buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    const body = response.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    const stored = await ComplianceReportModel.findOne({ reportId: report.reportId }).lean();
    expect(stored?.exportMetadata?.downloadCount).toBe(1);
    expect(stored?.exportMetadata?.lastExportedFormat).toBe("pdf");
  });

  it("refuses an export format it does not produce", async () => {
    const regulator = await onChainParticipant("REGULATOR");
    const report = dataOf<ComplianceReport>(
      await post(api(), regulator, "/api/compliance/reports", { title: "Export review" })
    );

    const response = await get(
      api(),
      regulator,
      `/api/compliance/reports/${report.reportId}/export?format=xlsx`
    );

    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
  });

  it("lists only mismatches when the review queue is filtered by result", async () => {
    const farmer = await onChainParticipant("FARMER");
    const regulator = await onChainParticipant("REGULATOR");
    const clean = await registerBatch(farmer);
    const tampered = await registerBatch(farmer, { cropType: "Soya bean" });
    await ProductMetadataModel.updateOne(
      { productId: tampered },
      { $set: { farmLocation: "Somewhere else entirely" } }
    );
    await postPublic(api(), `/api/verify/${clean}/log`, { requestChannel: "DIRECT_URL" });
    await postPublic(api(), `/api/verify/${tampered}/log`, { requestChannel: "DIRECT_URL" });

    const filtered = dataOf<{ verifications: VerificationQueueRow[] }>(
      await get(api(), regulator, "/api/compliance/verifications?result=MISMATCH")
    );

    expect(filtered.verifications).toHaveLength(1);
    expect(filtered.verifications[0]?.productId).toBe(tampered);
    expect(filtered.verifications[0]?.result).toBe("MISMATCH");
    expect(filtered.verifications[0]?.requester).toBe("PUBLIC");

    const all = dataOf<{ verifications: VerificationQueueRow[] }>(
      await get(api(), regulator, "/api/compliance/verifications")
    );
    expect(all.verifications.length).toBeGreaterThan(filtered.verifications.length);
  });

  it("records a regulator's finding on the blockchain", async () => {
    const farmer = await onChainParticipant("FARMER");
    const regulator = await onChainParticipant("REGULATOR");
    const productId = await registerBatch(farmer);
    await postPublic(api(), `/api/verify/${productId}/log`, { requestChannel: "REGULATOR_REVIEW" });

    const prepared = await post(api(), regulator, "/api/compliance/attestations/prepare", {
      productId,
      result: "VERIFIED",
      occurredAt: ATTESTED_AT,
    });
    expect(prepared.status).toBe(200);
    const action = dataOf<{ prepared: PreparedAction; productId: string }>(prepared);

    const submitted = await post(api(), regulator, "/api/compliance/attestations/submit", {
      productId,
      result: "VERIFIED",
      occurredAt: ATTESTED_AT,
      signedTransaction: sign(action.prepared, regulator),
    });

    expect(submitted.status).toBe(200);
    const signature = dataOf<{ signature: string }>(submitted).signature;
    const events = await VerificationEventModel.find({ productId }).lean();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.attestationTxHash === signature)).toBe(true);
    expect((await testChain().fetchProduct(productId))?.lastVerifiedAt).toBeGreaterThan(0);
  });

  it("refuses an on-chain attestation from a farmer", async () => {
    const farmer = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);

    const response = await post(api(), farmer, "/api/compliance/attestations/prepare", {
      productId,
      result: "VERIFIED",
      occurredAt: ATTESTED_AT,
    });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("ROLE_NOT_ALLOWED");
  });

  it("shows the regulator the reconciliation queue and resolves a task only once", async () => {
    const farmer = await onChainParticipant("FARMER");
    const regulator = await onChainParticipant("REGULATOR");
    const outsider = await onChainParticipant("FARMER");
    const productId = await registerBatch(farmer);
    await ReconciliationTaskModel.create({
      taskId: "task-under-review-0001",
      action: "COMPLETE_PRODUCT_REGISTRATION",
      status: "PENDING",
      productId,
      transactionSignature: "sig000000",
      intentHash: "0".repeat(64),
      intent: { productId },
    });

    const refused = await get(api(), outsider, "/api/operations/reconciliation");
    const queue = dataOf<{
      tasks: Array<{ taskId: string; status: string; productId: string }>;
      resolvedCount: number;
    }>(await get(api(), regulator, "/api/operations/reconciliation"));

    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("ROLE_NOT_ALLOWED");
    expect(queue.tasks.map((task) => task.taskId)).toContain("task-under-review-0001");
    expect(queue.resolvedCount).toBe(0);

    const resolved = await post(
      api(),
      regulator,
      "/api/operations/reconciliation/task-under-review-0001/resolve"
    );
    expect(resolved.status).toBe(200);
    expect(dataOf<{ status: string }>(resolved).status).toBe("RESOLVED");

    const again = await post(
      api(),
      regulator,
      "/api/operations/reconciliation/task-under-review-0001/resolve"
    );
    expect(again.status).toBe(404);
    expect(errorOf(again).code).toBe("NOT_FOUND");
  });

  it("reports the service, database and blockchain as healthy", async () => {
    const liveness = await request(api()).get("/api/health");
    const database = await request(api()).get("/api/health/database");
    const blockchain = await request(api()).get("/api/health/blockchain");
    const ready = await request(api()).get("/api/health/ready");

    expect(liveness.status).toBe(200);
    expect(
      dataOf<{ status: string; runtime: { solanaProgramId: string } }>(liveness).runtime
        .solanaProgramId
    ).toBe("AgriTrace418FNVcjry6EMUbiqx5DLTahpw4CKSZgov3");
    expect(database.status).toBe(200);
    expect(dataOf<{ reachable: boolean }>(database).reachable).toBe(true);
    expect(blockchain.status).toBe(200);
    expect(dataOf<{ reachable: boolean }>(blockchain).reachable).toBe(true);
    expect(ready.status).toBe(200);
  });

  it("reports the blockchain as unavailable while the cluster cannot be reached", async () => {
    testChain().reachable = false;
    let blockchain: request.Response;
    let ready: request.Response;
    try {
      blockchain = await request(api()).get("/api/health/blockchain");
      ready = await request(api()).get("/api/health/ready");
    } finally {
      testChain().reachable = true;
    }

    expect(blockchain.status).toBe(503);
    expect(ready.status).toBe(503);
    expect((ready.body as { data: { ready: boolean } }).data.ready).toBe(false);
    const recovered = await request(api()).get("/api/health/blockchain");
    expect(recovered.status).toBe(200);
  });

  it("sends the security headers an API response needs", async () => {
    const response = await request(api()).get("/api/health");

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(response.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(String(response.headers["referrer-policy"])).toBe("no-referrer");
  });

  it("answers an unknown API route with the standard not-found envelope", async () => {
    const response = await request(api()).get("/api/no-such-route");

    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe("NOT_FOUND");
    expect(errorOf(response).message).toContain("no-such-route");
  });

  it("rejects a body that is not JSON without leaking a stack trace", async () => {
    const response = await request(api())
      .post("/api/auth/nonce")
      .set("content-type", "application/json")
      .send("this is not json at all");

    expect([400, 422]).toContain(response.status);
    const failure = errorOf(response);
    expect(failure.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("\n    at ");
    expect(JSON.stringify(response.body)).not.toContain(".ts:");
  });

  it("does not issue a session for a request with no valid signature", async () => {
    const response = await request(api())
      .post("/api/auth/nonce")
      .set(csrf(await onChainParticipant("FARMER")))
      .send("not json");

    expect([400, 422]).toContain(response.status);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});
