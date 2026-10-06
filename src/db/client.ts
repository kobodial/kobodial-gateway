import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

/**
 * The store is Postgres.
 *
 * It was SQLite on the container filesystem, which worked locally and lost
 * everything on a deployment with no persistent disk — every restart,
 * including waking from idle, began with an empty database. Balances were
 * never affected, since those live on-chain, but the transaction log and the
 * agent directory were, so the dashboard's history vanished on each sleep.
 *
 * Two drivers, one schema:
 *
 * - **node-postgres** for a real `postgres://` URL.
 * - **PGlite** — Postgres compiled to WebAssembly, running in this process —
 *   for tests. This is why the suite still needs no service container while
 *   exercising the same SQL as production. The alternative was a second,
 *   SQLite-shaped schema, which would drift from this one.
 */

export type Db =
  ReturnType<typeof drizzlePglite<typeof schema>> | ReturnType<typeof drizzleNodePg<typeof schema>>;

/** Asks for the in-process database. Kept as the spelling tests already used. */
export const IN_MEMORY = ":memory:";

function isInMemory(databaseUrl: string): boolean {
  const u = databaseUrl.trim();
  return u === IN_MEMORY || u === "" || u.startsWith("memory://");
}

export class UnsupportedDatabaseUrlError extends Error {
  constructor(databaseUrl: string) {
    // Deliberately does not echo the URL: it carries the password.
    super(
      `DATABASE_URL must be a postgres:// or postgresql:// URL, or "${IN_MEMORY}" for an ` +
        `in-process database. Got "${databaseUrl.split(":")[0] || "(empty)"}:…"`,
    );
    this.name = "UnsupportedDatabaseUrlError";
  }
}

export function createDb(databaseUrl: string): Db {
  if (isInMemory(databaseUrl)) {
    return drizzlePglite(new PGlite(), { schema });
  }

  const url = databaseUrl.trim();
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    // A bare file path used to mean SQLite. Failing loudly beats starting
    // against nothing and reporting an empty database as though it were real.
    throw new UnsupportedDatabaseUrlError(url);
  }

  // Managed Postgres (Neon, Render, most providers) refuses plaintext, and
  // their certificates often chain to roots a slim image does not carry.
  // Verification is relaxed only when the URL itself asks for TLS without a
  // mode that demands full verification — the same latitude libpq gives
  // `sslmode=require`, which encrypts without authenticating the server.
  const wantsTls = /[?&]sslmode=(require|prefer)\b/i.test(url);

  const pool = new Pool({
    connectionString: url,
    ...(wantsTls ? { ssl: { rejectUnauthorized: false } } : {}),
    // Small on purpose: a USSD request runs a handful of short queries, and
    // free-tier Postgres caps connections tightly.
    max: 5,
    // Under the idle timeout of serverless Postgres, so the pool discards a
    // connection before the provider closes it underneath us.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  return drizzleNodePg(pool, { schema });
}
