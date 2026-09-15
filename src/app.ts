import express, { type Express } from "express";
import type { Db } from "./db/client.js";
import type { UssdMenuHandler } from "./ussd/menu.js";
import type { KoboDialClient } from "./contract/client.js";
import type { Logger } from "./logger.js";
import { createUssdRouter } from "./routes/ussd.js";
import { createDashboardRouter } from "./routes/dashboard.js";

export interface CreateAppOptions {
  db: Db;
  menu: UssdMenuHandler;
  /** Also used directly by the dashboard's balance route, which reads through to the chain. */
  contract: KoboDialClient;
  logger: Logger;
  africasTalkingUsername: string;
  africasTalkingApiKey: string;
}

/**
 * Builds the whole Express app from already-constructed dependencies,
 * rather than reading the environment or constructing a database
 * connection itself — every dependency is a parameter, so a test can
 * hand this a real in-memory database and a mocked contract client
 * (via a menu built on top of one) with nothing here to stub out at
 * the module level.
 *
 * /ussd is Africa's Talking's callback; everything else is the
 * unauthenticated internal dashboard API — see SECURITY.md for why
 * that's an accepted MVP posture, not an oversight.
 */
export function createApp(opts: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(
    "/ussd",
    createUssdRouter({
      africasTalkingUsername: opts.africasTalkingUsername,
      africasTalkingApiKey: opts.africasTalkingApiKey,
      menu: opts.menu,
      logger: opts.logger,
    }),
  );
  app.use(createDashboardRouter(opts.db, opts.contract));

  return app;
}
