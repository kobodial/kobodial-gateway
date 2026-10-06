import { createDb } from "./client.js";
import { migrateDb } from "./migrator.js";

/**
 * Command-line entry point: `npm run db:migrate`.
 *
 * The migration itself lives in migrator.ts, so tests can apply migrations
 * without this file's environment loading running as a side effect of the
 * import.
 *
 * Only DATABASE_URL is read, deliberately — not the full validated
 * environment. Creating tables has no business requiring a relayer signing
 * key or an Africa's Talking credential, and demanding them makes migrating
 * awkward exactly where it matters: a deploy step, or a one-off run against a
 * fresh database.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set (see .env.example)");
  }
  const db = createDb(databaseUrl);
  await migrateDb(db);
  console.log("migrations applied");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
