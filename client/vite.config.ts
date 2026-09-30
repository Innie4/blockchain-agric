import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * The dev server proxies `/api` to the Express server so the browser only ever
 * talks to one origin. That keeps the session and CSRF cookies first-party
 * during development, which is exactly how they behave in production.
 *
 * Both ports can be overridden, which the end-to-end suite relies on: it starts
 * a real API and a real dev server, and needs to move them off the defaults when
 * something else on the machine already holds :4000 or :5173. The proxy target has
 * to follow the API port, or the browser silently talks to whatever else is
 * listening there.
 */
const apiPort = Number.parseInt(process.env["API_PORT"] ?? "", 10);
const clientPort = Number.parseInt(process.env["CLIENT_PORT"] ?? "", 10);

export default defineConfig({
  plugins: [react()],
  // Vite only exposes variables to the browser bundle when they carry one of
  // these prefixes, and everything it exposes is public. The default is just
  // `VITE_`; `DEMO_` is added so the fixture switch can be named for what it is
  // rather than for the tool that reads it.
  //
  // These are build-time switches, not secrets: one says "answer from fixtures",
  // the other says "I understand this is not real data". Neither is sensitive, and
  // both have to be readable by the browser, because the browser is the thing
  // deciding whether to call the API at all.
  envPrefix: ["VITE_", "DEMO_"],
  server: {
    port: Number.isInteger(clientPort) ? clientPort : 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://localhost:${Number.isInteger(apiPort) ? apiPort : 4000}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
