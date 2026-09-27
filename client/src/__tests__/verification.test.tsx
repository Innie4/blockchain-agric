import { screen, waitFor, within, cleanup } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";
import VerifyLookupPage from "../pages/public/VerifyLookupPage";
import VerifyResultPage from "../pages/public/VerifyResultPage";
import {
  BATCH_ID,
  DATA_HASH,
  deferred,
  FARMER_WALLET,
  makePublicProduct,
  makeVerification,
  makeVerificationResponse,
  mockApi,
  OTHER_DATA_HASH,
  OTHER_BATCH_ID,
  renderPublicly,
  resetBrowserState,
  setupUser,
  THIRD_DATA_HASH,
  type ApiMock,
} from "./harness";
import type { Verification } from "../api/types";
import { truncateAddress } from "../lib/format";

/**
 * Public verification: the page a buyer reaches from a code on a pack, with no
 * account, no wallet and no signature. Rendered with the toast provider and a
 * router only, because that is genuinely all it is allowed to need.
 */

const MISMATCH_EXPLANATION =
  "The stored quantity was changed from 1200 kg to 900 kg after the batch was registered.";

let http: ApiMock;

/**
 * The `GET /verify/:id` and `POST /verify/:id/log` handlers, which every test
 * drives directly.
 */
function serveVerification(
  verification: Verification,
  product = makePublicProduct(),
  options: { onLog?: () => unknown; productId?: string } = {},
): void {
  const productId = options.productId ?? BATCH_ID;
  http.on("GET", new RegExp(`^/verify/${productId}$`), () =>
    makeVerificationResponse(verification, product),
  );
  http.on(
    "POST",
    new RegExp(`^/verify/${productId}/log$`),
    options.onLog ?? (() => ({ verificationId: "ver-logged" })),
  );
}

function renderResult(path = `/verify/${BATCH_ID}`): void {
  renderPublicly(
    <Routes>
      <Route path="/verify/:productId" element={<VerifyResultPage />} />
      <Route path="/verify" element={<VerifyLookupPage />} />
      <Route path="/search" element={<p>The search page</p>} />
    </Routes>,
    path,
  );
}

/**
 * The result banner the page puts at the top of every outcome. Anchored on the
 * "Result …" line, because a failure state further down is also an alert and
 * every titled panel is also a level-two heading.
 */
async function banner(): Promise<HTMLElement> {
  const marker = await screen.findByText(/^Result /);
  const region = marker.closest("[role='alert']");
  expect(region).not.toBeNull();
  return region as HTMLElement;
}

const mismatchVerification = (): Verification =>
  makeVerification({
    result: "MISMATCH",
    onChain: DATA_HASH,
    stored: OTHER_DATA_HASH,
    computed: THIRD_DATA_HASH,
    mismatch: {
      reason: "The stored quantity does not match the anchored fingerprint",
      explanation: MISMATCH_EXPLANATION,
      expected: DATA_HASH,
      actual: OTHER_DATA_HASH,
      field: "quantity",
    },
    headline: "The stored details no longer produce the anchored fingerprint.",
    explanation: MISMATCH_EXPLANATION,
  });

beforeEach(() => {
  http = mockApi();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBrowserState();
});

describe("a batch whose details no longer match", () => {
  it("leads with an unmistakably labelled mismatch banner, not colour alone", async () => {
    serveVerification(mismatchVerification());
    renderResult();

    const alert = await banner();
    // A text label, not a colour and not an icon.
    expect(within(alert).getByText("Details do not match")).toBeInTheDocument();
    expect(
      within(alert).getByRole("heading", {
        name: "This batch does not match its blockchain record.",
      }),
    ).toBeInTheDocument();
    expect(within(alert).getByText(/Result Details do not match · reference/)).toBeInTheDocument();
    // And the banner is announced, so the outcome is not visual only.
    expect(alert).toHaveAttribute("role", "alert");
  });

  it("says the details do not match, to treat the batch as unverified, and to report it", async () => {
    serveVerification(mismatchVerification());
    renderResult();

    const alert = await banner();
    const summary = within(alert).getByText(
      /The details held for this batch no longer produce the fingerprint/,
    );
    expect(summary).toHaveTextContent(
      "Treat the batch as unverified, do not rely on the details below, and tell a regulator.",
    );
    expect(within(alert).getByText(/Reason recorded: /)).toHaveTextContent(
      "The stored quantity does not match the anchored fingerprint",
    );
    expect(
      within(alert).getByText(/the field that differs is quantity/),
    ).toBeInTheDocument();
    // A concrete way to act on it, not only a warning.
    expect(within(alert).getByRole("button", { name: /Print or save this result/ })).toBeEnabled();
    expect(within(alert).getByRole("link", { name: "Search the registry" })).toHaveAttribute(
      "href",
      "/search",
    );
  });

  it("does not present the provenance as trustworthy", async () => {
    serveVerification(mismatchVerification());
    renderResult();

    await banner();
    expect(
      await screen.findByText("Shown for reference only — not verified"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Read it as a claim, not as a fact/),
    ).toBeInTheDocument();
    // The history is renamed and badged, so its status is not left to colour.
    expect(
      screen.getByRole("region", { name: "History (unverified)" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
    expect(screen.getAllByText("Not verified").length).toBeGreaterThan(0);
    // The facts are still shown, but the anchored fingerprint is not passed off as good.
    expect(screen.getByText("Anchored fingerprint")).toBeInTheDocument();
  });

  it("shows the three-way hash comparison a reader can check themselves", async () => {
    serveVerification(mismatchVerification());
    renderResult();

    const panel = await screen.findByRole("region", { name: "Why it does not match" });
    const labels = within(panel).getAllByRole("term").map((term) => term.textContent);
    expect(labels).toEqual(["On the blockchain", "Held in the records", "Recomputed now"]);

    // All three values are printed in full, so no conclusion has to be trusted.
    expect(within(panel).getByLabelText(`On the blockchain: ${DATA_HASH}`)).toHaveTextContent(
      DATA_HASH,
    );
    expect(
      within(panel).getByLabelText(`Held in the records: ${OTHER_DATA_HASH}`),
    ).toHaveTextContent(OTHER_DATA_HASH);
    expect(
      within(panel).getByLabelText(`Recomputed now: ${THIRD_DATA_HASH}`),
    ).toHaveTextContent(THIRD_DATA_HASH);
    expect(
      within(panel).getByText(/A buyer or a regulator can read the difference directly/),
    ).toBeInTheDocument();
  });

  it("marks a null value as missing rather than as a match", async () => {
    serveVerification(
      makeVerification({
        result: "MISMATCH",
        onChain: DATA_HASH,
        stored: DATA_HASH,
        computed: null,
        mismatch: {
          reason: "The details could not be rebuilt from what is stored",
          explanation: MISMATCH_EXPLANATION,
          expected: DATA_HASH,
          actual: "",
        },
      }),
    );
    renderResult();

    const panel = await screen.findByRole("region", { name: "Why it does not match" });
    expect(within(panel).getByText("No value was returned.")).toBeInTheDocument();
  });
});

describe("a batch that matches", () => {
  it("renders the facts, the provenance timeline and the certificate list", async () => {
    serveVerification(makeVerification({ result: "VERIFIED" }));
    renderResult();

    const alert = await banner();
    expect(within(alert).getByText("Verified")).toBeInTheDocument();
    expect(
      within(alert).getByRole("heading", { name: "This batch matches its blockchain record." }),
    ).toBeInTheDocument();

    const facts = screen.getByRole("region", { name: "The facts on record" });
    expect(within(facts).getByText("Cocoa")).toBeInTheDocument();
    expect(within(facts).getByText("1,200 kg")).toBeInTheDocument();
    expect(within(facts).getByText("Abeokuta, Ogun State")).toBeInTheDocument();
    // Both the harvest date and the registration date are on this record.
    expect(within(facts).getAllByText("14 March 2026")).toHaveLength(2);
    // The stage is written out twice, as a badge and as a sentence.
    expect(within(facts).getAllByText("Registered")).toHaveLength(2);
    // The public record gives a category of business, never a wallet address.
    expect(
      within(facts).getByText(
        "The public record gives the category of business only, never the wallet address.",
      ),
    ).toBeInTheDocument();

    const history = screen.getByRole("region", { name: "History" });
    expect(within(history).getByText("Batch registered by the farmer")).toBeInTheDocument();
    // The actor is named as a truncated address plus the role they acted under.
    const attribution = within(history).getByText(/^Registration by /);
    expect(attribution.textContent).toMatch(
      new RegExp(`^Registration by ${truncateAddress(FARMER_WALLET.toBase58())} \\(FARMER\\)$`),
    );
    expect(
      within(history).getByRole("link", { name: /View on Solana Explorer/ }),
    ).toBeInTheDocument();

    const certificates = screen.getByRole("region", { name: "Certificates" });
    const table = within(certificates).getByRole("table", {
      name: "Certificates attached to this batch",
    });
    expect(within(table).getByRole("columnheader", { name: "Certificate" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: /Kola Organic Certifiers/ })).toBeInTheDocument();
    expect(within(table).getByText("Organic")).toBeInTheDocument();

    // Nothing on a clean result is hedged.
    expect(screen.queryByText("Shown for reference only — not verified")).not.toBeInTheDocument();
  });

  it("says the checked batch needs no account and shows the check itself", async () => {
    serveVerification(makeVerification({ result: "VERIFIED" }));
    renderResult();

    await banner();
    expect(
      screen.getByText(/No account was used, and none is needed/),
    ).toBeInTheDocument();
    const lastChecked = screen.getByRole("region", { name: "Last checked" });
    const carriedOut = within(lastChecked).getByText(/This check was carried out at/);
    const stamp = carriedOut.querySelector("time");
    expect(stamp).toHaveAttribute("dateTime", "2026-03-14T12:30:00.000Z");
    expect(stamp?.textContent).toMatch(/^14 March 2026 at \d{2}:\d{2}$/);
    expect(
      within(lastChecked).getByText("Checked by a member of the public, with no account."),
    ).toBeInTheDocument();
    expect(within(lastChecked).getByText(/Checks recorded for this batch: 1/)).toBeInTheDocument();
  });

  it("reports when there are no certificates rather than showing an empty table", async () => {
    serveVerification(
      makeVerification({ result: "VERIFIED" }),
      makePublicProduct({ certificates: [] }),
    );
    renderResult();

    const certificates = await screen.findByRole("region", { name: "Certificates" });
    expect(
      within(certificates).getByText("No certificates are attached to this batch"),
    ).toBeInTheDocument();
    expect(within(certificates).queryByRole("table")).toBeNull();
  });
});

describe("a batch with no on-chain record", () => {
  it("says so plainly and offers a way to search instead", async () => {
    serveVerification(
      makeVerification({
        result: "NOT_FOUND",
        recordPresent: false,
        productId: OTHER_BATCH_ID,
        onChain: null,
        stored: null,
        computed: null,
        headline: "The blockchain holds no account for this identifier.",
        explanation: "No product account exists at the derived address for this identifier.",
      }),
      makePublicProduct({ productId: OTHER_BATCH_ID, dataHash: null }),
      { productId: OTHER_BATCH_ID },
    );
    renderResult(`/verify/${OTHER_BATCH_ID}`);

    const alert = await banner();
    expect(within(alert).getByText("No record found")).toBeInTheDocument();
    expect(
      within(alert).getByRole("heading", { name: "No batch is registered under this identifier." }),
    ).toBeInTheDocument();

    expect(
      await screen.findByText(`No batch is registered as ${OTHER_BATCH_ID}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/a mistyped or truncated identifier is the usual cause/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Search the registry" }),
    ).toHaveAttribute("href", "/search");
    expect(
      screen.getByRole("link", { name: "Check a different batch" }),
    ).toHaveAttribute("href", "/verify");
    // Nothing is presented as verified.
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
  });
});

describe("a batch that could not be checked", () => {
  it("is reported honestly, and never as verified", async () => {
    serveVerification(
      makeVerification({
        result: "INCOMPLETE",
        chainReachable: false,
        onChain: null,
        stored: DATA_HASH,
        computed: null,
        headline: "The chain could not be read while the check ran.",
        explanation: "The Solana RPC endpoint did not answer within the deadline.",
      }),
    );
    renderResult();

    const alert = await banner();
    expect(within(alert).getByText("Not yet fully registered")).toBeInTheDocument();
    expect(
      within(alert).getByRole("heading", {
        name: "This batch could not be checked right now.",
      }),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText(/Nothing here should be treated as verified/),
    ).toBeInTheDocument();

    // The reason is named, with the code the reader could quote to a regulator.
    expect(
      await screen.findByText("The network could not be reached for this check"),
    ).toBeInTheDocument();
    const failure = screen
      .getByText("Could not check this batch")
      .closest("[role='alert']") as HTMLElement;
    expect(failure).not.toBeNull();
    expect(failure).toHaveTextContent(
      "The Solana RPC endpoint did not answer within the deadline.",
    );
    expect(failure).toHaveTextContent("BLOCKCHAIN_RPC_UNAVAILABLE");
    expect(failure).toHaveTextContent("Wait about a minute.");

    // No VERIFIED wording anywhere, in label or headline form.
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /matches its blockchain record/ }),
    ).not.toBeInTheDocument();
  });

  it("offers to check again rather than leaving a dead end", async () => {
    const user = setupUser();
    let attempt = 0;
    http.on("GET", new RegExp(`^/verify/${BATCH_ID}$`), () => {
      attempt += 1;
      return attempt === 1
        ? makeVerificationResponse(
            makeVerification({
              result: "INCOMPLETE",
              onChain: null,
              stored: DATA_HASH,
              computed: null,
            }),
            null,
          )
        : makeVerificationResponse(makeVerification({ result: "VERIFIED" }), makePublicProduct());
    });
    http.on("POST", new RegExp(`^/verify/${BATCH_ID}/log$`), () => ({
      verificationId: "ver-logged",
    }));

    renderResult();
    await screen.findByText("Not yet fully registered");

    await user.click(screen.getByRole("button", { name: "Check it again" }));

    expect(await screen.findByText("Verified")).toBeInTheDocument();
    expect(http.callsTo("GET", new RegExp(`^/verify/${BATCH_ID}$`))).toHaveLength(2);
  });
});

describe("while the check is in flight", () => {
  it("shows a loading state that announces itself", async () => {
    const pending = deferred<ReturnType<typeof makeVerificationResponse>>();
    http.on("GET", new RegExp(`^/verify/${BATCH_ID}$`), () => pending.promise);
    http.on("POST", new RegExp(`^/verify/${BATCH_ID}/log$`), () => ({
      verificationId: "ver-logged",
    }));

    renderResult();

    const status = await screen.findByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(
      within(status).getByText(`Checking batch ${BATCH_ID} against the blockchain record`),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: `Batch ${BATCH_ID}` })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();

    pending.resolve(makeVerificationResponse(makeVerification(), makePublicProduct()));
    await banner();
  });
});

describe("a check that could not be completed at all", () => {
  it("shows the reason and offers a retry that re-issues the request", async () => {
    const user = setupUser();
    let attempt = 0;
    http.on("GET", new RegExp(`^/verify/${BATCH_ID}$`), () => {
      attempt += 1;
      if (attempt === 1) {
        throw new ApiError({
          code: "BLOCKCHAIN_RPC_UNAVAILABLE",
          status: 0,
          message: "The Solana network could not be reached, so the record was not read.",
        });
      }
      return makeVerificationResponse(makeVerification(), makePublicProduct());
    });
    http.on("POST", new RegExp(`^/verify/${BATCH_ID}/log$`), () => ({
      verificationId: "ver-logged",
    }));

    renderResult();

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent(`Batch ${BATCH_ID} could not be checked`);
    expect(failure).toHaveTextContent(
      "The Solana network could not be reached, so the record was not read.",
    );
    expect(
      within(failure).getByRole("button", { name: "Check it again" }),
    ).toBeInTheDocument();
    expect(within(failure).getByRole("link", { name: "Search the registry" })).toBeInTheDocument();

    await user.click(within(failure).getByRole("button", { name: "Check it again" }));

    expect(await screen.findByText("Verified")).toBeInTheDocument();
    expect(http.callsTo("GET", new RegExp(`^/verify/${BATCH_ID}$`))).toHaveLength(2);
  });

  it("refuses an empty identifier before making a request", async () => {
    const user = setupUser();
    renderResult("/verify/%20");

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("No batch identifier was given");
    expect(
      failure.textContent,
    ).toContain("The address on this page did not include a batch identifier.");
    expect(
      within(failure).getByRole("button", { name: "Go to the batch lookup" }),
    ).toBeInTheDocument();
    expect(http.callsTo("GET", /^\/verify\//)).toHaveLength(0);

    await user.click(within(failure).getByRole("button", { name: "Go to the batch lookup" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Check a batch" }),
    ).toBeInTheDocument();
  });
});

describe("working with no session", () => {
  it("asks only the public verification endpoints, and for no wallet at all", async () => {
    serveVerification(makeVerification({ result: "VERIFIED" }));
    renderResult();

    await banner();
    await waitFor(() => {
      expect(http.callsTo("POST", new RegExp("^/verify/.*/log$"))).toHaveLength(1);
    });

    // No session-bearing endpoint is touched at all.
    expect(http.paths).toEqual([
      `GET /verify/${BATCH_ID}`,
      `POST /verify/${BATCH_ID}/log`,
    ]);
    // And nothing on the page asks for a wallet or a connection.
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(screen.queryByText(/seed phrase/i)).toBeNull();
    expect(screen.queryByText(/Sign in/)).toBeNull();
    expect(
      screen.getByText(/No account was used, and none is needed/),
    ).toBeInTheDocument();
  });

  it("sends a plain GET with no session-bearing credential, checked at the fetch boundary", async () => {
    // The `api.request` mock is released here so the real `ApiClient` runs and
    // only `fetch` is replaced: the outgoing request itself is then inspected.
    // A CSRF cookie is present, so a request that wrongly needed a session
    // would be forced to attach one.
    vi.restoreAllMocks();
    document.cookie = "agri_csrf=csrf-token-value";
    const seen: { url: string; method: string; headers: Headers; credentials: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        credentials: init?.credentials,
      });
      return new Response(
        JSON.stringify(
          makeVerificationResponse(makeVerification(), makePublicProduct()),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    renderResult();
    await banner();

    const verificationCall = seen.find((entry) => entry.url.includes(`/verify/${BATCH_ID}`));
    expect(verificationCall).toBeDefined();
    expect(verificationCall?.method).toBe("GET");
    expect(verificationCall?.headers.get("x-csrf-token")).toBeNull();
    expect(verificationCall?.headers.get("authorization")).toBeNull();
    expect(verificationCall?.credentials).toBe("include");

    // The audit write is a POST, and it does carry the CSRF token it needs.
    const logCall = seen.find((entry) => entry.url.includes("/log"));
    expect(logCall?.method).toBe("POST");
    expect(logCall?.headers.get("x-csrf-token")).toBe("csrf-token-value");
  });
});

describe("recording the attempt", () => {
  it("writes the attempt to the log endpoint with how the reader arrived", async () => {
    const bodies: unknown[] = [];
    const pendingLog = deferred<{ verificationId: string }>();
    http.on("GET", new RegExp(`^/verify/${BATCH_ID}$`), () =>
      makeVerificationResponse(makeVerification(), makePublicProduct()),
    );
    http.on("POST", new RegExp(`^/verify/${BATCH_ID}/log$`), (options) => {
      bodies.push(options.body);
      return pendingLog.promise;
    });

    renderResult();
    await banner();

    // While the audit write is in flight the reader is told it is happening.
    const lastChecked = await screen.findByRole("region", { name: "Last checked" });
    expect(
      within(lastChecked).getByText(/Recording this check so a regulator can see who looked at what/),
    ).toBeInTheDocument();
    expect(within(lastChecked).getByText(/Recording this check/).closest("[aria-live]")).not.toBeNull();

    pendingLog.resolve({ verificationId: "ver-audit-77" });

    await waitFor(() => {
      expect(bodies).toEqual([{ source: "direct" }]);
    });
    const recorded = await within(lastChecked).findByText(
      /This check was recorded on the server\. Reference/,
    );
    expect(recorded.textContent).toContain("ver-audit-77");
    expect(
      within(lastChecked).queryByText(/Recording this check so a regulator/),
    ).not.toBeInTheDocument();
  });

  it("records a scan as a QR scan", async () => {
    const bodies: unknown[] = [];
    http.on("GET", new RegExp(`^/verify/${BATCH_ID}$`), () =>
      makeVerificationResponse(makeVerification(), makePublicProduct()),
    );
    http.on("POST", new RegExp(`^/verify/${BATCH_ID}/log$`), (options) => {
      bodies.push(options.body);
      return { verificationId: "ver-audit-78" };
    });

    renderResult(`/verify/${BATCH_ID}?source=qr`);
    await banner();

    await waitFor(() => {
      expect(bodies).toEqual([{ source: "qr" }]);
    });
  });

  it("shows a failed log write rather than swallowing it", async () => {
    http.on("GET", new RegExp(`^/verify/${BATCH_ID}$`), () =>
      makeVerificationResponse(makeVerification(), makePublicProduct()),
    );
    http.on("POST", new RegExp(`^/verify/${BATCH_ID}/log$`), () => {
      throw new ApiError({
        code: "DATABASE_UNAVAILABLE",
        status: 503,
        message: "The audit trail is temporarily unavailable.",
      });
    });

    renderResult();
    await banner();

    const lastChecked = await screen.findByRole("region", { name: "Last checked" });
    const notice = within(lastChecked).getByText(
      /This check could not be recorded on the server, so it will not appear in the audit trail/,
    );
    expect(notice).toHaveTextContent("The audit trail is temporarily unavailable.");
    expect(notice).toHaveTextContent("Nothing was changed, and the result above still stands.");
    // The result itself is unaffected by the audit failure.
    expect(within(await banner()).getByText("Verified")).toBeInTheDocument();
  });
});

describe("the lookup page", () => {
  it("refuses a malformed identifier before asking the server", async () => {
    const user = setupUser();
    renderResult("/verify");

    await user.type(
      await screen.findByRole("textbox", { name: /Batch identifier/ }),
      "cocoa-2026",
    );
    await user.click(screen.getByRole("button", { name: /Check this batch/ }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("That identifier could not be checked");
    expect(failure).toHaveTextContent("An identifier looks like AGT-COCOA-2026-A1B2C3");
    expect(http.callsTo("GET", /^\/verify\//)).toHaveLength(0);
  });

  it("marks the control invalid and describes the identifier it expected", async () => {
    const user = setupUser();
    renderResult("/verify");

    const input = await screen.findByRole("textbox", { name: /Batch identifier/ });
    await user.type(input, "cocoa-2026");
    await user.click(screen.getByRole("button", { name: /Check this batch/ }));

    const failure = await screen.findByRole("alert");
    await waitFor(() => {
      expect(input).toHaveAttribute("aria-invalid", "true");
    });
    // The message is wired to the control, not only placed nearby.
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    const errorId = describedBy.split(/\s+/).find((id) => id.endsWith("-error"));
    expect(errorId).toBeDefined();
    expect(document.getElementById(errorId as string)).toHaveTextContent(
      "An identifier looks like AGT-COCOA-2026-A1B2C3",
    );
    expect(failure).toHaveAttribute("role", "alert");
  });

  it("normalises a mistyped identifier and opens the result", async () => {
    const user = setupUser();
    renderResult("/verify");

    await user.type(
      await screen.findByRole("textbox", { name: /Batch identifier/ }),
      "  agt-cocoa-2026-a1b2c3  ",
    );
    await user.click(screen.getByRole("button", { name: /Check this batch/ }));

    expect(
      await screen.findByRole("heading", { level: 1, name: `Batch ${BATCH_ID}` }),
    ).toBeInTheDocument();
    expect(http.callsTo("GET", new RegExp(`^/verify/${BATCH_ID}$`))).toHaveLength(1);
  });
});
