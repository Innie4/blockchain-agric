import { screen, waitFor, within, cleanup } from "@testing-library/react";
import type { RouteObject } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, messageForError } from "../api/errors";
import type { Role } from "../api/types";
import { PageBoundary, RouteErrorElement } from "../components/RouteGuards";
import { LoadingState } from "../components/states";
import {
  captureConsoleError,
  expectClusterGenesis,
  FARMER_WALLET,
  installFakeWallet,
  makeRegistrationAccepted,
  makeRegistrationConfirmed,
  mockApi,
  renderRealRouter,
  renderRoutes,
  resetBrowserState,
  restoreRouterRequest,
  useRouterRequestStandIn,
  type ApiMock,
} from "./harness";

/**
 * Route protection and role routing, checked against the shipped route table
 * rather than a copy of it. `renderRealRouter` hands `src/routes/router.tsx`'s
 * own `routes` to a memory router, so the guards, the role requirements and the
 * lazy pages under test are the ones that ship.
 */

let http: ApiMock;

beforeAll(() => {
  useRouterRequestStandIn();
});

afterAll(() => {
  restoreRouterRequest();
});

/** A signed-out session: the guard must stop here. */
function signedOut(): void {
  http.on("GET", "/auth/me", () => ({ authenticated: false, user: null, permissions: [] }));
  // The landing page checks the records service on mount, even for a visitor.
  http.on("GET", "/health", () => ({
    status: "ok",
    runtime: { solanaNetwork: "devnet", uploadMaxFileBytes: 5_242_880 },
  }));
}

/** A signed-in participant with a connected wallet, for every role. */
function signedInAs(role: Role): void {
  const wallet = FARMER_WALLET;
  http.on("GET", "/auth/me", () => ({
    authenticated: true,
    user: {
      userId: `usr-${role}`,
      walletAddress: wallet.toBase58(),
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
  }));
  http.on("GET", "/health", () => ({ status: "ok", runtime: { uploadMaxFileBytes: 5_242_880 } }));
  http.on("GET", "/dashboard", () => ({
    role,
    introduction: "What this screen is for.",
    metrics: [],
    sections: [],
    quickActions: [],
    onChainRegistrationRequired: false,
  }));
  http.on("GET", "/compliance/overview", () => ({
    metrics: [],
    statusCounts: [],
    cropTypeCounts: [],
    recentVerifications: [],
    anomalies: [],
    transferActivity: [],
  }));
  http.on("GET", "/compliance/verifications", () => ({
    verifications: [],
    pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
  }));
  http.on("POST", "/products", () => makeRegistrationAccepted());
  http.on("POST", /^\/products\/[^/]+\/submit$/, () => makeRegistrationConfirmed());
}

beforeEach(() => {
  expectClusterGenesis(true);
  http = mockApi();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBrowserState();
});

describe("a visitor with no session", () => {
  it("is sent from /app/dashboard to the connect page when no wallet is installed", async () => {
    signedOut();

    renderRealRouter("/app/dashboard");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Connect your wallet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No Solana wallet was found in this browser"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking your session")).not.toBeInTheDocument();
  });

  it("is offered a connect button rather than a dead end when a wallet is installed", async () => {
    signedOut();
    installFakeWallet({ name: "phantom" });

    renderRealRouter("/app/products");

    expect(await screen.findByText("Connect your wallet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Connect wallet/ }),
    ).toBeEnabled();
    expect(screen.queryByRole("heading", { level: 1, name: "Connect your wallet" })).toBeNull();
  });

  it("shows the session check while it is still in flight", () => {
    signedOut();
    http.on("GET", "/auth/me", () => new Promise(() => undefined));

    renderRealRouter("/app/dashboard");

    expect(screen.getByText("Checking your session")).toBeInTheDocument();
  });

  it.each([
    ["/", "Trace the batch, not the story"],
    ["/verify", "Check a batch"],
    ["/search", "Search the registry"],
  ] as const)("can still reach the public route %s", async (path, heading) => {
    signedOut();

    renderRealRouter(path);

    expect(
      await screen.findByRole("heading", { level: 1, name: heading }),
    ).toBeInTheDocument();
  });

  it("lets a signed-in participant through to their own dashboard", async () => {
    signedInAs("FARMER");

    renderRealRouter("/app/dashboard");

    // The guard admits them, and the server's own copy is what is rendered.
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your farm" }),
    ).toBeInTheDocument();
    expect(screen.getByText("What this screen is for.")).toBeInTheDocument();
    expect(
      screen.queryByText("This section is not open to your role"),
    ).not.toBeInTheDocument();
    // The signed-in frame, with its own landmarks, is the one on screen.
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });

  it("sends /app to the dashboard rather than to a bare frame", async () => {
    signedInAs("FARMER");

    renderRealRouter("/app");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Your farm" }),
    ).toBeInTheDocument();
  });
});

describe("role routing", () => {
  it("tells a CONSUMER reaching /app/compliance which role it needs, not a blank page", async () => {
    signedInAs("CONSUMER");

    renderRealRouter("/app/compliance");

    expect(
      await screen.findByText("This section is not open to your role"),
    ).toBeInTheDocument();
    const description = screen.getByText(/You are signed in as a consumer\./);
    expect(description).toHaveTextContent("You are signed in as a consumer.");
    expect(description).toHaveTextContent("This page is for regulator accounts.");
    // The forbidden state is announced, not merely coloured.
    expect(screen.queryByRole("heading", { level: 1, name: "Compliance overview" })).toBeNull();
  });

  it("lets a REGULATOR into /app/compliance", async () => {
    signedInAs("REGULATOR");

    renderRealRouter("/app/compliance");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Compliance overview" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("This section is not open to your role")).not.toBeInTheDocument();
  });

  it("refuses a FARMER at /app/compliance", async () => {
    signedInAs("FARMER");

    renderRealRouter("/app/compliance");

    expect(
      await screen.findByText("This section is not open to your role"),
    ).toBeInTheDocument();
    const description = screen.getByText(/You are signed in as a farmer\./);
    expect(description).toHaveTextContent("You are signed in as a farmer.");
    expect(description).toHaveTextContent("This page is for regulator accounts.");
  });

  it.each([
    ["FARMER", true],
    ["REGULATOR", true],
    ["PROCESSOR", false],
    ["TRANSPORTER", false],
    ["RETAILER", false],
  ] as const)("lets %s reach /app/products/register: %s", async (role, allowed) => {
    signedInAs(role);
    installFakeWallet({ name: "phantom", exposesAddress: true });

    renderRealRouter("/app/products/register");

    if (allowed) {
      expect(
        await screen.findByRole("heading", { level: 1, name: "Register a batch" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("This section is not open to your role")).not.toBeInTheDocument();
      return;
    }

    expect(
      await screen.findByText("This section is not open to your role"),
    ).toBeInTheDocument();
    const description = screen.getByText(new RegExp(`You are signed in as a ${role.toLowerCase()}\\.`));
    expect(description).toHaveTextContent("This page is for farmer or regulator accounts.");
    expect(
      screen.queryByRole("heading", { level: 1, name: "Register a batch" }),
    ).not.toBeInTheDocument();
  });

  it("also gates the compliance report builder to a regulator", async () => {
    signedInAs("FARMER");

    renderRealRouter("/app/compliance/reports/new");

    expect(
      await screen.findByText("This section is not open to your role"),
    ).toBeInTheDocument();
    expect(screen.getByText(/You are signed in as a farmer\./)).toHaveTextContent(
      "This page is for regulator accounts.",
    );
  });
});

describe("an unknown address", () => {
  it("shows the not-found page with its recovery links", async () => {
    signedOut();

    renderRealRouter("/this/does/not/exist");

    expect(
      await screen.findByRole("heading", { level: 1, name: "That page does not exist" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check a batch" })).toHaveAttribute("href", "/verify");
    expect(screen.getByRole("link", { name: "Search the registry" })).toHaveAttribute(
      "href",
      "/search",
    );
    expect(screen.getByRole("link", { name: "Go to the start" })).toHaveAttribute("href", "/");
  });

  it("offers the dashboard link as well once there is a session", async () => {
    signedInAs("FARMER");

    renderRealRouter("/app/no-such-page");

    expect(
      await screen.findByRole("link", { name: "Go to your dashboard" }),
    ).toHaveAttribute("href", "/app");
  });
});

/* ------------------------------------------------------------------ *
 * A component that throws
 * ------------------------------------------------------------------ */

const FAILURE_MESSAGE = "The registry service answered with something unreadable.";

function ExplodingPage(): never {
  throw new ApiError({
    code: "INTERNAL_ERROR",
    status: 500,
    message: FAILURE_MESSAGE,
    requestId: "req-9f21",
  });
}

function loaderThatThrows(): never {
  throw new Error("The route loader could not read the record.");
}

/** A stack trace, as it would appear if one were rendered. */
const STACK_SHAPE = /\n\s+at\s|\bat\s+\S+\s+\(|\.tsx:\d+:\d+|\.ts:\d+:\d+/;

describe("a page that throws while rendering", () => {
  it("shows the recoverable error page with messageForError copy and a way back", async () => {
    const consoleCapture = captureConsoleError();
    const routes: RouteObject[] = [
      {
        path: "/",
        element: (
          <PageBoundary>
            <ExplodingPage />
          </PageBoundary>
        ),
      },
      { path: "/error", element: <p>The report page</p> },
      { path: "/", element: <p>Home</p> },
    ];

    try {
      renderRoutes(routes, "/");

      const alert = await screen.findByText("Something on this page failed");
      expect(alert).toBeInTheDocument();
      expect(
        screen.getByText(
          new RegExp(
            `${FAILURE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Nothing was changed.`,
          ),
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Reload the page/ })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Report this problem/ })).toHaveAttribute(
        "href",
        "/error",
      );
      // The reference is offered for a report without becoming a stack trace.
      expect(screen.getByText("req-9f21")).toBeInTheDocument();
    } finally {
      consoleCapture.restore();
    }
  });

  it("does not print a stack trace to the reader", async () => {
    const consoleCapture = captureConsoleError();
    const routes: RouteObject[] = [
      {
        path: "/",
        element: (
          <PageBoundary>
            <ExplodingPage />
          </PageBoundary>
        ),
      },
    ];

    try {
      const { container } = renderRoutes(routes, "/");
      await screen.findByText("Something on this page failed");

      const text = container.textContent ?? "";
      expect(text).not.toMatch(STACK_SHAPE);
      expect(text).not.toContain("ApiError");
      expect(text).not.toContain("getDerivedStateFromError");
      expect(text).not.toContain("harness.tsx");
    } finally {
      consoleCapture.restore();
    }
  });

  it("keeps the diagnostic in the console rather than on the page", async () => {
    const consoleCapture = captureConsoleError();
    const routes: RouteObject[] = [
      {
        path: "/",
        element: (
          <PageBoundary>
            <ExplodingPage />
          </PageBoundary>
        ),
      },
    ];

    try {
      renderRoutes(routes, "/");
      await screen.findByText("Something on this page failed");

      await waitFor(() => {
        expect(consoleCapture.errors.length).toBeGreaterThan(0);
      });
      const logged = consoleCapture.errors.flat().map((entry) => String(entry)).join(" ");
      expect(logged).toContain(FAILURE_MESSAGE);
    } finally {
      consoleCapture.restore();
    }
  });

  it("hands an error the router caught to the same recovery view", async () => {
    const consoleCapture = captureConsoleError();
    const routes: RouteObject[] = [
      {
        path: "/broken",
        loader: loaderThatThrows,
        element: <p>unreachable</p>,
        errorElement: <RouteErrorElement />,
      },
      { path: "/app/dashboard", element: <p>Dashboard</p> },
      { path: "/error", element: <p>The report page</p> },
    ];

    try {
      renderRoutes(routes, "/broken");

      expect(await screen.findByText("Something on this page failed")).toBeInTheDocument();
      expect(
        screen.getByText(
          /The route loader could not read the record\. Nothing was changed\./,
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Report this problem/ })).toHaveAttribute(
        "href",
        "/error",
      );
    } finally {
      consoleCapture.restore();
    }
  });

  it("turns a thrown non-ApiError into a readable sentence", async () => {
    const consoleCapture = captureConsoleError();
    function PlainFailure(): never {
      throw new TypeError("Cannot read properties of undefined (reading 'productId')");
    }
    const routes: RouteObject[] = [
      {
        path: "/",
        element: (
          <PageBoundary>
            <PlainFailure />
          </PageBoundary>
        ),
      },
    ];

    try {
      renderRoutes(routes, "/");
      await screen.findByText("Something on this page failed");
      expect(
        screen.getByText(/Cannot read properties of undefined/),
      ).toBeInTheDocument();
      // No reference is invented for a failure the server never saw.
      expect(screen.queryByText(/^Reference/)).not.toBeInTheDocument();
    } finally {
      consoleCapture.restore();
    }
  });
});

/* ------------------------------------------------------------------ *
 * The guard components on their own
 * ------------------------------------------------------------------ */

describe("RequireAuth and RequireRole in isolation", () => {
  it("shows the wait rather than the page while the session is unknown", async () => {
    http.on("GET", "/auth/me", () => new Promise(() => undefined));
    const { RequireAuth } = await import("../components/RouteGuards");

    const { container } = renderRoutes(
      [{ path: "/", element: <RequireAuth>Behind the guard</RequireAuth> }],
      "/",
    );

    const status = await screen.findByRole("status");
    expect(within(status).getByText("Checking your session")).toBeInTheDocument();
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Behind the guard")).not.toBeInTheDocument();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("lets a matching role through and keeps a body that throws inside a boundary", async () => {
    const consoleCapture = captureConsoleError();
    const { RequireRole } = await import("../components/RouteGuards");
    signedInAs("REGULATOR");

    const routes: RouteObject[] = [
      {
        path: "/",
        element: (
          <RequireRole roles={["REGULATOR"]}>
            <p>Only a regulator sees this</p>
          </RequireRole>
        ),
      },
    ];
    renderRoutes(routes, "/");

    expect(await screen.findByText("Only a regulator sees this")).toBeInTheDocument();
    consoleCapture.restore();
  });

  it("announces the wait to assistive technology rather than only showing a spinner", async () => {
    const { container } = renderRoutes([{ path: "/", element: <LoadingState label="Reading" /> }], "/");
    const status = container.querySelector("[role='status']");
    expect(status).not.toBeNull();
    expect(within(status as HTMLElement).getByText("Reading")).toBeInTheDocument();
  });
});

describe("messageForError copy on the error page", () => {
  it("prefers the server's own sentence over the local vocabulary", async () => {
    const consoleCapture = captureConsoleError();
    function ServerRefusal(): never {
      throw new ApiError({
        code: "HASH_MISMATCH",
        status: 409,
        message: "The stored details no longer match the anchored copy.",
      });
    }
    const routes: RouteObject[] = [
      { path: "/", element: <PageBoundary><ServerRefusal /></PageBoundary> },
    ];

    try {
      renderRoutes(routes, "/");
      await screen.findByText("Something on this page failed");
      expect(
        screen.getByText(/The stored details no longer match the anchored copy\./),
      ).toBeInTheDocument();
      expect(messageForError(new Error("anything"))).toBe("anything");
    } finally {
      consoleCapture.restore();
    }
  });
});
