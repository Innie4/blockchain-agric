import { createApp } from "./app.js";
import { env, publicRuntimeConfig } from "./config/env.js";
import { connectDatabase, disconnectDatabase, ensureIndexes } from "./config/database.js";
import { logger } from "./lib/logger.js";
import { getChainClient } from "./services/solana/chainClientRegistry.js";
import { normaliseBlockchainError } from "./services/solana/errorMapping.js";

/**
 * Process entry point. Configuration is validated on import of `config/env`,
 * so an incomplete `.env` stops the process with a precise message rather than
 * letting it start in a half-working state.
 */
async function main(): Promise<void> {
  const chain = getChainClient();
  logger.info(
    {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      database: env.MONGODB_DB_NAME,
      ...publicRuntimeConfig(),
    },
    "starting the agricultural supply chain API"
  );

  await connectDatabase();
  await ensureIndexes();

  const health = await chain.health();
  if (health.reachable) {
    logger.info({ slot: health.slot, commitment: health.commitment }, "connected to Solana");
  } else {
    // A reachable database with an unreachable cluster is still worth starting
    // for: public pages that do not need the chain keep working, and the
    // health endpoints report the outage accurately.
    const problem = normaliseBlockchainError(new Error(health.problem ?? "unreachable"), "startup health check");
    logger.error(
      { code: problem.code, problem: problem.message },
      "Solana is not reachable; write operations will fail until it is"
    );
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, clientUrl: env.CLIENT_URL }, "API listening");
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.error(
        { port: env.PORT },
        `Port ${env.PORT} is already in use. Set PORT in your .env file to a free port.`
      );
      process.exit(1);
    }
    logger.error({ problem: String(error) }, "the HTTP server failed");
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void disconnectDatabase().finally(() => {
        process.exit(0);
      });
    });
    // Do not let a stuck connection hold the process open indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ problem: String(reason) }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ problem: String(error), stack: error.stack }, "uncaught exception");
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  // Configuration failures throw before the logger is configured, so this is
  // printed directly: it is the message the operator needs to see.
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
