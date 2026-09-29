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

/** The host part of a connection string, without the credentials or the path. */
export function mongoHost(uri: string): string {
  return uri.replace(/^mongodb(\+srv)?:\/\//, "").split("/")[0]?.split("@").pop() ?? "";
}

/**
 * Whether the connection string points at the machine the process runs on.
 *
 * That is right in development and almost always wrong when deployed: a hosted
 * platform runs the application in a container with no database of its own, so a
 * loopback address means the connection string was left at its development value
 * and the process will spend its whole start-up budget waiting for a server that
 * is not there. Warning at start, before the attempt, turns a slow crash-loop
 * into one clear line in the log.
 */
export function pointsAtLoopback(uri: string): boolean {
  // Split the port off first. IPv6 literals are bracketed, so the port separator
  // is the colon after the closing bracket, not the first colon in the string.
  const authority = mongoHost(uri);
  const host = authority.startsWith("[")
    ? (authority.slice(0, authority.indexOf("]") + 1) || authority)
    : (authority.split(":")[0] ?? "");
  const normalised = host.toLowerCase();
  return (
    normalised === "localhost" ||
    normalised === "127.0.0.1" ||
    normalised === "[::1]" ||
    normalised === "::1"
  );
}

/**
 * What the operator is told when the database cannot be reached.
 *
 * Exported because it is a pure function of the mode and the address, and because
 * the wording is the part that matters. The previous version told the reader to
 * check a `.env` file and to start MongoDB, neither of which is possible on a
 * deployed service, and it did not name the thing that has to change.
 */
export function databaseUnreachableMessage(nodeEnv: string, uri: string): string {
  const base = "The database could not be reached, so the API cannot serve requests and will stop.";
  if (nodeEnv === "production") {
    return (
      `${base} On a deployed service MONGODB_URI must be an environment variable pointing at a ` +
      "hosted database, not a local one: there is no MongoDB running alongside the process. " +
      `It currently points at "${mongoHost(uri)}". ` +
      "Provision a database (MongoDB Atlas has a free tier) and set MONGODB_URI on the service. " +
      "Do not put the connection string in the repository."
    );
  }
  return (
    `${base} Check MONGODB_URI, and that MongoDB is running and reachable at ` +
    `"${mongoHost(uri)}".`
  );
}

/**
 * Opens the shared Mongoose connection. Safe to call repeatedly: concurrent
 * callers await the same promise.
 */
export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting !== null) return connecting;

  if (env.NODE_ENV === "production" && pointsAtLoopback(env.MONGODB_URI)) {
    log.warn(
      {
        database: env.MONGODB_DB_NAME,
        host: mongoHost(env.MONGODB_URI),
      },
      "MONGODB_URI points at the local machine while running in production; " +
        "a deployed service needs a hosted database set as an environment variable"
    );
  }

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
      log.error(
        { problem: describe(error), host: mongoHost(env.MONGODB_URI) },
        "could not connect to MongoDB"
      );
      throw new AppError(ERROR_CODES.DATABASE_UNAVAILABLE, {
        message: databaseUnreachableMessage(env.NODE_ENV, env.MONGODB_URI),
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
