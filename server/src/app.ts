import express, { type Application, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import mongoSanitize from "express-mongo-sanitize";
import { pinoHttp } from "pino-http";
import { env, corsOrigins } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { AppError, ERROR_CODES } from "./lib/errors.js";
import { requestId } from "./middleware/requestId.js";
import { attachSession } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { generalLimiter } from "./middleware/rateLimit.js";
import { idempotency } from "./middleware/idempotency.js";
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import productRoutes from "./routes/products.js";
import transferRoutes from "./routes/transfers.js";
import verifyRoutes from "./routes/verify.js";
import searchRoutes from "./routes/search.js";
import mediaRoutes from "./routes/media.js";
import workspaceRoutes from "./routes/workspace.js";
import operationsRoutes from "./routes/operations.js";

export function createApp(): Application {
  const app = express();

  // Required for correct client IPs and secure cookies behind a reverse proxy.
  if (env.TRUST_PROXY !== undefined) {
    app.set("trust proxy", env.TRUST_PROXY);
  }
  app.disable("x-powered-by");

  app.use(requestId);

  app.use(
    helmet({
      // The API serves JSON and file streams only; a restrictive policy costs
      // nothing and removes any chance of the API being framed.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "no-referrer" },
      hsts: env.NODE_ENV === "production" ? { maxAge: 15_552_000 } : false,
    })
  );

  app.use(
    cors({
      origin(origin, callback) {
        // A request with no Origin is a same-origin request or a server-side
        // call; neither is subject to the allowlist.
        if (origin === undefined) {
          callback(null, true);
          return;
        }
        if (corsOrigins().includes(origin)) {
          callback(null, true);
          return;
        }
        callback(
          new AppError(ERROR_CODES.FORBIDDEN, {
            message: `This origin is not allowed to call the API. Allowed origins: ${corsOrigins().join(", ")}.`,
          })
        );
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "content-type",
        "x-csrf-token",
        "x-request-id",
        "idempotency-key",
        "authorization",
      ],
      exposedHeaders: ["x-request-id", "idempotent-replay"],
      maxAge: 600,
    })
  );

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).requestId,
      autoLogging: { ignore: (req) => req.url === "/api/health" },
      customLogLevel(_req, res, err) {
        if (err !== undefined || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    })
  );

  // Bodies are small: nothing the API accepts is a document.
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));
  app.use(cookieParser());
  // Strips `$`-prefixed keys and dots, closing operator-injection attempts.
  app.use(mongoSanitize({ allowDots: false, replaceWith: "_" }));

  app.use("/api", attachSession);
  app.use("/api", generalLimiter);
  app.use("/api", idempotency());

  // Mounted at the API root because the router already declares the full paths
  // (`/health`, `/health/ready`, `/config`); mounting it at `/api/health` as
  // well would only produce unreachable `/api/health/health` routes.
  app.use("/api", healthRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/products", productRoutes);
  app.use("/api/transfers", transferRoutes);
  app.use("/api/verify", verifyRoutes);
  // Search is the public registry lookup. It is its own router rather than a
  // second mount of the verification router, because `GET /api/search/:productId`
  // would otherwise mean "verify this product", which is not what the URL says.
  app.use("/api/search", searchRoutes);
  app.use("/api/media", mediaRoutes);
  app.use("/api/certificates", mediaRoutes);
  app.use("/api/operations", operationsRoutes);
  app.use("/api", workspaceRoutes);

  app.use("/api", notFoundHandler);

  // Anything outside the API prefix is a client-side route; the SPA serves it.
  app.use((req: Request, res: Response) => {
    if (req.path.startsWith("/api/")) {
      res.status(404).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: "No API route matches that path." },
      });
      return;
    }
    res.status(404).type("text/plain").send("Not found");
  });

  app.use(errorHandler);

  return app;
}
