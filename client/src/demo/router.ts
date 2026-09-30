/**
 * The request router used when demo data is on.
 *
 * Every call the interface makes goes through `ApiClient.request`, so a single
 * interception point covers the whole product without a page knowing. This
 * module answers from `dataset.ts` and returns exactly the value `request` would
 * have resolved to, so nothing downstream can tell the difference except the
 * absence of a wallet and the absence of a chain.
 *
 * A path with no handler throws rather than returning something empty. A
 * demonstration that quietly showed a blank screen where a real screen would have
 * shown a failure would hide exactly the problem it exists to surface.
 */

import {
  BATCHES,
  DEMO_PERMISSIONS,
  DEMO_USER,
  PARTICIPANTS,
  certificatesFor,
  demoSignature,
  historyFor,
  processingFor,
  productFor,
  provenanceFor,
  transportFor,
  verificationFor,
  WALLETS,
  after,
} from "./dataset.js";
import type { DemoBatchRow } from "./types.js";

/** What the caller passed, as far as the router needs to know. */
export interface DemoRequest {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export class DemoRouteNotFound extends Error {
  constructor(method: string, path: string) {
    super(`Demo data has no handler for ${method} ${path}.`);
    this.name = "DemoRouteNotFound";
  }
}

function findRow(productId: string): DemoBatchRow | undefined {
  return BATCHES.find((row) => row.seed.productId === productId);
}

/**
 * A page of rows, in the shape the list screens expect.
 *
 * The key is named per endpoint, because the API names its lists after what they
 * list — `products`, `verifications`, `reports`, `transfers` — and the pages read
 * those names. A demonstration that used a single generic key would render an
 * empty table everywhere, which is the failure this is meant to avoid.
 */
function paginate<T>(rows: T[], key: string, page = 1, limit = 50): Record<string, unknown> {
  const start = (page - 1) * limit;
  const slice = rows.slice(start, start + limit);
  return {
    [key]: slice,
    pagination: {
      page,
      limit,
      total: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / limit)),
    },
  };
}

function statusLabel(status: string): string {
  return (
    {
      REGISTERED: "Registered",
      IN_PROCESSING: "In processing",
      PROCESSED: "Processed",
      IN_TRANSIT: "In transit",
      AT_RETAILER: "At retailer",
      LISTED: "Listed",
      SOLD: "Sold",
      FLAGGED: "Flagged",
    }[status] ?? status
  );
}

const OVERVIEW_CROP_COUNTS = (() => {
  const counts = new Map<string, number>();
  for (const row of BATCHES) {
    counts.set(row.seed.cropType, (counts.get(row.seed.cropType) ?? 0) + 1);
  }
  return [...counts.entries()].map(([cropType, count]) => ({ cropType, count }));
})();

/* ------------------------------------------------------------------ *
 * Record builders
 *
 * These mirror the shapes in `api/types.ts` exactly. A fixture that is close but
 * not quite right is worse than no fixture at all: the screen renders, a field
 * reads `undefined`, and the page throws while it draws. So each one is built in
 * one place and typed against the same contract the real server answers to.
 * ------------------------------------------------------------------ */

type TransferStatusValue = "PREPARED" | "SUBMITTED" | "COMPLETED" | "FAILED" | "CANCELLED" | "NEEDS_RECONCILIATION";

function transferFor(
  row: DemoBatchRow,
  index: number,
  status: TransferStatusValue
): Record<string, unknown> {
  const { seed } = row;
  const settled = status === "COMPLETED" || status === "NEEDS_RECONCILIATION";
  return {
    transferId: `trf-${seed.productId}-${index + 1}`,
    onChainTransferRef: `ref-${seed.productId}-${index + 1}`,
    productId: seed.productId,
    fromWallet: WALLETS.farmer,
    toWallet: status === "COMPLETED" ? WALLETS.processor : WALLETS.retailer,
    toRole: status === "COMPLETED" ? "PROCESSOR" : "RETAILER",
    fromRole: "FARMER",
    status,
    transactionSignature: demoSignature(`${seed.productId}:transfer:${index + 1}`),
    previousStatus: "REGISTERED",
    resultingStatus: settled ? "IN_PROCESSING" : null,
    note: "",
    failureReason: null,
    createdAt: seed.registeredAt,
    submittedAt: settled ? seed.registeredAt : null,
    confirmedAt: settled ? seed.registeredAt : null,
    acknowledgedAt: settled ? seed.registeredAt : null,
    cropType: seed.cropType,
    quantity: seed.quantity,
    unit: seed.unit,
  };
}

function verificationRecordFor(row: DemoBatchRow, index: number): Record<string, unknown> {
  const { seed, dataHash } = row;
  const flagged = seed.flagged === true;
  return {
    verificationId: `ver-${seed.productId}-${index + 1}`,
    productId: seed.productId,
    result: flagged ? "MISMATCH" : "VERIFIED",
    requester: WALLETS.regulator,
    requesterRole: "REGULATOR",
    requestChannel: "REGULATOR_PORTAL",
    chainReachable: true,
    recordPresent: true,
    mismatchDetails: flagged
      ? {
          field: "quantity",
          expected: String(seed.quantity),
          found: String(seed.quantity + 25),
          explanation: "The stored quantity no longer produces the anchored fingerprint.",
        }
      : null,
    dataHash: { onChain: dataHash, stored: dataHash, computed: dataHash },
    createdAt: after(seed.registeredAt, 5 * (index + 1)),
  };
}

function reportProductRowFor(row: DemoBatchRow): Record<string, unknown> {
  const { seed, dataHash } = row;
  return {
    productId: seed.productId,
    cropType: seed.cropType,
    quantity: seed.quantity,
    unit: seed.unit,
    status: seed.status,
    statusLabel: statusLabel(seed.status),
    ownerWallet: seed.owner,
    registeredByWallet: seed.registeredBy,
    registeredAt: seed.registeredAt,
    lastVerificationResult: seed.flagged === true ? "MISMATCH" : "VERIFIED",
    verificationCount: 2,
    mismatchCount: seed.flagged === true ? 1 : 0,
    transferCount: seed.transferCount,
    onChainTxHash: demoSignature(`${seed.productId}:register`),
    dataHash,
  };
}

function reportFor(reportId: string, covered: readonly DemoBatchRow[]): Record<string, unknown> {
  const anomalies = covered
    .filter((row) => row.seed.flagged === true)
    .map((row) => ({
      productId: row.seed.productId,
      kind: "HASH_MISMATCH",
      detail: "The stored details no longer produce the fingerprint anchored on the chain.",
      detectedAt: after(row.seed.registeredAt, 1440),
    }));

  const byStatus: Record<string, number> = {};
  const byCropType: Record<string, number> = {};
  for (const row of covered) {
    byStatus[row.seed.status] = (byStatus[row.seed.status] ?? 0) + 1;
    byCropType[row.seed.cropType] = (byCropType[row.seed.cropType] ?? 0) + 1;
  }

  return {
    reportId,
    title: "Batches reviewed for compliance",
    generatedBy: WALLETS.regulator,
    generatedByName: PARTICIPANTS[4]?.fullName ?? "Regulator",
    filters: { cropTypes: [...new Set(covered.map((row) => row.seed.cropType))], statuses: [] },
    criteria: [
      { label: "Crop types", value: [...new Set(covered.map((row) => row.seed.cropType))].join(", ") },
      { label: "Stage", value: "Any stage" },
      { label: "Only batches verified since registration", value: "Yes" },
    ],
    includedProducts: covered.map(reportProductRowFor),
    summary: {
      productCount: covered.length,
      verifiedCount: covered.filter((row) => row.seed.flagged !== true).length,
      mismatchCount: anomalies.length,
      notFoundCount: 0,
      incompleteCount: 0,
      byStatus,
      byCropType,
      transferCount: covered.reduce((total, row) => total + row.seed.transferCount, 0),
      anomalyCount: anomalies.length,
    },
    anomalies,
    generatedAt: after(covered[0]!.seed.registeredAt, 2880),
    exportMetadata: {
      formats: ["csv", "json"],
      lastExportedAt: null,
      lastExportedFormat: null,
      downloadCount: 0,
    },
    createdAt: covered[0]!.seed.registeredAt,
    exportedAt: null,
  };
}

/* ------------------------------------------------------------------ *
 * Read paths
 * ------------------------------------------------------------------ */

function handleRead(method: string, path: string, request: DemoRequest): unknown {
  // ------------------------------------------------------------------ identity
  if (path === "/auth/me") {
    return {
      authenticated: true,
      user: DEMO_USER,
      permissions: [...DEMO_PERMISSIONS],
    };
  }

  if (path === "/users/me") return { user: DEMO_USER };

  if (path === "/users/participants") {
    const scope = request.query?.["scope"];
    const search = String(request.query?.["search"] ?? "").toLowerCase();
    const role = request.query?.["role"];
    let rows = PARTICIPANTS.filter((participant) => participant.walletAddress !== DEMO_USER.walletAddress);
    if (typeof role === "string" && role.length > 0) {
      rows = rows.filter((participant) => participant.role === role);
    }
    if (search.length > 0) {
      rows = rows.filter(
        (participant) =>
          participant.fullName.toLowerCase().includes(search) ||
          participant.organisation.toLowerCase().includes(search)
      );
    }
    if (scope === "directory") {
      return {
        participants: PARTICIPANTS.map((participant) => ({
          walletAddress: participant.walletAddress,
          fullName: participant.fullName,
          role: participant.role,
          organisation: participant.organisation,
          state: participant.state,
          onChainRegistered: true,
        })),
      };
    }
    return {
      participants: rows.map((participant) => ({
        walletAddress: participant.walletAddress,
        fullName: participant.fullName,
        role: participant.role,
        organisation: participant.organisation,
        state: participant.state,
      })),
    };
  }

  // ------------------------------------------------------------------- products
  if (path === "/products") {
    const page = Number(request.query?.["page"] ?? 1);
    const limit = Number(request.query?.["limit"] ?? 20);
    const status = request.query?.["status"];
    let rows = BATCHES.map(productFor);
    if (typeof status === "string" && status.length > 0) {
      rows = rows.filter((row) => row["status"] === status);
    }
    return paginate(rows, "products", page, limit);
  }

  let match = /^\/products\/([^/]+)$/.exec(path);
  if (match !== null) {
    const row = findRow(decodeURIComponent(match[1]!));
    if (row === undefined) return null;
    const { seed } = row;
    // The session is treated as the holder of every fixture batch, and as able to
    // act on it in any of the chain's roles. Ownership and role gating are the
    // real API's job; here they are set so that every action a product page
    // offers is reachable, rather than three of the four buttons being absent.
    return {
      product: productFor(row),
      verificationUrl: `/verify/${encodeURIComponent(seed.productId)}`,
      isOwner: true,
      isRegistrant: true,
      canTransfer: true,
      canRecordProcessing: true,
      canRecordTransport: true,
      canListForSale: true,
    };
  }

  match = /^\/products\/([^/]+)\/history$/.exec(path);
  if (match !== null) {
    const row = findRow(decodeURIComponent(match[1]!));
    return row === undefined ? null : historyFor(row);
  }

  match = /^\/products\/([^/]+)\/processing$/.exec(path);
  if (match !== null) {
    const row = findRow(decodeURIComponent(match[1]!));
    return row === undefined ? null : processingFor(row);
  }

  match = /^\/products\/([^/]+)\/transport$/.exec(path);
  if (match !== null) {
    const row = findRow(decodeURIComponent(match[1]!));
    return row === undefined ? null : transportFor(row);
  }

  match = /^\/products\/([^/]+)\/certificates$/.exec(path);
  if (match !== null) {
    const row = findRow(decodeURIComponent(match[1]!));
    return row === undefined ? null : certificatesFor(row);
  }

  match = /^\/products\/([^/]+)\/verify$/.exec(path);
  if (match !== null) {
    const row = findRow(decodeURIComponent(match[1]!));
    // The product comes with it: the screen shows the batch's own verification
    // count and last result alongside the verdict, and reads them from here.
    return row === undefined ? null : verificationFor(row, true);
  }

  // -------------------------------------------------------------- verification
  match = /^\/verify\/([^/]+)$/.exec(path);
  if (match !== null) {
    const productId = decodeURIComponent(match[1]!);
    const row = findRow(productId);
    if (row === undefined) {
      return {
        verification: {
          result: "NOT_FOUND",
          productId,
          headline: "No batch is registered under this identifier.",
          explanation:
            "The blockchain holds no record for this identifier. Check the identifier against the packaging.",
          chainReachable: true,
          recordPresent: false,
          dataHash: { onChain: null, stored: null, computed: null },
          mismatch: null,
          mediaProblems: [],
          verificationId: `ver-${productId}-none`,
          verifiedAt: new Date().toISOString(),
          durationMs: 12,
        },
        product: null,
      };
    }
    return verificationFor(row);
  }

  // -------------------------------------------------------------------- search
  if (path === "/search") {
    const term = String(request.query?.["q"] ?? request.query?.["term"] ?? "")
      .trim()
      .toLowerCase();
    if (term.length === 0) {
      return { results: [], term, message: 'Enter something to search for, such as "cocoa".' };
    }
    const results = BATCHES.filter(
      (row) =>
        row.seed.productId.toLowerCase().includes(term) ||
        row.seed.cropType.toLowerCase().includes(term) ||
        row.seed.farmLocation.toLowerCase().includes(term) ||
        statusLabel(row.seed.status).toLowerCase().includes(term)
    ).map((row) => ({
      productId: row.seed.productId,
      cropType: row.seed.cropType,
      status: row.seed.status,
      statusLabel: statusLabel(row.seed.status),
      origin: row.seed.farmLocation,
      registeredAt: row.seed.registeredAt,
      lastVerificationResult: "VERIFIED",
    }));
    return {
      results,
      term,
      message:
        results.length === 0
          ? `No registered batch matches "${term}".`
          : `${results.length} batch${results.length === 1 ? "" : "es"} match "${term}".`,
    };
  }

  // ------------------------------------------------------------------ dashboard
  if (path === "/dashboard") {
    const mine = BATCHES.filter((row) => row.seed.registeredBy === DEMO_USER.walletAddress);
    const listed = mine.filter((row) => row.seed.retail.listed);
    return {
      role: DEMO_USER.role,
      introduction:
        "Everything you have registered, and where each batch has got to. A batch you have handed on stays in this list so you can still see how it is doing.",
      metrics: [
        { label: "Batches registered", value: mine.length, hint: "All time", tone: "primary" },
        {
          label: "With a processor",
          value: mine.filter((row) => row.seed.status === "IN_PROCESSING").length,
          hint: "Being sorted and packed",
        },
        {
          label: "On offer",
          value: listed.length,
          hint: "Listed by a retailer",
          tone: "success",
        },
        {
          label: "Handed on",
          value: mine.filter((row) => row.seed.transferCount > 0).length,
          hint: "Ownership passed onward",
        },
      ],
      sections: [
        {
          title: "Your most recent batches",
          kind: "table",
          columns: ["Batch", "Crop", "Quantity", "Stage", "Verified"],
          items: mine
            .slice(0, 4)
            .map((row) => ({
              batch: row.seed.productId,
              crop: row.seed.cropType,
              quantity: `${row.seed.quantity} ${row.seed.unit}`,
              stage: statusLabel(row.seed.status),
              verified: "Verified",
            })),
          emptyMessage: "You have not registered a batch yet.",
          emptyAction: { label: "Register a batch", to: "/app/products/register" },
        },
      ],
      quickActions: [
        {
          label: "Register a batch",
          to: "/app/products/register",
          description: "Record a new batch and anchor its fingerprint.",
        },
        {
          label: "See all your batches",
          to: "/app/products",
          description: "Everything you have registered.",
        },
        {
          label: "Check a batch",
          to: "/verify",
          description: "Look up any batch by its identifier.",
        },
      ],
      onChainRegistrationRequired: false,
    };
  }

  if (path === "/activity") {
    return {
      entries: BATCHES.slice(0, 6).map((row, index) => ({
        id: `act-${row.seed.productId}`,
        kind: index % 3 === 0 ? "REGISTERED" : index % 3 === 1 ? "TRANSFER" : "VERIFICATION",
        title: `${row.seed.productId} ${index % 3 === 0 ? "registered" : index % 3 === 1 ? "handed over" : "checked"}`,
        detail: `${row.seed.quantity} ${row.seed.unit} of ${row.seed.cropType}`,
        productId: row.seed.productId,
        actorWallet: index % 3 === 1 ? row.seed.owner : row.seed.registeredBy,
        actorRole: index % 3 === 1 ? "PROCESSOR" : "FARMER",
        occurredAt: row.seed.registeredAt,
        transactionSignature: demoSignature(`${row.seed.productId}:activity:${index}`),
      })),
      pagination: { page: 1, limit: 20, total: BATCHES.length, totalPages: 1 },
    };
  }

  if (path === "/notifications") {
    const notifications = BATCHES.slice(0, 4).map((row, index) => ({
      notificationId: `ntf-${row.seed.productId}`,
      kind: "CHAIN",
      title: `${row.seed.productId} is now ${statusLabel(row.seed.status).toLowerCase()}`,
      body: `Held by a ${row.seed.ownerRole === DEMO_USER.role ? "participant" : row.seed.ownerRole.toLowerCase()}.`,
      productId: row.seed.productId,
      linkPath: `/app/products/${row.seed.productId}`,
      readAt: index === 0 ? null : null,
      createdAt: row.seed.registeredAt,
    }));
    return { notifications, unreadCount: notifications.length };
  }

  // ----------------------------------------------------------------- compliance
  if (path === "/compliance/overview") {
    const flagged = BATCHES.filter((row) => row.seed.flagged === true);
    const statusCounts = Object.entries(
      BATCHES.reduce<Record<string, number>>((counts, row) => {
        counts[row.seed.status] = (counts[row.seed.status] ?? 0) + 1;
        return counts;
      }, {})
    ).map(([status, count]) => ({ status, label: statusLabel(status), count }));

    return {
      metrics: [
        { key: "totalBatches", label: "Batches on the record", value: BATCHES.length, tone: "neutral" },
        {
          key: "verifiedBatches",
          label: "Matching their chain record",
          value: BATCHES.length - flagged.length,
          tone: "success",
        },
        {
          key: "flaggedBatches",
          label: "Held for review",
          value: flagged.length,
          tone: flagged.length > 0 ? "warning" : "success",
        },
        {
          key: "listedBatches",
          label: "Offered for sale",
          value: BATCHES.filter((row) => row.seed.retail.listed).length,
          tone: "info",
        },
        { key: "participants", label: "Registered participants", value: PARTICIPANTS.length, tone: "neutral" },
        { key: "checksRecorded", label: "Checks recorded", value: BATCHES.length * 2, tone: "neutral" },
      ],
      statusCounts,
      cropTypeCounts: OVERVIEW_CROP_COUNTS,
      recentVerifications: BATCHES.slice(0, 5).map((row, index) => verificationRecordFor(row, index)),
      anomalies: flagged.map((row) => ({
        taskId: `rec-${row.seed.productId}`,
        kind: "HASH_MISMATCH",
        productId: row.seed.productId,
        detail: "The stored details no longer produce the fingerprint anchored on the chain.",
        transactionSignature: demoSignature(`${row.seed.productId}:register`),
        createdAt: after(row.seed.registeredAt, 1440),
      })),
      transferActivity: BATCHES.filter((row) => row.seed.transferCount > 0).map((row) => ({
        productId: row.seed.productId,
        count: row.seed.transferCount,
        lastTransferAt: row.seed.registeredAt,
      })),
    };
  }

  if (path === "/compliance/verifications") {
    const verifications = BATCHES.slice(0, 6).map((row, index) => verificationRecordFor(row, index));
    return paginate(
      verifications,
      "verifications",
      Number(request.query?.["page"] ?? 1),
      Number(request.query?.["limit"] ?? 20),
    );
  }

  if (path === "/compliance/reports") {
    const reports = BATCHES.slice(0, 3).map((row, index) =>
      reportFor(`rpt-${row.seed.productId}`, BATCHES.slice(0, 3 + index)),
    );
    return paginate(reports, "reports", 1, 20);
  }

  match = /^\/compliance\/reports\/([^/]+)$/.exec(path);
  if (match !== null) {
    const reportId = decodeURIComponent(match[1]!);
    return reportFor(reportId, BATCHES.slice(0, 3));
  }

  if (path === "/operations/reconciliation") {
    // A queue with entries in it, in the states the screen has to render: one
    // waiting on a participant, one that failed and needs a retry, and one
    // already closed. An empty queue hides the whole point of the screen.
    const flagged = BATCHES.find((row) => row.seed.flagged === true) ?? BATCHES[0]!;
    const task = (
      row: DemoBatchRow,
      action: string,
      status: "PENDING" | "RESOLVED" | "FAILED",
      attempts: number,
      lastError: string | null
    ) => ({
      taskId: `rec-${row.seed.productId}-${action.toLowerCase()}`,
      action,
      status,
      productId: row.seed.productId,
      transactionSignature: demoSignature(`${row.seed.productId}:${action}`),
      intentHash: row.dataHash,
      attempts,
      lastError,
      createdAt: row.seed.registeredAt,
      resolvedAt: status === "RESOLVED" ? after(row.seed.registeredAt, 60) : null,
    });

    const tasks = [
      task(flagged, "COMPLETE_PRODUCT_REGISTRATION", "PENDING", 1, null),
      task(BATCHES[1]!, "COMPLETE_TRANSFER", "FAILED", 3, "The Solana transaction expired before it was confirmed."),
      task(BATCHES[2]!, "COMPLETE_PROCESSING_LOG", "RESOLVED", 1, null),
    ];

    return {
      tasks,
      resolvedCount: 1,
      productsNeedingReconciliation: [
        {
          productId: flagged.seed.productId,
          dataHash: flagged.dataHash,
          onChainTxHash: demoSignature(`${flagged.seed.productId}:register`),
          updatedAt: flagged.seed.registeredAt,
        },
      ],
      transfersNeedingReconciliation: [
        {
          transferId: `trf-${BATCHES[1]!.seed.productId}-1`,
          productId: BATCHES[1]!.seed.productId,
          fromWallet: WALLETS.farmer,
          toWallet: WALLETS.processor,
          updatedAt: BATCHES[1]!.seed.registeredAt,
        },
      ],
    };
  }

  // ----------------------------------------------------------------- transfers
  if (path === "/transfers") {
    const transfers = BATCHES.flatMap((row) =>
      Array.from({ length: Math.max(1, row.seed.transferCount) }, (_unused, index) =>
        transferFor(row, index, index === 0 ? "COMPLETED" : "NEEDS_RECONCILIATION"),
      ),
    );
    return paginate(transfers, "transfers", 1, 20);
  }

  if (path === "/transfers/pending") {
    // Hand-overs that have not finished. The screen exists to act on these, so an
    // empty one leaves the acknowledge and cancel buttons with nothing to do.
    // Both unfinished states are here: one prepared but never sent, and one sent
    // but not yet confirmed.
    const pending = BATCHES.slice(0, 2).map((row, index) =>
      transferFor(row, 10 + index, index === 0 ? "PREPARED" : "SUBMITTED"),
    );
    return {
      transfers: pending,
      pagination: { page: 1, limit: 50, total: pending.length, totalPages: 1 },
    };
  }

  match = /^\/transfers\/([^/]+)$/.exec(path);
  if (match !== null) {
    const transferId = decodeURIComponent(match[1]!);
    const row =
      BATCHES.find((entry) => transferId.includes(entry.seed.productId)) ?? BATCHES[0]!;
    return {
      transfer: transferFor(row, 0, "COMPLETED"),
      product: productFor(row),
      canAcknowledge: true,
      canCancel: true,
    };
  }

  match = /^\/certificates\/([^/]+)$/.exec(path);
  if (match !== null) {
    const certificateId = decodeURIComponent(match[1]!);
    const row = findRow(certificateId.split("-").slice(1, 4).join("-")) ?? BATCHES[0]!;
    return {
      certificate: {
        certificateId,
        productId: row.seed.productId,
        issuingBody: "Ghana Organic Certification Board",
        certificateType: "ORGANIC",
        reference: `GOCB-${certificateId.slice(-6).toUpperCase()}`,
        issuedAt: row.seed.registeredAt,
        expiresAt: "2027-06-02T00:00:00.000Z",
        documentUrl: `/api/media/${encodeURIComponent(certificateId)}`,
        status: "VALID",
      },
    };
  }

  // ------------------------------------------------------------------- health
  if (path === "/health" || path === "/config") {
    return {
      status: "ok",
      runtime: { fixtures: true },
    };
  }

  void method;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Write paths
 *
 * A write in demo mode reports the same shape the API would, with a plausible
 * transaction. It does not pretend a chain accepted anything: the confirmation
 * panel shows a signature that was not signed, which is the one thing a viewer
 * must be able to tell from a real one.
 * ------------------------------------------------------------------ */

function handleWrite(path: string, request: DemoRequest): unknown {
  const productMatch = /^\/products\/([^/]+)/.exec(path);
  const productId = productMatch === null ? "" : decodeURIComponent(productMatch[1]!);
  const row = productId.length === 0 ? undefined : findRow(productId);

  if (path === "/auth/logout") return { signedOut: true };

  if (path === "/auth/verify") {
    return {
      walletAddress: DEMO_USER.walletAddress,
      user: DEMO_USER,
      isNewParticipant: false,
      needsRoleSelection: false,
      needsOnChainRegistration: false,
    };
  }

  if (path === "/auth/nonce") {
    return {
      nonce: "fixture-nonce",
      message: "Sign this message to sign in.",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      notBefore: new Date().toISOString(),
    };
  }

  if (path === "/products") {
    return {
      productId: "AGT-DEMO-2026-NEWBATCH",
      dataHash: "0".repeat(64),
      chainState: "AWAITING_SIGNATURE",
      prepared: {
        transaction: "demo-transaction",
        blockhash: "demo-blockhash",
        lastValidBlockHeight: 0,
        description: "Register AGT-DEMO-2026-NEWBATCH",
        accountAddresses: [],
      },
      product: {
        productId: "AGT-DEMO-2026-NEWBATCH",
        cropType: "cocoa",
        quantity: 100,
        unit: "kg",
        harvestDate: new Date().toISOString().slice(0, 10),
        farmLocation: "Kumasi, Ghana",
        description: "Registered while demo data was on.",
        additionalNotes: "",
        status: "REGISTERED",
        chainState: "AWAITING_SIGNATURE",
        ownerWallet: DEMO_USER.walletAddress,
        registeredByWallet: DEMO_USER.walletAddress,
        registrantRole: "FARMER",
        dataHash: "0".repeat(64),
        onChainDataHash: null,
        onChainTxHash: null,
        onChainAddress: null,
        onChainRegisteredAt: null,
        onChainTransferCount: 0,
        images: [],
        certificates: [],
        retail: { listed: false, listedAt: null, askingPrice: null, currency: "NGN", soldAt: null, note: "" },
        lastVerificationResult: "PENDING",
        lastVerifiedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
  }

  const signature = demoSignature(`${path}:${JSON.stringify(request.body ?? {})}`);

  if (/\/submit$/.test(path) || /\/status\/(prepare|submit)$/.test(path) || /\/transfers$/.test(path)) {
    return {
      prepared: {
        transaction: "demo-transaction",
        blockhash: "demo-blockhash",
        lastValidBlockHeight: 0,
        description: `Demo write for ${productId}`,
        accountAddresses: [],
      },
      transferId: `trf-${productId}-demo`,
      transfer: {
        transferId: `trf-${productId}-demo`,
        productId,
        status: "CONFIRMED",
        onChainSignature: signature,
      },
      product: row === undefined ? undefined : productFor(row),
      log: { logId: `log-${productId}-demo`, onChainSignature: signature },
    };
  }

  if (/\/verify\/[^/]+\/log$/.test(path)) {
    return {
      verificationId: `ver-${productId}-demo-log`,
      result: "VERIFIED",
      recordedAt: new Date().toISOString(),
    };
  }

  if (/\/sale$/.test(path)) {
    return row === undefined ? undefined : productFor(row);
  }

  if (/\/acknowledge$/.test(path) || /\/cancel$/.test(path)) {
    const transferId = /^\/transfers\/([^/]+)\//.exec(path)?.[1] ?? "trf-fixture";
    return {
      transfer: {
        transferId: decodeURIComponent(transferId),
        productId,
        status: path.endsWith("/cancel") ? "CANCELLED" : "ACKNOWLEDGED",
        acknowledgedAt: new Date().toISOString(),
        onChainSignature: signature,
      },
    };
  }

  // A profile edit, so the profile screen's form can be completed and saved.
  if (/^\/users\/me$/.test(path)) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return {
      user: {
        ...DEMO_USER,
        fullName: typeof body["fullName"] === "string" ? body["fullName"] : DEMO_USER.fullName,
        contactInfo: {
          ...DEMO_USER.contactInfo,
          ...(typeof body["contactInfo"] === "object" && body["contactInfo"] !== null
            ? (body["contactInfo"] as Record<string, unknown>)
            : {}),
        },
        organisation:
          typeof body["organisation"] === "string" ? body["organisation"] : DEMO_USER.organisation,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  if (/\/participant\/register\/(prepare|submit)$/.test(path)) {
    return path.endsWith("/prepare")
      ? {
          prepared: {
            transaction: "fixture-transaction",
            blockhash: "fixture-blockhash",
            lastValidBlockHeight: 0,
            description: `Register as a participant on the chain`,
            accountAddresses: [],
          },
          participantRegistration: {
            productCount: 0,
            walletAddress: DEMO_USER.walletAddress,
            role: DEMO_USER.role,
            onChainRegistered: false,
          },
        }
      : {
          participant: {
            walletAddress: DEMO_USER.walletAddress,
            role: DEMO_USER.role,
            onChainRegistered: true,
            onChainRegistrationTx: signature,
            registeredAt: new Date().toISOString(),
          },
        };
  }

  if (/\/compliance\/attestations\/(prepare|submit)$/.test(path)) {
    return path.endsWith("/prepare")
      ? {
          prepared: {
            transaction: "fixture-transaction",
            blockhash: "fixture-blockhash",
            lastValidBlockHeight: 0,
            description: "Record a regulator attestation",
            accountAddresses: [],
          },
        }
      : {
          attestation: {
            attestationId: `att-${productId}-fixture`,
            productId,
            result: "VERIFIED",
            onChainSignature: signature,
            recordedAt: new Date().toISOString(),
          },
        };
  }

  if (path === "/compliance/reports") {
    const covered = BATCHES.slice(0, 3);
    return {
      report: {
        reportId: `rpt-${covered[0]!.seed.productId}-new`,
        title: "Compliance report",
        productCount: covered.length,
        mismatchCount: 0,
        anomalyCount: 1,
        createdAt: new Date().toISOString(),
        exportedAt: null,
        exportedBy: null,
      },
    };
  }

  if (/\/products\/[^/]+\/media$/.test(path)) {
    return {
      product: row === undefined ? undefined : productFor(row),
      media: {
        mediaId: `med-${productId}-fixture`,
        productId,
        fileName: "batch-photo.jpg",
        contentType: "image/jpeg",
        sizeBytes: 184_320,
        uploadedAt: new Date().toISOString(),
      },
    };
  }

  if (/\/products\/[^/]+\/cancel$/.test(path)) {
    return row === undefined
      ? undefined
      : { product: { ...productFor(row), status: "CANCELLED", chainState: "CANCELLED" } };
  }

  if (path === "/notifications/../read" || /\/read$/.test(path)) {
    const notificationId = /\/notifications\/([^/]+)\//.exec(path)?.[1] ?? "ntf-fixture";
    return {
      notification: {
        notificationId: decodeURIComponent(notificationId),
        readAt: new Date().toISOString(),
      },
    };
  }

  if (/\/resolve$/.test(path)) {
    const taskId = /\/([^/]+)\/resolve$/.exec(path)?.[1] ?? "task-fixture";
    return {
      task: {
        taskId: decodeURIComponent(taskId),
        productId,
        status: "RESOLVED",
        resolvedAt: new Date().toISOString(),
        resolutionNote: "Marked resolved while reviewing the interface.",
      },
    };
  }

  return undefined;
}

/* ------------------------------------------------------------------ *
 * Binary endpoints
 * ------------------------------------------------------------------ */

/**
 * A stand-in for a media download or a report export.
 *
 * These two are the only endpoints that do not answer with JSON, and they are
 * opened rather than rendered: a photo, and a report a regulator saves. Both need
 * to return real bytes or the screen fails in a way that tells a reviewer nothing
 * about the product.
 *
 * The bytes are generated, not stored, so nothing has to be kept in the repository
 * and there is no file to go missing. A plain text body is used rather than a
 * fabricated JPEG or PDF: a viewer that cannot render the file says so, which is
 * an honest outcome, where a corrupt image would look like a broken product.
 */
export function demoDownload(path: string, method: string): Blob {
  void method;
  const mediaId = /^\/media\/([^/]+)$/.exec(path)?.[1];
  const reportId = /^\/compliance\/reports\/([^/]+)\/export$/.exec(path)?.[1];

  if (mediaId === undefined && reportId === undefined) {
    throw new DemoRouteNotFound("GET", path);
  }

  const body =
    reportId !== undefined
      ? [
          `Compliance report ${decodeURIComponent(reportId)}`,
          "",
          "productId,cropType,status,lastVerificationResult",
          ...BATCHES.map(
            (row) =>
              `${row.seed.productId},${row.seed.cropType},${row.seed.status},VERIFIED`,
          ),
          "",
        ].join("\n")
      : [
          `Media ${decodeURIComponent(mediaId ?? "")}`,
          "",
          "This file stands in for an uploaded image or certificate.",
          "",
        ].join("\n");

  return new Blob([body], {
    type: reportId !== undefined ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8",
  });
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Answers one request from the dataset, or throws if there is no handler.
 *
 * The caller is `ApiClient.request`, so the returned value is exactly what the
 * envelope would have carried in `data`.
 */
export function demoRequest(request: DemoRequest): unknown {
  const answer =
    request.method === "GET" || request.method === "HEAD"
      ? handleRead(request.method, request.path, request)
      : handleWrite(request.path, request);

  if (answer === undefined) {
    throw new DemoRouteNotFound(request.method, request.path);
  }
  return answer;
}

/** The provenance chain, for the screens that need it directly. */
export { provenanceFor };
