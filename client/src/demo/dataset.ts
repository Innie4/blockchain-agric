/**
 * Placeholder data for the interface, served in place of the API.
 *
 * The point is to be able to open every screen and see a working product without
 * a database, a chain connection or a wallet. The data is internally consistent
 * rather than decorative: registration fingerprints are computed by the server's
 * own canonical module, provenance chains run in chronological order with the
 * right wallets, and a batch's stage matches the hand-overs that produced it. A
 * demonstration that contradicts itself would be worse than an empty screen,
 * because it would hide the problems it is meant to reveal.
 *
 * It is not, and does not pretend to be, the real registry. `mode.ts` keeps it
 * out of production builds and the interface banners it while it is on.
 */

import { BATCHES, SIGNATURE_SEEDS, TIMES, WALLETS } from "./generated.js";
import type { DemoBatchRow } from "./types.js";
import { STATUS_LABELS, PRODUCT_STATUSES, VERIFICATION_RESULT_LABELS } from "../api/types";

/* ------------------------------------------------------------------ *
 * Identities
 * ------------------------------------------------------------------ */

export interface DemoParticipant {
  walletAddress: string;
  fullName: string;
  role: string;
  organisation: string;
  state: string;
  contactEmail: string;
  contactPhone: string;
}

export const PARTICIPANTS: readonly DemoParticipant[] = [
  {
    walletAddress: WALLETS.farmer,
    fullName: "Ada Okafor",
    role: "FARMER",
    organisation: "Okafor Cocoa Farm",
    state: "Ashanti Region",
    contactEmail: "ada@okafforkmasi.example",
    contactPhone: "+233 20 555 0114",
  },
  {
    walletAddress: WALLETS.processor,
    fullName: "Bello Danjuma",
    role: "PROCESSOR",
    organisation: "Ibadan Processing Depot",
    state: "Oyo State",
    contactEmail: "bello@ibadandepot.example",
    contactPhone: "+234 803 555 0182",
  },
  {
    walletAddress: WALLETS.transporter,
    fullName: "Chioma Eze",
    role: "TRANSPORTER",
    organisation: "Ondo Haulage",
    state: "Ondo State",
    contactEmail: "chioma@ondohaulage.example",
    contactPhone: "+234 806 555 0143",
  },
  {
    walletAddress: WALLETS.retailer,
    fullName: "Ibrahim Sanni",
    role: "RETAILER",
    organisation: "Ikeja Fresh Market",
    state: "Lagos State",
    contactEmail: "ibrahim@ikejafresh.example",
    contactPhone: "+234 802 555 0177",
  },
  {
    walletAddress: WALLETS.regulator,
    fullName: "Amina Yusuf",
    role: "REGULATOR",
    organisation: "State Produce Regulator",
    state: "Federal Capital Territory",
    contactEmail: "amina@producesafety.example",
    contactPhone: "+234 809 555 0121",
  },
];

/** The session a demo visitor arrives with. */
export const DEMO_USER = {
  userId: "usr-demo-0001",
  walletAddress: WALLETS.farmer,
  fullName: "Ada Okafor",
  role: "FARMER" as const,
  contactInfo: {
    email: PARTICIPANTS[0]!.contactEmail,
    phone: PARTICIPANTS[0]!.contactPhone,
    address: "Plot 14, Okawkrom, Kumasi",
    state: "Ashanti Region",
  },
  organisation: PARTICIPANTS[0]!.organisation,
  status: "ACTIVE" as const,
  onChainRegistered: true,
  onChainRegistrationTx: SIGNATURE_SEEDS[0]!,
  profileHash: "b".repeat(64),
  registrationDate: "2026-06-02T08:15:00.000Z",
  lastSeen: "2026-09-29T06:40:00.000Z",
};

export const DEMO_PERMISSIONS: readonly string[] = [
  "batch:read",
  "batch:create",
  "batch:transfer",
  "batch:record-processing",
  "profile:write",
];

/* ------------------------------------------------------------------ *
 * Signatures
 * ------------------------------------------------------------------ */

/**
 * A plausible-looking transaction signature derived from the batch identifier.
 *
 * These are not valid signatures and nothing is signed with them. They exist so
 * the interface has a stable value to display and copy, and so a screenshot does
 * not show an empty field.
 */
export function demoSignature(seed: string): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 2166136261;
  for (const character of seed) {
    value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  let output = "";
  for (let index = 0; index < 88; index += 1) {
    value = (Math.imul(value, 1103515245) + 12345) >>> 0;
    output += alphabet[value % alphabet.length];
  }
  return output;
}

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */

interface ProvenanceRow {
  sequence: number;
  kind: string;
  title: string;
  detail: string;
  occurredAt: string;
  actorWallet: string | null;
  actorRole: string | null;
  status: string | null;
  transactionSignature: string | null;
  dataHash: string | null;
  flagged: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  FARMER: "farmer",
  PROCESSOR: "processor",
  TRANSPORTER: "transporter",
  RETAILER: "retailer",
  REGULATOR: "regulator",
};

/** Minutes after a batch's registration, so a chain reads in order. */
function after(registeredAt: string, minutes: number): string {
  return new Date(new Date(registeredAt).getTime() + minutes * 60_000).toISOString();
}

/**
 * The story of one batch, built from the hand-overs it actually had.
 *
 * A batch registered and never handed on has one event. A batch that reached a
 * retailer has the registration, each transfer, the processing and journey
 * entries that moved it, the listing, and — for a flagged batch — the regulator's
 * finding. Nothing is included that the batch's own stage does not support.
 */
export function provenanceFor(row: DemoBatchRow): ProvenanceRow[] {
  const { seed, dataHash } = row;
  const rows: ProvenanceRow[] = [
    {
      sequence: 1,
      kind: "REGISTERED",
      title: "Registered by farmer",
      detail: `${seed.cropType}, ${seed.quantity} ${seed.unit}, harvested ${seed.harvestDate} at ${seed.farmLocation}.`,
      occurredAt: seed.registeredAt,
      actorWallet: null,
      actorRole: "FARMER",
      status: "REGISTERED",
      transactionSignature: demoSignature(`${seed.productId}:register`),
      dataHash,
      flagged: false,
    },
  ];

  let sequence = 2;
  const at = (minutes: number): string => after(seed.registeredAt, minutes);

  if (seed.transferCount >= 1) {
    rows.push({
      sequence: sequence++,
      kind: "TRANSFER",
      title: "Ownership passed to a processor",
      detail: `Ownership moved from ${short(WALLETS.farmer)} to ${short(WALLETS.processor)}.`,
      occurredAt: at(180),
      actorWallet: WALLETS.farmer,
      actorRole: "FARMER",
      status: "IN_PROCESSING",
      transactionSignature: demoSignature(`${seed.productId}:transfer:1`),
      dataHash: null,
      flagged: false,
    });
  }

  if (seed.transferCount >= 1 && seed.status !== "REGISTERED") {
    rows.push({
      sequence: sequence++,
      kind: "PROCESSING",
      title: "Processing recorded",
      detail: "Sorted, graded and packed at the depot.",
      occurredAt: at(300),
      actorWallet: WALLETS.processor,
      actorRole: "PROCESSOR",
      status: "PROCESSED",
      transactionSignature: demoSignature(`${seed.productId}:processing`),
      dataHash: null,
      flagged: false,
    });
  }

  if (seed.transferCount >= 2) {
    rows.push({
      sequence: sequence++,
      kind: "TRANSFER",
      title: "Ownership passed to a transporter",
      detail: `Ownership moved from ${short(WALLETS.processor)} to ${short(WALLETS.transporter)}.`,
      occurredAt: at(1_440),
      actorWallet: WALLETS.processor,
      actorRole: "PROCESSOR",
      status: "IN_TRANSIT",
      transactionSignature: demoSignature(`${seed.productId}:transfer:2`),
      dataHash: null,
      flagged: false,
    });
  }

  if (seed.transferCount >= 2 && (seed.status === "AT_RETAILER" || seed.status === "LISTED" || seed.status === "SOLD" || seed.status === "FLAGGED")) {
    rows.push({
      sequence: sequence++,
      kind: "TRANSPORT",
      title: "Journey recorded as delivered",
      detail: "Delivered from the depot to the market, seals intact.",
      occurredAt: at(1_920),
      actorWallet: WALLETS.transporter,
      actorRole: "TRANSPORTER",
      status: "AT_RETAILER",
      transactionSignature: demoSignature(`${seed.productId}:transport`),
      dataHash: null,
      flagged: false,
    });
  }

  if (seed.transferCount >= 3) {
    rows.push({
      sequence: sequence++,
      kind: "TRANSFER",
      title: "Ownership passed to a retailer",
      detail: `Ownership moved from ${short(WALLETS.transporter)} to ${short(WALLETS.retailer)}.`,
      occurredAt: at(2_880),
      actorWallet: WALLETS.transporter,
      actorRole: "TRANSPORTER",
      status: "AT_RETAILER",
      transactionSignature: demoSignature(`${seed.productId}:transfer:3`),
      dataHash: null,
      flagged: false,
    });
  }

  if (seed.retail.listedAt !== null) {
    rows.push({
      sequence: sequence++,
      kind: "RETAIL",
      title: "Listed for sale",
      detail:
        seed.retail.askingPrice === null
          ? "The retailer listed the batch."
          : `The retailer listed the batch at ${seed.retail.askingPrice.toLocaleString("en-GB")} ${seed.retail.currency}.`,
      occurredAt: seed.retail.listedAt,
      actorWallet: WALLETS.retailer,
      actorRole: "RETAILER",
      status: "LISTED",
      transactionSignature: null,
      dataHash: null,
      flagged: false,
    });
  }

  if (seed.retail.soldAt !== null) {
    rows.push({
      sequence: sequence++,
      kind: "RETAIL",
      title: "Sold",
      detail: `Sold for ${(seed.retail.askingPrice ?? 0).toLocaleString("en-GB")} ${seed.retail.currency}.`,
      occurredAt: seed.retail.soldAt,
      actorWallet: WALLETS.retailer,
      actorRole: "RETAILER",
      status: "SOLD",
      transactionSignature: null,
      dataHash: null,
      flagged: false,
    });
  }

  if (seed.flagged === true) {
    rows.push({
      sequence: sequence++,
      kind: "VERIFICATION",
      title: "Withheld by a regulator",
      detail: "Held pending an inspection of the packing records. The batch cannot progress while withheld.",
      occurredAt: at(4_320),
      actorWallet: WALLETS.regulator,
      actorRole: "REGULATOR",
      status: "FLAGGED",
      transactionSignature: demoSignature(`${seed.productId}:attestation`),
      dataHash: null,
      flagged: true,
    });
  }

  return rows;
}

function short(wallet: string): string {
  return `${wallet.slice(0, 6)}…${wallet.slice(-6)}`;
}

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

function roleOf(wallet: string): string {
  return PARTICIPANTS.find((participant) => participant.walletAddress === wallet)?.role ?? "FARMER";
}

function categoryOf(wallet: string): string {
  return ROLE_LABEL[roleOf(wallet)] ?? "participant";
}

export function productFor(row: DemoBatchRow): Record<string, unknown> {
  const { seed, dataHash, onChainAddress } = row;
  return {
    productId: seed.productId,
    cropType: seed.cropType,
    quantity: seed.quantity,
    unit: seed.unit,
    harvestDate: seed.harvestDate,
    farmLocation: seed.farmLocation,
    description: seed.description,
    additionalNotes: seed.additionalNotes,
    status: seed.status,
    chainState: "CONFIRMED",
    ownerWallet: seed.owner,
    registeredByWallet: seed.registeredBy,
    registrantRole: seed.registrantRole,
    dataHash,
    onChainDataHash: dataHash,
    onChainTxHash: demoSignature(`${seed.productId}:register`),
    onChainAddress,
    onChainRegisteredAt: seed.registeredAt,
    onChainTransferCount: seed.transferCount,
    images: [],
    certificates: seed.certificateHashes.map((hash, index) => ({
      mediaId: `media-${seed.productId}-${index + 1}`,
      fileName: `${seed.cropType}-certificate-${index + 1}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 184_320,
      contentHash: hash,
      kind: "DOCUMENT",
      caption: "Packing and quality certificate",
      uploadedAt: seed.registeredAt,
    })),
    retail: {
      listed: seed.retail.listed,
      listedAt: seed.retail.listedAt,
      askingPrice: seed.retail.askingPrice,
      currency: seed.retail.currency,
      soldAt: seed.retail.soldAt,
      note: seed.retail.note,
    },
    lastVerificationResult: seed.flagged === true ? "VERIFIED" : "VERIFIED",
    lastVerifiedAt: after(seed.registeredAt, 5_000),
    createdAt: seed.registeredAt,
    updatedAt: after(seed.registeredAt, 5_000),
  };
}

export function publicProductFor(row: DemoBatchRow): Record<string, unknown> {
  const { seed, dataHash, onChainAddress } = row;
  const provenance = provenanceFor(row);
  return {
    productId: seed.productId,
    cropType: seed.cropType,
    quantity: seed.quantity,
    unit: seed.unit,
    harvestDate: seed.harvestDate,
    origin: seed.farmLocation,
    description: seed.description,
    additionalNotes: seed.additionalNotes,
    status: seed.status,
    statusLabel: STATUS_LABELS[seed.status as keyof typeof STATUS_LABELS] ?? seed.status,
    registeredAt: seed.registeredAt,
    currentOwnerCategory: categoryOf(seed.owner),
    registrantCategory: categoryOf(seed.registeredBy),
    dataHash,
    onChainAddress,
    onChainTxHash: demoSignature(`${seed.productId}:register`),
    onChainRegisteredAt: seed.registeredAt,
    images: [],
    certificates: seed.certificateHashes.map((hash, index) => ({
      certificateId: `cert-${seed.productId}-${index + 1}`,
      issuingBody: "State Produce Regulator",
      certificateType: "Quality and packing",
      referenceNumber: `SPR-${seed.productId.slice(-6)}-${index + 1}`,
      issuedOn: seed.harvestDate,
      expiresOn: null,
      dataHash: hash,
    })),
    provenance,
    verificationHistory: [
      {
        verificationId: `ver-${seed.productId}-1`,
        result: "VERIFIED",
        requester: "PUBLIC",
        requesterRole: null,
        requestChannel: "DIRECT_URL",
        createdAt: after(seed.registeredAt, 4_000),
        resultLabel: VERIFICATION_RESULT_LABELS["VERIFIED"],
      },
      {
        verificationId: `ver-${seed.productId}-2`,
        result: "VERIFIED",
        requester: WALLETS.regulator,
        requesterRole: "REGULATOR",
        requestChannel: "REGULATOR_REVIEW",
        createdAt: after(seed.registeredAt, 5_000),
        resultLabel: VERIFICATION_RESULT_LABELS["VERIFIED"],
      },
    ],
    verificationCount: 2,
    lastVerificationResult: "VERIFIED",
  };
}

export function historyFor(row: DemoBatchRow): Record<string, unknown> {
  const { seed, dataHash } = row;
  const provenance = provenanceFor(row);
  return {
    productId: seed.productId,
    status: seed.status,
    statusLabel: STATUS_LABELS[seed.status as keyof typeof STATUS_LABELS] ?? seed.status,
    chainState: "CONFIRMED",
    onChainAddress: row.onChainAddress,
    onChainTxHash: demoSignature(`${seed.productId}:register`),
    dataHash,
    onChainDataHash: dataHash,
    integrity: {
      status: "MATCH",
      detail: "The stored details still produce the fingerprint anchored at registration.",
    },
    provenance,
    counts: {
      transfers: provenance.filter((event) => event.kind === "TRANSFER").length,
      processingEvents: provenance.filter((event) => event.kind === "PROCESSING").length,
      transportEvents: provenance.filter((event) => event.kind === "TRANSPORT").length,
      certificates: seed.certificateHashes.length,
      verifications: 2,
    },
  };
}

export function processingFor(row: DemoBatchRow): Record<string, unknown> {
  const { seed } = row;
  const hasProcessing = provenanceFor(row).some((event) => event.kind === "PROCESSING");
  const logs = hasProcessing
    ? [
        {
          logId: `prc-${seed.productId}-1`,
          productId: seed.productId,
          activity: "GRADING",
          activityDescription: "Sorted by size and hand-picked for defects.",
          previousStatus: "IN_PROCESSING",
          newStatus: "PROCESSED",
          occurredAt: after(seed.registeredAt, 300),
          actorWallet: WALLETS.processor,
          actorRole: "PROCESSOR",
          onChainSignature: demoSignature(`${seed.productId}:processing`),
        },
      ]
    : [];
  return { logs, pagination: { page: 1, limit: 50, total: logs.length, totalPages: 1 } };
}

export function transportFor(row: DemoBatchRow): Record<string, unknown> {
  const { seed } = row;
  const hasJourney = provenanceFor(row).some((event) => event.kind === "TRANSPORT");
  const logs = hasJourney
    ? [
        {
          logId: `trn-${seed.productId}-1`,
          productId: seed.productId,
          origin: "Ibadan processing depot",
          destination: "Ikeja Fresh Market, Lagos",
          routeDetails: "Ibadan to Lagos, one overnight stop at Ogbomoso.",
          vehicleDescription: "Refrigerated 8 tonne lorry, AY 402 KRD.",
          deliveryStatus: "DELIVERED",
          previousStatus: "IN_TRANSIT",
          newStatus: "AT_RETAILER",
          occurredAt: after(seed.registeredAt, 1_920),
          actorWallet: WALLETS.transporter,
          actorRole: "TRANSPORTER",
          onChainSignature: demoSignature(`${seed.productId}:transport`),
        },
      ]
    : [];
  return { logs, pagination: { page: 1, limit: 50, total: logs.length, totalPages: 1 } };
}

export function certificatesFor(row: DemoBatchRow): Record<string, unknown> {
  const { seed } = row;
  const certificates = seed.certificateHashes.map((hash, index) => ({
    certificateId: `cert-${seed.productId}-${index + 1}`,
    productId: seed.productId,
    mediaId: `media-${seed.productId}-${index + 1}`,
    fileName: `${seed.cropType}-certificate-${index + 1}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 184_320,
    contentHash: hash,
    caption: "Packing and quality certificate",
    issuingBody: "State Produce Regulator",
    certificateType: "Quality and packing",
    referenceNumber: `SPR-${seed.productId.slice(-6)}-${index + 1}`,
    issuedOn: seed.harvestDate,
    expiresOn: null,
    uploadedBy: WALLETS.farmer,
    uploadedAt: seed.registeredAt,
  }));
  return { certificates, pagination: { page: 1, limit: 50, total: certificates.length, totalPages: 1 } };
}

export function verificationFor(row: DemoBatchRow, includeProduct = true): Record<string, unknown> {
  const { seed, dataHash } = row;
  return {
    verification: {
      result: "VERIFIED",
      productId: seed.productId,
      headline: "This batch matches its blockchain record.",
      explanation:
        "Every stored detail still produces the fingerprint that was anchored on the blockchain when the batch was registered.",
      chainReachable: true,
      recordPresent: true,
      dataHash: { onChain: dataHash, stored: dataHash, computed: dataHash },
      mismatch: null,
      mediaProblems: [],
      verificationId: `ver-${seed.productId}-demo`,
      verifiedAt: after(seed.registeredAt, 5_000),
      durationMs: 41,
    },
    ...(includeProduct ? { product: publicProductFor(row) } : {}),
  };
}

export { BATCHES, SIGNATURE_SEEDS, TIMES, WALLETS, PRODUCT_STATUSES };
