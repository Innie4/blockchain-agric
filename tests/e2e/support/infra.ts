import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoMemoryServer } from "mongodb-memory-server";

import {
  INFRA_CONTROL_PORT,
  MONGO_DB_NAME,
  MOCK_RPC_PORT,
  RUNTIME_ENV_FILE,
  SOLANA_NETWORK,
  SOLANA_PROGRAM_ID,
} from "./constants";
import { startMockRpc, type MockRpcHandle } from "./mockRpc";

/**
 * The long-lived process the Playwright `webServer` array starts first.
 *
 * It brings up the two things the API needs that no repository file can provide:
 * a MongoDB it can talk to, and a Solana endpoint it can write to. Both live
 * here rather than in a `globalSetup` hook because `globalSetup` exits as soon
 * as it returns, which would take a mock validator with it.
 *
 * It also publishes what it chose on a small HTTP control port:
 *   - `GET  /ready`  the readiness document, which is what `webServer.url` polls
 *   - `POST /rpc/reset`  clears the mock ledger between tests
 * and writes the connection details to `tests/e2e/.runtime/environment.json`,
 * which the API launcher and the test process both read.
 *
 * The suite relies on packages the `server` workspace already declares
 * (`mongodb-memory-server`, `mongodb`) and on npm's workspace hoisting to reach
 * them from here, so this project adds no dependencies of its own.
 */

export interface RuntimeEnvironment {
  mongoUri: string;
  mongoDbName: string;
  mockRpcUrl: string;
  programId: string;
  network: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

function runtimeEnvironmentPath(): string {
  return resolve(REPO_ROOT, RUNTIME_ENV_FILE);
}

async function main(): Promise<void> {
  const rpc: MockRpcHandle = await startMockRpc({
    programId: SOLANA_PROGRAM_ID,
    port: MOCK_RPC_PORT,
  });

  const mongod = await MongoMemoryServer.create({
    instance: {
      // A free port of its own choosing, so a previous run's mongod can never
      // block this one.
      dbName: MONGO_DB_NAME,
    },
  });

  const environment: RuntimeEnvironment = {
    mongoUri: mongod.getUri(),
    mongoDbName: MONGO_DB_NAME,
    mockRpcUrl: rpc.url,
    programId: SOLANA_PROGRAM_ID,
    network: SOLANA_NETWORK,
  };

  const target = runtimeEnvironmentPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(environment, null, 2)}\n`, "utf8");

  const control = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/ready" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: true, ...environment }));
      return;
    }
    if (req.method === "POST" && req.url === "/rpc/reset") {
      rpc.reset();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reset: true, ledger: rpc.snapshot() }));
      return;
    }
    if (req.method === "GET" && req.url === "/rpc/snapshot") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rpc.snapshot()));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "No such control route." }));
  });

  await new Promise<void>((resolveListen) => {
    control.listen(INFRA_CONTROL_PORT, "127.0.0.1", () => {
      resolveListen();
    });
  });

  // Playwright kills this process when the run ends; the handlers below make
  // sure the mongod it started does not outlive it.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    control.close();
    void rpc.close().finally(() => {
      void mongod.stop().finally(() => {
        process.exit(0);
      });
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `The end-to-end infrastructure could not start: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
