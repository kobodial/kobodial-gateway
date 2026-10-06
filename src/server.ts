import "dotenv/config";
import { migrateDb } from "./db/migrator.js";
import { loadEnv } from "./config/env.js";
import { Hasher } from "./crypto/hash.js";
import { createDb } from "./db/client.js";
import { SorobanKoboDialClient } from "./contract/client.js";
import { UssdMenuHandler } from "./ussd/menu.js";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const db = createDb(env.DATABASE_URL);
  // Idempotent — safe on every restart. A multi-instance deployment
  // should run `npm run db:migrate` once before starting additional
  // instances rather than relying on every instance racing to migrate
  // on boot; see the relayer sequence-number note in SECURITY.md for
  // the same shape of caveat on the write side.
  await migrateDb(db);

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

  const hasher = new Hasher(env.HASH_PEPPER);
  const menu = new UssdMenuHandler(db, contract, hasher, logger);
  const app = createApp({
    db,
    menu,
    contract,
    hasher,
    logger,
    // Spread rather than passed directly: with exactOptionalPropertyTypes,
    // an explicitly-undefined optional property is not the same as an absent
    // one, and "absent" is what means "use the default".
    ...(env.TRUST_PROXY_HOPS !== undefined ? { trustProxyHops: env.TRUST_PROXY_HOPS } : {}),
    ...(env.RATE_LIMIT_MAX !== undefined ? { rateLimit: { max: env.RATE_LIMIT_MAX } } : {}),
    africasTalkingUsername: env.AFRICAS_TALKING_USERNAME,
    africasTalkingApiKey: env.AFRICAS_TALKING_API_KEY,
  });

  app.listen(env.PORT, () => {
    logger.info("kobodial-gateway listening", { port: env.PORT });
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
