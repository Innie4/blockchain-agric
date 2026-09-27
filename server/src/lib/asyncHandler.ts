import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Forwards rejected promises from async handlers to the central error handler
 * so no route has to remember its own try/catch.
 */
export function asyncHandler<T>(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<T>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
