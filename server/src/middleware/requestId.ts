import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlates log lines, error responses and audit rows. */
      requestId: string;
      startTime: number;
    }
  }
}

/** Assigns a request id, honouring an inbound `x-request-id` for tracing. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header("x-request-id");
  req.requestId =
    inbound !== undefined && /^[A-Za-z0-9._-]{8,128}$/.test(inbound) ? inbound : randomUUID();
  req.startTime = Date.now();
  res.setHeader("x-request-id", req.requestId);
  next();
}
