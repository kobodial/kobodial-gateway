import { Router } from "express";
import { desc, count, eq, and } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { wallets, transactions } from "../db/schema.js";
import type { KoboDialClient } from "../contract/client.js";
import { ContractError, ContractErrorCode } from "../contract/errors.js";
import { fromHex } from "../crypto/hash.js";

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

/**
 * A phone hash as it appears in these tables: the lowercase hex of a
 * SHA-256 digest, so exactly 64 hex characters. Validated before any
 * RPC call, so a malformed path parameter costs a 400 rather than a
 * round trip to the chain.
 */
const phoneHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export function createDashboardRouter(db: Db, contract: KoboDialClient): Router {
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

  /**
   * The one endpoint here that leaves the database. Balances live on
   * chain and are deliberately not cached locally — see the wallets
   * table comment in src/db/schema.ts — so this reads through to the
   * contract on every call.
   */
  router.get("/wallets/:phoneHash/balance", async (req, res) => {
    const parsed = phoneHashSchema.safeParse(req.params.phoneHash);
    if (!parsed.success) {
      res.status(400).json({ error: "phoneHash must be 64 lowercase hex characters" });
      return;
    }
    const phoneHash = parsed.data;

    try {
      const balance = await contract.getBalance(fromHex(phoneHash));
      // A decimal string, not a number: balances are i128 on chain and
      // can exceed Number.MAX_SAFE_INTEGER. The transactions table
      // stores amounts as text for the same reason.
      res.json({ phoneHash, balance: balance.toString() });
    } catch (err) {
      // "No such wallet" and "the chain did not answer" must not collapse
      // into one status. The first is a fact about the wallet; the second
      // says nothing about it and the caller should retry.
      if (err instanceof ContractError && err.code === ContractErrorCode.WalletNotFound) {
        res.status(404).json({ error: "WalletNotFound", phoneHash });
        return;
      }
      res.status(502).json({
        error: "could not read the balance from the contract",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
