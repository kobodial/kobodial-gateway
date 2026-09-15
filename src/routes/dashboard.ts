import { Router } from "express";
import { desc, count, eq, and } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { wallets, transactions } from "../db/schema.js";

/**
 * A small internal read-only API for the dashboard. Every row returned
 * from these tables already contains only SHA-256 hex digests and
 * amounts — see src/db/schema.ts — so there is nothing further to
 * redact here; the safety property comes from what was never written
 * to these tables in the first place, not from filtering on the way
 * out.
 *
 * No authentication in this MVP, matching the same posture
 * kobodial-contracts documents for its own read views: this is meant
 * to sit behind a private network or a reverse proxy that adds access
 * control, not to be exposed directly. See SECURITY.md.
 */

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Filters for GET /transactions. The accepted values are read off the
 * table definition rather than restated here: a new transaction kind
 * added to src/db/schema.ts becomes filterable automatically, instead
 * of silently 400ing until someone remembers to update a second list.
 *
 * Both are optional, and an unrecognised value is rejected rather than
 * ignored — an empty result must mean "nothing matched", never "you
 * spelled it wrong".
 */
const transactionQuerySchema = paginationSchema.extend({
  kind: z.enum(transactions.kind.enumValues).optional(),
  status: z.enum(transactions.status.enumValues).optional(),
});

export function createDashboardRouter(db: Db): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    try {
      // Any query at all proves the connection this process holds is
      // alive; the wallets table always exists once migrations have
      // run, so counting it costs nothing and asserts something real.
      await db.select().from(wallets).limit(1);
      res.json({ status: "ok" });
    } catch (err) {
      res.status(503).json({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/wallets", async (req, res) => {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }
    const { limit, offset } = parsed.data;
    const rows = await db.select().from(wallets).orderBy(desc(wallets.id)).limit(limit).offset(offset);
    // A COUNT always returns exactly one row, but the index signature
    // is still optional under noUncheckedIndexedAccess; 0 is the only
    // sensible reading of a missing count anyway.
    const total = (await db.select({ total: count() }).from(wallets))[0]?.total ?? 0;
    // limit and offset are echoed back because both have defaults: a client
    // that sent neither is holding rows 0-49 and has no other way to know
    // which window it got. Values above the cap are rejected outright by
    // paginationSchema rather than clamped, so this never disagrees with
    // what was asked for.
    res.json({ wallets: rows, total, limit, offset });
  });

  router.get("/transactions", async (req, res) => {
    const parsed = transactionQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }
    const { limit, offset, kind, status } = parsed.data;

    const conditions = [
      kind === undefined ? undefined : eq(transactions.kind, kind),
      status === undefined ? undefined : eq(transactions.status, status),
    ].filter((c) => c !== undefined);
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(transactions)
      .where(where)
      .orderBy(desc(transactions.id))
      .limit(limit)
      .offset(offset);
    // The count applies the same predicate as the rows. A total computed
    // over the whole table while the rows are filtered would be worse
    // than no total at all — it would make every filtered view look like
    // it was hiding results.
    // A COUNT always returns exactly one row, but the index signature is
    // still optional under noUncheckedIndexedAccess; 0 is the only
    // sensible reading of a missing count anyway.
    const total = (await db.select({ total: count() }).from(transactions).where(where))[0]?.total ?? 0;
    res.json({ transactions: rows, total, limit, offset, kind, status });
  });

  return router;
}
