import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ERROR_MESSAGES, RECOVERY_HINTS } from "../api/errors";
import { TransactionState, type TransactionPhase } from "../components/states";
import RegisterProductPage from "../pages/app/products/RegisterProductPage";
import { todayInputValue } from "../lib/format";
import {
  BATCH_ID,
  DATA_HASH,
  expectClusterGenesis,
  FARMER_WALLET,
  installFakeWallet,
  makePrepared,
  makeRegistrationAccepted,
  makeRegistrationConfirmed,
  mockApi,
  renderWithProviders,
  resetBrowserState,
  setupUser,
  restoreGlobalTypedArrayRealm,
  SIGNATURE,
  useNodeTypedArrayRealm,
  type ApiMock,
  type FakeWallet,
  type UserEvent,
} from "./harness";

/**
 * The farmer's registration form, and the shared `TransactionState` that every
 * blockchain write in the application renders.
 *
 * The typed-array realm shim is enabled because the two-phase flow really does
 * parse and re-serialise a Solana transaction: `WalletContext.deserializeTransaction`
 * reads the server's bytes and `serializeSignedTransaction` writes the wallet's
 * back. Under jsdom those two operations fail for realm reasons, not logic ones.
 */

let http: ApiMock;
let wallet: FakeWallet;

/** The harvest date the form starts with, so a submission is never "in the future". */
const HARVEST = "2026-03-14";

const VALID_FORM = {
  "Crop or product type": "Cocoa",
  Quantity: "1200",
  "Farm location": "Abeokuta, Ogun State",
  Description: "Forastero cocoa beans, sun dried on raised beds.",
} as const;

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

function renderForm(): void {
  renderWithProviders(<RegisterProductPage />, "/app/products/register");
}

/** Fills in every required field with a plausible value. */
async function fillValidForm(user: UserEvent): Promise<void> {
  await user.clear(screen.getByLabelText(/^Harvest date/));
  await user.type(screen.getByLabelText(/^Harvest date/), HARVEST);
  for (const [label, value] of Object.entries(VALID_FORM)) {
    const control = screen.getByLabelText(new RegExp(`^${label}`));
    await user.type(control, value);
  }
}

const submitButton = (): HTMLElement => screen.getByRole("button", { name: /Register this batch/ });

beforeAll(() => {
  useNodeTypedArrayRealm();
});

afterAll(() => {
  restoreGlobalTypedArrayRealm();
});

beforeEach(() => {
  expectClusterGenesis(true);
  http = mockApi();
  sessionAsFarmer();
  // Connected, so the form is reachable at all.
  wallet = installFakeWallet({ name: "phantom", exposesAddress: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBrowserState();
});

/* ------------------------------------------------------------------ *
 * The form
 * ------------------------------------------------------------------ */

describe("the fields the specification names", () => {
  it("renders every one of them, each with an accessible name", async () => {
    renderForm();

    await screen.findByRole("heading", { level: 1, name: "Register a batch" });

    expect(screen.getByRole("textbox", { name: /Batch identifier/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Crop or product type/ })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /^Quantity/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Unit/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Harvest date/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Farm location/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Description/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Additional notes/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Photographs of the batch")).toBeInTheDocument();
    expect(screen.getByLabelText("Certificates")).toBeInTheDocument();

    // The unit is a closed list of what a batch is actually counted in.
    const unit = screen.getByRole("combobox", { name: /^Unit/ });
    expect(
      within(unit).getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "Kilograms (kg)",
      "Tonnes",
      "Bags (typically 50 kg)",
      "Crates",
      "Bunches",
      "Pieces",
    ]);

    // The upload limits are stated, and are the ones the server reported.
    expect(
      screen.getByText(/JPEG, PNG or WebP, up to 5 MB each, 6 at a time/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/PDF only, up to 5 MB each, 3 at a time/),
    ).toBeInTheDocument();
  });

  it("shows what will be written, so the fingerprint is never a surprise", async () => {
    const user = setupUser();
    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);

    const payload = screen.getByText(/^crop /);
    expect(payload).toHaveTextContent("crop Cocoa");
    expect(payload).toHaveTextContent("1,200 kg");
    expect(payload).toHaveTextContent("at Abeokuta, Ogun State");
    expect(payload).toHaveTextContent(": Forastero cocoa beans, sun dried on raised beds.");
    expect(screen.getByText(/Registered by Amina Bello as a farmer/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "This is the payload the fingerprint is computed from. Read it as if it were permanent, because it is.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/only your wallet can transfer it on/),
    ).toBeInTheDocument();
  });
});

describe("submitting an incomplete form", () => {
  it("puts a specific message beside every missing required field and calls nothing", async () => {
    const user = setupUser();
    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    // The form offers today's date as a starting point; clear it so every
    // required field is genuinely empty.
    await user.clear(screen.getByLabelText(/^Harvest date/));

    await user.click(submitButton());

    const expected: ReadonlyArray<readonly [string, string]> = [
      ["register-crop-type", "Name the crop or product, for example cocoa, maize or cashew."],
      ["register-quantity", "Enter how much of the batch there is."],
      [
        "register-farm-location",
        "Describe where the batch was grown, for example the village, the local government area and the state.",
      ],
      [
        "register-description",
        "Describe the batch in at least ten characters: the variety, how it was grown, and anything a buyer would want to know.",
      ],
      ["register-harvest-date", "Enter the date the batch was harvested."],
    ];

    for (const [fieldId, message] of expected) {
      const control = document.getElementById(fieldId) as HTMLElement;
      expect(control, `no control with id ${fieldId}`).not.toBeNull();
      expect(control).toHaveAttribute("aria-invalid", "true");
      // The message is the control's own description, which is what makes it
      // "next to" the field rather than merely near it.
      const describedBy = (control.getAttribute("aria-describedby") ?? "").split(/\s+/);
      const errorId = describedBy.find((id) => id === `${fieldId}-error`);
      expect(errorId, `aria-describedby for ${fieldId}`).toBeDefined();
      expect(document.getElementById(errorId as string)).toHaveTextContent(message);
    }

    // Optional fields are not turned into errors.
    expect(document.getElementById("register-product-id")).not.toHaveAttribute(
      "aria-invalid",
    );
    expect(document.getElementById("register-notes")).not.toHaveAttribute("aria-invalid");

    expect(http.callsTo("POST", "/products")).toHaveLength(0);
    expect(http.callsTo("POST", /submit$/)).toHaveLength(0);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("warns once, in a live region, rather than only colouring the fields", async () => {
    const user = setupUser();
    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });

    await user.click(submitButton());

    const region = await screen.findByRole("region", { name: "Notifications" });
    expect(within(region).getByText("The form still needs attention")).toBeInTheDocument();
    expect(
      within(region).getByText("Correct the highlighted fields, then submit again."),
    ).toBeInTheDocument();
    expect(within(region).getByRole("list")).toHaveAttribute("aria-live", "polite");
  });

  it("clears a field's error as soon as it is corrected", async () => {
    const user = setupUser();
    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });

    await user.click(submitButton());
    expect(document.getElementById("register-crop-type")).toHaveAttribute("aria-invalid", "true");

    await user.type(screen.getByLabelText(/Crop or product type/), "Cocoa");
    await waitFor(() => {
      expect(document.getElementById("register-crop-type")).not.toHaveAttribute("aria-invalid");
    });
  });
});

describe("an identifier in the wrong shape", () => {
  it("is refused in the browser, naming the format expected", async () => {
    const user = setupUser();
    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);

    await user.type(screen.getByLabelText(/Batch identifier/), "cocoa-2026-01");
    await user.click(submitButton());

    const control = document.getElementById("register-product-id") as HTMLElement;
    expect(control).toHaveAttribute("aria-invalid", "true");
    const message =
      "That is not a batch identifier. Use the AGT-COCOA-2026-A1B2C3 form, or leave it blank and let the server suggest one.";
    expect(document.getElementById("register-product-id-error")).toHaveTextContent(message);
    // The hint spells the format out too, so the rule is learnable.
    expect(screen.getByText(/the prefix AGT, a crop code of three to six characters/)).toBeInTheDocument();
    expect(http.callsTo("POST", "/products")).toHaveLength(0);
  });

  it("is accepted once it matches, upper case and all", async () => {
    const user = setupUser();
    http.on("POST", "/products", () => makeRegistrationAccepted());
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => makeRegistrationConfirmed());
    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);

    const identifier = screen.getByLabelText(/Batch identifier/);
    await user.type(identifier, "agt-maize-2026-d4e5f6");

    // The control upper-cases as the farmer types, so what is sent is canonical.
    expect(identifier).toHaveValue("AGT-MAIZE-2026-D4E5F6");

    await user.click(submitButton());
    await screen.findByRole("heading", { level: 1, name: "Batch registered" });
  });
});

/* ------------------------------------------------------------------ *
 * The two-phase flow
 * ------------------------------------------------------------------ */

describe("a valid submission", () => {
  it("prepares, signs through the wallet, then submits, in that order", async () => {
    const user = setupUser();
    let submittedBody: { signedTransaction: string } | null = null;
    http.on("POST", "/products", () => makeRegistrationAccepted());
    http.on("POST", /^\/products\/[^/]+\/submit$/, (options) => {
      submittedBody = options.body as { signedTransaction: string };
      return makeRegistrationConfirmed();
    });

    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);
    await user.click(submitButton());

    await screen.findByRole("heading", { level: 1, name: "Batch registered" });

    // The call sequence, asserted by the order the mocks were invoked in. The
    // session check and the health check are requests too, so they are filtered
    // out before the two that matter are compared.
    const postOrders = http.request.mock.calls
      .map((call, index) => ({
        method: call[0],
        order: http.request.mock.invocationCallOrder[index] as number,
      }))
      .filter((entry) => entry.method === "POST")
      .map((entry) => entry.order);
    const signOrder = wallet.signTransaction.mock.invocationCallOrder[0] as number;

    expect(postOrders).toHaveLength(2);
    const [prepareOrder, submitOrder] = postOrders as [number, number];
    expect(prepareOrder).toBeLessThan(signOrder);
    expect(signOrder).toBeLessThan(submitOrder);

    // And the endpoints themselves, in order.
    const postCalls = http.calls.filter((call) => call.method === "POST");
    expect(postCalls.map((call) => call.path)).toEqual([
      "/products",
      `/products/${BATCH_ID}/submit`,
    ]);

    // The bytes the server prepared really were parsed and really were signed.
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    const signed = wallet.signTransaction.mock.calls[0]?.[0];
    expect(signed).toBeDefined();
    expect(signed?.recentBlockhash).toBe(makePrepared().blockhash);
    expect(signed?.feePayer?.toBase58()).toBe(FARMER_WALLET.toBase58());

    // The submitted bytes are the serialised transaction, not an empty string.
    const body = submittedBody as { signedTransaction: string } | null;
    expect(body).not.toBeNull();
    expect((body as { signedTransaction: string }).signedTransaction.length).toBeGreaterThan(100);
  });

  it("sends the entered details as the multipart payload the server expects", async () => {
    const user = setupUser();
    let sent: FormData | null = null;
    http.on("POST", "/products", (options) => {
      sent = options.formData as FormData;
      return makeRegistrationAccepted();
    });
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => makeRegistrationConfirmed());

    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);
    await user.type(screen.getByLabelText(/Additional notes/), "Stored at 24 degrees Celsius.");
    await user.upload(
      screen.getByLabelText("Photographs of the batch"),
      new File([new Uint8Array([1, 2, 3])], "beans.jpg", { type: "image/jpeg" }),
    );
    await user.upload(
      screen.getByLabelText("Certificates"),
      new File([new Uint8Array([4, 5, 6])], "organic.pdf", { type: "application/pdf" }),
    );

    await user.click(submitButton());
    await screen.findByRole("heading", { level: 1, name: "Batch registered" });

    const body = sent as FormData | null;
    expect(body).not.toBeNull();
    expect(body?.get("cropType")).toBe("Cocoa");
    expect(body?.get("quantity")).toBe("1200");
    expect(body?.get("unit")).toBe("kg");
    expect(body?.get("farmLocation")).toBe("Abeokuta, Ogun State");
    expect(body?.get("description")).toBe("Forastero cocoa beans, sun dried on raised beds.");
    expect(body?.get("additionalNotes")).toBe("Stored at 24 degrees Celsius.");
    // The date is sent as an ISO timestamp, as the API contract requires.
    expect(String(body?.get("harvestDate"))).toMatch(/^2026-03-14T/);
    // The identifier is left out when the farmer did not choose one.
    expect(body?.get("productId")).toBeNull();
    expect((body?.getAll("images") as File[]).map((file) => file.name)).toEqual(["beans.jpg"]);
    expect((body?.getAll("certificates") as File[]).map((file) => file.name)).toEqual([
      "organic.pdf",
    ]);
  });
});

describe("a wallet that refuses to sign", () => {
  it("shows a signature-rejected state with a retry, and never a success", async () => {
    const user = setupUser();
    http.on("POST", "/products", () => makeRegistrationAccepted());
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => makeRegistrationConfirmed());
    wallet.signTransaction.mockRejectedValueOnce({
      code: 4001,
      message: "User rejected the request.",
    });

    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);
    await user.click(submitButton());

    expect(await screen.findByText("You declined to sign")).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing was written to the blockchain and the record is unchanged/),
    ).toBeInTheDocument();
    // Nothing was submitted, so nothing was confirmed.
    expect(http.callsTo("POST", /submit$/)).toHaveLength(0);
    expect(
      screen.queryByRole("heading", { level: 1, name: "Batch registered" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Confirmed on Solana")).not.toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "Prepare again" });
    expect(retry).toBeEnabled();
    await user.click(retry);

    // A second attempt signs, submits and confirms.
    await screen.findByRole("heading", { level: 1, name: "Batch registered" });
    expect(http.callsTo("POST", "/products")).toHaveLength(2);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(2);
  });

  it("keeps the same identifier on a retry, so no second batch is created", async () => {
    const user = setupUser();
    http.on("POST", "/products", () => makeRegistrationAccepted());
    wallet.signTransaction.mockRejectedValueOnce({ code: 4001, message: "User rejected." });

    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);
    await user.click(submitButton());
    await screen.findByText("You declined to sign");

    expect(
      screen.getByText(/the same batch identifier is reused, not a new one/),
    ).toBeInTheDocument();
  });
});

describe("a transaction Solana refuses", () => {
  it("shows the code, the message and a recovery step, with a retry", async () => {
    const user = setupUser();
    http.on("POST", "/products", () => makeRegistrationAccepted());
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => {
      throw new ApiError({
        code: "BLOCKCHAIN_TRANSACTION_FAILED",
        status: 0,
        message: "Solana rejected the transaction while the fee payer was being set.",
        requestId: "req-77aa",
      });
    });

    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);
    await user.click(submitButton());

    const failure = await screen.findByText("Could not register this batch on the blockchain");
    const state = failure.closest("[role='alert']") as HTMLElement;
    expect(state).toHaveTextContent(
      "Solana rejected the transaction while the fee payer was being set.",
    );
    expect(state).toHaveTextContent("BLOCKCHAIN_TRANSACTION_FAILED");
    expect(state).toHaveTextContent("req-77aa");
    expect(state).toHaveTextContent(
      RECOVERY_HINTS.BLOCKCHAIN_TRANSACTION_FAILED as string,
    );
    expect(within(state).getByRole("button", { name: "Prepare again" })).toBeEnabled();
    expect(within(state).getByRole("button", { name: /Abandon the draft/ })).toBeEnabled();
    expect(
      screen.queryByRole("heading", { level: 1, name: "Batch registered" }),
    ).not.toBeInTheDocument();
  });

  it("falls back to the local sentence when the server sends none", async () => {
    const user = setupUser();
    http.on("POST", "/products", () => makeRegistrationAccepted());
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => {
      throw new ApiError({ code: "BLOCKCHAIN_RPC_UNAVAILABLE", status: 0 });
    });

    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);
    await user.click(submitButton());

    const state = (await screen.findByText(
      "Could not register this batch on the blockchain",
    )).closest("[role='alert']") as HTMLElement;
    expect(state).toHaveTextContent(ERROR_MESSAGES.BLOCKCHAIN_RPC_UNAVAILABLE);
  });

  it("reports a prepare failure with the field the server objected to", async () => {
    const user = setupUser();
    http.on("POST", "/products", () => {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        status: 422,
        message: "That identifier is already registered.",
        details: [{ path: "productId", message: "That identifier is already registered." }],
      });
    });

    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);
    await user.type(screen.getByLabelText(/Batch identifier/), BATCH_ID);
    await user.click(submitButton());

    await waitFor(() => {
      expect(document.getElementById("register-product-id")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });
    expect(
      document.getElementById("register-product-id-error"),
    ).toHaveTextContent("That identifier is already registered.");
  });
});

describe("a confirmed registration", () => {
  it("shows the batch, the signature, a QR code, a copyable link and what to do next", async () => {
    const user = setupUser();
    const clipboard = { written: [] as string[] };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async (value: string) => {
          clipboard.written.push(value);
        }),
      },
    });

    http.on("POST", "/products", () => makeRegistrationAccepted());
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => makeRegistrationConfirmed());

    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);
    await user.click(submitButton());

    expect(
      await screen.findByRole("heading", { level: 1, name: "Batch registered" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Batch ${BATCH_ID} is on the blockchain`),
    ).toBeInTheDocument();

    // The facts of what was written.
    expect(screen.getByText(BATCH_ID)).toBeInTheDocument();
    expect(screen.getByText(SIGNATURE)).toBeInTheDocument();
    expect(screen.getByText("254123")).toBeInTheDocument();
    expect(screen.getByText(DATA_HASH)).toBeInTheDocument();

    // The QR code, named for the batch rather than left as decoration.
    const code = await screen.findByRole("img", {
      name: `Verification QR code for batch ${BATCH_ID}`,
    });
    expect(code).toHaveAttribute("width", "192");
    expect(code).toHaveAttribute("height", "192");
    expect(code.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(
      screen.getByRole("link", { name: /Download code/ }),
    ).toHaveAttribute("download", `verification-${BATCH_ID}.png`);

    // The shareable link, and a control that copies it.
    const link = `https://trace.example/verify/${BATCH_ID}`;
    expect(screen.getAllByText(link).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: /Open the verification page/ }),
    ).toHaveAttribute("href", link);
    await user.click(screen.getByRole("button", { name: "Copy the link" }));
    expect(clipboard.written).toContain(link);

    // Concrete next actions, each a real destination.
    const next = screen.getByRole("region", { name: "What to do next" });
    expect(
      within(next).getByRole("link", { name: /Open the batch/ }),
    ).toHaveAttribute("href", `/app/products/${BATCH_ID}`);
    expect(
      within(next).getByRole("link", { name: /See the public verification page/ }),
    ).toHaveAttribute("href", `/verify/${BATCH_ID}`);
    expect(within(next).getByText(/Step 1\./)).toBeInTheDocument();
    expect(within(next).getByText(/Step 2\./)).toBeInTheDocument();
    expect(within(next).getByText(/Step 3\./)).toBeInTheDocument();
    expect(
      within(next).getByRole("button", { name: /Register another batch/ }),
    ).toBeEnabled();
  });

  it("confirms in a live region, so the outcome is not visual only", async () => {
    const user = setupUser();
    http.on("POST", "/products", () => makeRegistrationAccepted());
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => makeRegistrationConfirmed());

    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);
    await user.click(submitButton());

    await screen.findByRole("heading", { level: 1, name: "Batch registered" });
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(
      within(region).getByText("The batch is recorded on the blockchain"),
    ).toBeInTheDocument();
  });

  it("returns to a fresh form when another batch is registered", async () => {
    const user = setupUser();
    http.on("POST", "/products", () => makeRegistrationAccepted());
    http.on("POST", /^\/products\/[^/]+\/submit$/, () => makeRegistrationConfirmed());

    renderForm();
    await screen.findByRole("heading", { level: 1, name: "Register a batch" });
    await fillValidForm(user);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 1, name: "Batch registered" });

    await user.click(screen.getByRole("button", { name: /Register another batch/ }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Register a batch" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Crop or product type/)).toHaveValue("");
    expect(screen.getByLabelText(/^Harvest date/)).toHaveValue(todayInputValue());
  });
});

describe("the page before a wallet is connected", () => {
  it("asks for a wallet rather than showing a form that could not work", async () => {
    // The wallet is installed but has not shared an address.
    wallet.setPublicKey(null);

    renderForm();

    expect(await screen.findByText("Connect your wallet")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Everything recorded here is signed by the wallet that holds the batch/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Crop or product type/)).not.toBeInTheDocument();
  });
});

describe("the page with no wallet in the browser at all", () => {
  it("offers the installation route rather than a connect button that cannot work", async () => {
    resetBrowserState();

    renderForm();

    expect(
      await screen.findByText("No Solana wallet found in this browser"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Install Phantom, Backpack or Solflare from your browser's extension store/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Reload the page/ }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Crop or product type/)).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * TransactionState, driven through its props
 * ------------------------------------------------------------------ */

describe("TransactionState", () => {
  const PREPARED = makePrepared();
  const STEP_LABELS = [
    "The server builds the transaction",
    "You sign it in your wallet",
    "Solana confirms it",
  ] as const;

  function renderPhase(
    phase: TransactionPhase,
    props: Partial<ComponentProps<typeof TransactionState>> = {},
  ): HTMLElement {
    const { container } = render(
      <TransactionState phase={phase} {...props} />,
    );
    const root = container.querySelector(".transaction") as HTMLElement;
    expect(root).not.toBeNull();
    return root;
  }

  /** The visible step markers, with the state the component assigned to each. */
  function stepStates(root: HTMLElement): string[] {
    return Array.from(root.querySelectorAll("[data-state]")).map(
      (item) => item.getAttribute("data-state") as string,
    );
  }

  function stepText(root: HTMLElement): string[] {
    return STEP_LABELS.map((label) => {
      const item = Array.from(root.querySelectorAll("li")).find((li) =>
        (li.textContent ?? "").includes(label),
      );
      return item?.textContent ?? "";
    });
  }

  function actionNames(root: HTMLElement): string[] {
    return Array.from(root.querySelectorAll("button")).map(
      (button) => button.textContent ?? "",
    );
  }

  it("always announces itself, so a change is heard and not only seen", () => {
    for (const phase of [
      "idle",
      "preparing",
      "awaiting-signature",
      "signature-rejected",
      "submitted",
      "confirming",
      "confirmed",
      "failed",
      "timed-out",
    ] as const) {
      const root = renderPhase(phase, { onPrepare: () => undefined });
      expect(root, phase).toHaveAttribute("role", "status");
      expect(root, phase).toHaveAttribute("aria-live", "polite");
    }
  });

  it("marks only the phases that are genuinely in flight as busy", () => {
    for (const phase of ["preparing", "submitted", "confirming"] as const) {
      expect(renderPhase(phase), phase).toHaveAttribute("aria-busy", "true");
    }
    for (const phase of [
      "idle",
      "awaiting-signature",
      "signature-rejected",
      "confirmed",
      "failed",
      "timed-out",
    ] as const) {
      expect(renderPhase(phase, { onPrepare: () => undefined }), phase).not.toHaveAttribute(
        "aria-busy",
      );
    }
  });

  it("shows the three steps, marking how far the sequence has got", () => {
    // The value is the one-based index of the step currently under way, so the
    // step the participant is on always announces itself as "Now" and, once
    // Solana has confirmed, all three read as completed.
    const cases: ReadonlyArray<readonly [TransactionPhase, string[]]> = [
      ["idle", ["todo", "todo", "todo"]],
      ["preparing", ["current", "todo", "todo"]],
      ["awaiting-signature", ["done", "current", "todo"]],
      ["signature-rejected", ["done", "current", "todo"]],
      ["submitted", ["done", "done", "current"]],
      ["confirming", ["done", "done", "current"]],
      ["confirmed", ["done", "done", "done"]],
      ["failed", ["done", "done", "current"]],
      ["timed-out", ["done", "done", "current"]],
    ];

    for (const [phase, expected] of cases) {
      const root = renderPhase(phase, { onPrepare: () => undefined });
      expect(stepStates(root), phase).toEqual(expected);
      expect(stepText(root), phase).toHaveLength(3);
    }

    // The state is in words, so it does not depend on colour or on position.
    const preparing = renderPhase("preparing");
    expect(stepText(preparing)[0]).toContain("Now: The server builds the transaction");
    const awaiting = renderPhase("awaiting-signature");
    expect(stepText(awaiting)[0]).toContain("Completed: The server builds the transaction");
    expect(stepText(awaiting)[1]).toContain("Now: You sign it in your wallet");
    const confirming = renderPhase("confirming");
    expect(stepText(confirming)[0]).toContain("Completed: The server builds the transaction");
    expect(stepText(confirming)[1]).toContain("Completed: You sign it in your wallet");
    expect(stepText(confirming)[2]).toContain("Now: Solana confirms it");
    const confirmed = renderPhase("confirmed");
    for (const text of stepText(confirmed)) {
      expect(text).toContain("Completed:");
    }
  });

  it("says what will happen before anything is signed", () => {
    const root = renderPhase("idle", { onPrepare: () => undefined });

    expect(root).toHaveTextContent("Ready to record this on the blockchain");
    expect(root).toHaveTextContent(
      "Preparing asks the server to build the transaction. You will then see it in your wallet, where you decide whether to sign. Nothing is written until you sign.",
    );
    expect(actionNames(root)).toEqual(["Prepare the transaction"]);
  });

  it("disables the prepare action when there is nothing to prepare with", () => {
    const root = renderPhase("idle");
    const button = root.querySelector("button") as HTMLButtonElement;
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Prepare the transaction");
  });

  it("puts the prepare action in its loading state while preparing", () => {
    const root = renderPhase("preparing");

    expect(root).toHaveTextContent("Building the transaction");
    expect(root).toHaveTextContent(
      "The server is assembling the transaction against a live Solana block. This usually takes a second or two.",
    );
    const button = root.querySelector("button") as HTMLButtonElement;
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Preparing");
    expect(root).toHaveTextContent("Building the transaction");
  });

  it("explains the wallet prompt and its deadline, and offers sign and cancel", () => {
    const onSign = vi.fn();
    const onCancel = vi.fn();
    const root = renderPhase("awaiting-signature", {
      prepared: PREPARED,
      onSign,
      onCancel,
    });

    expect(root).toHaveTextContent("Waiting for you to sign");
    expect(root).toHaveTextContent(
      "Open your wallet and approve the transaction. The transaction is only valid for a short time, because Solana blockhashes expire. If it expires, prepare it again.",
    );
    // The deadline and the account the transaction acts on are both printed.
    expect(root).toHaveTextContent("Valid for about 120 seconds");
    expect(root).toHaveTextContent(PREPARED.targetAddress.slice(0, 4));
    expect(root).toHaveTextContent("254000");

    expect(actionNames(root)).toEqual(["Sign and submit", "Cancel"]);
    const sign = root.querySelector("button") as HTMLButtonElement;
    expect(sign).toBeEnabled();
    sign.click();
    expect(onSign).toHaveBeenCalledTimes(1);
    (root.querySelectorAll("button")[1] as HTMLButtonElement).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables the sign action when there is nothing to sign", () => {
    const root = renderPhase("awaiting-signature", { prepared: PREPARED });
    expect((root.querySelector("button") as HTMLButtonElement)).toBeDisabled();
    expect(actionNames(root)).toEqual(["Sign and submit"]);
  });

  it("treats a declined signature as a normal outcome, with a retry", () => {
    const onPrepare = vi.fn();
    const root = renderPhase("signature-rejected", {
      prepared: PREPARED,
      onPrepare,
      retryLabel: "Prepare again",
      cancelLabel: "Abandon this draft",
      onCancel: () => undefined,
    });

    expect(root).toHaveTextContent("You declined to sign");
    expect(root).toHaveTextContent(
      "Nothing was written to the blockchain and the record is unchanged. You can prepare the same action again whenever you are ready.",
    );
    expect(actionNames(root)).toEqual(["Prepare again", "Abandon this draft"]);
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(onPrepare).toHaveBeenCalledTimes(1);
    // A decline is an ordinary outcome, not a fault: no error code is shown,
    // only the deadline for the transaction that was never signed.
    expect(root).not.toHaveTextContent("WALLET_SIGNATURE_REJECTED");
    expect(root).toHaveTextContent("Valid for about 120 seconds");
  });

  it("says the transaction is already with Solana while it waits", () => {
    const submitted = renderPhase("submitted", { signature: SIGNATURE });
    expect(submitted).toHaveTextContent("Sent to Solana");
    expect(submitted).toHaveTextContent(
      "The signed transaction has been submitted to the cluster and is waiting for a slot. This finishes on its own.",
    );
    const confirming = renderPhase("confirming", { signature: SIGNATURE });
    expect(confirming).toHaveTextContent("Waiting for the blockchain");
    expect(confirming).toHaveTextContent(
      "Solana is confirming the transaction. Once it does, the server re-reads the on-chain account and only then marks the record as complete.",
    );
    for (const root of [submitted, confirming]) {
      const button = root.querySelector("button") as HTMLButtonElement;
      expect(button).toHaveTextContent("Confirming");
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-busy", "true");
    }
  });

  it("confirms with the signature, the slot and a way to check it independently", () => {
    const root = renderPhase("confirmed", { signature: SIGNATURE, slot: 254123 });

    expect(root).toHaveTextContent("Confirmed on Solana");
    expect(root).toHaveTextContent(
      "The record is on the blockchain and matches the details held here. The signature below can be checked by anyone.",
    );
    expect(root).toHaveTextContent(SIGNATURE);
    expect(root).toHaveTextContent("Slot 254123");
    const explorer = root.querySelector("a[href*='explorer.solana.com']") as HTMLAnchorElement;
    expect(explorer).not.toBeNull();
    expect(explorer.getAttribute("href")).toContain(`/tx/${SIGNATURE}`);
    expect(explorer.getAttribute("rel") ?? "").toContain("noopener");
    // A confirmed transaction needs no further action from this component.
    expect(actionNames(root)).toEqual([]);
  });

  it("omits the explorer link when there is no signature to look up", () => {
    const root = renderPhase("confirmed", { slot: 1 });
    expect(root.querySelector("a")).toBeNull();
    expect(root.querySelector(".transaction__links")).toBeNull();
  });

  it("shows the failure, the reason and a retry", () => {
    const onRetry = vi.fn();
    const root = renderPhase("failed", {
      error: new ApiError({
        code: "BLOCKCHAIN_TRANSACTION_FAILED",
        status: 0,
        message: "Solana rejected the transaction while the fee payer was being set.",
      }),
      onRetry,
    });

    expect(root).toHaveTextContent("The blockchain write did not complete");
    expect(root).toHaveTextContent(
      "Nothing was recorded. Read the detail below, then prepare the action again.",
    );
    expect(root).toHaveTextContent(
      "Solana rejected the transaction while the fee payer was being set.",
    );
    expect(actionNames(root)).toEqual(["Prepare again"]);
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("gives a confirmation timeout its own wording", () => {
    const root = renderPhase("failed", {
      error: new ApiError({
        code: "BLOCKCHAIN_CONFIRMATION_TIMEOUT",
        status: 0,
        message: "The transaction reached Solana but confirmation took too long.",
      }),
    });

    expect(root).toHaveTextContent("Confirmation took too long");
    expect(root).toHaveTextContent(
      "The transaction reached Solana but was not confirmed in time. It may still settle, so open the record before trying again.",
    );
  });

  it("explains an expired blockhash as an expiry, not a fault", () => {
    const root = renderPhase("timed-out", {
      prepared: PREPARED,
      error: new ApiError({
        code: "BLOCKCHAIN_TRANSACTION_FAILED",
        status: 0,
        message:
          "This transaction was valid for about 120 seconds and that time has passed, so it can no longer be signed. Nothing was recorded.",
      }),
      onPrepare: () => undefined,
    });

    expect(root).toHaveTextContent("The prepared transaction expired");
    expect(root).toHaveTextContent(
      "Solana transactions are only valid for a short window. Nothing was recorded. Prepare the action again to get a fresh one, and sign it straight away.",
    );
    expect(root).toHaveTextContent(
      "This transaction was valid for about 120 seconds and that time has passed",
    );
    expect(actionNames(root)).toEqual(["Prepare again"]);
  });

  it("disables the retry when neither a retry nor a prepare handler is offered", () => {
    expect((renderPhase("failed").querySelector("button") as HTMLButtonElement)).toBeDisabled();
    expect((renderPhase("timed-out").querySelector("button") as HTMLButtonElement)).toBeDisabled();
  });

  it("prepends the server's own description of what the transaction does", () => {
    const root = renderPhase("awaiting-signature", {
      prepared: PREPARED,
      description: PREPARED.description,
      onSign: () => undefined,
    });
    expect(root).toHaveTextContent(PREPARED.description);
  });

  it("renders whatever a caller passes as children", () => {
    const root = renderPhase("signature-rejected", {
      children: <p>Preparing again reuses the same identifier.</p>,
    });
    expect(root).toHaveTextContent("Preparing again reuses the same identifier.");
  });

  it("uses the labels a caller supplies rather than its own defaults", () => {
    const root = renderPhase("idle", {
      onPrepare: () => undefined,
      prepareLabel: "Save my details and build the transaction",
    });
    expect(actionNames(root)).toEqual(["Save my details and build the transaction"]);
  });
});
