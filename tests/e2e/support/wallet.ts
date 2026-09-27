import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { Keypair, type PublicKey } from "@solana/web3.js";

/**
 * A Solana wallet for the tests, with no browser extension involved.
 *
 * WHAT IS REAL
 * - The keypair is a genuine Ed25519 keypair, generated in Node by
 *   `@solana/web3.js`'s own `Keypair.generate()`.
 * - `signMessage` returns a genuine detached Ed25519 signature over exactly the
 *   challenge bytes the API issued, produced by `tweetnacl` — the same library
 *   the API verifies with. A wrong signature here would make every
 *   authentication test fail with `AUTH_SIGNATURE_INVALID`, so it is not a
 *   stand-in for the real thing.
 * - `signTransaction` hands the bytes to the application's own
 *   `@solana/web3.js` `Transaction` instance, so the signature is a real
 *   signature over the real compiled message, and `verifySignatures()` on the
 *   server genuinely verifies it.
 *
 * WHAT IS SUBSTITUTED
 * - The provider object. The application reads `window.phantom.solana` and calls
 *   `connect`, `disconnect`, `signMessage`, `signTransaction` and `on`/`off`;
 *   this file implements exactly that surface and nothing more. It presents
 *   itself as Phantom because the interface has a fixed vocabulary of wallet
 *   names and would otherwise say "Solana wallet" throughout.
 * - `publicKey` is a small stand-in for a `PublicKey`. The application only ever
 *   calls `toBase58()` on it, so the base58 string is the real public key of the
 *   real keypair and the object merely carries it.
 *
 * The provider is installed with `page.addInitScript`, so it exists before any
 * application code runs — `WalletContext` detects a wallet on mount, and a stub
 * installed afterwards would arrive too late to be seen.
 */

/** The secret key as the 64 bytes `tweetnacl` expects: seed followed by public key. */
export interface TestWallet {
  readonly label: string;
  readonly address: string;
  /** 64 bytes: the 32-byte seed concatenated with the 32-byte public key. */
  readonly secretKey: readonly number[];
  readonly publicKey: readonly number[];
}

export interface WalletOptions {
  /**
   * Reject every `signTransaction` with an EIP-1193-style `4001`, which is what
   * a real extension does when the participant presses "Reject". Defaults to
   * false. Can also be switched at runtime through the control object below.
   */
  readonly rejectTransactions?: boolean;
  /** Reject `signMessage` as well, for testing a declined sign-in. */
  readonly rejectMessages?: boolean;
  /** Start the wallet already connected, as if a visitor had connected earlier. */
  readonly startConnected?: boolean;
}

/** What the stub leaves on `window` so a test can drive it mid-flow. */
interface WalletControlWindow {
  address(): string;
  rejectTransactions(reject: boolean): void;
  rejectMessages(reject: boolean): void;
  connected(): boolean;
}

let naclSourceCache: string | null = null;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `tweetnacl`'s browser bundle, read from the workspace so the page can sign
 * with the same implementation the API verifies with. It installs itself on
 * `self.nacl` when loaded as a plain script, which is why it is injected as
 * script content rather than as a function.
 */
function naclSource(): string {
  if (naclSourceCache !== null) return naclSourceCache;
  const file = resolve(HERE, "..", "..", "..", "node_modules", "tweetnacl", "nacl-fast.js");
  naclSourceCache = readFileSync(file, "utf8");
  return naclSourceCache;
}

/** Generates a wallet with a real keypair. */
export function createTestWallet(label: string): TestWallet {
  const keypair = Keypair.generate();
  return {
    label,
    address: keypair.publicKey.toBase58(),
    secretKey: [...keypair.secretKey],
    publicKey: [...keypair.publicKey.toBytes()],
  };
}

/**
 * Installs the stub on `window.phantom.solana`, `window.solana` and
 * `window.backpack.solana` before any application code runs.
 */
export async function installTestWallet(
  page: Page,
  wallet: TestWallet,
  options: WalletOptions = {}
): Promise<void> {
  await page.addInitScript({ content: naclSource() });

  await page.addInitScript(
    (settings: {
      address: string;
      secretKey: number[];
      publicKey: number[];
      rejectTransactions: boolean;
      rejectMessages: boolean;
      startConnected: boolean;
    }) => {
      const secretKey = new Uint8Array(settings.secretKey);
      const publicKeyBytes = new Uint8Array(settings.publicKey);
      let rejectTransactions = settings.rejectTransactions;
      let rejectMessages = settings.rejectMessages;
      let connected = false;

      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

      function emit(event: string, ...args: unknown[]): void {
        for (const handler of listeners.get(event) ?? []) {
          handler(...args);
        }
      }

      /** The refusal a real extension raises when the participant says no. */
      function declined(): Error {
        const error = new Error("User rejected the request.") as Error & { code: number };
        error.code = 4001;
        return error;
      }

      function asBytes(value: Uint8Array | ArrayBuffer | number[] | string): Uint8Array {
        if (value instanceof Uint8Array) return value;
        if (typeof value === "string") return new TextEncoder().encode(value);
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        return Uint8Array.from(value);
      }

      /**
       * The stand-in for `@solana/web3.js`'s `PublicKey`. The application calls
       * `toBase58()` and nothing else, so that is all this offers, and the
       * string it returns is the real public key of the real keypair.
       */
      const publicKeyHandle = {
        toBase58: () => settings.address,
        toString: () => settings.address,
        equals: (other: { toBase58?: () => string } | null) =>
          other !== null && other !== undefined && other.toBase58?.() === settings.address,
        toBytes: () => publicKeyBytes,
      };

      const provider = {
        isPhantom: true,
        name: "Phantom",
        publicKey: settings.startConnected ? publicKeyHandle : null,
        connected: settings.startConnected,

        connect: async () => {
          connected = true;
          provider.connected = true;
          provider.publicKey = publicKeyHandle;
          emit("connect", publicKeyHandle);
          return publicKeyHandle;
        },

        disconnect: async () => {
          connected = false;
          provider.connected = false;
          provider.publicKey = null;
          emit("disconnect");
        },

        signMessage: async (message: Uint8Array): Promise<Uint8Array> => {
          if (rejectMessages) throw declined();
          const nacl = (self as unknown as {
            nacl: { sign: { detached(msg: Uint8Array, key: Uint8Array): Uint8Array } };
          }).nacl;
          return nacl.sign.detached(asBytes(message), secretKey);
        },

        signTransaction: async <T>(transaction: T): Promise<T> => {
          if (rejectTransactions) throw declined();
          // The application's own `Transaction` does the cryptography, so the
          // signature covers exactly the message a real wallet would cover.
          const signable = transaction as {
            feePayer: PublicKey;
            partialSign(signer: { publicKey: PublicKey; secretKey: Uint8Array }): void;
          };
          signable.partialSign({
            publicKey: signable.feePayer,
            secretKey,
          });
          return transaction;
        },

        signAllTransactions: async <T>(transactions: T[]): Promise<T[]> => {
          const signed: T[] = [];
          for (const transaction of transactions) {
            signed.push(await provider.signTransaction(transaction));
          }
          return signed;
        },

        on: (event: string, handler: (...args: unknown[]) => void) => {
          const existing = listeners.get(event) ?? [];
          existing.push(handler);
          listeners.set(event, existing);
        },

        off: (event: string, handler: (...args: unknown[]) => void) => {
          const existing = listeners.get(event) ?? [];
          listeners.set(
            event,
            existing.filter((candidate) => candidate !== handler),
          );
        },
      };

      const control: WalletControlWindow = {
        address: () => settings.address,
        rejectTransactions: (reject: boolean) => {
          rejectTransactions = reject;
        },
        rejectMessages: (reject: boolean) => {
          rejectMessages = reject;
        },
        connected: () => connected,
      };

      const globalScope = window as unknown as Record<string, unknown>;
      globalScope["__e2eWallet"] = control;
      globalScope["phantom"] = { solana: provider };
      globalScope["solana"] = provider;
      globalScope["backpack"] = { solana: provider };
    },
    {
      address: wallet.address,
      secretKey: [...wallet.secretKey],
      publicKey: [...wallet.publicKey],
      rejectTransactions: options.rejectTransactions ?? false,
      rejectMessages: options.rejectMessages ?? false,
      startConnected: options.startConnected ?? false,
    }
  );
}

/** Switches transaction signing on or off mid-flow, to model a participant declining. */
export async function setTransactionRejection(page: Page, reject: boolean): Promise<void> {
  await page.evaluate((value: boolean) => {
    const control = (window as unknown as { __e2eWallet?: WalletControlWindow }).__e2eWallet;
    if (control === undefined) {
      throw new Error("No test wallet is installed in this page.");
    }
    control.rejectTransactions(value);
  }, reject);
}

/** Switches message signing on or off mid-flow, to model a declined sign-in. */
export async function setMessageRejection(page: Page, reject: boolean): Promise<void> {
  await page.evaluate((value: boolean) => {
    const control = (window as unknown as { __e2eWallet?: WalletControlWindow }).__e2eWallet;
    if (control === undefined) {
      throw new Error("No test wallet is installed in this page.");
    }
    control.rejectMessages(value);
  }, reject);
}

/** The address the installed wallet reports, read back out of the page. */
export async function readWalletAddress(page: Page): Promise<string> {
  return page.evaluate(() => {
    const control = (window as unknown as { __e2eWallet?: WalletControlWindow }).__e2eWallet;
    if (control === undefined) {
      throw new Error("No test wallet is installed in this page.");
    }
    return control.address();
  });
}
