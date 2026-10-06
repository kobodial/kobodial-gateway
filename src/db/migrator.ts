import { PGlite } from "@electric-sql/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client.js";

export const MIGRATIONS_FOLDER = "./src/db/migrations";

/**
 * Applies pending migrations. Safe to run on every deploy and every local
 * start — drizzle records which migrations have already applied and skips
 * them.
 *
 * The two drivers have separate migrators, so the right one is chosen from
 * the client the db was actually built with, rather than from configuration.
 * Deciding that twice — here and in createDb — is how the two would end up
 * disagreeing.
 *
 * Kept apart from migrate.ts so that importing this from a test does not run
 * the command-line entry point, which reads the environment and would try to
 * connect to a real database.
 */
export async function migrateDb(db: Db): Promise<void> {
  const client: unknown = (db as { $client?: unknown }).$client;
  if (client instanceof PGlite) {
    await migratePglite(db as Parameters<typeof migratePglite>[0], {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    return;
  }
  await migrateNodePg(db as Parameters<typeof migrateNodePg>[0], {
    migrationsFolder: MIGRATIONS_FOLDER,
  });
}
