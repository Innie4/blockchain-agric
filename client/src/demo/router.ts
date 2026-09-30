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
  return [...counts.entries()].map(([cropType, count]) => ({ _id: cropType, count }));
})();

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
    return {
      product: productFor(row),
      verificationUrl: `/verify/${encodeURIComponent(seed.productId)}`,
      isOwner: seed.owner === DEMO_USER.walletAddress,
      isRegistrant: seed.registeredBy === DEMO_USER.walletAddress,
      canTransfer: seed.owner === DEMO_USER.walletAddress,
      canRecordProcessing:
        seed.owner === DEMO_USER.walletAddress && seed.registrantRole === "PROCESSOR",
      canRecordTransport: seed.owner === DEMO_USER.walletAddress && seed.registrantRole === "TRANSPORTER",
      canListForSale: seed.owner === DEMO_USER.walletAddress && seed.registrantRole === "RETAILER",
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
    return row === undefined ? null : verificationFor(row, false);
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
      entries: BATCHES.slice(0, 6).map((row) => ({
        eventId: `act-${row.seed.productId}`,
        kind: "REGISTERED",
        title: `${row.seed.productId} registered`,
        detail: `${row.seed.quantity} ${row.seed.unit} of ${row.seed.cropType}`,
        productId: row.seed.productId,
        occurredAt: row.seed.registeredAt,
        actorRole: "FARMER",
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
    return {
      overview: {
        totalBatches: BATCHES.length,
        verifiedBatches: BATCHES.length,
        flaggedBatches: BATCHES.filter((row) => row.seed.flagged === true).length,
        listedBatches: BATCHES.filter((row) => row.seed.retail.listed).length,
        participants: PARTICIPANTS.length,
        checksRecorded: BATCHES.length * 2,
      },
      statusCounts: Object.entries(
        BATCHES.reduce<Record<string, number>>((counts, row) => {
          counts[row.seed.status] = (counts[row.seed.status] ?? 0) + 1;
          return counts;
        }, {})
      ).map(([status, count]) => ({ _id: status, count })),
      cropTypeCounts: OVERVIEW_CROP_COUNTS.map((entry) => ({ cropType: entry._id, count: entry.count })),
      recentChecks: BATCHES.slice(0, 5).map((row) => ({
        verificationId: `ver-${row.seed.productId}-2`,
        productId: row.seed.productId,
        result: "VERIFIED",
        requester: WALLETS.regulator,
        requesterRole: "REGULATOR",
        requestChannel: "REGULATOR_REVIEW",
        createdAt: row.seed.registeredAt,
      })),
      transferCounts: BATCHES.filter((row) => row.seed.transferCount > 0).map((row) => ({
        productId: row.seed.productId,
        transferCount: row.seed.transferCount,
      })),
    };
  }

  if (path === "/compliance/verifications") {
    const verifications = BATCHES.flatMap((row) => [
      {
        verificationId: `ver-${row.seed.productId}-2`,
        productId: row.seed.productId,
        result: "VERIFIED",
        requester: WALLETS.regulator,
        requesterRole: "REGULATOR",
        requestChannel: "REGULATOR_REVIEW",
        createdAt: row.seed.registeredAt,
        onChainTx: demoSignature(`${row.seed.productId}:attestation`),
      },
      {
        verificationId: `ver-${row.seed.productId}-1`,
        productId: row.seed.productId,
        result: "VERIFIED",
        requester: "PUBLIC",
        requesterRole: null,
        requestChannel: "DIRECT_URL",
        createdAt: row.seed.registeredAt,
        onChainTx: null,
      },
    ]);
    return paginate(verifications, "verifications", Number(request.query?.["page"] ?? 1), Number(request.query?.["limit"] ?? 20));
  }

  if (path === "/compliance/reports") {
    const reports = BATCHES.slice(0, 3).map((row, index) => ({
      reportId: `rpt-${row.seed.productId}`,
      title: `${row.seed.cropType} batches reviewed in ${statusLabel(row.seed.status).toLowerCase()}`,
      productCount: 1 + index,
      mismatchCount: 0,
      anomalyCount: row.seed.flagged === true ? 1 : 0,
      createdAt: row.seed.registeredAt,
      exportedAt: index === 0 ? null : row.seed.registeredAt,
      exportedBy: index === 0 ? null : WALLETS.regulator,
    }));
    return paginate(reports, "reports", 1, 20);
  }

  match = /^\/compliance\/reports\/([^/]+)$/.exec(path);
  if (match !== null) {
    const reportId = decodeURIComponent(match[1]!);
    const covered = BATCHES.slice(0, 3);
    return {
      reportId,
      title: "Batches reviewed for compliance",
      requestedBy: WALLETS.regulator,
      filters: { cropTypes: covered.map((row) => row.seed.cropType), statuses: [] },
      criteria: [
        { label: "Crop types", value: covered.map((row) => row.seed.cropType).join(", ") },
        { label: "Stage", value: "Any stage" },
        { label: "Only batches verified since registration", value: "Yes" },
      ],
      summary: {
        productCount: covered.length,
        mismatchCount: 0,
        anomalyCount: 1,
        participantCount: PARTICIPANTS.length,
      },
      includedProducts: covered.map((row) => ({
        productId: row.seed.productId,
        cropType: row.seed.cropType,
        status: row.seed.status,
        statusLabel: statusLabel(row.seed.status),
        lastVerificationResult: "VERIFIED",
      })),
      createdAt: covered[0]!.seed.registeredAt,
      exportedAt: null,
    };
  }

  if (path === "/operations/reconciliation") {
    return {
      tasks: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
    };
  }

  // ----------------------------------------------------------------- transfers
  if (path === "/transfers") {
    const transfers = BATCHES.filter((row) => row.seed.transferCount > 0).map((row, index) => ({
      transferId: `trf-${row.seed.productId}-${index + 1}`,
      productId: row.seed.productId,
      fromWallet: WALLETS.farmer,
      toWallet: WALLETS.processor,
      toRole: "PROCESSOR",
      status: "CONFIRMED",
      occurredAt: row.seed.registeredAt,
      acknowledgedAt: row.seed.registeredAt,
      onChainSignature: demoSignature(`${row.seed.productId}:transfer:1`),
    }));
    return paginate(transfers, "transfers", 1, 20);
  }

  if (path === "/transfers/pending") {
    return {
      transfers: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
    };
  }

  // ------------------------------------------------------------------- health
  if (path === "/health" || path === "/config") {
    return {
      status: "ok",
      runtime: { demoData: true },
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
      nonce: "demo-nonce-not-a-real-challenge",
      message: "Demo data does not verify signatures.",
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
    return { transfer: { transferId: "trf-demo", status: "ACKNOWLEDGED" } };
  }

  if (path === "/notifications/../read" || /\/read$/.test(path)) {
    return { notification: { notificationId: "ntf-demo", readAt: new Date().toISOString() } };
  }

  if (/\/resolve$/.test(path)) {
    return { taskId: "task-demo", status: "RESOLVED", resolvedAt: new Date().toISOString() };
  }

  return undefined;
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
