import { resetDatabase, runtimeEnvironment } from "./database";

/**
 * One check before any test runs: the infrastructure published its connection
 * details and the database is reachable.
 *
 * Starting the infrastructure is not done here. `globalSetup` returns as soon as
 * it finishes, and anything it started would go with it, so MongoDB and the mock
 * Solana node live in the process Playwright keeps alive as the first
 * `webServer` entry. What this hook can usefully do is fail immediately, and
 * with an explanation, if that process never came up.
 */
export default async function globalSetup(): Promise<void> {
  const environment = runtimeEnvironment();
  await resetDatabase();

  process.stdout.write(
    [
      "",
      "End-to-end infrastructure is up:",
      `  database        ${environment.mongoDbName} at ${environment.mongoUri}`,
      `  solana cluster  the mock node at ${environment.mockRpcUrl} (${environment.network})`,
      `  program         ${environment.programId}`,
      "",
    ].join("\n"),
  );
}
