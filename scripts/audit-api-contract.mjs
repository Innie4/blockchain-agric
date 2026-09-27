#!/usr/bin/env node
/**
 * Compares the API paths the client calls with the routes the server registers.
 *
 * A client call with no matching server route is a dead button. A server route
 * no client calls is either an unused endpoint or a capability the interface
 * never reaches; both are reported so the gap is a decision rather than an
 * accident.
 *
 * Usage: node scripts/audit-api-contract.mjs
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const clientEndpoints = join(root, "client", "src", "api", "endpoints.ts");
const serverRoutesDir = join(root, "server", "src", "routes");

/**
 * Every path the client asks for. The client is configured with a base URL that
 * already ends in `/api`, so its paths here are relative to that prefix.
 */
async function clientPaths() {
  const source = await readFile(clientEndpoints, "utf8");
  const found = new Set();
  const patterns = [
    // api.request<T>("GET", `/products/${id}`) — a literal or template path.
    /api\.request<[^>]*>\(\s*"([A-Z]+)"\s*,\s*(`[^`]*`|"[^"]*")/g,
    /api\.download\(\s*(`[^`]*`|"[^"]*")/g,
    // The method and path on separate lines, as the formatter often writes them.
    /"([A-Z]+)"\s*,\s*\n?\s*(`[^`]*`|"[^"]*")\s*,?\s*\{/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const literal = match[2] ?? match[1];
      const path = literal.startsWith("`")
        ? literal.slice(1, -1)
        : literal.slice(1, -1);
      if (path.length === 0 || path === "/") continue;
      found.add(normalise(path));
    }
  }
  return found;
}

function normalise(path) {
  return path
    .replace(/\$\{[^}]+\}/g, ":param")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":param")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

/**
 * Rebuilds each router's mount point and paths. Express mounts are read from
 * `app.use` in `app.ts`; router-local paths come from the router files.
 */
async function serverRoutes() {
  const appSource = await readFile(join(root, "server", "src", "app.ts"), "utf8");
  const mounts = [];
  for (const match of appSource.matchAll(/app\.use\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g)) {
    mounts.push({ prefix: match[1], router: match[2] });
  }

  const routerAlias = {
    healthRoutes: "health.ts",
    authRoutes: "auth.ts",
    userRoutes: "users.ts",
    productRoutes: "products.ts",
    transferRoutes: "transfers.ts",
    verifyRoutes: "verify.ts",
    searchRoutes: "search.ts",
    mediaRoutes: "media.ts",
    operationsRoutes: "operations.ts",
    workspaceRoutes: "workspace.ts",
  };

  const routes = new Set();
  for (const { prefix, router } of mounts) {
    const file = routerAlias[router];
    if (file === undefined) continue;
    const source = await readFile(join(serverRoutesDir, file), "utf8");
    for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*\n?\s*"([^"]*)"/g)) {
      const verb = match[1].toUpperCase();
      const path = normalise(`${prefix}${match[2]}`).replace(/^\/api/, "");
      routes.add(`${verb} ${path}`);
    }
  }
  return { routes, mounts };
}

const client = await clientPaths();
const { routes, mounts } = await serverRoutes();

const unmatched = [...client].filter((path) => {
  if (path.length === 0) return false;
  const probe = `GET ${path}`;
  return ![...routes].some((route) => route === probe || route.endsWith(` ${path}`));
});

/**
 * Routes that exist for operations rather than for the browser.
 *
 * Health and readiness probes are called by whoever is watching the service, not
 * by the interface, and the public configuration endpoint exists so a deployment
 * can be inspected without a session. Calling any of them from client code would
 * be the mistake, so they are expected to be unreachable from the client.
 */
const OPERATIONAL_ROUTES = new Set([
  "GET /config",
  "GET /health",
  "GET /health/blockchain",
  "GET /health/database",
  "GET /health/ready",
]);

const problems = [];

if (unmatched.length > 0) {
  problems.push("Client calls with no matching server route:");
  for (const path of unmatched.sort()) problems.push(`  ${path}`);
}

const used = new Set();
for (const path of client) {
  for (const route of routes) {
    if (route.endsWith(` ${path}`)) used.add(route);
  }
}
const unused = [...routes].filter((route) => !used.has(route)).sort();

const unexpectedUnused = unused.filter((route) => !OPERATIONAL_ROUTES.has(route));
const expectedUnused = unused.filter((route) => OPERATIONAL_ROUTES.has(route));

if (unexpectedUnused.length > 0) {
  problems.push("Server routes no client call reaches, and none is an operational endpoint:");
  for (const route of unexpectedUnused) problems.push(`  ${route}`);
}

if (expectedUnused.length > 0) {
  problems.push("Operational endpoints the browser correctly never calls:");
  for (const route of expectedUnused) problems.push(`  ${route}`);
}

if (problems.length === 0) {
  process.stdout.write(
    `API contract audit: ${client.size} client paths, ${routes.size} server routes, no gaps.\n`
  );
  process.exit(0);
}

const failed = unmatched.length > 0 || unexpectedUnused.length > 0;

process.stdout.write(`${problems.join("\n")}\n`);
process.stdout.write(
  `\n${client.size} client paths checked against ${routes.size} server routes across ${mounts.length} mounts.\n`
);
if (!failed) {
  process.stdout.write(
    `No gaps: every client call has a server route, and every server route is either called by the client or an operational endpoint.\n`
  );
}
process.exit(failed ? 1 : 0);
