import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ToastProvider } from "./context/ToastContext";
import { WalletProvider } from "./context/WalletContext";
import { router } from "./routes/router";
import "./styles/global.css";

/**
 * The provider order is deliberate:
 *
 *   WalletProvider  knows whether a wallet exists and can sign
 *   AuthProvider    signs the server's challenge, which needs the wallet
 *   ToastProvider   reports the outcome, and is used by the auth provider
 *   RouterProvider  renders the routes, which use all of the above
 *
 * There is no `BrowserRouter` here: `RouterProvider` with a router built by
 * `createBrowserRouter` supplies the router context itself, and nesting both
 * would leave two competing histories.
 */
const container = document.getElementById("root");
if (container === null) {
  throw new Error(
    "The application root element is missing from index.html, so the interface cannot be mounted.",
  );
}

createRoot(container).render(
  <StrictMode>
    <WalletProvider>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </WalletProvider>
  </StrictMode>,
);
