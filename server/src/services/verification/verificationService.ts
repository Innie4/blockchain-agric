import { childLogger } from "../../lib/logger.js";
import { assertProductId, newId, sha256Hex, stringOr } from "../../lib/crypto.js";
import { retrieveMedia as readStoredMedia } from "../files/mediaStore.js";
import { computeRegistrationHash, compareHashes } from "../hashing/canonical.js";
import { getProductAddress } from "../solana/pda.js";
import { getChainClient } from "../solana/chainClientRegistry.js";
import {
  CertificateModel,
  ProcessingLogModel,
  ProductMetadataModel,
  TransferModel,
  TransportLogModel,
  UserModel,
  VerificationEventModel,
  type VerificationResult,
} from "../../models/index.js";
import { statusLabel, type ProductStatus } from "../../lib/statusMachine.js";

const log = childLogger({ layer: "verification" });

export type RequestChannel =
  | "SEARCH"
  | "DIRECT_URL"
  | "QR_SCAN"
  | "DASHBOARD"
  | "REGULATOR_REVIEW";

export interface MismatchDetail {
  reason: string;
  explanation: string;
  expected: string;
  actual: string;
  field?: string;
}

export interface MediaIntegrityProblem {
  mediaId: string;
  fileName: string;
  expected: string;
  actual: string;
}

export interface ProvenanceEvent {
  sequence: number;
  kind:
    | "REGISTERED"
    | "TRANSFER"
    | "PROCESSING"
    | "TRANSPORT"
    | "STATUS"
    | "VERIFICATION"
    | "RETAIL";
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

export interface VerificationResultBody {
  result: VerificationResult;
  productId: string;
  /** Human explanation of the outcome, safe to show a consumer. */
  headline: string;
  explanation: string;
  chainReachable: boolean;
  recordPresent: boolean;
  dataHash: { onChain: string | null; stored: string | null; computed: string | null };
  mismatch: MismatchDetail | null;
  /** Files whose stored bytes no longer match the digest recorded for them. */
  mediaProblems: MediaIntegrityProblem[];
  verificationId: string;
  verifiedAt: string;
  durationMs: number;
}

export interface PublicProductView {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  harvestDate: string;
  /** Farm location, shown as recorded. Precise coordinates are not published. */
  origin: string;
  description: string;
  additionalNotes: string;
  status: string;
  statusLabel: string;
  registeredAt: string | null;
  /** Participant category of the current owner, not the wallet itself. */
  currentOwnerCategory: string | null;
  registrantCategory: string;
  dataHash: string | null;
  onChainAddress: string | null;
  onChainTxHash: string | null;
  onChainRegisteredAt: string | null;
  images: Array<{ mediaId: string; caption: string }>;
  certificates: Array<{
    certificateId: string;
    issuingBody: string;
    certificateType: string;
    referenceNumber: string;
    issuedOn: string | null;
    expiresOn: string | null;
    dataHash: string;
  }>;
  provenance: ProvenanceEvent[];
  verificationHistory: Array<{
    verificationId: string;
    result: VerificationResult;
    requester: string;
    requestedAt: string;
  }>;
  verificationCount: number;
  /**
   * The most recent outcome. `PENDING` means nobody has checked this batch yet,
   * which is different from having checked it and found nothing.
   */
  lastVerificationResult: VerificationResult | "PENDING";
}

export interface VerificationOutcome {
  verification: VerificationResultBody;
  product: PublicProductView | null;
}

/** A lean MongoDB document omits unset fields, so absent and null both occur. */
function isoOrNull(value: Date | null | undefined): string | null {
  return value == null ? null : value.toISOString();
}

function strOrNull(value: string | null | undefined): string | null {
  return value ?? null;
}

interface StoredProductLike {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  harvestDate: Date;
  farmLocation: string;
  description: string;
  additionalNotes: string;
  status: string;
  dataHash: string;
  onChainDataHash?: string | null;
  onChainTxHash?: string | null;
  onChainAddress?: string | null;
  onChainRegisteredAt?: Date | null;
  ownerWallet: string;
  registeredByWallet: string;
  registrantRole: string;
  chainState: string;
  registrationHashTimestamp: Date;
  anchoredImageHashes?: string[];
  anchoredCertificateHashes?: string[];
  images: Array<{ mediaId: string; caption: string; contentHash?: string }>;
  createdAt: Date;
  lastVerificationResult: VerificationResult | "PENDING";
  lastVerifiedAt?: Date | null;
  retail?: { listed?: boolean; listedAt?: Date | null; soldAt?: Date | null; askingPrice?: number | null; currency?: string } | null;
}

/**
 * Verifies a batch and returns everything a consumer or regulator needs.
 *
 * The check is the one described in the source project's activity diagram:
 * read the on-chain record, rebuild the canonical off-chain payload, recompute
 * its hash, and compare it with the hash anchored on-chain. A mismatch is
 * reported prominently and logged, never smoothed over.
 */
export async function verifyProduct(input: {
  productId: string;
  requesterWallet?: string | null | undefined;
  requesterRole?: string | undefined;
  channel: RequestChannel;
  logEvent: boolean;
}): Promise<VerificationOutcome> {
  const startedAt = Date.now();
  const productId = assertProductId(input.productId);
  const chain = getChainClient();
  const chainReachable = await clusterReachable();

  if (!chainReachable) {
    const verification = await finishUnavailable(productId, input, startedAt);
    return { verification, product: null };
  }

  const stored = await ProductMetadataModel.findOne({ productId }).lean();

  let onChainProduct = null;
  try {
    onChainProduct = await chain.fetchProduct(productId);
  } catch (error) {
    log.warn({ productId, problem: String(error) }, "on-chain read failed during verification");
  }

  if (onChainProduct === null) {
    const verification = await recordOutcome({
      productId,
      input,
      startedAt,
      chainReachable: true,
      result: "NOT_FOUND",
      stored,
      onChainHash: null,
      computedHash: null,
      mismatch: null,
      recordPresent: stored !== null,
    });
    return { verification, product: null };
  }

  if (stored === null) {
    // The chain knows this batch but the off-chain record is missing, which is
    // either a registration still in flight or a record that needs rebuilding.
    const verification = await recordOutcome({
      productId,
      input,
      startedAt,
      chainReachable: true,
      result: "INCOMPLETE",
      stored: null,
      onChainHash: onChainProduct.offChainDataHash,
      computedHash: null,
      mismatch: null,
      recordPresent: false,
    });
    return { verification, product: null };
  }

  if (stored.chainState !== "CONFIRMED") {
    const verification = await recordOutcome({
      productId,
      input,
      startedAt,
      chainReachable: true,
      result: "INCOMPLETE",
      stored,
      onChainHash: onChainProduct.offChainDataHash,
      computedHash: null,
      mismatch: null,
      recordPresent: true,
    });
    return { verification, product: null };
  }

  const computedHash = computeHashFromRecord(stored);
  const comparison = compareHashes(onChainProduct.offChainDataHash, computedHash);
  const mediaProblems = await checkMediaIntegrity(stored);

  if (mediaProblems.length > 0) {
    // A file whose bytes no longer match its recorded digest is a substitution,
    // whether or not the registration facts are intact.
    const verification = await recordOutcome({
      productId,
      input,
      startedAt,
      chainReachable: true,
      result: "MISMATCH",
      stored,
      onChainHash: onChainProduct.offChainDataHash,
      computedHash,
      mismatch: {
        reason: "MEDIA_DIGEST_MISMATCH",
        explanation: `The stored contents of ${mediaProblems.length} file${mediaProblems.length === 1 ? "" : "s"} attached to this batch no longer match the digest recorded when ${mediaProblems.length === 1 ? "it was" : "they were"} uploaded. The image${mediaProblems.length === 1 ? " has" : "s have"} been replaced.`,
        expected: mediaProblems[0]?.expected ?? "",
        actual: mediaProblems[0]?.actual ?? "",
        field: mediaProblems[0]?.mediaId,
      },
      recordPresent: true,
      mediaProblems,
    });
    stored.lastVerificationResult = "MISMATCH";
    stored.lastVerifiedAt = new Date(verification.verifiedAt);
    return { verification, product: await buildPublicView(stored, productId) };
  }

  const result: VerificationResult = comparison.match ? "VERIFIED" : "MISMATCH";
  const mismatch =
    comparison.match ? null : describeMismatch(computedHash, onChainProduct.offChainDataHash);

  const verification = await recordOutcome({
    productId,
    input,
    startedAt,
    chainReachable: true,
    result,
    stored,
    onChainHash: onChainProduct.offChainDataHash,
    computedHash,
    mismatch,
    recordPresent: true,
    mediaProblems,
  });

  // The event write above updates the record in MongoDB; applying the same
  // change in memory keeps the returned view from contradicting the result.
  stored.lastVerificationResult = result;
  stored.lastVerifiedAt = new Date(verification.verifiedAt);
  const product = await buildPublicView(stored, productId);
  return { verification, product };
}

/**
 * Rebuilds the hash from what is stored now. This is the step that detects
 * substitution: any change to the registration facts produces a different
 * digest from the one anchored on-chain.
 *
 * `registrationHashTimestamp` is the exact instant that was mixed into the
 * original digest, and `anchoredImageHashes` / `anchoredCertificateHashes` are
 * the digests that were mixed in at that moment. Both are stored on the record
 * rather than reconstructed, because a certificate added months later must not
 * retroactively invalidate the anchor.
 */
export function computeHashFromRecord(
  record: Pick<
    StoredProductLike,
    | "productId"
    | "cropType"
    | "quantity"
    | "unit"
    | "harvestDate"
    | "farmLocation"
    | "description"
    | "additionalNotes"
    | "registeredByWallet"
    | "registrationHashTimestamp"
    | "anchoredImageHashes"
    | "anchoredCertificateHashes"
  >
): string {
  return computeRegistrationHash({
    productId: record.productId,
    cropType: record.cropType,
    quantity: record.quantity,
    unit: record.unit,
    harvestDate: record.harvestDate,
    farmLocation: record.farmLocation,
    description: record.description,
    additionalNotes: record.additionalNotes,
    registeredByWallet: record.registeredByWallet,
    imageHashes: record.anchoredImageHashes ?? [],
    certificateHashes: record.anchoredCertificateHashes ?? [],
    registeredAt: record.registrationHashTimestamp,
  });
}

function describeMismatch(computed: string, onChain: string): MismatchDetail {
  return {
    reason: "HASH_MISMATCH",
    explanation:
      "The details held for this batch do not match the record anchored on the blockchain. Someone may have altered the stored information after registration. Treat this batch as unverified and report it to a regulator.",
    expected: onChain,
    actual: computed,
  };
}

async function clusterReachable(): Promise<boolean> {
  try {
    const health = await getChainClient().health();
    return health.reachable;
  } catch {
    return false;
  }
}

async function finishUnavailable(
  productId: string,
  input: {
    requesterWallet?: string | null | undefined;
    requesterRole?: string | undefined;
    channel: RequestChannel;
    logEvent: boolean;
  },
  startedAt: number
): Promise<VerificationResultBody> {
  const stored = await ProductMetadataModel.findOne({ productId }).lean();
  return recordOutcome({
    productId,
    input,
    startedAt,
    chainReachable: false,
    result: "INCOMPLETE",
    stored,
    onChainHash: null,
    computedHash: null,
    mismatch: null,
    recordPresent: stored !== null,
  });
}

async function recordOutcome(params: {
  productId: string;
  input: {
    requesterWallet?: string | null | undefined;
    requesterRole?: string | undefined;
    channel: RequestChannel;
    logEvent: boolean;
  };
  startedAt: number;
  chainReachable: boolean;
  result: VerificationResult;
  stored: Record<string, unknown> | null;
  onChainHash: string | null;
  computedHash: string | null;
  mismatch: MismatchDetail | null;
  recordPresent: boolean;
  mediaProblems?: MediaIntegrityProblem[];
}): Promise<VerificationResultBody> {
  const durationMs = Date.now() - params.startedAt;
  const verificationId = newId();
  const requester = params.input.requesterWallet ?? "PUBLIC";

  const copy = headlineFor(params.result, params.mismatch !== null);

  if (params.input.logEvent) {
    try {
      await VerificationEventModel.create({
        verificationId,
        productId: params.productId,
        requestedByWallet: params.input.requesterWallet ?? null,
        requester,
        requesterRole: params.input.requesterRole ?? "PUBLIC",
        requestChannel: params.input.channel,
        verificationResult: params.result,
        calculatedHash: params.computedHash,
        onChainHash: params.onChainHash,
        storedHash:
          params.stored === null ? null : stringOr(params.stored["dataHash"]),
        mismatchDetails: params.mismatch,
        onChainTxHash:
          params.stored === null ? null : stringOr(params.stored["onChainTxHash"]),
        chainReachable: params.chainReachable,
        recordPresent: params.recordPresent,
        durationMs,
      });
    } catch (error) {
      log.error(
        { productId: params.productId, problem: String(error) },
        "could not record the verification event"
      );
    }
  }

  // The batch's `lastVerificationResult` is a cache of the most recent outcome,
  // not an audit count, so it follows every check. If the record has been
  // altered then every check reports a mismatch and the cache stays a mismatch;
  // a page load cannot paper over that, because a page load would only report
  // VERIFIED if the record genuinely matches.
  await ProductMetadataModel.updateOne(
    { productId: params.productId },
    {
      $set: {
        lastVerificationResult: params.result,
        lastVerifiedAt: new Date(),
      },
    }
  ).catch((error: unknown) => {
    log.error(
      { productId: params.productId, problem: String(error) },
      "could not update the batch's last verification result"
    );
  });

  return {
    result: params.result,
    productId: params.productId,
    headline: copy.headline,
    explanation: copy.explanation,
    chainReachable: params.chainReachable,
    recordPresent: params.recordPresent,
    dataHash: {
      onChain: params.onChainHash,
      stored: params.stored === null ? null : stringOr(params.stored["dataHash"]),
      computed: params.computedHash,
    },
    mismatch: params.mismatch,
    mediaProblems: params.mediaProblems ?? [],
    verificationId,
    verifiedAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Recomputes the digest of each stored file and compares it with the digest
 * recorded when the file was uploaded.
 *
 * The anchored registration hash covers the registration facts, not the file
 * contents, so this is a separate check: it is what makes a substituted
 * photograph or certificate detectable. The file is read once and hashed; no
 * bytes leave the server.
 */
async function checkMediaIntegrity(
  record: Pick<StoredProductLike, "images">
): Promise<MediaIntegrityProblem[]> {
  const problems: MediaIntegrityProblem[] = [];
  for (const image of record.images ?? []) {
    if (typeof image.contentHash !== "string" || image.contentHash.length === 0) continue;
    try {
      const stored = await readStoredMedia(image.mediaId);
      if (stored === null) {
        problems.push({
          mediaId: image.mediaId,
          fileName: `media ${image.mediaId}`,
          expected: image.contentHash,
          actual: "not found in storage",
        });
        continue;
      }
      const digest = sha256Hex(await collect(stored.stream));
      if (digest !== image.contentHash) {
        problems.push({
          mediaId: image.mediaId,
          fileName: stored.fileName,
          expected: image.contentHash,
          actual: digest,
        });
      }
    } catch {
      // A storage read failure is not evidence of tampering, so it is left out
      // of the result rather than being reported as a substitution.
    }
  }
  return problems;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array)
    );
  }
  return Buffer.concat(chunks);
}

function headlineFor(
  result: VerificationResult,
  hasMismatch: boolean
): { headline: string; explanation: string } {
  switch (result) {
    case "VERIFIED":
      return {
        headline: "This batch matches its blockchain record.",
        explanation:
          "Every stored detail still produces the same fingerprint that was anchored on the blockchain at registration. The history below is the record the supply chain has agreed on.",
      };
    case "MISMATCH":
      return {
        headline: "Warning: the stored details do not match the blockchain record.",
        explanation:
          "The information held for this batch has changed since it was registered. Treat the batch as unverified and report it to a regulator.",
      };
    case "NOT_FOUND":
      return {
        headline: "No batch is registered under this identifier.",
        explanation:
          "The blockchain has no record for this identifier. Check the identifier, or ask the supplier for a different one.",
      };
    case "INCOMPLETE":
    default:
      return {
        headline: "This batch could not be checked right now.",
        explanation:
          hasMismatch
            ? "Some of the information needed to check this batch is not available yet."
            : "Either the blockchain could not be reached, or this batch is still being registered. Try again shortly.",
      };
  }
}

/** Assembles the public view: provenance, certificates and verification history. */
export async function buildPublicView(
  stored: StoredProductLike,
  productId: string
): Promise<PublicProductView> {
  const [transfers, processingLogs, transportLogs, certificates, verifications, owner] =
    await Promise.all([
      TransferModel.find({ productId, status: "COMPLETED" })
        .sort({ confirmedAt: 1 })
        .lean(),
      ProcessingLogModel.find({ productId }).sort({ occurredAt: 1 }).lean(),
      TransportLogModel.find({ productId }).sort({ departedAt: 1 }).lean(),
      CertificateModel.find({ productId }).sort({ createdAt: 1 }).lean(),
      VerificationEventModel.find({ productId })
        .sort({ createdAt: -1 })
        .limit(25)
        .lean(),
      UserModel.findOne({ walletAddress: stored.ownerWallet })
        .select({ role: 1 })
        .lean(),
    ]);

  const events: ProvenanceEvent[] = [];
  let sequence = 0;
  const push = (event: Omit<ProvenanceEvent, "sequence">): void => {
    sequence += 1;
    events.push({ ...event, sequence });
  };

  if (stored.onChainRegisteredAt !== null) {
    push({
      kind: "REGISTERED",
      title: `Registered by ${stored.registrantRole.toLowerCase()}`,
      detail: `${stored.cropType}, ${stored.quantity} ${stored.unit}, harvested ${stored.harvestDate.toISOString().slice(0, 10)} at ${stored.farmLocation}.`,
      occurredAt: isoOrNull(stored.onChainRegisteredAt) ?? "not recorded",
      actorWallet: null,
      actorRole: stored.registrantRole,
      status: "REGISTERED",
      transactionSignature: strOrNull(stored.onChainTxHash),
      dataHash: strOrNull(stored.onChainDataHash),
      flagged: false,
    });
  }

  for (const transfer of transfers) {
    push({
      kind: "TRANSFER",
      title: `Ownership passed to a ${transfer.toRole.toLowerCase()}`,
      detail:
        transfer.note.length > 0
          ? transfer.note
          : `Ownership moved from ${transfer.fromWallet.slice(0, 6)}… to ${transfer.toWallet.slice(0, 6)}…`,
      occurredAt: (transfer.confirmedAt ?? transfer.createdAt).toISOString(),
      actorWallet: transfer.fromWallet,
      actorRole: transfer.fromRole,
      status: strOrNull(transfer.resultingStatus),
      transactionSignature: strOrNull(transfer.transactionSignature),
      dataHash: null,
      flagged: false,
    });
  }

  for (const entry of processingLogs) {
    push({
      kind: "PROCESSING",
      title: entry.activity,
      detail: entry.activityDescription,
      occurredAt: entry.occurredAt.toISOString(),
      actorWallet: entry.processorWallet,
      actorRole: "PROCESSOR",
      status: entry.statusAfter,
      transactionSignature: strOrNull(entry.onChainTxHash),
      dataHash: entry.dataHash,
      flagged: false,
    });
  }

  for (const entry of transportLogs) {
    push({
      kind: "TRANSPORT",
      title: `Carried from ${entry.origin} to ${entry.destination}`,
      detail:
        entry.routeDetails.length > 0
          ? entry.routeDetails
          : `Delivery status: ${entry.deliveryStatus.toLowerCase().replace(/_/g, " ")}.`,
      occurredAt: entry.departedAt.toISOString(),
      actorWallet: entry.transporterWallet,
      actorRole: "TRANSPORTER",
      status: entry.deliveryStatus,
      transactionSignature: strOrNull(entry.onChainTxHash),
      dataHash: entry.dataHash,
      flagged: false,
    });
  }

  if (stored.retail?.listed === true && stored.retail.listedAt instanceof Date) {
    push({
      kind: "RETAIL",
      title: "Listed for sale",
      detail:
        stored.retail.askingPrice !== null && stored.retail.askingPrice !== undefined
          ? `Listed at ${stored.retail.askingPrice} ${stored.retail.currency ?? "NGN"}.`
          : "Listed by the retailer.",
      occurredAt: stored.retail.listedAt.toISOString(),
      actorWallet: stored.ownerWallet,
      actorRole: "RETAILER",
      status: "LISTED",
      transactionSignature: null,
      dataHash: null,
      flagged: false,
    });
  }

  for (const entry of verifications.slice(0, 10)) {
    push({
      kind: "VERIFICATION",
      title: `Checked: ${entry.verificationResult.replace(/_/g, " ").toLowerCase()}`,
      detail:
        entry.requester === "PUBLIC"
          ? "Checked by a member of the public."
          : `Checked by a participant with the wallet ${entry.requester.slice(0, 6)}….`,
      occurredAt: entry.createdAt.toISOString(),
      actorWallet: entry.requester === "PUBLIC" ? null : entry.requester,
      actorRole: entry.requesterRole,
      status: null,
      transactionSignature: strOrNull(entry.onChainTxHash),
      dataHash: strOrNull(entry.calculatedHash),
      flagged: entry.verificationResult === "MISMATCH",
    });
  }

  events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  events.forEach((event, index) => {
    event.sequence = index + 1;
  });

  return {
    productId,
    cropType: stored.cropType,
    quantity: stored.quantity,
    unit: stored.unit,
    harvestDate: stored.harvestDate.toISOString(),
    origin: stored.farmLocation,
    description: stored.description,
    additionalNotes: stored.additionalNotes,
    status: stored.status,
    statusLabel: statusLabel(stored.status as ProductStatus),
    registeredAt:
      isoOrNull(stored.onChainRegisteredAt),
    currentOwnerCategory: owner?.role ?? null,
    registrantCategory: stored.registrantRole,
    dataHash: stored.onChainDataHash ?? stored.dataHash,
    onChainAddress: stored.onChainAddress ?? productAddressOrNull(productId),
    onChainTxHash: strOrNull(stored.onChainTxHash),
    onChainRegisteredAt:
      isoOrNull(stored.onChainRegisteredAt),
    images: (stored.images ?? []).map((image) => ({
      mediaId: image.mediaId,
      caption: image.caption ?? "",
    })),
    certificates: certificates.map((certificate) => ({
      certificateId: certificate.certificateId,
      issuingBody: certificate.issuingBody,
      certificateType: certificate.certificateType,
      referenceNumber: certificate.referenceNumber,
      issuedOn: isoOrNull(certificate.issuedOn),
      expiresOn: isoOrNull(certificate.expiresOn),
      dataHash: certificate.dataHash,
    })),
    provenance: events,
    verificationHistory: verifications.map((entry) => ({
      verificationId: entry.verificationId,
      result: entry.verificationResult as VerificationResult,
      requester: entry.requester,
      requestedAt: entry.createdAt.toISOString(),
    })),
    verificationCount: verifications.length,
    // A batch nobody has checked yet is honestly reported as unverified rather
    // than being given a passing or failing result it has not earned.
    lastVerificationResult: stored.lastVerificationResult,
  };
}

function productAddressOrNull(productId: string): string | null {
  try {
    return getProductAddress(getChainClient().programId, productId).toBase58();
  } catch {
    return null;
  }
}

/** A short, human summary used in notifications and reports. */
export function summariseVerification(result: VerificationResultBody): string {
  return `${result.productId}: ${result.result} (${result.durationMs} ms, chain ${
    result.chainReachable ? "reachable" : "unreachable"
  })`;
}
