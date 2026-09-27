import { createHash } from "node:crypto";
import type {
  PublicKey} from "@solana/web3.js";
import {
  Connection,
  Transaction,
  type Commitment,
  type SignatureStatus,
} from "@solana/web3.js";
import { env } from "../../config/env.js";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { childLogger } from "../../lib/logger.js";
import { toPublicKey } from "../../lib/crypto.js";
import {
  PARTICIPANT_ACCOUNT_SIZE,
  PRODUCT_ACCOUNT_SIZE,
  decodeParticipantAccount,
  decodeProductAccount,
  hasProgramDiscriminator,
} from "./layout.js";
import { parseProgramEvents } from "./events.js";
import { getParticipantAddress, getProductAddress } from "./pda.js";
import { normaliseBlockchainError } from "./errorMapping.js";
import type {
  BuildTransactionInput,
  BuiltTransaction,
  ChainClient,
  ChainHealth,
  ProgramEvent,
  SendResult,
  SubmittedTransaction,
} from "./chainClient.js";

const log = childLogger({ layer: "solana" });

type ChainCommitment = "processed" | "confirmed" | "finalized";
type PrefetchLevel = ChainCommitment | "none";

export interface Web3ChainClientOptions {
  rpcUrl?: string;
  wsUrl?: string;
  programId?: string;
  commitment?: ChainCommitment;
}

const CONFIRMATION_RANK: Record<string, number> = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

/**
 * `getSignatureStatuses` reports only finality levels, so a configuration that
 * accepts `processed` is polled at `confirmed` and filtered locally.
 */
const FINALITY: Record<ChainCommitment, "confirmed" | "finalized"> = {
  processed: "confirmed",
  confirmed: "confirmed",
  finalized: "finalized",
};

const PREFETCH_COMMITMENT: Record<PrefetchLevel, Commitment> = {
  none: "processed",
  processed: "processed",
  confirmed: "confirmed",
  finalized: "finalized",
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Anchor derives an account discriminator from `sha256("account:<Name>")`. */
function accountDiscriminator(structName: string): Buffer {
  return createHash("sha256")
    .update(`account:${structName}`, "utf8")
    .digest()
    .subarray(0, 8);
}

const PRODUCT_DISCRIMINATOR = accountDiscriminator("ProductAccount");
const PARTICIPANT_DISCRIMINATOR = accountDiscriminator("ParticipantAccount");

/**
 * The production Solana client. Every method performs a real RPC call: there is
 * no cache that could answer on the cluster's behalf and no code path that
 * returns a synthesised account.
 */
export class Web3ChainClient implements ChainClient {
  readonly programId: PublicKey;
  readonly network: string;
  readonly commitment: ChainCommitment;
  readonly connection: Connection;

  constructor(connection?: Connection, options: Web3ChainClientOptions = {}) {
    this.programId = toPublicKey(
      options.programId ?? env.SOLANA_PROGRAM_ID,
      "SOLANA_PROGRAM_ID"
    );
    this.network = env.SOLANA_NETWORK;
    this.commitment = options.commitment ?? env.SOLANA_COMMITMENT;
    this.connection =
      connection ??
      new Connection(options.rpcUrl ?? env.SOLANA_RPC_URL, {
        commitment: this.commitment,
        wsEndpoint: options.wsUrl ?? env.SOLANA_WS_URL,
        confirmTransactionInitialTimeout: env.SOLANA_TX_TIMEOUT_MS,
        disableRetryOnRateLimit: false,
      });
  }

  async health(): Promise<ChainHealth> {
    try {
      const slot = await this.connection.getSlot(FINALITY[this.commitment]);
      return { reachable: true, slot, commitment: this.commitment };
    } catch (error) {
      const normalised = normaliseBlockchainError(error, "cluster health check");
      log.warn({ problem: normalised.message }, "solana health check failed");
      return {
        reachable: false,
        slot: null,
        commitment: this.commitment,
        problem: normalised.message,
      };
    }
  }

  async fetchProduct(productId: string) {
    const address = getProductAddress(this.programId, productId);
    const info = await this.connection.getAccountInfo(address, this.commitment);
    if (info === null) return null;
    if (!hasProgramDiscriminator(info.data, PRODUCT_DISCRIMINATOR)) {
      throw new AppError(ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED, {
        message:
          "An account exists at the address derived from this identifier but it was not written by the supply chain program. Treat this identifier as unverified.",
        details: { productAddress: address.toBase58() },
      });
    }
    const decoded = decodeProductAccount(info.data, address.toBase58());
    if (decoded.productId !== productId) {
      throw new AppError(ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED, {
        message:
          "The on-chain record stored under this address carries a different product identifier. Treat this identifier as unverified.",
        details: {
          requestedProductId: productId,
          onChainProductId: decoded.productId,
        },
      });
    }
    return decoded;
  }

  async fetchParticipant(wallet: PublicKey) {
    const address = getParticipantAddress(this.programId, wallet);
    const info = await this.connection.getAccountInfo(address, this.commitment);
    if (info === null) return null;
    if (!hasProgramDiscriminator(info.data, PARTICIPANT_DISCRIMINATOR)) return null;
    const decoded = decodeParticipantAccount(info.data);
    if (decoded.participant !== wallet.toBase58()) return null;
    return decoded;
  }

  async buildTransaction(input: BuildTransactionInput): Promise<BuiltTransaction> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash(this.commitment);
    const transaction = new Transaction({
      feePayer: input.feePayer,
      blockhash,
      lastValidBlockHeight,
    });
    for (const instruction of input.instructions) {
      transaction.add(instruction);
    }
    const base64 = transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
    return { transaction, base64, blockhash, lastValidBlockHeight };
  }

  async sendSignedTransaction(
    signedBase64: string,
    description: string
  ): Promise<SendResult> {
    const raw = decodeBase64(signedBase64);
    if (raw.length === 0 || raw.length > 1232) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
        message:
          "The signed transaction has an unexpected size. Sign the transaction again and resubmit.",
        details: [{ path: "signedTransaction", message: "Unexpected size." }],
      });
    }
    try {
      const signature = await this.connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: PREFETCH_COMMITMENT[env.SOLANA_PREFETCH_COMMITMENT],
        maxRetries: env.SOLANA_RETRY_ATTEMPTS,
      });
      log.info({ signature, description }, "submitted signed transaction");
      return { signature };
    } catch (error) {
      throw normaliseBlockchainError(error, description);
    }
  }

  /**
   * Polls the signature's status until it reaches the configured commitment,
   * fails on-chain, or the configured timeout elapses. Confirmation is never
   * assumed from a successful submission.
   */
  async confirmTransaction(signature: string): Promise<SubmittedTransaction> {
    const required = CONFIRMATION_RANK[this.commitment] ?? 1;
    const deadline = Date.now() + env.SOLANA_TX_TIMEOUT_MS;
    let lastSeen: SignatureStatus | null = null;

    while (Date.now() < deadline) {
      try {
        const { value } = await this.connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        const status = value[0] ?? null;
        if (status !== null) {
          lastSeen = status;
          const rank = CONFIRMATION_RANK[status.confirmationStatus ?? "processed"] ?? 0;
          if (status.err !== null) {
            return {
              signature,
              slot: status.slot,
              err: status.err,
              logs: await this.logsFor(signature),
            };
          }
          if (rank >= required) {
            log.info(
              { signature, slot: status.slot, confirmationStatus: status.confirmationStatus },
              "transaction confirmed"
            );
            return {
              signature,
              slot: status.slot,
              err: null,
              logs: await this.logsFor(signature),
            };
          }
        }
      } catch (error) {
        const normalised = normaliseBlockchainError(error, "polling transaction status");
        if (normalised.code === ERROR_CODES.BLOCKCHAIN_RPC_UNAVAILABLE) {
          throw normalised;
        }
        log.debug({ problem: normalised.message }, "status poll failed; retrying");
      }
      await sleep(600);
    }

    log.error(
      { signature, lastSeenSlot: lastSeen?.slot ?? null },
      "transaction did not confirm before the timeout"
    );
    throw new AppError(ERROR_CODES.BLOCKCHAIN_CONFIRMATION_TIMEOUT, {
      details: {
        signature,
        lastObservedSlot: lastSeen?.slot ?? null,
        observedStatus: lastSeen?.confirmationStatus ?? null,
      },
    });
  }

  async fetchTransactionEvents(signature: string): Promise<ProgramEvent[]> {
    const parsed = await this.connection.getParsedTransaction(signature, {
      commitment: FINALITY[this.commitment],
      maxSupportedTransactionVersion: 0,
    });
    if (parsed === null) return [];
    return parseProgramEvents(parsed.meta?.logMessages ?? [], signature, parsed.slot);
  }

  async fetchSignaturesForAddress(
    address: PublicKey,
    limit: number
  ): Promise<string[]> {
    const signatures = await this.connection.getSignaturesForAddress(address, {
      limit,
    });
    return signatures.map((entry) => entry.signature);
  }

  async clusterTime(): Promise<number> {
    const slot = await this.connection.getSlot(FINALITY[this.commitment]);
    const blockTime = await this.connection.getBlockTime(slot);
    return blockTime ?? Math.floor(Date.now() / 1000);
  }

  participantAddressFor(wallet: PublicKey): PublicKey {
    return getParticipantAddress(this.programId, wallet);
  }

  productAddressFor(productId: string): PublicKey {
    return getProductAddress(this.programId, productId);
  }

  /** Rent the cluster requires to open each account, for pre-flight estimates. */
  async rentForProductAccount(): Promise<number> {
    return this.connection.getMinimumBalanceForRentExemption(PRODUCT_ACCOUNT_SIZE);
  }

  async rentForParticipantAccount(): Promise<number> {
    return this.connection.getMinimumBalanceForRentExemption(PARTICIPANT_ACCOUNT_SIZE);
  }

  private async logsFor(signature: string): Promise<string[]> {
    try {
      const parsed = await this.connection.getParsedTransaction(signature, {
        commitment: FINALITY[this.commitment],
        maxSupportedTransactionVersion: 0,
      });
      return parsed?.meta?.logMessages ?? [];
    } catch (error) {
      log.warn(
        { signature, problem: String(error) },
        "could not read transaction logs"
      );
      return [];
    }
  }
}

function decodeBase64(value: string): Buffer {
  const cleaned = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message:
        "The signed transaction could not be read. Sign the transaction again and resubmit.",
      details: [{ path: "signedTransaction", message: "Not valid base64." }],
    });
  }
  return Buffer.from(cleaned, "base64");
}
