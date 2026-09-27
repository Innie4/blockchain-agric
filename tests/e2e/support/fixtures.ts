import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { INFRA_CONTROL_ORIGIN, MOCK_RPC_ORIGIN } from "./constants";
import {
  closeDatabase,
  resetDatabase,
  runtimeEnvironment,
  type E2eRuntimeEnvironment,
} from "./database";
import { becomeParticipant, type ParticipantProfile } from "./actors";
import type { MockLedgerSnapshot } from "./mockRpc";
import { createTestWallet, type TestWallet } from "./wallet";

/**
 * The fixtures every flow in this suite uses.
 *
 * Between each test the suite clears two things, because there are two
 * independent stores: the MongoDB collections (over a direct connection this
 * process opens itself) and the mock Solana ledger (over the infrastructure
 * process's control route). Neither is done through the API, so the application
 * needs no reset endpoint in any environment.
 *
 * The reset is a `beforeEach` hook rather than a fixture on purpose. Playwright
 * runs hooks before it resolves a test's own fixtures, so the store is always
 * empty before a participant is set up, whatever order a spec asks for things
 * in.
 *
 * `openAs` gives each participant in a flow their own browser context, because a
 * session cookie belongs to one context and a transfer is performed by one
 * wallet. Each context gets its own freshly generated keypair, so no two actors
 * in a flow can be mistaken for one another.
 */

export type LedgerSnapshot = MockLedgerSnapshot;

export interface ParticipantSession {
  readonly profile: ParticipantProfile;
  readonly wallet: TestWallet;
  readonly context: BrowserContext;
  readonly page: Page;
  /** Closes the context. Call it when a spec is finished with the participant. */
  close(): Promise<void>;
}

export interface OpenParticipantOptions {
  /**
   * Reject every transaction signature from the start, as a participant who
   * always presses "Reject" in their wallet would.
   */
  readonly rejectTransactions?: boolean;
}

export interface E2EFixtures {
  /** The configuration the infrastructure process published. */
  runtime: E2eRuntimeEnvironment;
  /** A read-only view of the mock Solana ledger, for setup assertions. */
  ledger(): Promise<LedgerSnapshot>;
  /** A keypair that is not attached to any browser context. */
  newWallet(label: string): TestWallet;
  /**
   * Opens a signed-in, on-chain registered participant in their own browser
   * context: a fresh keypair, a real sign-in signature and a real on-chain
   * registration.
   */
  openAs(profile: ParticipantProfile, options?: OpenParticipantOptions): Promise<ParticipantSession>;
  /** As above, but with a keypair the test supplies. */
  openAsWith(
    wallet: TestWallet,
    profile: ParticipantProfile,
    options?: OpenParticipantOptions
  ): Promise<ParticipantSession>;
}

export const test = base.extend<E2EFixtures>({
  runtime: async ({}, use) => {
    await use(runtimeEnvironment());
  },

  ledger: async ({}, use) => {
    await use(async () => {
      const response = await fetch(`${INFRA_CONTROL_ORIGIN}/rpc/snapshot`);
      if (!response.ok) {
        throw new Error(
          `The mock Solana ledger could not be read (HTTP ${response.status}). ` +
            `The infrastructure process should be answering on ${INFRA_CONTROL_ORIGIN}, ` +
            `with the mock cluster itself on ${MOCK_RPC_ORIGIN}.`,
        );
      }
      return (await response.json()) as LedgerSnapshot;
    });
  },

  newWallet: async ({}, use) => {
    await use((label: string) => createTestWallet(label));
  },

  openAs: async ({ browser }, use) => {
    await use(async (profile: ParticipantProfile, options: OpenParticipantOptions = {}) => {
      const wallet = createTestWallet(`${profile.role} (generated)`);
      return openSession(browser, wallet, profile, options);
    });
  },

  openAsWith: async ({ browser }, use) => {
    await use(
      async (
        wallet: TestWallet,
        profile: ParticipantProfile,
        options: OpenParticipantOptions = {}
      ) => openSession(browser, wallet, profile, options)
    );
  },
});

async function openSession(
  browser: Browser,
  wallet: TestWallet,
  profile: ParticipantProfile,
  options: OpenParticipantOptions
): Promise<ParticipantSession> {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await becomeParticipant(page, wallet, profile, options);
  } catch (error) {
    await context.close();
    throw error;
  }
  return {
    profile,
    wallet,
    context,
    page,
    close: async () => {
      await context.close();
    },
  };
}

/** Empties the database and the mock ledger. Runs before every test. */
export async function resetAllState(): Promise<void> {
  const response = await fetch(`${INFRA_CONTROL_ORIGIN}/rpc/reset`, { method: "POST" });
  if (!response.ok) {
    throw new Error(
      `The mock Solana ledger could not be cleared (HTTP ${response.status}). ` +
        "The infrastructure process must be running; it is the first entry in the `webServer` array.",
    );
  }
  await resetDatabase();
}

test.beforeEach(async () => {
  await resetAllState();
});

test.afterAll(async () => {
  await closeDatabase();
});

export { expect };
