/* eslint-disable react-refresh/only-export-components -- A test harness is a
   library of helpers, not a component module, so fast refresh has nothing to
   preserve here. */
import { Connection, Keypair, PublicKey, Transaction, type VersionedTransaction } from "@solana/web3.js";
import { configure } from "@testing-library/dom";
import { render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  MemoryRouter,
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router-dom";
import { vi, type MockInstance } from "vitest";
import { api, type HttpMethod, type RequestOptions } from "../api/client";
import { AuthProvider } from "../context/AuthContext";
import { ToastProvider } from "../context/ToastContext";
import { WalletProvider, type StandardWallet } from "../context/WalletContext";
import { expectedGenesisHash } from "../lib/solana";
import { router as realRouter } from "../routes/router";
import type {
  ChainState,
  Prepared,
  Product,
  ProductRegistrationAccepted,
  ProductRegistrationConfirmed,
  PublicProduct,
  PublicCertificateSummary,
  ProvenanceEvent,
  Verification,
  VerificationResponse,
} from "../api/types";

/**
 * Every page here is code-split, so a `findBy*` on a lazy route has to allow for
 * a module load. The default one-second budget is enough on an idle machine and
 * not enough when six files are being transformed in parallel, which makes the
 * suite fail for reasons that have nothing to do with the code under test.
 */
configure({ asyncUtilTimeout: 5_000 });

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

/* ------------------------------------------------------------------ *
 * Deterministic values
 *
 * Every key below is derived from a repeated byte pattern, so a failure
 * reproduces exactly rather than drifting with a random keypair.
 * ------------------------------------------------------------------ */

export const FARMER_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
export const FARMER_WALLET = FARMER_KEYPAIR.publicKey;




export const BATCH_ID = "AGT-COCOA-2026-A1B2C3";
export const OTHER_BATCH_ID = "AGT-MAIZE-2026-D4E5F6";
export const SIGNATURE = "4Jt3Zq8nQQwvKc9mVx7bH2sYtR5uAeL6dGf0hIjKmNoP";

export const DATA_HASH = "a".repeat(64);
export const OTHER_DATA_HASH = "b".repeat(64);
export const THIRD_DATA_HASH = "c".repeat(64);
const ON_CHAIN_ADDRESS = new PublicKey(new Uint8Array(32).fill(11));
const BLOCKHASH = "2iXtA8oeZqUU5pofxK971TCEvFGfems2AcDRaZHKD2pQ";

/**
 * A real, signed, legacy Solana transaction, base64 encoded exactly as the
 * server sends it in `Prepared.transaction`.
 *
 * Wire layout: 1 required signature, 0 readonly signers, 0 readonly unsigned
 * accounts, a 32-byte blockhash, one instruction (program index 0, two
 * accounts, a 12-byte System transfer body) and one 65-byte signature slot.
 * It is signed by `FARMER_KEYPAIR`, whose public key is the fee payer, so the
 * fake wallet can sign it again exactly as a real extension would and the
 * client can then re-serialise it. `deserializeTransaction` in `WalletContext`
 * parses this same bytes, so the tests exercise the real parse.
 */
const PREPARED_TRANSACTION_BASE64 =
  "AffEXXkP/NFhyCe68HSqAhaOuud6pgxkCbHPbGeaER55S91/f5RI0AhFC1PoqBU+dYOXWfVojkye+MHzWdHImwQBAAED6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iz9FyQ4WqDHW2T7eM1gL6HZkf3r92sTxY7XAurINen2GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGX9rI+FshTLGq8g4+s1ep4m+DHaykgM0A5v6iz02jWEBAgIAAQwCAAAAgE8SAAAAAAA=";

/* ------------------------------------------------------------------ *
 * Browser state
 * ------------------------------------------------------------------ */

interface SolanaWindow {
  phantom?: unknown;
  solana?: unknown;
  backpack?: unknown;
  solflare?: unknown;
}

function walletWindow(): SolanaWindow {
  return window as unknown as SolanaWindow;
}

/**
 * Clears every injected wallet and every piece of stored state, so a test can
 * never see a wallet or a session another test left behind.
 */
export function resetBrowserState(): void {
  const target = walletWindow();
  delete target.phantom;
  delete target.solana;
  delete target.backpack;
  delete target.solflare;
  window.localStorage.clear();
  window.sessionStorage.clear();
}

/**
 * Makes `instanceof Uint8Array` mean one thing inside a test.
 *
 * Vitest's jsdom environment installs jsdom's `Uint8Array` on the test global,
 * while Node's `buffer` and `bs58` produce typed arrays from their own realm.
 * `@solana/buffer-layout` checks exactly that relationship, so Solana
 * transaction serialisation throws "b must be a Uint8Array" under jsdom unless
 * the two are the same realm. Pointing the global at Node's own typed array
 * makes the two agree; it is an environment repair, not a relaxation.
 */
export function useNodeTypedArrayRealm(): void {
  const NodeUint8Array = Object.getPrototypeOf(
    (globalThis as unknown as { Buffer: { prototype: object } }).Buffer.prototype,
  ).constructor as Uint8ArrayConstructor;
  const original = Object.getOwnPropertyDescriptor(globalThis, "Uint8Array");
  Object.defineProperty(globalThis, "Uint8Array", {
    configurable: true,
    writable: true,
    value: NodeUint8Array,
  });
  if (original === undefined) return;
  restoreTypedArrayRealm = () => {
    Object.defineProperty(globalThis, "Uint8Array", original);
    restoreTypedArrayRealm = () => undefined;
  };
}

let restoreTypedArrayRealm: () => void = () => undefined;

export function restoreGlobalTypedArrayRealm(): void {
  restoreTypedArrayRealm();
}

/**
 * jsdom implements no layout, so `HTMLElement.offsetParent` is always `null`.
 * `Modal` uses it to decide which controls are inside the dialog, so the focus
 * trap would silently degrade to "nothing is focusable". Reporting a connected
 * element as having an offset parent is what a browser does, and it is the only
 * environment gap between jsdom and a real dialog.
 */
export function useVisibleLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected ? document.body : null;
    },
  });
}

export function restoreLayout(): void {
  Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
}

/* ------------------------------------------------------------------ *
 * The Request React Router builds for itself
 * ------------------------------------------------------------------ */

/**
 * Stands in for `Request`, which React Router constructs for every navigation.
 *
 * In this environment `Request` is Node's undici implementation, and undici
 * checks that the abort signal it is handed is one of its *own* `AbortSignal`s.
 * The global `AbortController` is jsdom's, so every navigation throws before a
 * single assertion runs, as an unhandled rejection inside React Router.
 * React Router only reads `url`, `method` and `signal` off the object it builds,
 * and no route in this application declares a loader or an action, so a
 * stand-in carrying those fields behaves identically.
 */
class RouterRequestStandIn {
  readonly url: string;
  readonly method: string;
  readonly signal: AbortSignal | null;

  constructor(input: string, init: RequestInit = {}) {
    this.url = input;
    this.method = init.method ?? "GET";
    this.signal = init.signal ?? null;
  }
}

let restoreRequest: () => void = () => undefined;

export function useRouterRequestStandIn(): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Request");
  Object.defineProperty(globalThis, "Request", {
    configurable: true,
    writable: true,
    value: RouterRequestStandIn,
  });
  if (original === undefined) return;
  restoreRequest = () => {
    Object.defineProperty(globalThis, "Request", original);
    restoreRequest = () => undefined;
  };
}

export function restoreRouterRequest(): void {
  restoreRequest();
}

/* ------------------------------------------------------------------ *
 * The injected wallet
 * ------------------------------------------------------------------ */

type ConnectSpy = MockInstance<() => Promise<PublicKey | void>>;
type DisconnectSpy = MockInstance<() => Promise<void>>;
type SignMessageSpy = MockInstance<
  (message: Uint8Array, display?: string) => Promise<Uint8Array | string>
>;
type SignTransactionSpy = MockInstance<(transaction: Transaction) => Promise<Transaction>>;

export interface FakeWallet {
  readonly provider: StandardWallet;
  readonly connect: ConnectSpy;
  readonly disconnect: DisconnectSpy;
  readonly signMessage: SignMessageSpy;
  readonly signTransaction: SignTransactionSpy;
  /** The address the wallet reports, mutated by `connect` in the default fake. */
  setPublicKey(key: PublicKey | null): void;
  setConnected(connected: boolean): void;
}

export interface FakeWalletOptions {
  /**
   * Which vendor flag the fake sets, which is what names it in the interface.
   * `none` sets no flag and no `name`, so the injection path's fallback name is
   * the only label available.
   */
  name?: "phantom" | "backpack" | "solflare" | "custom" | "none";
  customName?: string;
  /** The address the wallet already reports, if it is already connected. */
  address?: PublicKey;
  /** Start already connected, as a browser that has approved before would. */
  connected?: boolean;
  /** Start with an address but not flagged as connected, as a fresh load looks. */
  exposesAddress?: boolean;
}

/** `VersionedTransaction` has no `instanceof`, so the shape decides. */
function isLegacyTransaction(
  value: Transaction | VersionedTransaction,
): value is Transaction {
  return value instanceof Transaction;
}

function buildFakeWallet(options: FakeWalletOptions): FakeWallet {
  const address = options.address ?? FARMER_WALLET;
  let publicKey: PublicKey | null = options.exposesAddress === true ? address : null;

  const connect = vi.fn<() => Promise<PublicKey | void>>(async () => {
    publicKey = address;
    return address;
  });
  const disconnect = vi.fn<() => Promise<void>>(async () => {
    publicKey = null;
  });
  const signMessage = vi.fn<(message: Uint8Array, display?: string) => Promise<Uint8Array | string>>(
    async () => new Uint8Array(64).fill(9),
  );
  // A real extension signs the transaction in place and returns it, which is
  // what lets the client re-serialise it. The signature is genuine, so
  // `Transaction.serialize()` with its default verification succeeds.
  const signTransaction = vi.fn<(transaction: Transaction) => Promise<Transaction>>(
    async (transaction) => {
      transaction.sign(address === FARMER_WALLET ? FARMER_KEYPAIR : Keypair.generate());
      return transaction;
    },
  );

  const provider: StandardWallet = {
    ...(options.name === "phantom" ? { isPhantom: true } : {}),
    ...(options.name === "backpack" ? { isBackpack: true } : {}),
    ...(options.name === "solflare" ? { isSolflare: true } : {}),
    ...(options.name === "custom" ? { name: options.customName ?? "Test Wallet" } : {}),
    connected: options.connected === true,
    connect,
    disconnect,
    signMessage,
    // The guard proves the value is a `Transaction`. The application only ever
    // signs what its own `deserializeTransaction` produced, which is one, so
    // the cast re-states that guarantee rather than adding a new assumption.
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      transaction: T,
    ): Promise<T | void> => {
      if (!isLegacyTransaction(transaction)) {
        throw new Error("This test wallet only signs legacy transactions.");
      }
      return (await signTransaction(transaction)) as T;
    },
  };

  // The context reads `publicKey` on every render and after every connect, so
  // the getter is what keeps the context in step with the fake.
  Object.defineProperty(provider, "publicKey", {
    configurable: true,
    enumerable: true,
    get: () => publicKey,
  });

  return {
    provider,
    connect,
    disconnect,
    signMessage,
    signTransaction,
    setPublicKey(key) {
      publicKey = key;
    },
    setConnected(connected) {
      provider.connected = connected;
    },
  };
}

/** Injects a fake wallet at `window.phantom.solana`, the first path checked. */
export function installFakeWallet(options: FakeWalletOptions = {}): FakeWallet {
  const wallet = buildFakeWallet(options);
  walletWindow().phantom = { solana: wallet.provider };
  return wallet;
}

/** Injects a fake wallet at the bare `window.solana` path instead. */
export function installFakeWalletAtRoot(options: FakeWalletOptions = {}): FakeWallet {
  const wallet = buildFakeWallet(options);
  walletWindow().solana = wallet.provider;
  return wallet;
}

/* ------------------------------------------------------------------ *
 * The cluster check
 * ------------------------------------------------------------------ */

/** A genesis hash that is not the one this build expects. */
const FOREIGN_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/**
 * Answers the cluster check `WalletContext.connect` makes. Without this the
 * check would reach for a public RPC endpoint, which is slow and flaky.
 */
export function expectClusterGenesis(matches: boolean): void {
  vi.spyOn(Connection.prototype, "getGenesisHash").mockResolvedValue(
    (matches ? expectedGenesisHash() : FOREIGN_GENESIS_HASH) as never,
  );
}

/* ------------------------------------------------------------------ *
 * The API boundary
 * ------------------------------------------------------------------ */

interface ApiCall {
  readonly method: HttpMethod;
  readonly path: string;
  readonly options: RequestOptions;
}

type ApiHandler = (
  options: RequestOptions,
  call: { readonly method: HttpMethod; readonly path: string },
) => unknown;

export interface ApiMock {
  /** Every request the application made, in order. */
  readonly calls: readonly ApiCall[];
  /** `METHOD path` for every request, in order. */
  readonly paths: readonly string[];
  readonly request: MockInstance<
    <T>(method: HttpMethod, path: string, options?: RequestOptions) => Promise<T>
  >;
  /** Registers a handler. The first matching registration wins. */
  on(method: HttpMethod, path: string | RegExp, handler: ApiHandler): ApiMock;
  /** Registers a catch-all handler, for tests that do not care about routing. */
  onAny(handler: ApiHandler): ApiMock;
  /** Requests matching a method and an exact path or pattern. */
  callsTo(method: HttpMethod, path: string | RegExp): ApiCall[];
  /** `METHOD path` for every request matching a method and pattern. */
  pathsOf(method: HttpMethod, path: string | RegExp): string[];
}

interface Route {
  readonly method: HttpMethod | "ANY";
  readonly path: string | RegExp;
  readonly handler: ApiHandler;
}

function pathMatches(pattern: string | RegExp, path: string): boolean {
  if (typeof pattern === "string") return pattern === path;
  pattern.lastIndex = 0;
  return pattern.test(path);
}

/**
 * Replaces the single HTTP boundary, leaving every endpoint, hook and component
 * above it real. An unmapped request rejects loudly rather than resolving to
 * `undefined`, so a test cannot pass on a call nobody anticipated.
 */
export function mockApi(): ApiMock {
  const calls: ApiCall[] = [];
  const routes: Route[] = [];

  const request = vi.spyOn(api, "request");
  request.mockImplementation(
    async <T,>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> => {
      calls.push({ method, path, options });
      const route = routes.find(
        (entry) => (entry.method === "ANY" || entry.method === method) && pathMatches(entry.path, path),
      );
      if (route === undefined) {
        throw new Error(`No test handler for ${method} ${path}`);
      }
      return (await route.handler(options, { method, path })) as T;
    },
  );

  vi.spyOn(api, "download").mockImplementation(async (path: string) => {
    calls.push({ method: "GET", path, options: {} });
    return new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" });
  });

  const pathsOf = (method: HttpMethod, path: string | RegExp): string[] =>
    calls.filter((call) => call.method === method && pathMatches(path, call.path)).map((call) => call.path);

  return {
    calls,
    get paths() {
      return calls.map((call) => `${call.method} ${call.path}`);
    },
    request,
    on(method, path, handler) {
      routes.push({ method, path, handler });
      return this;
    },
    onAny(handler) {
      routes.push({ method: "ANY", path: /.*/, handler });
      return this;
    },
    callsTo(method, path) {
      return calls.filter((call) => call.method === method && pathMatches(path, call.path));
    },
    pathsOf,
  };
}

/* ------------------------------------------------------------------ *
 * Promises held open on purpose
 * ------------------------------------------------------------------ */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/** A promise a test settles by hand, for observing a state mid-flight. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function providers(ui: ReactNode): ReactNode {
  return (
    <WalletProvider>
      <AuthProvider>
        <ToastProvider>{ui}</ToastProvider>
      </AuthProvider>
    </WalletProvider>
  );
}

/** Renders inside the three real providers and a memory router. */
export function renderWithProviders(ui: ReactNode, initialEntry = "/"): RenderResult {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>{providers(ui)}</MemoryRouter>,
  );
}

/**
 * Renders with only the toast provider and a router. Used for the public pages,
 * which must work with no session and therefore need no auth or wallet provider
 * at all: if one of them ever reached for one, this would throw.
 */
export function renderPublicly(ui: ReactNode, initialEntry = "/"): RenderResult {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>,
  );
}

/** Renders an explicit route table inside the three real providers. */
export function renderRoutes(routes: RouteObject[], initialEntry: string): RenderResult {
  const memoryRouter = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  return render(providers(<RouterProvider router={memoryRouter} />));
}

/**
 * Renders the application's real route table, guards and all, over an in-memory
 * history. The table is the shipped one, not a copy, so a change to a role
 * requirement in `src/routes/router.tsx` is a change to what these tests check.
 */
export function renderRealRouter(path: string): RenderResult {
  const memoryRouter = createMemoryRouter(realRouter.routes, { initialEntries: [path] });
  return render(providers(<RouterProvider router={memoryRouter} />));
}

/* ------------------------------------------------------------------ *
 * Console
 * ------------------------------------------------------------------ */

interface ConsoleCapture {
  restore(): void;
  readonly errors: readonly unknown[][];
}

/**
 * Captures `console.error` for the duration of a test. React always logs a
 * caught error boundary; the tests that trigger one on purpose use this so the
 * expected diagnostic does not look like a failure.
 */
export function captureConsoleError(): ConsoleCapture {
  const errors: unknown[][] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  return { restore: () => spy.mockRestore(), errors };
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

export function makePrepared(overrides: Partial<Prepared> = {}): Prepared {
  return {
    phase: "PREPARED",
    transaction: PREPARED_TRANSACTION_BASE64,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 254000,
    targetAddress: ON_CHAIN_ADDRESS.toBase58(),
    description: "Register AGT-COCOA-2026-A1B2C3 as a cocoa batch from Ogun State",
    validForSeconds: 120,
    ...overrides,
  };
}

function makeProvenanceEvent(
  overrides: Partial<ProvenanceEvent> = {},
): ProvenanceEvent {
  return {
    sequence: 1,
    kind: "REGISTERED",
    title: "Batch registered by the farmer",
    detail: "1200 kg of cocoa beans, harvested 14 March 2026.",
    occurredAt: "2026-03-14T12:00:00.000Z",
    actorWallet: FARMER_WALLET.toBase58(),
    actorRole: "FARMER",
    status: "REGISTERED",
    transactionSignature: SIGNATURE,
    dataHash: DATA_HASH,
    flagged: false,
    ...overrides,
  };
}

function makeCertificate(
  overrides: Partial<PublicCertificateSummary> = {},
): PublicCertificateSummary {
  return {
    certificateId: "cert-1",
    issuingBody: "Kola Organic Certifiers",
    certificateType: "Organic",
    referenceNumber: "KOC-2026-0042",
    issuedOn: "2026-02-01T12:00:00.000Z",
    expiresOn: "2027-02-01T12:00:00.000Z",
    dataHash: DATA_HASH,
    ...overrides,
  };
}

export function makePublicProduct(overrides: Partial<PublicProduct> = {}): PublicProduct {
  return {
    productId: BATCH_ID,
    cropType: "Cocoa",
    quantity: 1200,
    unit: "kg",
    harvestDate: "2026-03-14T12:00:00.000Z",
    origin: "Abeokuta, Ogun State",
    description: "Forastero cocoa beans, sun dried on raised beds.",
    additionalNotes: "Stored in jute sacks at 24 degrees Celsius.",
    status: "REGISTERED",
    statusLabel: "Registered",
    registeredAt: "2026-03-14T12:00:00.000Z",
    currentOwnerCategory: "FARMER",
    registrantCategory: "FARMER",
    dataHash: DATA_HASH,
    onChainAddress: ON_CHAIN_ADDRESS.toBase58(),
    onChainTxHash: SIGNATURE,
    onChainRegisteredAt: "2026-03-14T12:05:00.000Z",
    images: [{ mediaId: "media-1", caption: "The drying beds" }],
    certificates: [makeCertificate()],
    provenance: [makeProvenanceEvent()],
    verificationHistory: [
      {
        verificationId: "ver-1",
        result: "VERIFIED",
        requester: "PUBLIC",
        requestedAt: "2026-03-14T12:10:00.000Z",
      },
    ],
    verificationCount: 1,
    lastVerificationResult: "VERIFIED",
    ...overrides,
  };
}

interface VerificationOverrides {
  result?: Verification["result"];
  mismatch?: Verification["mismatch"];
  onChain?: string | null;
  stored?: string | null;
  computed?: string | null;
  chainReachable?: boolean;
  recordPresent?: boolean;
  headline?: string;
  explanation?: string;
  productId?: string;
}

export function makeVerification(overrides: VerificationOverrides = {}): Verification {
  const {
    result = "VERIFIED",
    mismatch = null,
    onChain = DATA_HASH,
    stored = DATA_HASH,
    computed = DATA_HASH,
    chainReachable = true,
    recordPresent = true,
    headline = "Every stored detail still matches the fingerprint anchored on the blockchain.",
    explanation = "The stored details were read again just now and produced the same fingerprint.",
    productId = BATCH_ID,
  } = overrides;
  return {
    result,
    productId,
    headline,
    explanation,
    chainReachable,
    recordPresent,
    dataHash: { onChain, stored, computed },
    mismatch,
    verificationId: "ver-2",
    verifiedAt: "2026-03-14T12:30:00.000Z",
    durationMs: 412,
  };
}

export function makeVerificationResponse(
  verification: Verification,
  product: PublicProduct | null,
): VerificationResponse {
  return { verification, product };
}

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    productId: BATCH_ID,
    cropType: "Cocoa",
    quantity: 1200,
    unit: "kg",
    harvestDate: "2026-03-14T12:00:00.000Z",
    farmLocation: "Abeokuta, Ogun State",
    description: "Forastero cocoa beans, sun dried on raised beds.",
    additionalNotes: "Stored in jute sacks at 24 degrees Celsius.",
    status: "REGISTERED",
    chainState: "CONFIRMED" as ChainState,
    ownerWallet: FARMER_WALLET.toBase58(),
    registeredByWallet: FARMER_WALLET.toBase58(),
    registrantRole: "FARMER",
    dataHash: DATA_HASH,
    onChainDataHash: DATA_HASH,
    onChainTxHash: SIGNATURE,
    onChainAddress: ON_CHAIN_ADDRESS.toBase58(),
    onChainRegisteredAt: "2026-03-14T12:05:00.000Z",
    onChainTransferCount: 0,
    images: [],
    certificates: [],
    retail: {
      listed: false,
      listedAt: null,
      askingPrice: null,
      currency: "NGN",
      soldAt: null,
      note: "",
    },
    lastVerificationResult: "VERIFIED",
    lastVerifiedAt: "2026-03-14T12:10:00.000Z",
    createdAt: "2026-03-14T12:00:00.000Z",
    updatedAt: "2026-03-14T12:05:00.000Z",
    ...overrides,
  };
}

export function makeRegistrationAccepted(
  overrides: Partial<ProductRegistrationAccepted> = {},
): ProductRegistrationAccepted {
  const product = overrides.product ?? makeProduct();
  return {
    productId: product.productId,
    dataHash: product.dataHash,
    chainState: "AWAITING_SIGNATURE",
    prepared: makePrepared(),
    product,
    ...overrides,
  };
}

export function makeRegistrationConfirmed(
  overrides: Partial<ProductRegistrationConfirmed> = {},
): ProductRegistrationConfirmed {
  const product = overrides.product ?? makeProduct();
  return {
    product,
    signature: SIGNATURE,
    slot: 254123,
    verificationUrl: `https://trace.example/verify/${BATCH_ID}`,
    qrPayload: `https://trace.example/verify/${BATCH_ID}`,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Assertions shared by more than one file
 * ------------------------------------------------------------------ */

/**
 * A close approximation of the accessible name, enough to tell a control that a
 * reader could not name from one they could. `aria-label` and `aria-labelledby`
 * win, then an associated `<label>`, then the control's own text (which is where
 * a visually hidden sentence lives), then `title`, then `alt`.
 */
function accessibleNameOf(element: Element): string {
  const explicit = element.getAttribute("aria-label");
  if (explicit !== null && explicit.trim().length > 0) return explicit.trim();

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text.length > 0) return text;
  }

  const id = element.getAttribute("id");
  if (id !== null) {
    const label = element.ownerDocument.querySelector(`label[for="${id}"]`);
    const text = label?.textContent?.trim() ?? "";
    if (text.length > 0) return text;
  }

  const wrapping = element.closest("label");
  const wrappingText = wrapping?.textContent?.trim() ?? "";
  if (wrappingText.length > 0) return wrappingText;

  const own = element.textContent?.trim() ?? "";
  if (own.length > 0) return own;

  const title = element.getAttribute("title");
  if (title !== null && title.trim().length > 0) return title.trim();

  return element.getAttribute("alt")?.trim() ?? "";
}

/**
 * Every form control in `container` that no reader could name. An empty list is
 * the pass condition, so a control that loses its label fails the test.
 */
export function unnamedFormControls(container: HTMLElement): Element[] {
  const controls = Array.from(
    container.querySelectorAll<HTMLElement>("input, select, textarea, [role='textbox']"),
  );
  return controls.filter(
    (control) =>
      control.getAttribute("aria-hidden") !== "true" &&
      control.closest("[aria-hidden='true']") === null &&
      accessibleNameOf(control).length === 0,
  );
}

/**
 * Every button and link in `container` that no reader could name. A control
 * whose only content is an icon needs a hidden sentence or an `aria-label`; this
 * is the list of the ones that do not have either.
 */
export function unnamedIconControls(container: HTMLElement): Element[] {
  const controls = Array.from(container.querySelectorAll<HTMLElement>("button, a[href]"));
  return controls.filter(
    (control) =>
      control.getAttribute("aria-hidden") !== "true" &&
      control.closest("[aria-hidden='true']") === null &&
      accessibleNameOf(control).length === 0,
  );
}

/** True when the element announces itself as a live region of some kind. */
export function announcesItself(element: Element | null): boolean {
  if (element === null) return false;
  const role = element.getAttribute("role");
  if (role === "status" || role === "alert" || role === "log" || role === "progressbar") return true;
  const live = element.getAttribute("aria-live");
  return live === "polite" || live === "assertive";
}

export type UserEvent = ReturnType<typeof userEvent.setup>;

/**
 * A `userEvent` session with no inter-keypress delay.
 *
 * The delay exists so a test can observe a partially typed value, which none of
 * these tests does; leaving it out turns several minutes of keystroke timers
 * into a few seconds.
 */
export function setupUser(): UserEvent {
  return userEvent.setup({ delay: null });
}