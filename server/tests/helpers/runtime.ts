import type { Application } from "express";
import { getEnvironment } from "./environment.js";
import type { InMemoryChainClient } from "./inMemoryChain.js";
import { resetDatabase } from "./environment.js";

/**
 * Accessors for the shared environment started by `tests/globalSetup.ts`.
 * Reading them lazily means an import order problem shows up as a clear error
 * rather than an undefined app.
 */
export function api(): Application {
  return getEnvironment().app;
}

export function testChain(): InMemoryChainClient {
  return getEnvironment().chain;
}

/** Clears every collection and returns the chain to a known-good state. */
export async function freshState(): Promise<void> {
  await resetDatabase();
  const chain = testChain();
  chain.reachable = true;
  chain.failNextSend = null;
  chain.neverConfirms = false;
  chain.submitted.length = 0;
  chain.submitters.length = 0;
  for (const productId of [...chain.ledger.keys()]) {
    chain.ledger.delete(productId);
  }
}
