import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * The dev server proxies `/api` to the Express server so the browser only ever
 * talks to one origin. That keeps the session and CSRF cookies first-party
 * during development, which is exactly how they behave in production.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
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
