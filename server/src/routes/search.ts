import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ok } from "../lib/response.js";
import { validate, validatedQuery } from "../middleware/validate.js";
import { publicReadLimiter } from "../middleware/rateLimit.js";
import { searchPublicProducts } from "../services/products/productQueryService.js";

/**
 * The public registry lookup.
 *
 * It is its own router rather than a second mount of the verification router,
 * because `GET /api/search/:productId` would otherwise mean "verify this
 * product", which is not what that URL says to a reader.
 */
const router = Router();

const searchQuerySchema = z.object({
  q: z.string().trim().min(2, "Enter at least two characters to search.").max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get(
  "/",
  publicReadLimiter,
  validate(searchQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<z.infer<typeof searchQuerySchema>>(req);
    const results = await searchPublicProducts({ term: query.q, limit: query.limit });
    res.json(
      ok(
        { results, term: query.q },
        results.length === 0 ? `No registered batch matches "${query.q}".` : undefined
      )
    );
  })
);

export default router;
