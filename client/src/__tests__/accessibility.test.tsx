import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../components/ui/Modal";
import { QrCode } from "../components/ui/QrCode";
import { Tabs, type TabDefinition } from "../components/ui/Tabs";
import { PublicShell } from "../components/layout/PublicShell";
import ConnectWalletPage from "../pages/public/ConnectWalletPage";
import RegisterProductPage from "../pages/app/products/RegisterProductPage";
import SearchPage from "../pages/public/SearchPage";
import VerifyLookupPage from "../pages/public/VerifyLookupPage";
import VerifyResultPage from "../pages/public/VerifyResultPage";
import type { Pagination } from "../api/types";
import { PaginationControls } from "../pages/app/appUi";
import {
  BATCH_ID,
  DATA_HASH,
  expectClusterGenesis,
  FARMER_WALLET,
  installFakeWallet,
  makePublicProduct,
  makeRegistrationAccepted,
  makeRegistrationConfirmed,
  makeVerification,
  makeVerificationResponse,
  mockApi,
  renderWithProviders,
  renderRealRouter,
  resetBrowserState,
  restoreLayout,
  restoreGlobalTypedArrayRealm,
  setupUser,
  SIGNATURE,
  unnamedFormControls,
  unnamedIconControls,
  useNodeTypedArrayRealm,
  useVisibleLayout,
  type ApiMock,
} from "./harness";

/**
 * The accessibility contract of the pages this suite covers: one heading per
 * page, a name for every control, meaningful alternative text for every image,
 * a caption and header cells on every table, a dialog that behaves like a
 * dialog, and tabs that behave like tabs.
 *
 * The two environment repairs live here rather than in the shared setup: jsdom
 * implements no layout, so `offsetParent` is always `null`, and without it
 * `Modal` cannot tell which controls are inside the dialog.
 */

let http: ApiMock;

function sessionAsFarmer(): void {
  http.on("GET", "/auth/me", () => ({
    authenticated: true,
    user: {
      userId: "usr-farmer",
      walletAddress: FARMER_WALLET.toBase58(),
      fullName: "Amina Bello",
      role: "FARMER",
      contactInfo: { email: "a@example.test", phone: "+2348000000000", address: "Plot 1", state: "Ogun" },
      organisation: "Bello Cocoa Farm",
      status: "ACTIVE",
      onChainRegistered: true,
      onChainRegistrationTx: SIGNATURE,
      profileHash: DATA_HASH,
      registrationDate: "2026-01-05T12:00:00.000Z",
      lastSeen: "2026-03-14T12:15:00.000Z",
    },
    permissions: [],
  }));
  http.on("GET", "/health", () => ({ status: "ok", runtime: { uploadMaxFileBytes: 5_242_880 } }));
  http.on("GET", "/dashboard", () => ({
    role: "FARMER",
    introduction: "What this screen is for.",
    metrics: [],
    sections: [],
    quickActions: [],
    onChainRegistrationRequired: false,
  }));
  http.on("POST", "/products", () => makeRegistrationAccepted());
  http.on("POST", /^\/products\/[^/]+\/submit$/, () => makeRegistrationConfirmed());
}

/** Serves a clean verification result for `VerifyResultPage`. */
function serveVerifiedBatch(): void {
  http.on("GET", new RegExp(`^/verify/${BATCH_ID}$`), () =>
    makeVerificationResponse(makeVerification({ result: "VERIFIED" }), makePublicProduct()),
  );
  http.on("POST", new RegExp(`^/verify/${BATCH_ID}/log$`), () => ({
    verificationId: "ver-a11y",
  }));
}

beforeAll(() => {
  useNodeTypedArrayRealm();
  useVisibleLayout();
});

afterAll(() => {
  restoreLayout();
  restoreGlobalTypedArrayRealm();
});

beforeEach(() => {
  expectClusterGenesis(true);
  http = mockApi();
  sessionAsFarmer();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBrowserState();
});

/* ------------------------------------------------------------------ *
 * Headings
 * ------------------------------------------------------------------ */

interface PageCase {
  readonly name: string;
  readonly render: () => HTMLElement;
  /** The heading that names the page. */
  readonly heading: string;
}

const PAGES: readonly PageCase[] = [
  {
    name: "the batch lookup",
    heading: "Check a batch",
    render: () => {
      const { container } = renderWithProviders(<VerifyLookupPage />, "/verify");
      return container;
    },
  },
  {
    name: "public search",
    heading: "Search the registry",
    render: () => {
      const { container } = renderWithProviders(<SearchPage />, "/search");
      return container;
    },
  },
  {
    name: "the connect page",
    heading: "Connect your wallet",
    render: () => {
      installFakeWallet({ name: "phantom" });
      const { container } = renderWithProviders(
        <PublicShell>
          <ConnectWalletPage />
        </PublicShell>,
        "/connect",
      );
      return container;
    },
  },
  {
    name: "the verification result",
    heading: `Batch ${BATCH_ID}`,
    render: () => {
      serveVerifiedBatch();
      const { container } = renderWithProviders(
        <Routes>
          <Route path="/verify/:productId" element={<VerifyResultPage />} />
        </Routes>,
        `/verify/${BATCH_ID}`,
      );
      return container;
    },
  },
  {
    name: "the registration form",
    heading: "Register a batch",
    render: () => {
      installFakeWallet({ name: "phantom", exposesAddress: true });
      const { container } = renderWithProviders(<RegisterProductPage />, "/app/products/register");
      return container;
    },
  },
];

describe("page structure", () => {
  it.each(PAGES)("$name has exactly one first-level heading", async (page) => {
    const container = page.render();

    // Wait for whatever the page fetches before judging its headings.
    await screen.findByRole("heading", { level: 1, name: page.heading });
    await waitFor(() => {
      expect(container.querySelectorAll("h1")).toHaveLength(1);
    });
    expect(screen.getByRole("heading", { level: 1, name: page.heading })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

describe("every control has a name", () => {
  it.each(PAGES)("$name names all of its form controls", async (page) => {
    const container = page.render();
    await screen.findByRole("heading", { level: 1, name: page.heading });

    await waitFor(() => {
      expect(unnamedFormControls(container)).toEqual([]);
    });
  });

  it.each(PAGES)("$name names every icon-only control", async (page) => {
    const container = page.render();
    await screen.findByRole("heading", { level: 1, name: page.heading });

    await waitFor(() => {
      expect(unnamedIconControls(container)).toEqual([]);
    });
  });

  it("gives the header's icon-only wallet and notification controls a name", async () => {
    installFakeWallet({ name: "phantom", exposesAddress: true });
    http.on("GET", "/notifications", () => ({ notifications: [], unreadCount: 0 }));
    const { container } = renderRealRouter("/app/dashboard");
    await screen.findByRole("heading", { level: 1, name: "Your workspace" });

    // The bell is an icon with a hidden sentence, not an unlabelled button.
    const bell = screen.getByRole("button", { name: /Notifications, none unread/ });
    expect(bell.querySelector("svg")).not.toBeNull();
    expect(bell.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    // The wallet control names both the address and the menu it opens.
    const walletButton = screen.getByRole("button", { name: /Wallet menu for/ });
    expect(walletButton).toHaveAttribute("aria-haspopup", "menu");
    expect(walletButton).toHaveAttribute("aria-expanded", "false");

    // Every control in the whole signed-in frame is named, icons included.
    expect(unnamedIconControls(container)).toEqual([]);
    expect(unnamedFormControls(container)).toEqual([]);
  });

  it("names a file control by what it collects", async () => {
    installFakeWallet({ name: "phantom", exposesAddress: true });
    renderWithProviders(<RegisterProductPage />, "/app/products/register");

    expect(
      await screen.findByLabelText("Photographs of the batch"),
    ).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    expect(screen.getByLabelText("Certificates")).toHaveAttribute(
      "accept",
      "application/pdf",
    );
  });

  it("names the control that removes a chosen file", async () => {
    const user = setupUser();
    installFakeWallet({ name: "phantom", exposesAddress: true });
    renderWithProviders(<RegisterProductPage />, "/app/products/register");
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });

    await user.upload(
      screen.getByLabelText("Photographs of the batch"),
      new File([new Uint8Array([1, 2, 3])], "beans.jpg", { type: "image/jpeg" }),
    );

    // An icon-only button whose only text is a hidden sentence.
    const remove = await screen.findByRole("button", { name: "Remove beans.jpg" });
    expect(remove).toBeEnabled();
    expect(remove.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

describe("images", () => {
  it("names the QR code for the batch it encodes", async () => {
    render(<QrCode productId={BATCH_ID} payload={`https://trace.example/verify/${BATCH_ID}`} />);

    const image = await screen.findByRole("img", {
      name: `Verification QR code for batch ${BATCH_ID}`,
    });
    expect(image.getAttribute("alt")).toBe(
      `Verification QR code for batch ${BATCH_ID}`,
    );
    // The link the code carries is printed in full, so a label can be read by hand.
    expect(screen.getByText(`https://trace.example/verify/${BATCH_ID}`)).toBeInTheDocument();
  });

  it("marks every decorative graphic as hidden from assistive technology", async () => {
    const { container } = render(
      <QrCode productId={BATCH_ID} payload="https://trace.example/verify/x" />,
    );
    await screen.findByRole("img");

    const svgs = Array.from(container.querySelectorAll("svg"));
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("focusable", "false");
    }
    // No image on the covered pages is left with an empty or missing alt.
    const images = Array.from(container.querySelectorAll("img"));
    for (const image of images) {
      expect((image.getAttribute("alt") ?? "").length).toBeGreaterThan(0);
      expect(image.getAttribute("role")).not.toBe("presentation");
    }
  });
});

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

describe("tables", () => {
  it("carry a caption, column headers and a row header for the identifying column", async () => {
    serveVerifiedBatch();
    const { container } = renderWithProviders(
      <Routes>
        <Route path="/verify/:productId" element={<VerifyResultPage />} />
      </Routes>,
      `/verify/${BATCH_ID}`,
    );

    const table = await screen.findByRole("table", {
      name: "Certificates attached to this batch",
    });

    // The caption is the table's accessible name and is a real element.
    const caption = table.querySelector("caption");
    expect(caption).not.toBeNull();
    expect(caption).toHaveTextContent("Certificates attached to this batch");

    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      "Certificate",
      "Type",
      "Issued",
      "Expires",
    ]);
    for (const header of headers) {
      expect(header).toHaveAttribute("scope", "col");
    }
    expect(within(table).getByRole("rowheader", { name: /Kola Organic Certifiers/ })).toHaveAttribute(
      "scope",
      "row",
    );

    // A scrolling table is reachable by keyboard, which needs the wrapper.
    const scroller = table.parentElement as HTMLElement;
    expect(scroller).toHaveAttribute("role", "region");
    expect(scroller).toHaveAttribute("tabindex", "0");
    expect(scroller).toHaveAccessibleName("Certificates attached to this batch");
    expect(container.querySelectorAll("table")).toHaveLength(1);
  });

  it("give a list its own accessible name", async () => {
    const pagination: Pagination = { page: 1, pageSize: 20, total: 45, totalPages: 3 };
    render(<PaginationControls pagination={pagination} onPageChange={() => undefined} />);

    const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(nav).toBeInTheDocument();
    // The range is announced rather than only drawn.
    expect(within(nav).getByText(/Showing 1 to 20 of 45 records/)).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Dialogs
 * ------------------------------------------------------------------ */

describe("a dialog", () => {
  function DialogHarness({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open the dialog
        </button>
        <button type="button">Outside the dialog</button>
        <Modal
          open={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          title="Confirm the transfer"
          description="The batch will change hands on the blockchain."
        >
          <button type="button">Check the recipient</button>
          <button type="button">Confirm</button>
        </Modal>
      </>
    );
  }

  it("is a labelled modal dialog, and takes focus on open", async () => {
    const user = setupUser();
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);

    const trigger = screen.getByRole("button", { name: "Open the dialog" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Confirm the transfer" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("The batch will change hands on the blockchain.");
    // Focus has moved inside, onto the first control in the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("traps Tab inside itself, in both directions", async () => {
    const user = setupUser();
    render(<DialogHarness onClose={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Open the dialog" }));
    await screen.findByRole("dialog", { name: "Confirm the transfer" });

    const close = screen.getByRole("button", { name: "Close this dialog" });
    const first = screen.getByRole("button", { name: "Check the recipient" });
    const last = screen.getByRole("button", { name: "Confirm" });

    // Forward past the last control wraps to the first.
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);

    // Backwards from the first wraps to the last.
    close.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);

    // Nothing outside the dialog is ever reached.
    for (let step = 0; step < 6; step += 1) {
      await user.tab();
      expect(
        screen.getByRole("dialog", { name: "Confirm the transfer" }).contains(
          document.activeElement,
        ),
      ).toBe(true);
    }
    expect(first).toBeInTheDocument();
  });

  it("closes on Escape and gives focus back to whatever opened it", async () => {
    const user = setupUser();
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "Open the dialog" });

    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Confirm the transfer" });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("gives focus back to the trigger when the close control is used", async () => {
    const user = setupUser();
    render(<DialogHarness onClose={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "Open the dialog" });

    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Confirm the transfer" });
    await user.click(screen.getByRole("button", { name: "Close this dialog" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("holds the page behind it still while it is open", async () => {
    const user = setupUser();
    render(<DialogHarness onClose={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Open the dialog" }));
    await screen.findByRole("dialog", { name: "Confirm the transfer" });
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("names its own close control", () => {
    render(
      <Modal open onClose={() => undefined} title="Anything" closeLabel="Close the summary">
        <p>Body</p>
      </Modal>,
    );
    expect(
      screen.getByRole("button", { name: "Close the summary" }),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

const TABS: readonly TabDefinition[] = [
  { id: "facts", label: "Facts", icon: "clipboard", content: <p>The facts panel</p> },
  { id: "history", label: "History", icon: "flag", content: <p>The history panel</p> },
  { id: "certificates", label: "Certificates", icon: "fileText", content: <p>The certificates panel</p> },
];

function TabsHarness() {
  const [active, setActive] = useState("facts");
  return <Tabs label="Batch sections" tabs={TABS} activeId={active} onChange={setActive} />;
}

describe("tabs", () => {
  it("expose a named tab list with one selected tab", () => {
    render(<TabsHarness />);

    const list = screen.getByRole("tablist", { name: "Batch sections" });
    expect(list).toBeInTheDocument();
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Facts",
      "History",
      "Certificates",
    ]);
    expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Facts");
    // Only the selected tab is in the tab order.
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("tie each tab to the panel it controls", () => {
    render(<TabsHarness />);

    const tab = screen.getByRole("tab", { name: "Facts" });
    const panel = screen.getByRole("tabpanel");
    expect(tab).toHaveAttribute("aria-controls", panel.getAttribute("id"));
    expect(panel).toHaveAttribute("aria-labelledby", tab.getAttribute("id"));
    expect(panel).toHaveTextContent("The facts panel");
  });

  it("move with the arrow keys, wrapping at both ends", async () => {
    const user = setupUser();
    render(<TabsHarness />);

    await user.click(screen.getByRole("tab", { name: "Facts" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("The facts panel");

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("History");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("The history panel");

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Certificates");

    // Forward from the last wraps to the first.
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Facts");

    // Backwards from the first wraps to the last.
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Certificates");
  });

  it("jump to the ends with Home and End", async () => {
    const user = setupUser();
    render(<TabsHarness />);
    await user.click(screen.getByRole("tab", { name: "Facts" }));

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Certificates");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Certificates" }));

    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Facts");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Facts" }));
  });

  it("are also reachable by clicking, not only by keyboard", async () => {
    const user = setupUser();
    render(<TabsHarness />);

    await user.click(screen.getByRole("tab", { name: "Certificates" }));

    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Certificates");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("The certificates panel");
  });
});

