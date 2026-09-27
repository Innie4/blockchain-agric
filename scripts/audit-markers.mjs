#!/usr/bin/env node
/**
 * Scans the repository for the markers that indicate unfinished work.
 *
 * The specification is explicit that no mock, placeholder, dead route or
 * leftover debug statement may survive into the delivered system. This turns
 * that from an intention into a check that fails the build.
 *
 * It also distinguishes findings that matter from those that do not, so a
 * genuine placeholder in a page is not drowned out by the word "mock" inside a
 * test double's name. Paths to test fixtures and documentation are excluded
 * deliberately: describing a mock is not mocking.
 *
 * Usage: node scripts/audit-markers.mjs
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const SCAN_DIRECTORIES = [
  "server/src",
  "server/tests",
  "server/scripts",
  "client/src",
  "programs/agri_trace",
];

const SCAN_EXTENSIONS = [".ts", ".tsx", ".rs", ".json", ".css", ".html", ".toml"];

/**
 * Paths where a content marker is not a finding. Test fixtures describe the
 * shape of data on purpose, and documentation quotes the words it is telling
 * readers to avoid. These exclusions apply only to the copy and marker rules:
 * stray debug output is a finding wherever it appears, tests included.
 */
const EXCLUDED = [
  /(^|[\\/])tests?[\\/]/,
  /(^|[\\/])__tests__[\\/]/,
  /(^|[\\/])docs[\\/]/,
  /README\.md$/,
  /audit-markers\.mjs$/,
  /\.test\.[a-z]+$/,
];

/** Rules that still apply inside test and documentation files. */
const RULES_THAT_APPLY_EVERYWHERE = new Set([
  "console-debug",
  "debugger",
  "dead-button",
  "empty-handler",
]);

const RULES = [
  {
    id: "unfinished-marker",
    pattern: /\b(TODO|FIXME|XXX|HACK|WIP)\b/g,
    // A comment that deliberately discusses the words, e.g. "no TODOs", is not
    // unfinished work.
    exempt: /no (TODO|FIXME|placeholder)|removes? .*(TODO|placeholder)|audit/i,
    message: "Unfinished-work marker left in the source.",
  },
  {
    id: "placeholder-copy",
    pattern: /\b(lorem ipsum|your journey starts here|coming soon|tbd|to be determined|placeholder text|replace me|dummy value|sample text)\b/gi,
    exempt: /audit|placeholder-copy|audit-markers/i,
    message: "Placeholder copy that would reach a participant.",
  },
  {
    id: "ai-marketing",
    pattern: /\b(powered by ai|ai-powered|revolutionis(e|ing|ed)|next-generation|game-?changing|cutting-edge|unleash|seamless(?:ly)? transform)\b/gi,
    exempt: /audit-markers/,
    message: "Marketing language the specification rules out.",
  },
  {
    id: "console-debug",
    pattern: /console\.(log|debug|info|dir|table|trace)\s*\(/g,
    exempt: /console\.(error|warn)/,
    message: "Debug output left in the source.",
    only: ["client/src", "server/src", "programs/agri_trace"],
  },
  {
    id: "empty-handler",
    pattern: /\b(onClick|onSubmit)=\{\(\)\s*=>\s*\{\s*\}\}/g,
    exempt: null,
    message: "A control that is present but does nothing.",
  },
  {
    id: "dead-button",
    pattern: /<button[^>]*>\s*(Coming soon|placeholder|TODO)\s*<\/button>/gi,
    exempt: null,
    message: "A button that is visibly present and functionally inert.",
  },
  {
    id: "disabled-debug",
    pattern: /\bdebugger\b|\bconsole\.assert\b/g,
    exempt: null,
    message: "Debugger statement left in the source.",
  },
];

async function walk(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "target" || entry.name === "dist") {
        continue;
      }
      found.push(...(await walk(path)));
    } else if (SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

const findings = [];
let scanned = 0;

for (const directory of SCAN_DIRECTORIES) {
  for (const file of await walk(join(root, directory))) {
    const relativePath = relative(root, file).replace(/\\/g, "/");
    const excluded = EXCLUDED.some((pattern) => pattern.test(relativePath));
    scanned += 1;
    const source = await readFile(file, "utf8");
    const lines = source.split(/\r?\n/);
    for (const rule of RULES) {
      if (excluded && !RULES_THAT_APPLY_EVERYWHERE.has(rule.id)) continue;
      if (rule.only !== undefined && !rule.only.some((prefix) => relativePath.startsWith(prefix))) {
        continue;
      }
      for (const match of source.matchAll(rule.pattern)) {
        const line = lines.slice(0, match.index).length;
        const text = lines[line] ?? "";
        if (rule.exempt !== null && rule.exempt !== undefined && rule.exempt.test(text)) {
          continue;
        }
        findings.push({
          id: rule.id,
          message: rule.message,
          file: relativePath,
          line: line + 1,
          excerpt: text.trim().slice(0, 120),
        });
      }
    }
  }
}

process.stdout.write("Unfinished-work marker audit\n\n");
process.stdout.write(`  files scanned : ${scanned}\n`);
process.stdout.write(`  rules         : ${RULES.length}\n\n`);

if (findings.length === 0) {
  process.stdout.write(
    "  No TODO, placeholder copy, marketing language, debug output or inert\n" +
      "  control was found in the shipped source.\n"
  );
  process.exit(0);
}

process.stdout.write(`  Findings (${findings.length}):\n`);
for (const finding of findings) {
  process.stdout.write(
    `    ${finding.file}:${finding.line}  [${finding.id}] ${finding.message}\n` +
      `      ${finding.excerpt}\n`
  );
}
process.exit(1);
