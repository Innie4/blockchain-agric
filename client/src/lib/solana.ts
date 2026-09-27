/**
 * Solana cluster and explorer helpers.
 *
 * The client never needs to be a full RPC client of its own: the server owns
 * the endpoint and does the reading and the writing. What the client does need
 * is to know which cluster it is talking about, so it can build honest links to
 * the block explorer and refuse a wallet that is pointed at the wrong one.
 */

import { Connection } from "@solana/web3.js";

export const SOLANA_CLUSTERS = ["devnet", "testnet", "mainnet-beta", "localnet"] as const;
export type SolanaCluster = (typeof SOLANA_CLUSTERS)[number];

const DEFAULT_CLUSTER: SolanaCluster = "devnet";

function readCluster(): SolanaCluster {
  const configured = import.meta.env.VITE_SOLANA_NETWORK;
  if (typeof configured !== "string") return DEFAULT_CLUSTER;
  const normalised = configured.trim();
  return (SOLANA_CLUSTERS as readonly string[]).includes(normalised)
    ? (normalised as SolanaCluster)
    : DEFAULT_CLUSTER;
}

/** The cluster this build talks to. */
export const SOLANA_CLUSTER = readCluster();

/** How the cluster is named when shown to a participant. */
export const CLUSTER_LABEL: Record<SolanaCluster, string> = {
  devnet: "Solana Devnet",
  testnet: "Solana Testnet",
  "mainnet-beta": "Solana Mainnet",
  localnet: "a local Solana validator",
};

const EXPLORER_HOSTS: Record<SolanaCluster, string | null> = {
  devnet: "https://explorer.solana.com",
  testnet: "https://explorer.solana.com",
  "mainnet-beta": "https://explorer.solana.com",
  // A local validator has no public explorer, so linking would mislead.
  localnet: null,
};

const DEFAULT_RPC_ENDPOINTS: Record<SolanaCluster, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

/**
 * Genesis hashes are the cheapest honest way to prove a wallet and this
 * deployment are on the same cluster. A local validator's hash is chosen by
 * whoever started it, so it cannot be checked from here.
 */
const GENESIS_HASHES: Record<SolanaCluster, string | null> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  localnet: null,
};

function clusterQuery(): string {
  return SOLANA_CLUSTER === "mainnet-beta" ? "" : `?cluster=${SOLANA_CLUSTER}`;
}

/** A link to a confirmed transaction, or `null` when there is no explorer. */
export function explorerTxUrl(signature: string | null | undefined): string | null {
  if (signature === null || signature === undefined || signature.length === 0) return null;
  const host = EXPLORER_HOSTS[SOLANA_CLUSTER];
  if (host === null) return null;
  return `${host}/tx/${signature}${clusterQuery()}`;
}

/** A link to an on-chain account. */
export function explorerAddressUrl(address: string | null | undefined): string | null {
  if (address === null || address === undefined || address.length === 0) return null;
  const host = EXPLORER_HOSTS[SOLANA_CLUSTER];
  if (host === null) return null;
  return `${host}/address/${address}${clusterQuery()}`;
}

/** The public verification path for a batch, as printed on a label. */
/**
 * The configured on-chain program, read from the environment.
 *
 * The API reports the same value and the settings screen shows both, so a
 * participant can see which program they are signing for and a mismatch between
 * the two configurations is visible rather than silent.
 */
export function configuredProgramId(): string | null {
  const value = import.meta.env.VITE_SOLANA_PROGRAM_ID;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
export function verificationPath(productId: string): string {
  return `/verify/${encodeURIComponent(productId)}`;
}

/** The absolute public link for a batch, for use in a QR code. */
export function verificationUrl(productId: string): string {
  if (typeof window === "undefined" || typeof window.location === "undefined") {
    return verificationPath(productId);
  }
  return `${window.location.origin}${verificationPath(productId)}`;
}

/** The text encoded in a batch's QR code: a link anyone can scan. */
export function qrPayloadFor(productId: string): string {
  return verificationUrl(productId);
}

/** The RPC endpoint this build reads from. */
export function rpcEndpoint(): string {
  const configured = import.meta.env.VITE_SOLANA_RPC_URL;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }
  return DEFAULT_RPC_ENDPOINTS[SOLANA_CLUSTER];
}

let sharedConnection: Connection | null = null;

/** A lazily created read-only connection, used only to check the cluster. */
export function getRpcConnection(): Connection {
  if (sharedConnection === null || sharedConnection.rpcEndpoint !== rpcEndpoint()) {
    sharedConnection = new Connection(rpcEndpoint(), "confirmed");
  }
  return sharedConnection;
}

/** The genesis hash the connected wallet must be on. */
export function expectedGenesisHash(): string | null {
  return GENESIS_HASHES[SOLANA_CLUSTER];
}

/** The sentence shown when a wallet is pointed at the wrong cluster. */
export function wrongNetworkMessage(): string {
  return (
    `This deployment reads from ${CLUSTER_LABEL[SOLANA_CLUSTER]}, but the wallet is on a ` +
    `different Solana network. Switch the wallet to ${CLUSTER_LABEL[SOLANA_CLUSTER]} in its ` +
    "settings, then connect again. Nothing was signed and nothing was recorded."
  );
}

function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The request did not answer within ${milliseconds}ms.`));
    }, milliseconds);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Compares the wallet's network with this deployment's.
 *
 * Returns `true` when they match, and `false` only when a mismatch was actually
 * observed. An unreachable endpoint yields `true`, because refusing a connection
 * during a network outage would be worse than the problem it prevents.
 */
export async function walletIsOnExpectedCluster(): Promise<boolean> {
  const expected = expectedGenesisHash();
  if (expected === null) return true;
  try {
    const actual = await withTimeout(getRpcConnection().getGenesisHash(), 4000);
    return actual === expected;
  } catch {
    return true;
  }
}
