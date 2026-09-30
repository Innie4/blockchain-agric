#!/usr/bin/env node
/**
 * Checks that every environment variable the code reads is documented, and that
 * nothing is documented that the code never reads.
 *
 * A variable in the code but missing from `.env.example` is a blocker the
 * operator only discovers at startup. A variable documented but never read is a
 * false promise. Both are reported here rather than left to a human reading
 * two directories at once.
 *
 * Usage: node scripts/audit-env.mjs
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverDir = join(root, "server", "src");
const clientDir = join(root, "client", "src");
const examplePath = join(root, ".env.example");

async function sourceFiles(dir) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(path);
    }
  };
  await walk(dir);
  return found;
}

/** Names the server reads, and whether each one is server-only. */
async function serverVariables() {
  const names = new Set();
  for (const file of await sourceFiles(serverDir)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/process\.env\["([A-Z0-9_]+)"\]/g)) {
      names.add(match[1]);
    }
    // `env.NAME`, which is how the validated configuration is consumed.
    for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
      names.add(match[1]);
    }
  }
  // A bare `.env.` in a comment or a file path is not a variable.
  names.delete("example");
  names.delete("js");
  return names;
}

/** Vite supplies these itself; they are not project configuration. */
const BUILT_IN_CLIENT_VARIABLES = new Set(["DEV", "PROD", "SSR", "MODE", "BASE_URL"]);

async function clientVariables() {
  const names = new Set();
  for (const file of await sourceFiles(clientDir)) {
    const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g)) {
        if (!BUILT_IN_CLIENT_VARIABLES.has(match[1])) names.add(match[1]);
      }
      // The bracketed form, `import.meta.env["NAME"]`, is the same read and is
      // what you get when the key is looked up defensively. Without this a
      // variable read that way looks undocumented and unused, and the audit
      // would send someone looking for a bug that is not there.
      for (const match of source.matchAll(/import\.meta\.env\["([A-Z][A-Z0-9_]*)"\]/g)) {
        if (!BUILT_IN_CLIENT_VARIABLES.has(match[1])) names.add(match[1]);
      }
  }
  return names;
}

/** Names documented in `.env.example`. */
async function documentedVariables() {
  const source = await readFile(examplePath, "utf8");
  const names = new Set();
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line.trim());
    if (match !== null) names.add(match[1]);
  }
  return names;
}

/** The variables the validation schema requires before the process will start. */
async function requiredVariables() {
  const source = await readFile(join(serverDir, "config", "env.ts"), "utf8");
  const block = /z\s*\.\s*object\(\{([\s\S]*?)\}\s*\)\s*\.\s*superRefine/.exec(source);
  if (block === null) return new Set();
  const required = new Set();
  for (const line of block[1].split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*):\s*z\.(?!enum|union|coerce|booleanish)/.exec(line);
    if (match !== null) required.add(match[1]);
  }
  return required;
}

const [server, client, documented, required] = [
  await serverVariables(),
  await clientVariables(),
  await documentedVariables(),
  await requiredVariables(),
];

const problems = [];
// The prefixes `client/vite.config.ts` declares in `envPrefix`. Anything Vite
// inlines ends up in the browser bundle, so a name on this list is public and must
// never be a secret, and a name off it that the browser reads is a bug: it will
// read as `undefined` in the bundle however the host has configured it.
const CLIENT_PREFIXES = ["VITE_", "DEMO_"];
const isClientSide = (name) => CLIENT_PREFIXES.some((prefix) => name.startsWith(prefix));

// A prefixed variable read by the server would be embedded in the bundle; a
// non-prefixed variable read by the client would simply be undefined there.
for (const name of server) {
  if (isClientSide(name)) {
    problems.push(`SERVER-SIDE SECRET: ${name} is read by the server but named as a browser variable.`);
  }
}
for (const name of client) {
  if (!isClientSide(name)) {
    problems.push(
      `CLIENT MISSING PREFIX: ${name} is read by the client but carries none of ${CLIENT_PREFIXES.join(", ")}, so it will be undefined in the bundle.`,
    );
  }
}
for (const name of [...server, ...client]) {
  if (!documented.has(name)) {
    problems.push(`UNDOCUMENTED: ${name} is read by the code but is absent from .env.example.`);
  }
}
for (const name of documented) {
  if (!server.has(name) && !client.has(name)) {
    problems.push(`UNUSED: ${name} is documented in .env.example but no code reads it.`);
  }
}

// A required variable with no usable default is a genuine external blocker, so
// it is reported separately from the consistency problems above.
const externalBlockers = [...required].filter(
  (name) => !documented.has(name)
);

const report = [];
report.push("Environment variable audit");
report.push("");
report.push(`  read by the server : ${server.size}`);
report.push(`  read by the client : ${client.size}`);
report.push(`  documented         : ${documented.size}`);
report.push(`  required to start  : ${required.size}`);
report.push("");

if (problems.length === 0) {
  report.push("  Every variable the code reads is documented, and every documented");
  report.push("  variable is read. No server-side secret is exposed to the browser.");
  report.push("");
  report.push(`  Server-only (never sent to a browser): ${[...server]
    .filter((name) => !isClientSide(name))
    .sort()
    .join(", ")}`);
  report.push("");
  report.push(`  Browser-visible (embedded in the bundle): ${[...client].sort().join(", ")}`);
} else {
  report.push("  Problems:");
  for (const problem of problems.sort()) report.push(`    - ${problem}`);
}

if (externalBlockers.length > 0) {
  report.push("");
  report.push("  Required but undocumented (must be supplied by the operator):");
  for (const name of externalBlockers.sort()) report.push(`    - ${name}`);
}

report.push("");
process.stdout.write(`${report.join("\n")}\n`);
process.exit(problems.length === 0 ? 0 : 1);
