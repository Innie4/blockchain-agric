import type { ChainClient } from "./chainClient.js";
import { Web3ChainClient } from "./web3ChainClient.js";

/**
 * Single place the application's Solana client is resolved.
 *
 * Production always resolves `Web3ChainClient`, which performs real RPC calls.
 * The indirection exists so a test suite can install a client that implements
 * the same interface against an in-process ledger; no code path in `src/`
 * substitutes canned chain responses.
 */
let client: ChainClient | null = null;

export function getChainClient(): ChainClient {
  if (client === null) {
    client = new Web3ChainClient();
  }
  return client;
}

/** Installs a client explicitly. Used by the test harness only. */
export function setChainClient(next: ChainClient | null): void {
  client = next;
}

export type { ChainClient };
