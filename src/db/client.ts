import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

/**
 * DATABASE_URL for the sqlite driver is a bare file path, optionally
 * prefixed with "file:" (accepted so the same variable name reads the
 * same way it would for a future Postgres URL). ":memory:" is passed
 * straight through, for tests.
 */
function resolveSqlitePath(databaseUrl: string): string {
  if (databaseUrl === ":memory:") return databaseUrl;
  return databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl;
}

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(databaseUrl: string): Db {
  const sqlite = new Database(resolveSqlitePath(databaseUrl));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}
