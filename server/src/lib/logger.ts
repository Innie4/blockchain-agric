import { pino, type Logger } from "pino";
import { env } from "../config/env.js";

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-csrf-token']",
  "res.headers['set-cookie']",
  "password",
  "sessionToken",
  "nonce",
  "signature",
  "privateKey",
  "secretPhrase",
  "*.password",
  "*.sessionTokenHash",
  "*.nonceHash",
];

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: "[redacted]" },
  base: { service: "agri-trace-api", env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino/file", options: { destination: 1 } }
      : undefined,
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
