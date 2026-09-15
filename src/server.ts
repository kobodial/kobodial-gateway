import "dotenv/config";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { loadEnv } from "./config/env.js";
import { createDb } from "./db/client.js";
import { SorobanKoboDialClient } from "./contract/client.js";
import { UssdMenuHandler } from "./ussd/menu.js";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";

function main(): void {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const db = createDb(env.DATABASE_URL);
  // Idempotent — safe on every restart. A multi-instance deployment
  // should run `npm run db:migrate` once before starting additional
  // instances rather than relying on every instance racing to migrate
  // on boot; see the relayer sequence-number note in SECURITY.md for
  // the same shape of caveat on the write side.
  migrate(db, { migrationsFolder: "./src/db/migrations" });

  const contract = new SorobanKoboDialClient({
    rpcUrl: env.RPC_URL,
    contractId: env.CONTRACT_ID,
    networkPassphrase: env.NETWORK_PASSPHRASE,
    relayerSecretKey: env.RELAYER_SECRET_KEY,
  });
  logger.info("contract client ready", {
    relayerAddress: contract.relayerAddress,
    contractId: env.CONTRACT_ID,
  });

  const menu = new UssdMenuHandler(db, contract, logger);
  const app = createApp({
    db,
    menu,
    contract,
    logger,
    africasTalkingUsername: env.AFRICAS_TALKING_USERNAME,
    africasTalkingApiKey: env.AFRICAS_TALKING_API_KEY,
  });

  app.listen(env.PORT, () => {
    logger.info("kobodial-gateway listening", { port: env.PORT });
  });
}

main();
