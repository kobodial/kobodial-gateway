import { Router } from "express";
import { desc, count } from "drizzle-orm";
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
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }
    const { limit, offset } = parsed.data;
    const rows = await db
      .select()
      .from(transactions)
      .orderBy(desc(transactions.id))
      .limit(limit)
      .offset(offset);
    // A COUNT always returns exactly one row, but the index signature
    // is still optional under noUncheckedIndexedAccess; 0 is the only
    // sensible reading of a missing count anyway.
    const total = (await db.select({ total: count() }).from(transactions))[0]?.total ?? 0;
    res.json({ transactions: rows, total, limit, offset });
  });

  return router;
}
