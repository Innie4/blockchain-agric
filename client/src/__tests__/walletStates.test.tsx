import { screen, waitFor, within, cleanup } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ERROR_MESSAGES } from "../api/errors";
import type { SessionState } from "../api/types";
import { PublicShell } from "../components/layout/PublicShell";
import ConnectWalletPage from "../pages/public/ConnectWalletPage";
import UnsupportedWalletPage from "../pages/public/UnsupportedWalletPage";
import { CLUSTER_LABEL, SOLANA_CLUSTER } from "../lib/solana";
import {
  deferred,
  expectClusterGenesis,
  FARMER_WALLET,
  installFakeWallet,
  installFakeWalletAtRoot,
  mockApi,
  renderWithProviders,
  resetBrowserState,
  setupUser,
  type ApiMock,
  type FakeWallet,
} from "./harness";

/**
 * The four wallet states a person can actually be in, plus the ways a
 * connection can go wrong.
 *
 * The page is rendered inside the real `PublicShell`, because the header's
 * `WalletButton` is where the connect control shows its busy state, and a person
 * meeting the connect page meets that button too.
 */

const NETWORK = CLUSTER_LABEL[SOLANA_CLUSTER];
const ADDRESS = FARMER_WALLET.toBase58();
const TRUNCATED = `${ADDRESS.slice(0, 4)}…${ADDRESS.slice(-4)}`;

/** The failure a wallet extension raises when the person says no. */
function userRejected(): { code: number; message: string } {
  return { code: 4001, message: "User rejected the request." };
}

let http: ApiMock;
let session: SessionState;

/** Signs the participant in as `role`, with the wallet address under test. */
function signInAs(role: "CONSUMER" | "FARMER"): void {
  session = {
    authenticated: true,
    user: {
      userId: `usr-${role}`,
      walletAddress: ADDRESS,
      fullName: "Test Participant",
      role,
      contactInfo: { email: "t@example.test", phone: "+2348000000000", address: "Plot 1", state: "Ogun" },
      organisation: "Test Organisation",
      status: "ACTIVE",
      onChainRegistered: true,
      onChainRegistrationTx: null,
      profileHash: null,
      registrationDate: "2026-01-05T09:00:00.000Z",
      lastSeen: "2026-03-14T08:00:00.000Z",
    },
    permissions: [],
  };
}

function renderConnectPage(): void {
  renderWithProviders(
    <PublicShell>
      <ConnectWalletPage />
    </PublicShell>,
    "/connect",
  );
}

/** The page's own "This browser" panel, which is where every state is shown. */
async function thisBrowserPanel(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: "This browser" });
}

beforeEach(() => {
  expectClusterGenesis(true);
  http = mockApi();
  session = { authenticated: false, user: null, permissions: [] };
  http.on("GET", "/auth/me", () => session);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBrowserState();
});

describe("no wallet in the browser", () => {
  it("says so, explains how to install one, and links to the setup page", async () => {
    renderConnectPage();

    const panel = await thisBrowserPanel();
    expect(
      within(panel).getByText("No Solana wallet was found in this browser"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/Install Phantom from your browser's extension store/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: /How to install Phantom/ }),
    ).toHaveAttribute("href", "/auth/unsupported-wallet");
    // Looking again is offered, and the header points at the same page.
    expect(within(panel).getByRole("button", { name: /Look again/ })).toBeEnabled();
    expect(screen.getByRole("link", { name: /Set up a wallet/ })).toHaveAttribute(
      "href",
      "/connect",
    );
  });

  it("reaches the installation instructions through that link", async () => {
    const user = setupUser();
    renderWithProviders(
      <PublicShell>
        <Routes>
          <Route path="/connect" element={<ConnectWalletPage />} />
          <Route path="/auth/unsupported-wallet" element={<UnsupportedWalletPage />} />
        </Routes>
      </PublicShell>,
      "/connect",
    );

    const panel = await thisBrowserPanel();
    await user.click(within(panel).getByRole("link", { name: /How to install Phantom/ }));

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This page needs a Solana wallet",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Nobody legitimate will ask for your recovery phrase"),
    ).toBeInTheDocument();
    // The public check needs no wallet, and the page says so.
    expect(
      screen.getByText("You do not need a wallet to check a batch"),
    ).toBeInTheDocument();
  });
});

describe("a wallet that is installed but not connected", () => {
  it("names the wallet and offers a connect button that works", async () => {
    const user = setupUser();
    const wallet: FakeWallet = installFakeWallet({ name: "phantom" });

    renderConnectPage();

    const panel = await thisBrowserPanel();
    const connect = within(panel).getByRole("button", { name: /^Connect$/ });
    expect(connect).toBeEnabled();
    expect(within(panel).getByText(/Phantom is installed in this browser/)).toBeInTheDocument();

    await user.click(connect);

    await waitFor(() => {
      expect(within(panel).getByText(`Phantom is connected to ${NETWORK}`)).toBeInTheDocument();
    });
    expect(wallet.connect).toHaveBeenCalledTimes(1);
  });

  it("finds a wallet injected at window.solana as well as window.phantom.solana", async () => {
    const user = setupUser();
    // The second injection path, with no vendor flag to name it by, so the
    // interface falls back to the generic name for that path.
    installFakeWalletAtRoot({ name: "backpack" });

    renderConnectPage();
    const panel = await thisBrowserPanel();
    expect(
      within(panel).getByText(/Backpack is installed in this browser/),
    ).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: /^Connect$/ }));

    await waitFor(() => {
      expect(
        within(panel).getByText(`Backpack is connected to ${NETWORK}`),
      ).toBeInTheDocument();
    });
  });

  it("falls back to a generic name for a wallet that reports none of its own", async () => {
    const user = setupUser();
    // No flag, no `name`: the only label available is the injection path's.
    installFakeWalletAtRoot({ name: "none" });

    renderConnectPage();
    const panel = await thisBrowserPanel();
    expect(
      within(panel).getByText(/Solana wallet is installed in this browser/),
    ).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: /^Connect$/ }));

    await waitFor(() => {
      expect(
        within(panel).getByText(`Solana wallet is connected to ${NETWORK}`),
      ).toBeInTheDocument();
    });
  });

  it("uses the name the wallet reports for itself", async () => {
    const user = setupUser();
    installFakeWallet({ name: "custom", customName: "Farm Ledger" });

    renderConnectPage();
    const panel = await thisBrowserPanel();
    await user.click(within(panel).getByRole("button", { name: /^Connect$/ }));

    await waitFor(() => {
      expect(
        within(panel).getByText(`Farm Ledger is connected to ${NETWORK}`),
      ).toBeInTheDocument();
    });
  });
});

describe("a connection in progress", () => {
  it("puts the connect control in its loading state and marks it busy", async () => {
    const user = setupUser();
    const pending = deferred<void>();
    const wallet = installFakeWallet({ name: "phantom" });
    const connectNormally = wallet.connect.getMockImplementation();
    wallet.connect.mockImplementationOnce(async () => {
      await pending.promise;
      return connectNormally === undefined ? undefined : await connectNormally();
    });

    renderConnectPage();
    const panel = await thisBrowserPanel();
    await user.click(within(panel).getByRole("button", { name: /^Connect$/ }));

    const headerConnect = await screen.findByRole("button", { name: /Connect wallet/ });
    await waitFor(() => {
      expect(headerConnect).toHaveAttribute("aria-busy", "true");
    });
    expect(headerConnect).toBeDisabled();
    // The reason for the wait is announced, not left to a spinner alone.
    expect(await screen.findByText("Waiting for your wallet")).toBeInTheDocument();
    expect(within(panel).getByText(/Approve the connection in Phantom/)).toBeInTheDocument();
    // The wait is a live region, so a screen reader is told without a visual cue.
    const liveRegion = within(panel)
      .getByText(/Approve the connection in Phantom/)
      .closest("[aria-live]");
    expect(liveRegion).not.toBeNull();
    expect(liveRegion).toHaveAttribute("aria-busy", "true");

    pending.resolve();
    await waitFor(() => {
      expect(within(panel).getByText(`Phantom is connected to ${NETWORK}`)).toBeInTheDocument();
    });
    // The header's control becomes the wallet menu once the address is shared.
    expect(
      await screen.findByRole("button", { name: /Wallet menu for/ }),
    ).toBeInTheDocument();
  });
});

describe("a connected wallet", () => {
  it("shows a truncated address and a disconnect action that works", async () => {
    const user = setupUser();
    const wallet = installFakeWallet({ name: "phantom", exposesAddress: true });

    renderConnectPage();
    const panel = await thisBrowserPanel();

    expect(within(panel).getByText(TRUNCATED)).toBeInTheDocument();
    // The whole address is still reachable, for copying and for a screen reader.
    expect(
      within(panel).getByLabelText(`Wallet address ${ADDRESS}`),
    ).toBeInTheDocument();
    expect(within(panel).getByText(NETWORK)).toBeInTheDocument();
    expect(within(panel).getByText("Not signed in yet")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: /^Disconnect$/ }));

    await waitFor(() => {
      expect(
        within(panel).getByText(/Phantom is installed in this browser/),
      ).toBeInTheDocument();
    });
    expect(wallet.disconnect).toHaveBeenCalledTimes(1);
  });

  it("offers the sign-in step once a wallet is connected", async () => {
    installFakeWallet({ name: "phantom", exposesAddress: true });

    renderConnectPage();

    const signIn = await screen.findByRole("button", { name: /Sign in with this wallet/ });
    expect(signIn).toBeEnabled();
    expect(
      screen.getByText("The server issues a single-use challenge addressed to your wallet."),
    ).toBeInTheDocument();
  });
});

describe("a connection the participant rejects", () => {
  it("says what happened and retries by calling connect again", async () => {
    const user = setupUser();
    const wallet = installFakeWallet({ name: "phantom" });
    wallet.connect.mockRejectedValueOnce(userRejected());

    renderConnectPage();
    const panel = await thisBrowserPanel();
    await user.click(within(panel).getByRole("button", { name: /^Connect$/ }));

    const retry = await within(panel).findByRole("button", { name: "Try again" });
    expect(
      within(panel).getByText(
        "The wallet connection was declined, so the application is still signed out.",
      ),
    ).toBeInTheDocument();
    // The refusal is a normal outcome, not a crash.
    expect(screen.queryByText("Something on this page failed")).not.toBeInTheDocument();

    await user.click(retry);

    await waitFor(() => {
      expect(within(panel).getByText(`Phantom is connected to ${NETWORK}`)).toBeInTheDocument();
    });
    expect(wallet.connect).toHaveBeenCalledTimes(2);
  });

  it("raises a toast as well, so the reason is not confined to the panel", async () => {
    const user = setupUser();
    const wallet = installFakeWallet({ name: "phantom" });
    wallet.connect.mockRejectedValueOnce(userRejected());

    renderConnectPage();
    const panel = await thisBrowserPanel();
    await user.click(within(panel).getByRole("button", { name: /^Connect$/ }));

    const region = await screen.findByRole("region", { name: "Notifications" });
    await waitFor(() => {
      expect(within(region).getByText("The wallet did not connect")).toBeInTheDocument();
    });
    expect(
      within(region).getByText(
        "The wallet connection was declined, so the application is still signed out.",
      ),
    ).toBeInTheDocument();
  });
});

describe("a wallet on the wrong cluster", () => {
  it("names the network this deployment reads from", async () => {
    const user = setupUser();
    expectClusterGenesis(false);
    installFakeWallet({ name: "phantom" });

    renderConnectPage();
    const panel = await thisBrowserPanel();
    await user.click(within(panel).getByRole("button", { name: /^Connect$/ }));

    expect(
      await within(panel).findByText("The wallet is on the wrong network"),
    ).toBeInTheDocument();
    const instruction = within(panel).getByText(/Open your wallet's settings/);
    expect(instruction).toHaveTextContent(`This deployment reads from ${NETWORK}.`);
    expect(instruction).toHaveTextContent(`pick ${NETWORK}, and connect again.`);
    expect(
      within(panel).getByText(/Switch the wallet to Solana Devnet in its settings/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", { name: /Try connecting again/ }),
    ).toBeEnabled();
  });
});

describe("a CONSUMER who has connected", () => {
  it("is told a batch can be checked without connecting at all", async () => {
    signInAs("CONSUMER");
    installFakeWallet({ name: "phantom", exposesAddress: true });

    renderConnectPage();

    expect(
      await screen.findByRole("region", { name: "Checking a batch needs no wallet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /You can verify any batch from the identifier printed on its packaging, with no account and no signature/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Connecting a wallet only helps if you intend to register, transfer or record something yourself/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Check a batch/ })).toHaveAttribute(
      "href",
      "/verify",
    );
    expect(screen.getByRole("link", { name: /Search the registry/ })).toHaveAttribute(
      "href",
      "/search",
    );
    // A consumer is already signed in, so no further signature is asked for.
    expect(
      screen.queryByRole("button", { name: /Sign in with this wallet/ }),
    ).not.toBeInTheDocument();
  });
});

describe("the seed phrase", () => {
  it("has no field anywhere on the page that would accept one", async () => {
    const user = setupUser();
    const wallet = installFakeWallet({ name: "phantom" });
    renderConnectPage();
    const panel = await thisBrowserPanel();
    await user.click(within(panel).getByRole("button", { name: /^Connect$/ }));
    await waitFor(() => {
      expect(within(panel).getByText(`Phantom is connected to ${NETWORK}`)).toBeInTheDocument();
    });

    // No control, in any of the four states, is labelled for a phrase or a key.
    for (const label of [/seed phrase/i, /recovery phrase/i, /private key/i, /mnemonic/i]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    const document_ = screen.getByRole("heading", { level: 1 }).ownerDocument;
    expect(document_.querySelectorAll("input")).toHaveLength(0);
    expect(document_.querySelectorAll("textarea")).toHaveLength(0);
    expect(document_.querySelectorAll("input[type='password']")).toHaveLength(0);
    expect(wallet.signMessage).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("warns against sharing one instead, in words rather than colour", async () => {
    renderConnectPage();

    expect(
      await screen.findByText("This application never asks for your seed phrase"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Anyone who asks you for your seed phrase is not this application/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /There is no field anywhere in this application for a recovery phrase or a private key/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your wallet holds the key; this page only asks the wallet to sign/),
    ).toBeInTheDocument();
    expect(screen.getByText("Never share a recovery phrase")).toBeInTheDocument();
  });
});

describe("a sign-in the server refuses", () => {
  const SERVER_MESSAGE =
    "That sign-in request was already used. Ask for a new one and sign that instead.";

  it("surfaces the server's own sentence, not the local fallback", async () => {
    const user = setupUser();
    installFakeWallet({ name: "phantom", exposesAddress: true });
    http.on("POST", "/auth/nonce", () => ({
      nonce: "nonce-1",
      message: "Sign in to Agricultural Traceability",
      expiresAt: "2026-03-14T12:00:00.000Z",
      notBefore: "2026-03-14T11:00:00.000Z",
    }));
    http.on("POST", "/auth/verify", () => {
      throw new ApiError({
        code: "AUTH_NONCE_INVALID",
        status: 401,
        message: SERVER_MESSAGE,
      });
    });

    renderConnectPage();
    await user.click(
      await screen.findByRole("button", { name: /Sign in with this wallet/ }),
    );

    const shown = await screen.findAllByText(SERVER_MESSAGE);
    expect(shown.length).toBeGreaterThan(0);
    // The local vocabulary for this code would have been a different sentence.
    expect(ERROR_MESSAGES.AUTH_NONCE_INVALID).not.toBe(SERVER_MESSAGE);
    expect(screen.queryByText(ERROR_MESSAGES.AUTH_NONCE_INVALID)).not.toBeInTheDocument();
    // And the recovery step for the code is offered.
    expect(
      screen.getByText(/What to do: Ask for a fresh sign-in request\./),
    ).toBeInTheDocument();
  });

  it("reports a rejected signature as a declined signature, not a server fault", async () => {
    const user = setupUser();
    const wallet = installFakeWallet({ name: "phantom", exposesAddress: true });
    http.on("POST", "/auth/nonce", () => ({
      nonce: "nonce-1",
      message: "Sign in to Agricultural Traceability",
      expiresAt: "2026-03-14T12:00:00.000Z",
      notBefore: "2026-03-14T11:00:00.000Z",
    }));
    wallet.signMessage.mockRejectedValueOnce(userRejected());

    renderConnectPage();
    await user.click(
      await screen.findByRole("button", { name: /Sign in with this wallet/ }),
    );

    expect(
      await screen.findAllByText(
        "The signature request was declined, so nothing was written to the blockchain.",
      ),
    ).not.toHaveLength(0);
    expect(http.callsTo("POST", "/auth/verify")).toHaveLength(0);
  });
});
