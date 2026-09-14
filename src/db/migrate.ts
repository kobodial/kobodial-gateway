import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb } from "./client.js";
import { loadEnv } from "../config/env.js";

/**
 * Applies pending migrations from src/db/migrations. Safe to run on
 * every deploy and every local start — drizzle tracks which migrations
 * have already applied and skips them.
 */
function main(): void {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("migrations applied");
}

main();
