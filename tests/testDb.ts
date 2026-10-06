import { sql } from "drizzle-orm";
import { createDb, IN_MEMORY, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrator.js";

/**
 * A clean database for one test, reusing a single Postgres instance.
 *
 * PGlite is Postgres compiled to WebAssembly, which gives the suite real
 * Postgres semantics with no service to run — but booting one costs **6 to 8
 * seconds**. A fresh instance per test, which is what the SQLite version did
 * for free, would have turned a five-second suite into several minutes.
 *
 * So the instance is created once per worker and truncated between tests
 * instead. `RESTART IDENTITY` matters: several tests assert on generated ids
 * and on a row's position, and without it those would drift as earlier tests
 * consumed sequence values.
 */
let shared: Db | undefined;

const TABLES = ["wallets", "ussd_sessions", "transactions", "agents", "pin_attempts"] as const;

export async function freshDb(): Promise<Db> {
  if (!shared) {
    shared = createDb(IN_MEMORY);
    await migrateDb(shared);
  }
  await shared.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
  return shared;
}
