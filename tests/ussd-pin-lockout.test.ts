import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { UssdMenuHandler } from "../src/ussd/menu.js";
import { Hasher } from "../src/crypto/hash.js";
import { MockKoboDialClient } from "./mockContract.js";
import { MAX_FAILED_ATTEMPTS } from "../src/ussd/pinLockout.js";

const TEST_PEPPER = "k".repeat(64);
const hasher = new Hasher(TEST_PEPPER);

/**
 * The lockout as a caller actually meets it, driven through the USSD menu
 * rather than against PinLockout directly.
 *
 * A PIN is four digits. Peppering the stored digest stops an attacker who has
 * read the ledger from testing candidates offline; nothing there stops them
 * testing candidates online, one session at a time. These tests are the
 * evidence that the online path is closed.
 */
describe("USSD: wrong-PIN lockout", () => {
  const phone = "+2348012345678";
  const CORRECT_PIN = "1234";
  const WRONG_PIN = "9999";

  let db: Db;
  let contract: MockKoboDialClient;
  let menu: UssdMenuHandler;

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    menu = new UssdMenuHandler(db, contract, hasher);

    // Register the wallet through the menu, so the fixture is the real flow.
    await drive("setup", ["4", CORRECT_PIN, CORRECT_PIN]);
  });

  /** Drive one USSD session to completion and return the final response. */
  async function drive(sessionId: string, inputs: string[]) {
    let text = "";
    let last!: { text: string; endSession: boolean };
    for (const input of inputs) {
      text = text === "" ? input : `${text}*${input}`;
      last = await menu.handle({ sessionId, phoneNumber: phone, text });
    }
    return last;
  }

  /** One balance check with the given PIN — the shortest PIN-verified flow. */
  const checkBalance = (session: string, pin: string) => drive(session, ["2", pin]);

  it("warns how many attempts remain before locking", async () => {
    const first = await checkBalance("s1", WRONG_PIN);
    expect(first.text).toContain("Incorrect PIN");
    expect(first.text).toContain(`${MAX_FAILED_ATTEMPTS - 1} attempts left`);

    const second = await checkBalance("s2", WRONG_PIN);
    expect(second.text).toContain(`${MAX_FAILED_ATTEMPTS - 2} attempts left`);
  });

  it("locks the wallet on the threshold attempt", async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      await checkBalance(`s${i}`, WRONG_PIN);
    }
    const final = await checkBalance("final", WRONG_PIN);
    expect(final.text).toContain("locked");
  });

  it("counts across sessions, so a fresh sessionId does not reset it", async () => {
    // The attack this closes. A sessionId is chosen by whoever is dialling,
    // so per-session counting would let an attacker start a new session per
    // guess and walk the whole 10,000-PIN space unimpeded.
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await checkBalance(`attacker-session-${i}`, WRONG_PIN);
    }
    const next = await checkBalance("another-brand-new-session", WRONG_PIN);
    expect(next.text).toContain("locked");
  });

  it("refuses the correct PIN too, once locked", async () => {
    // Otherwise the lock would be trivially bypassed by the guess that
    // happens to be right, which is the one guess that matters.
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await checkBalance(`s${i}`, WRONG_PIN);
    }
    const locked = await checkBalance("with-correct-pin", CORRECT_PIN);
    expect(locked.text).toContain("locked");
    expect(locked.text).not.toContain("Balance");
  });

  it("does not reach the contract while locked", async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await checkBalance(`s${i}`, WRONG_PIN);
    }
    const before = contract.changePinCalls;
    await checkBalance("while-locked", WRONG_PIN);
    expect(contract.changePinCalls).toBe(before);
  });

  it("clears the count after a correct PIN", async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      await checkBalance(`s${i}`, WRONG_PIN);
    }
    const ok = await checkBalance("correct", CORRECT_PIN);
    expect(ok.text).not.toContain("locked");

    // Without the reset this next failure would be the threshold one.
    const after = await checkBalance("after", WRONG_PIN);
    expect(after.text).not.toContain("locked");
    expect(after.text).toContain(`${MAX_FAILED_ATTEMPTS - 1} attempts left`);
  });

  it("locks the send flow as well, not just balance", async () => {
    // The lock is per wallet, not per menu option; money movement is the
    // flow it most needs to cover.
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await checkBalance(`s${i}`, WRONG_PIN);
    }
    const send = await drive("send-while-locked", ["1", "+2348011111111", "10", CORRECT_PIN]);
    expect(send.text).toContain("locked");
  });
});
