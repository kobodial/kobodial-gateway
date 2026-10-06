import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb } from "./testDb.js";
import { PinLockout, MAX_FAILED_ATTEMPTS, LOCKOUT_MS, attemptsRemaining } from "../src/ussd/pinLockout.js";

const PHONE = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("PinLockout", () => {
  let db: Db;
  let clock: Date;
  let lockout: PinLockout;

  beforeEach(async () => {
    db = await freshDb();
    clock = new Date("2026-01-01T12:00:00Z");
    lockout = new PinLockout(db, () => clock);
  });

  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  it("starts unlocked, with no row required", async () => {
    expect(await lockout.state(PHONE)).toEqual({
      locked: false,
      minutesRemaining: 0,
      failedCount: 0,
    });
  });

  it("counts failures without locking below the threshold", async () => {
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      const state = await lockout.recordFailure(PHONE);
      expect(state.locked).toBe(false);
      expect(state.failedCount).toBe(i);
    }
  });

  it("locks on the threshold failure", async () => {
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      await lockout.recordFailure(PHONE);
    }
    const state = await lockout.recordFailure(PHONE);
    expect(state.locked).toBe(true);
    expect(state.failedCount).toBe(MAX_FAILED_ATTEMPTS);
    expect(await lockout.state(PHONE)).toMatchObject({ locked: true });
  });

  it("lifts the lock once it expires, without anything having to run", async () => {
    // Expiry is evaluated on read. There is no scheduler in this service, so
    // a lock that needed a sweep to lift would never lift.
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await lockout.recordFailure(PHONE);
    }
    expect((await lockout.state(PHONE)).locked).toBe(true);

    advance(LOCKOUT_MS - 1000);
    expect((await lockout.state(PHONE)).locked).toBe(true);

    advance(2000);
    expect((await lockout.state(PHONE)).locked).toBe(false);
  });

  it("cannot be held locked indefinitely by guessing during a lock", async () => {
    // The denial-of-service this guards against: if each failure extended the
    // lock, an attacker guessing once every few minutes could keep the real
    // owner out of their wallet forever, turning a protection into a weapon.
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await lockout.recordFailure(PHONE);
    }

    advance(LOCKOUT_MS / 2);
    const during = await lockout.recordFailure(PHONE);
    expect(during.failedCount).toBe(MAX_FAILED_ATTEMPTS);

    // The original expiry still stands, so the wallet unlocks on schedule.
    advance(LOCKOUT_MS / 2 + 1000);
    expect((await lockout.state(PHONE)).locked).toBe(false);
  });

  it("clears the count after a correct PIN", async () => {
    await lockout.recordFailure(PHONE);
    await lockout.recordFailure(PHONE);
    await lockout.recordSuccess(PHONE);

    const state = await lockout.state(PHONE);
    expect(state.failedCount).toBe(0);
    expect(state.locked).toBe(false);
  });

  it("does not let a near-miss carry over into a later lock", async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      await lockout.recordFailure(PHONE);
    }
    await lockout.recordSuccess(PHONE);

    // Without the reset, this single failure would lock the wallet.
    const state = await lockout.recordFailure(PHONE);
    expect(state.locked).toBe(false);
    expect(state.failedCount).toBe(1);
  });

  it("counts each wallet separately", async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await lockout.recordFailure(PHONE);
    }
    expect((await lockout.state(PHONE)).locked).toBe(true);
    expect((await lockout.state(OTHER)).locked).toBe(false);
  });

  it("survives a restart, because the count is in the database", async () => {
    // The reason this is a table and not a Map: consecutive USSD requests are
    // not guaranteed to reach the same instance, and an in-process counter
    // would reset on every deploy.
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await lockout.recordFailure(PHONE);
    }
    const reopened = new PinLockout(db, () => clock);
    expect((await reopened.state(PHONE)).locked).toBe(true);
  });

  it("reports a whole number of minutes remaining, rounded up", async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await lockout.recordFailure(PHONE);
    }
    advance(LOCKOUT_MS - 90_000);
    expect((await lockout.state(PHONE)).minutesRemaining).toBe(2);

    advance(60_000);
    expect((await lockout.state(PHONE)).minutesRemaining).toBe(1);
  });
});

describe("attemptsRemaining", () => {
  it("counts down to zero and never below", () => {
    expect(attemptsRemaining(0)).toBe(MAX_FAILED_ATTEMPTS);
    expect(attemptsRemaining(MAX_FAILED_ATTEMPTS - 1)).toBe(1);
    expect(attemptsRemaining(MAX_FAILED_ATTEMPTS)).toBe(0);
    expect(attemptsRemaining(MAX_FAILED_ATTEMPTS + 3)).toBe(0);
  });
});
