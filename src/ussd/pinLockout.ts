import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pinAttempts } from "../db/schema.js";

/**
 * Rate limit on wrong PINs.
 *
 * A PIN is four digits — 10,000 possibilities. Peppering the stored digest
 * stops an attacker who has read the ledger from testing candidates offline
 * (see src/crypto/hash.ts), but nothing there prevents testing them *online*,
 * one USSD session at a time. At a few guesses a second the whole space falls
 * in under an hour. This is what makes that not work.
 *
 * Counting is keyed by **phone hash, not session**. A sessionId is chosen by
 * whoever is dialling, so a per-session counter resets on every guess and
 * limits nothing.
 */

/** Wrong PINs tolerated before the wallet locks. */
export const MAX_FAILED_ATTEMPTS = 5;

/** How long a lock lasts. */
export const LOCKOUT_MS = 15 * 60 * 1000;

export interface LockState {
  locked: boolean;
  /** Whole minutes remaining, rounded up; 0 when not locked. */
  minutesRemaining: number;
  /** Wrong PINs recorded since the last success. */
  failedCount: number;
}

const UNLOCKED: LockState = { locked: false, minutesRemaining: 0, failedCount: 0 };

export class PinLockout {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * The current state for a wallet, expiring a lock that has run its course.
   *
   * Expiry is evaluated on read rather than by a sweep: there is no scheduler
   * in this service, and a lock that only lifts when something happens to run
   * is a lock that never lifts.
   */
  async state(phoneHash: string): Promise<LockState> {
    const row = await this.row(phoneHash);
    if (!row) {
      return UNLOCKED;
    }
    const now = this.now().getTime();
    const until = row.lockedUntil?.getTime() ?? 0;
    if (until > now) {
      return {
        locked: true,
        minutesRemaining: Math.ceil((until - now) / 60_000),
        failedCount: row.failedCount,
      };
    }
    return { locked: false, minutesRemaining: 0, failedCount: row.failedCount };
  }

  /**
   * Record a wrong PIN, returning the resulting state.
   *
   * A failure while already locked extends nothing: the count stops at the
   * threshold and the existing expiry stands. Otherwise an attacker could
   * hold a wallet locked indefinitely by guessing once every few minutes,
   * turning a protection for the owner into a denial of service against them.
   */
  async recordFailure(phoneHash: string): Promise<LockState> {
    const current = await this.state(phoneHash);
    if (current.locked) {
      return current;
    }

    const failedCount = current.failedCount + 1;
    const lockedUntil =
      failedCount >= MAX_FAILED_ATTEMPTS ? new Date(this.now().getTime() + LOCKOUT_MS) : null;
    const updatedAt = this.now();

    await this.db
      .insert(pinAttempts)
      .values({ phoneHash, failedCount, lockedUntil, updatedAt })
      .onConflictDoUpdate({
        target: pinAttempts.phoneHash,
        set: { failedCount, lockedUntil, updatedAt },
      });

    return lockedUntil
      ? { locked: true, minutesRemaining: Math.ceil(LOCKOUT_MS / 60_000), failedCount }
      : { locked: false, minutesRemaining: 0, failedCount };
  }

  /**
   * Clear the count after a correct PIN.
   *
   * The row is updated rather than deleted so that an operator can still see
   * that failures occurred — a wallet that was nearly brute-forced and then
   * entered correctly is worth being able to notice.
   */
  async recordSuccess(phoneHash: string): Promise<void> {
    const updatedAt = this.now();
    await this.db
      .insert(pinAttempts)
      .values({ phoneHash, failedCount: 0, lockedUntil: null, updatedAt })
      .onConflictDoUpdate({
        target: pinAttempts.phoneHash,
        set: { failedCount: 0, lockedUntil: null, updatedAt },
      });
  }

  private async row(phoneHash: string) {
    const rows = await this.db
      .select()
      .from(pinAttempts)
      .where(eq(pinAttempts.phoneHash, phoneHash))
      .limit(1);
    return rows[0];
  }
}

/** Attempts left before locking, for the "wrong PIN" message. */
export function attemptsRemaining(failedCount: number): number {
  return Math.max(0, MAX_FAILED_ATTEMPTS - failedCount);
}
