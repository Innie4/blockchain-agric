import { Router } from "express";
import { env, publicRuntimeConfig } from "../config/env.js";
import { databaseHealth } from "../config/database.js";
import { getChainClient } from "../services/solana/chainClientRegistry.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ok } from "../lib/response.js";

const router = Router();

/**
 * Liveness. Answers as long as the process is running, so a load balancer does
 * not take a healthy instance out of rotation during a database outage.
 */
router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    res.json(
      ok({
        status: "ok",
        service: "agri-trace-api",
        uptimeSeconds: Math.floor(process.uptime()),
        runtime: publicRuntimeConfig(),
      })
    );
  })
);

/** Readiness. Requires both the database and the configured chain client. */
router.get(
  "/health/ready",
  asyncHandler(async (_req, res) => {
    const database = await databaseHealth();
    const chain = await getChainClient().health();
    const ready = database.reachable && chain.reachable;
    res.status(ready ? 200 : 503).json({
      success: ready,
      data: { ready, database, blockchain: chain },
      message: ready
        ? "The API is ready to serve requests."
        : "The API is not ready: see the database and blockchain details.",
    });
  })
);

router.get(
  "/health/database",
  asyncHandler(async (_req, res) => {
    const database = await databaseHealth();
    res
      .status(database.reachable ? 200 : 503)
      .json({ success: database.reachable, data: database });
  })
);

router.get(
  "/health/blockchain",
  asyncHandler(async (_req, res) => {
    const chain = await getChainClient().health();
    res.status(chain.reachable ? 200 : 503).json({ success: chain.reachable, data: chain });
  })
);

/** Public configuration the client needs before it has a session. */
router.get(
  "/config",
  asyncHandler(async (_req, res) => {
    res.json(
      ok({
        ...publicRuntimeConfig(),
        clientUrl: env.CLIENT_URL,
        nonceTtlSeconds: env.AUTH_NONCE_TTL_SECONDS,
      })
    );
  })
);

export default router;
