import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ussdSessions } from "../db/schema.js";
import type { UssdSessionState } from "./types.js";
import { UssdStep } from "./types.js";

/**
 * Persists in-progress USSD flow state, keyed by Africa's Talking's
 * sessionId. A DB table rather than an in-process Map: USSD is a
 * sequence of stateless HTTP requests, and nothing guarantees two
 * requests in the same session hit the same server instance — an
 * in-memory Map would silently lose the flow the moment a load balancer
 * routed the next request elsewhere.
 */
export class UssdSessionStore {
  constructor(private readonly db: Db) {}

  /**
   * Loads a session's state, or the welcome step if this sessionId has
   * no row yet — which is exactly what "the caller just dialled in"
   * looks like, so a missing row is not an error case here.
   */
  async load(sessionId: string): Promise<UssdSessionState> {
    const rows = await this.db
      .select()
      .from(ussdSessions)
      .where(eq(ussdSessions.sessionId, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return { step: UssdStep.Welcome, data: {} };
    }
    return { step: row.step as UssdStep, data: JSON.parse(row.data) };
  }

  /** Persists a session's next state, keyed by phoneHash (hex) for the caller who owns it. */
  async save(sessionId: string, phoneHash: string, state: UssdSessionState): Promise<void> {
    const serialized = JSON.stringify(state.data);
    await this.db
      .insert(ussdSessions)
      .values({ sessionId, phoneHash, step: state.step, data: serialized })
      .onConflictDoUpdate({
        target: ussdSessions.sessionId,
        set: { step: state.step, data: serialized, updatedAt: new Date() },
      });
  }

  /**
   * Deletes a session's row. Called whenever a flow ends — success,
   * failure, or a menu choice that terminates immediately — so a
   * finished session leaves no state behind for a reused sessionId to
   * accidentally resume.
   */
  async clear(sessionId: string): Promise<void> {
    await this.db.delete(ussdSessions).where(eq(ussdSessions.sessionId, sessionId));
  }
}
