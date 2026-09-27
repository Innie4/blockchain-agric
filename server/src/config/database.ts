import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import { childLogger } from "../lib/logger.js";

const log = childLogger({ layer: "database" });

// Untrusted request data is stripped of `$` keys and dots by
// `express-mongo-sanitize` at the HTTP boundary. Mongoose's own
// `sanitizeFilter` cannot be used as a second line of defence in this version:
// it wraps every operator object, including the `$in` and `$gte` the services
// legitimately build, in `$eq`, so those queries no longer cast.
mongoose.set("strictQuery", true);

let connecting: Promise<typeof mongoose> | null = null;

export function mongoUriForTests(): string {
  return env.MONGODB_URI;
}

/**
 * Opens the shared Mongoose connection. Safe to call repeatedly: concurrent
 * callers await the same promise.
 */
export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting !== null) return connecting;

  connecting = mongoose
    .connect(env.MONGODB_URI, {
      dbName: env.MONGODB_DB_NAME,
      maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
      retryWrites: true,
    })
    .then((instance) => {
      log.info(
        { database: env.MONGODB_DB_NAME },
        "connected to MongoDB"
      );
      return instance;
    })
    .catch((error: unknown) => {
      connecting = null;
      log.error({ problem: describe(error) }, "could not connect to MongoDB");
      throw new AppError(ERROR_CODES.DATABASE_UNAVAILABLE, {
        message:
          "The database could not be reached. Check MONGODB_URI in your .env file and that MongoDB is running.",
        cause: error,
      });
    });

  return connecting;
}

export async function disconnectDatabase(): Promise<void> {
  connecting = null;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

export interface DatabaseHealth {
  reachable: boolean;
  database: string;
  /** Present when `reachable` is false. */
  problem?: string;
}

export async function databaseHealth(): Promise<DatabaseHealth> {
  if (mongoose.connection.readyState === 1) {
    try {
      await mongoose.connection.db?.admin().ping();
      return { reachable: true, database: env.MONGODB_DB_NAME };
    } catch (error) {
      return {
        reachable: false,
        database: env.MONGODB_DB_NAME,
        problem: describe(error),
      };
    }
  }
  return {
    reachable: false,
    database: env.MONGODB_DB_NAME,
    problem: "The database connection is not established.",
  };
}

/**
 * Builds the indexes declared on the models. Called at startup so query
 * performance does not depend on an operator remembering to do it.
 */
export async function ensureIndexes(): Promise<void> {
  const models = mongoose.connection.models;
  for (const name of Object.keys(models)) {
    const model = models[name];
    if (model === undefined) continue;
    try {
      await model.createIndexes();
    } catch (error) {
      log.warn({ model: name, problem: describe(error) }, "index creation failed");
    }
  }
}

/** Wraps MongoDB driver failures as a stable database error. */
export function normaliseDatabaseError(error: unknown, context: string): AppError {
  if (AppError.isAppError(error)) return error;
  const name = (error as { name?: string } | null)?.name ?? "";
  if (
    name === "MongoNetworkError" ||
    name === "MongoServerSelectionError" ||
    name === "MongoNotConnectedError" ||
    name === "MongooseServerSelectionError"
  ) {
    return new AppError(ERROR_CODES.DATABASE_UNAVAILABLE, { cause: error });
  }
  if (name === "MongoServerError" && (error as { code?: number }).code === 11000) {
    return new AppError(ERROR_CODES.PRODUCT_ALREADY_EXISTS, {
      message: "A record with those identifying details already exists.",
      cause: error,
    });
  }
  log.error({ context, problem: describe(error) }, "database operation failed");
  return new AppError(ERROR_CODES.INTERNAL_ERROR, { cause: error });
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
