import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";
import { Button } from "../components/ui/Button";
import { PaginationControls } from "../pages/app/appUi";
import RegisterProductPage from "../pages/app/products/RegisterProductPage";
import ProductTransferPage from "../pages/app/products/ProductTransferPage";
import SearchPage from "../pages/public/SearchPage";
import { Route, Routes } from "react-router-dom";
import type { Pagination, SearchResult, Transfer } from "../api/types";
import {
  announcesItself,
  BATCH_ID,
  DATA_HASH,
  deferred,
  expectClusterGenesis,
  FARMER_WALLET,
  installFakeWallet,
  makeRegistrationAccepted,
  makeRegistrationConfirmed,
  makeProduct,
  makePrepared,
  mockApi,
  renderWithProviders,
  resetBrowserState,
  restoreGlobalTypedArrayRealm,
  setupUser,
  SIGNATURE,
  useNodeTypedArrayRealm,
  type ApiMock,
} from "./harness";

/**
 * Lists and forms through their whole lifecycle, and the rule that every
 * asynchronous region announces itself while it changes.
 *
 * Two real pages stand in for every list and every form in the application:
 * `SearchPage` is a server-driven list, and `RegisterProductPage` is a form that
 * also runs the two-phase blockchain write, so it has a submit, a pending chain
 * confirmation, a success and a failure to observe.
 */

const SEARCH_TERM = "cocoa";

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    productId: BATCH_ID,
    cropType: "Cocoa",
    quantity: 1200,
    unit: "kg",
    farmLocation: "Abeokuta, Ogun State",
    status: "REGISTERED",
    statusLabel: "Registered",
    lastVerificationResult: "VERIFIED",
    ...overrides,
  };
}

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
}

function renderSearch(): void {
  renderWithProviders(<SearchPage />, "/search");
}

async function runSearch(user: ReturnType<typeof setupUser>): Promise<void> {
  await user.type(await screen.findByRole("searchbox", { name: /What are you looking for/ }), SEARCH_TERM);
  await user.click(screen.getByRole("button", { name: /^Search$/ }));
}

function renderRegisterForm(): void {
  installFakeWallet({ name: "phantom", exposesAddress: true });
  renderWithProviders(<RegisterProductPage />, "/app/products/register");
}

async function fillRegisterForm(user: ReturnType<typeof setupUser>): Promise<void> {
  const date = screen.getByLabelText(/^Harvest date/);
  await user.clear(date);
  await user.type(date, "2026-03-14");
  await user.type(screen.getByLabelText(/Crop or product type/), "Cocoa");
  await user.type(screen.getByLabelText(/^Quantity/), "1200");
  await user.type(screen.getByLabelText(/Farm location/), "Abeokuta, Ogun State");
  await user.type(
    screen.getByLabelText(/^Description/),
    "Forastero cocoa beans, sun dried on raised beds.",
  );
}

beforeAll(() => {
  useNodeTypedArrayRealm();
});

afterAll(() => {
  restoreGlobalTypedArrayRealm();
});

beforeEach(() => {
  expectClusterGenesis(true);
  http = mockApi();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBrowserState();
});

/* ------------------------------------------------------------------ *
 * Lists
 * ------------------------------------------------------------------ */

describe("a list that is loading", () => {
  it("shows a loading state and announces it", async () => {
    const user = setupUser();
    const pending = deferred<{ results: SearchResult[] }>();
    http.on("GET", "/search", () => pending.promise);

    renderSearch();
    await runSearch(user);

    const status = await screen.findByRole("status");
    expect(announcesItself(status)).toBe(true);
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(within(status).getByText(`Searching for ${SEARCH_TERM}`)).toBeInTheDocument();
    // The region the results will occupy is marked busy, so a reader is told
    // the page is still working even if the skeleton is not seen.
    expect(document.querySelector("div[aria-busy='true']")).not.toBeNull();

    pending.resolve({ results: [result()] });
    await screen.findByRole("table", { name: "Registered batches matching your search" });
  });
});

describe("a populated list", () => {
  it("renders one row per record, with the facts that identify each", async () => {
    const user = setupUser();
    http.on("GET", "/search", () => ({
      results: [
        result(),
        result({
          productId: "AGT-MAIZE-2026-D4E5F6",
          cropType: "Maize",
          quantity: 40,
          status: "IN_TRANSIT",
          statusLabel: "In transit",
          lastVerificationResult: "MISMATCH",
        }),
      ],
    }));

    renderSearch();
    await runSearch(user);

    const table = await screen.findByRole("table", {
      name: "Registered batches matching your search",
    });
    const rows = within(table).getAllByRole("row");
    // A header row plus one row per record.
    expect(rows).toHaveLength(3);
    expect(within(table).getByRole("rowheader", { name: new RegExp(BATCH_ID) })).toBeInTheDocument();
    expect(within(table).getAllByText("Maize")).toHaveLength(2);
    expect(within(table).getByText("1,200 kg")).toBeInTheDocument();
    expect(within(table).getByText("40 kg")).toBeInTheDocument();
    // The stage is written out as a badge and again as a sentence.
    expect(within(table).getAllByText("In transit")).toHaveLength(2);
    // The result count is stated in a live region, not only in a badge.
    const region = screen.getByRole("region", { name: "Matches" });
    const count = region.querySelector("p[role='status']") as HTMLElement;
    expect(announcesItself(count)).toBe(true);
    expect(count).toHaveTextContent("2 registered batches match cocoa.");
    // Each row offers the full check, named for its own batch.
    expect(
      within(table).getByRole("link", { name: `Check batch ${BATCH_ID}` }),
    ).toHaveAttribute("href", `/verify/${BATCH_ID}`);
  });
});

describe("an empty list", () => {
  it("says so, and offers the action that would change it", async () => {
    const user = setupUser();
    http.on("GET", "/search", () => ({ results: [] }));

    renderSearch();
    await runSearch(user);

    expect(
      await screen.findByText(`Nothing registered matches "${SEARCH_TERM}"`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No batch has been registered under that identifier, crop or farm location/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Check a batch identifier" }),
    ).toHaveAttribute("href", "/verify");
    const again = screen.getByRole("button", { name: /Search again/ });
    expect(again).toBeEnabled();
    // The count is announced as a live region too.
    expect(screen.getByText(`No registered batch matches ${SEARCH_TERM}.`)).toBeInTheDocument();
  });

  it("does not confuse an empty result with a page that failed to load", async () => {
    const user = setupUser();
    http.on("GET", "/search", () => ({ results: [] }));

    renderSearch();
    await runSearch(user);
    await screen.findByText(`Nothing registered matches "${SEARCH_TERM}"`);

    expect(screen.queryByText("That did not work")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("a list that failed", () => {
  it("shows the error, and its retry re-issues the request", async () => {
    const user = setupUser();
    let attempt = 0;
    http.on("GET", "/search", () => {
      attempt += 1;
      if (attempt === 1) {
        throw new ApiError({
          code: "DATABASE_UNAVAILABLE",
          status: 503,
          message: "The records service is not reachable, so nothing was saved.",
        });
      }
      return { results: [result()] };
    });

    renderSearch();
    await runSearch(user);

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent(`The search for "${SEARCH_TERM}" could not be completed`);
    expect(failure).toHaveTextContent(
      "The records service is not reachable, so nothing was saved.",
    );
    expect(announcesItself(failure)).toBe(true);

    await user.click(within(failure).getByRole("button", { name: "Search again" }));

    expect(
      await screen.findByRole("table", { name: "Registered batches matching your search" }),
    ).toBeInTheDocument();
    expect(http.callsTo("GET", "/search")).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * A form's whole lifecycle
 * ------------------------------------------------------------------ */

describe("a form through its lifecycle", () => {
  it("starts with every control available and no error anywhere", async () => {
    sessionAsFarmer();
    renderRegisterForm();

    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    const submit = screen.getByRole("button", { name: "Register this batch" });
    expect(submit).toBeEnabled();
    expect(submit).not.toHaveAttribute("aria-busy");
    expect(
      screen.queryByRole("region", { name: "Registering this batch" }),
    ).not.toBeInTheDocument();

    const controls = Array.from(
      document.querySelectorAll<HTMLElement>("[aria-invalid]"),
    );
    expect(controls).toEqual([]);
  });

  it("moves focus to the control the reader chooses", async () => {
    const user = setupUser();
    sessionAsFarmer();
    renderRegisterForm();

    const cropType = await screen.findByRole("textbox", { name: /Crop or product type/ });
    expect(cropType).not.toHaveFocus();
    await user.click(cropType);
    expect(cropType).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("spinbutton", { name: /^Quantity/ })).toHaveFocus();
    // The focus ring itself belongs to the browser, so nothing is asserted
    // about styling; what is asserted is that focus really moves.
    expect(document.activeElement).toBe(screen.getByRole("spinbutton", { name: /^Quantity/ }));
  });

  it("marks the form invalid without blocking the reader from correcting it", async () => {
    const user = setupUser();
    sessionAsFarmer();
    renderRegisterForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });

    await user.click(screen.getByRole("button", { name: "Register this batch" }));

    const quantity = screen.getByRole("spinbutton", { name: /^Quantity/ });
    expect(quantity).toHaveAttribute("aria-invalid", "true");
    expect(quantity).toHaveAccessibleDescription(/Enter how much of the batch there is\./);

    await user.type(quantity, "1200");
    await waitFor(() => {
      expect(quantity).not.toHaveAttribute("aria-invalid");
    });
    expect(http.callsTo("POST", "/products")).toHaveLength(0);
  });

  it("shows the submit button in its loading state while the server works", async () => {
    const user = setupUser();
    sessionAsFarmer();
    const pending = deferred<ReturnType<typeof makeRegistrationAccepted>>();
    http.on("POST", "/products", () => pending.promise);

    renderRegisterForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillRegisterForm(user);
    await user.click(screen.getByRole("button", { name: "Register this batch" }));

    const submit = await screen.findByRole("button", { name: /Register this batch/ });
    await waitFor(() => {
      expect(submit).toHaveAttribute("aria-busy", "true");
    });
    expect(submit).toBeDisabled();
    // The reason for the wait is announced, and the control cannot be pressed
    // again while it is in flight.
    expect(
      screen.getByText("Saving your details and asking the server to build the transaction"),
    ).toBeInTheDocument();

    pending.resolve(makeRegistrationAccepted());
    await screen.findByText("Waiting for you to sign");
  });

  it("waits for the chain with a progress state that announces itself", async () => {
    const user = setupUser();
    sessionAsFarmer();
    const pending = deferred<ReturnType<typeof makeRegistrationConfirmed>>();
    http.on("POST", "/products", () => makeRegistrationAccepted());
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => pending.promise);

    renderRegisterForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillRegisterForm(user);
    await user.click(screen.getByRole("button", { name: "Register this batch" }));

    // The wallet has been asked and has answered; the cluster has not.
    const progressTitle = await screen.findByText("Waiting for the blockchain");
    const progress = progressTitle.closest("[role='status']") as HTMLElement;
    expect(announcesItself(progress)).toBe(true);
    expect(progress).toHaveAttribute("aria-busy", "true");
    expect(
      within(progress).getByRole("button", { name: /Confirming/ }),
    ).toBeDisabled();

    pending.resolve(makeRegistrationConfirmed());
    expect(
      await screen.findByRole("heading", { level: 1, name: "Batch registered" }),
    ).toBeInTheDocument();
  });

  it("reports success in a live region as well as on the page", async () => {
    const user = setupUser();
    sessionAsFarmer();
    http.on("POST", "/products", () => makeRegistrationAccepted());
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => makeRegistrationConfirmed());

    renderRegisterForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillRegisterForm(user);
    await user.click(screen.getByRole("button", { name: "Register this batch" }));

    await screen.findByRole("heading", { level: 1, name: "Batch registered" });
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(announcesItself(region.querySelector("[aria-live]"))).toBe(true);
    expect(
      within(region).getByText("The batch is recorded on the blockchain"),
    ).toBeInTheDocument();
  });

  it("reports a failure with its recovery step, and retries on request", async () => {
    const user = setupUser();
    sessionAsFarmer();
    let attempt = 0;
    http.on("POST", "/products", () => {
      attempt += 1;
      if (attempt === 1) {
        throw new ApiError({
          code: "DATABASE_UNAVAILABLE",
          status: 503,
          message: "The records service is not reachable, so nothing was saved.",
        });
      }
      return makeRegistrationAccepted();
    });
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => makeRegistrationConfirmed());

    renderRegisterForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillRegisterForm(user);
    await user.click(screen.getByRole("button", { name: "Register this batch" }));

    const failure = await screen.findByText(
      "Could not register this batch on the blockchain",
    );
    const state = failure.closest("[role='alert']") as HTMLElement;
    expect(announcesItself(state)).toBe(true);
    expect(state).toHaveTextContent(
      "The records service is not reachable, so nothing was saved.",
    );
    expect(state).toHaveTextContent("DATABASE_UNAVAILABLE");
    expect(state).toHaveTextContent("Wait about a minute, then repeat the action.");

    await user.click(within(state).getByRole("button", { name: "Prepare again" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Batch registered" }),
    ).toBeInTheDocument();
    expect(http.callsTo("POST", "/products")).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * Unavailable controls
 * ------------------------------------------------------------------ */

describe("controls that are unavailable", () => {
  it("are disabled rather than silently inert", async () => {
    const { rerender } = render(<Button>Do the thing</Button>);
    const button = screen.getByRole("button", { name: "Do the thing" });
    expect(button).toBeEnabled();

    rerender(
      <Button disabled>Do the thing</Button>,
    );
    expect(button).toBeDisabled();

    rerender(
      <Button loading loadingLabel="Working on it">
        Do the thing
      </Button>,
    );
    // A busy button is disabled too, so a second press cannot happen.
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Working on it");
  });

  it("disables the ends of a paginated list instead of hiding the control", () => {
    const onPageChange = vi.fn();
    const first: Pagination = { page: 1, pageSize: 20, total: 45, totalPages: 3 };
    const { rerender } = render(
      <PaginationControls pagination={first} onPageChange={onPageChange} />,
    );

    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();
    expect(screen.getByText(/^Showing 1 to 20 of 45 records$/)).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();

    const last: Pagination = { page: 3, pageSize: 20, total: 45, totalPages: 3 };
    rerender(<PaginationControls pagination={last} onPageChange={onPageChange} />);
    expect(screen.getByRole("button", { name: /Previous/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
    expect(screen.getByText(/^Showing 41 to 45 of 45 records$/)).toBeInTheDocument();

    const empty: Pagination = { page: 1, pageSize: 20, total: 0, totalPages: 0 };
    rerender(<PaginationControls pagination={empty} onPageChange={onPageChange} />);
    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
    expect(screen.getByText(/^Nothing to show records$/)).toBeInTheDocument();
  });

  it("disables the range while a page change is in flight", () => {
    const busy: Pagination = { page: 2, pageSize: 20, total: 45, totalPages: 3 };
    render(<PaginationControls pagination={busy} onPageChange={() => undefined} busy />);

    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
  });

  it("disables the submit button while the form is submitting", async () => {
    const user = setupUser();
    sessionAsFarmer();
    const pending = deferred<ReturnType<typeof makeRegistrationAccepted>>();
    http.on("POST", "/products", () => pending.promise);

    renderRegisterForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillRegisterForm(user);
    await user.click(screen.getByRole("button", { name: "Register this batch" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Register this batch/ })).toBeDisabled();
    });
    pending.resolve(makeRegistrationAccepted());
  });
});

/* ------------------------------------------------------------------ *
 * A second authenticated page, to show the pattern is not page-specific
 * ------------------------------------------------------------------ */

describe("the transfer page", () => {
  const TRANSFER_ID = "trf-1";

  /** The page reads the batch identifier from the route, so it needs one. */
  function TransferRoute() {
    return (
      <Routes>
        <Route path="/app/products/:productId/transfer" element={<ProductTransferPage />} />
      </Routes>
    );
  }
  const RECIPIENT = "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq";

  function transfer(overrides: Partial<Transfer> = {}): Transfer {
    return {
      transferId: TRANSFER_ID,
      onChainTransferRef: "ref-1",
      productId: BATCH_ID,
      fromWallet: FARMER_WALLET.toBase58(),
      toWallet: RECIPIENT,
      toRole: "PROCESSOR",
      fromRole: "FARMER",
      status: "COMPLETED",
      transactionSignature: SIGNATURE,
      previousStatus: "REGISTERED",
      resultingStatus: "IN_PROCESSING",
      note: "Arrived in good condition",
      failureReason: null,
      createdAt: "2026-03-14T12:00:00.000Z",
      submittedAt: "2026-03-14T12:01:00.000Z",
      confirmedAt: "2026-03-14T12:02:00.000Z",
      acknowledgedAt: null,
      ...overrides,
    };
  }

  function serveTransferPage(): void {
    sessionAsFarmer();
    installFakeWallet({ name: "phantom", exposesAddress: true });
    http.on("GET", `/products/${BATCH_ID}`, () => ({
      product: makeProduct(),
      verificationUrl: `https://trace.example/verify/${BATCH_ID}`,
      isOwner: true,
      isRegistrant: true,
      canTransfer: true,
      canRecordProcessing: false,
      canRecordTransport: false,
      canListForSale: false,
    }));
    http.on("GET", "/users/participants", () => ({
      participants: [
        {
          walletAddress: RECIPIENT,
          fullName: "Kola Processing",
          role: "PROCESSOR",
          organisation: "Kola Foods",
          state: "Ogun",
        },
      ],
    }));
  }

  function renderTransferPage(): void {
    serveTransferPage();
    renderWithProviders(<TransferRoute />, `/app/products/${BATCH_ID}/transfer`);
  }

  it("shows the batch first, then the participants who may take it", async () => {
    renderTransferPage();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Hand this batch on" }),
    ).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "The batch you are handing on" });
    expect(within(summary).getByText(BATCH_ID)).toBeInTheDocument();
    expect(within(summary).getByText("Cocoa · 1,200 kg")).toBeInTheDocument();

    const table = await screen.findByRole("table", {
      name: "Participants registered on the blockchain who may receive a batch",
    });
    expect(within(table).getByRole("rowheader", { name: /Kola Processing/ })).toBeInTheDocument();
    // Each participant is offered by a control named for them.
    expect(
      within(table).getByRole("button", { name: "Select Kola Processing" }),
    ).toBeInTheDocument();
  });

  it("refuses an empty or malformed recipient without asking the server", async () => {
    const user = setupUser();
    renderTransferPage();
    await screen.findByRole("heading", { level: 1, name: "Hand this batch on" });

    await user.click(await screen.findByRole("button", { name: /Prepare transfer/ }));
    expect(
      screen.getByText("Choose a recipient from the list, or paste their wallet address."),
    ).toBeInTheDocument();
    expect(document.getElementById("transfer-recipient")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(http.callsTo("POST", /transfers$/)).toHaveLength(0);

    const recipient = screen.getByLabelText(/Recipient wallet address/);
    await user.clear(recipient);
    await user.type(recipient, "not-a-wallet");
    await user.click(screen.getByRole("button", { name: /Prepare transfer/ }));
    expect(recipient).toHaveAccessibleDescription(
      /That is not a Solana wallet address\. A wallet address is 32 to 44 letters and digits, with no letter O, I, l or zero\./,
    );
    expect(http.callsTo("POST", /transfers$/)).toHaveLength(0);
  });

  it("waits for the chain with a progress state, then confirms", async () => {
    const user = setupUser();
    serveTransferPage();
    const pending = deferred<Transfer>();
    http.on("POST", `/products/${BATCH_ID}/transfers`, () => ({
      transfer: transfer({
        status: "PREPARED",
        transactionSignature: null,
        confirmedAt: null,
      }),
      prepared: makePrepared({ description: "Hand AGT-COCOA-2026-A1B2C3 to Kola Processing" }),
    }));
    http.on("POST", `/transfers/${TRANSFER_ID}/submit`, () => pending.promise);

    renderWithProviders(<TransferRoute />, `/app/products/${BATCH_ID}/transfer`);
    await screen.findByRole("heading", { level: 1, name: "Hand this batch on" });
    await user.click(await screen.findByRole("button", { name: "Select Kola Processing" }));
    await user.click(screen.getByRole("button", { name: /Prepare transfer/ }));

    const progressTitle = await screen.findByText("Waiting for the blockchain");
    const progress = progressTitle.closest("[role='status']") as HTMLElement;
    expect(announcesItself(progress)).toBe(true);
    expect(progress).toHaveAttribute("aria-busy", "true");
    // While the write is in flight the form's own submit is unavailable.
    expect(screen.getByRole("button", { name: /Prepare transfer/ })).toBeDisabled();

    pending.resolve(transfer());

    expect(
      await screen.findByText("The batch now belongs to the recipient"),
    ).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "The batch now belongs to the recipient" });
    expect(within(panel).getByText("A processor, who holds the batch from now on.")).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: /Open the transfer record/ }),
    ).toHaveAttribute("href", `/app/transfers/${TRANSFER_ID}`);

    // The confirmation panel must read the transfer the submit call returned,
    // because the prepared record cannot carry a transaction signature: the
    // server does not have one until the participant signs. The signature is
    // shown truncated, so it is asserted through its accessible name.
    expect(
      within(panel).getByLabelText(`Transaction signature ${SIGNATURE}`),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByText("No transaction has been recorded yet."),
    ).not.toBeInTheDocument();
  });

  it("offers a retry when the transfer is refused", async () => {
    const user = setupUser();
    serveTransferPage();
    let attempt = 0;
    http.on("POST", `/products/${BATCH_ID}/transfers`, () => {
      attempt += 1;
      if (attempt === 1) {
        throw new ApiError({
          code: "RECIPIENT_NOT_REGISTERED",
          status: 409,
          message: "That wallet is not a registered participant.",
        });
      }
      return {
        transfer: transfer({
          status: "PREPARED",
          transactionSignature: null,
          confirmedAt: null,
        }),
        prepared: makePrepared(),
      };
    });
    http.on("POST", `/transfers/${TRANSFER_ID}/submit`, () => transfer());

    renderWithProviders(<TransferRoute />, `/app/products/${BATCH_ID}/transfer`);
    await screen.findByRole("heading", { level: 1, name: "Hand this batch on" });
    await user.click(await screen.findByRole("button", { name: "Select Kola Processing" }));
    await user.click(screen.getByRole("button", { name: /Prepare transfer/ }));

    const failure = await screen.findByText("Could not hand this batch over");
    const state = failure.closest("[role='alert']") as HTMLElement;
    expect(announcesItself(state)).toBe(true);
    expect(state).toHaveTextContent("That wallet is not a registered participant.");
    expect(state).toHaveTextContent("RECIPIENT_NOT_REGISTERED");
    expect(state).toHaveTextContent("Ask the recipient to register, then select them again.");

    await user.click(within(state).getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("The batch now belongs to the recipient"),
    ).toBeInTheDocument();
    expect(http.callsTo("POST", `/products/${BATCH_ID}/transfers`)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * Every changing region announces itself
 * ------------------------------------------------------------------ */

describe("live regions", () => {
  it("covers every state a list can be in", async () => {
    const user = setupUser();
    const pending = deferred<{ results: SearchResult[] }>();
    http.on("GET", "/search", () => pending.promise);

    const { container } = renderWithProviders(<SearchPage />, "/search");
    await runSearch(user);

    // Loading.
    let status = await screen.findByRole("status");
    expect(announcesItself(status)).toBe(true);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();

    // Populated.
    pending.resolve({ results: [result()] });
    await screen.findByRole("table", { name: "Registered batches matching your search" });
    status = screen.getByRole("status");
    expect(announcesItself(status)).toBe(true);
    expect(container.querySelector("[aria-busy='false']")).not.toBeNull();
  });

  it("covers the failure state of a form as well as its progress", async () => {
    const user = setupUser();
    sessionAsFarmer();
    http.on("POST", "/products", () => {
      throw new ApiError({ code: "INTERNAL_ERROR", status: 500 });
    });

    renderRegisterForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillRegisterForm(user);
    await user.click(screen.getByRole("button", { name: "Register this batch" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(announcesItself(alert)).toBe(true);
    }
  });
});
