import { and, eq } from "drizzle-orm";
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
 *
 * Every operation is scoped to the caller's phone hash as well as the
 * sessionId. The USSD callback is unauthenticated — anyone who can
 * reach it can post any sessionId they like alongside their own number
 * (see SECURITY.md) — so a sessionId alone is a claim, not proof of
 * ownership. Without the phone-hash check, a caller who supplied
 * someone else's in-flight sessionId would inherit that session's step
 * and collected data (a chosen recipient and amount, mid-send) and
 * would clobber the real caller's row on the way past. Scoping every
 * read, write and delete to the owner makes both halves of that
 * impossible.
 */
export class UssdSessionStore {
  constructor(private readonly db: Db) {}

  /**
   * Loads the state of a session that belongs to this caller, or the
   * welcome step when there is no such row — which covers both "the
   * caller just dialled in" and "this sessionId belongs to someone
   * else." The two are deliberately indistinguishable to the caller:
   * a mismatch reveals nothing about whether that session exists.
   */
  async load(sessionId: string, phoneHash: string): Promise<UssdSessionState> {
    const rows = await this.db
      .select()
      .from(ussdSessions)
      .where(and(eq(ussdSessions.sessionId, sessionId), eq(ussdSessions.phoneHash, phoneHash)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return { step: UssdStep.Welcome, data: {} };
    }
    return { step: row.step as UssdStep, data: JSON.parse(row.data) };
  }

  /**
   * Persists a session's next state for the caller who owns it. The
   * conflict update is guarded by phoneHash, so a request carrying
   * someone else's sessionId cannot overwrite their in-flight session:
   * the insert conflicts, the update matches no row, and nothing
   * changes.
   */
  async save(sessionId: string, phoneHash: string, state: UssdSessionState): Promise<void> {
    const serialized = JSON.stringify(state.data);
    await this.db
      .insert(ussdSessions)
      .values({ sessionId, phoneHash, step: state.step, data: serialized })
      .onConflictDoUpdate({
        target: ussdSessions.sessionId,
        set: { step: state.step, data: serialized, updatedAt: new Date() },
        setWhere: eq(ussdSessions.phoneHash, phoneHash),
      });
  }

  /**
   * Deletes this caller's session row. Called whenever a flow ends —
   * success, failure, or a menu choice that terminates immediately — so
   * a finished session leaves no state behind for a reused sessionId to
   * accidentally resume. Scoped by phoneHash so one caller can't end
   * another's session.
   */
  async clear(sessionId: string, phoneHash: string): Promise<void> {
    await this.db
      .delete(ussdSessions)
      .where(and(eq(ussdSessions.sessionId, sessionId), eq(ussdSessions.phoneHash, phoneHash)));
  }
}
