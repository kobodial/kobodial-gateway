import { Router } from "express";
import { desc } from "drizzle-orm";
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
    const rows = await db
      .select()
      .from(wallets)
      .orderBy(desc(wallets.id))
      .limit(parsed.data.limit)
      .offset(parsed.data.offset);
    res.json({ wallets: rows });
  });

  router.get("/transactions", async (req, res) => {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }
    const rows = await db
      .select()
      .from(transactions)
      .orderBy(desc(transactions.id))
      .limit(parsed.data.limit)
      .offset(parsed.data.offset);
    res.json({ transactions: rows });
  });

  return router;
}
