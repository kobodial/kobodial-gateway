import { Router } from "express";
import AfricasTalking from "africastalking";
import type { UssdMenuHandler } from "../ussd/menu.js";
import type { Logger } from "../logger.js";

export interface UssdRouteOptions {
  africasTalkingUsername: string;
  africasTalkingApiKey: string;
  menu: UssdMenuHandler;
  logger: Logger;
}

/**
 * Mounts the USSD callback Africa's Talking's sandbox (and, later, a
 * real short code) hits on every keystroke of every session.
 *
 * Uses the africastalking package's own USSD() Express middleware
 * factory rather than hand-rolling the "CON "/"END " response format:
 * it parses the callback's application/x-www-form-urlencoded body,
 * hands the parsed payload to the callback below, and turns
 * {response, endSession} into the exact plain-text response shape
 * Africa's Talking's protocol expects — see node_modules/africastalking
 * /lib/ussd.js for the (short) implementation this depends on.
 */
export function createUssdRouter(opts: UssdRouteOptions): Router {
  const router = Router();
  const atClient = AfricasTalking({
    apiKey: opts.africasTalkingApiKey,
    username: opts.africasTalkingUsername,
  });

  router.post(
    "/",
    ...atClient.USSD(async (payload, respond) => {
      const start = Date.now();
      try {
        const result = await opts.menu.handle({
          sessionId: payload.sessionId,
          phoneNumber: payload.phoneNumber,
          text: payload.text,
        });
        // Deliberately no `text` or `body` field here — see src/logger.ts.
        opts.logger.info("ussd request handled", {
          sessionId: payload.sessionId,
          endSession: result.endSession,
          durationMs: Date.now() - start,
        });
        respond({ response: result.text, endSession: result.endSession });
      } catch (err) {
        opts.logger.error("ussd request crashed before menu.handle could catch it", {
          sessionId: payload.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        respond({ response: "Something went wrong. Please try again later.", endSession: true });
      }
    }),
  );

  return router;
}
