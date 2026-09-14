import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { UssdSessionStore } from "../src/ussd/sessionStore.js";
import { UssdMenuHandler } from "../src/ussd/menu.js";
import { UssdStep } from "../src/ussd/types.js";
import { hashPhoneNumber, hashPin, toHex } from "../src/crypto/hash.js";
import { ussdSessions } from "../src/db/schema.js";
import { MockKoboDialClient } from "./mockContract.js";

/**
 * The USSD callback is unauthenticated: anyone who can reach it can
 * post any sessionId alongside their own phone number. A sessionId is
 * therefore a claim, not proof of ownership, and every session
 * operation has to be scoped to the caller who owns the row.
 */
describe("session ownership", () => {
  const victim = "+2348012345678";
  const attacker = "+2348099999999";
  const victimHash = toHex(hashPhoneNumber(victim));
  const attackerHash = toHex(hashPhoneNumber(attacker));

  let db: Db;
  let store: UssdSessionStore;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    store = new UssdSessionStore(db);
  });

  it("does not hand one caller's session state to a different caller", async () => {
    await store.save("shared-id", victimHash, {
      step: UssdStep.SendEnterPin,
      data: { recipientPhoneNumber: "+2348055555555", amount: "5000" },
    });

    // Same sessionId, different caller: must look like a fresh session.
    const seenByAttacker = await store.load("shared-id", attackerHash);
    expect(seenByAttacker).toEqual({ step: UssdStep.Welcome, data: {} });
    expect(seenByAttacker.data.amount).toBeUndefined();
    expect(seenByAttacker.data.recipientPhoneNumber).toBeUndefined();

    // The owner still sees their own session, untouched.
    const seenByVictim = await store.load("shared-id", victimHash);
    expect(seenByVictim.step).toBe(UssdStep.SendEnterPin);
    expect(seenByVictim.data.amount).toBe("5000");
  });

  it("does not let one caller overwrite another's in-flight session", async () => {
    await store.save("shared-id", victimHash, {
      step: UssdStep.SendEnterPin,
      data: { recipientPhoneNumber: "+2348055555555", amount: "5000" },
    });

    await store.save("shared-id", attackerHash, { step: UssdStep.RegisterEnterPin, data: {} });

    // The victim's row is intact.
    const seenByVictim = await store.load("shared-id", victimHash);
    expect(seenByVictim.step).toBe(UssdStep.SendEnterPin);
    expect(seenByVictim.data.amount).toBe("5000");

    // And exactly one row exists — the attacker's write created nothing.
    const rows = await db.select().from(ussdSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phoneHash).toBe(victimHash);
  });

  it("does not let one caller end another's session", async () => {
    await store.save("shared-id", victimHash, { step: UssdStep.SendEnterAmount, data: {} });
    await store.clear("shared-id", attackerHash);

    const stillThere = await store.load("shared-id", victimHash);
    expect(stillThere.step).toBe(UssdStep.SendEnterAmount);
  });

  it("end to end: a hijacked sessionId gets the welcome menu, not the victim's send flow", async () => {
    const contract = new MockKoboDialClient();
    contract.seedWallet(hashPhoneNumber(victim), hashPin("1234"), 10_000n, 0);
    contract.seedWallet(hashPhoneNumber(attacker), hashPin("4321"), 0n, 0);
    contract.seedWallet(hashPhoneNumber("+2348055555555"), hashPin("1111"), 0n, 0);
    const menu = new UssdMenuHandler(db, contract);

    // Victim walks to the point of entering their PIN for a 5000 send.
    await menu.handle({ sessionId: "sid", phoneNumber: victim, text: "1" });
    await menu.handle({ sessionId: "sid", phoneNumber: victim, text: "1*+2348055555555" });
    const atPin = await menu.handle({ sessionId: "sid", phoneNumber: victim, text: "1*+2348055555555*5000" });
    expect(atPin.text).toContain("PIN");

    // Attacker reuses the sessionId. They must not inherit the step —
    // their input is read as a fresh menu choice, not as a PIN
    // completing the victim's transfer.
    const hijack = await menu.handle({
      sessionId: "sid",
      phoneNumber: attacker,
      text: "1*+2348055555555*5000*4321",
    });
    expect(hijack.text).not.toContain("Sent");

    // No money moved anywhere.
    expect(await contract.getBalance(hashPhoneNumber(victim))).toBe(10_000n);
    expect(await contract.getBalance(hashPhoneNumber("+2348055555555"))).toBe(0n);

    // And the victim can still complete their own flow.
    const done = await menu.handle({
      sessionId: "sid",
      phoneNumber: victim,
      text: "1*+2348055555555*5000*1234",
    });
    expect(done.endSession).toBe(true);
    expect(done.text).toContain("Sent 5000");
    expect(await contract.getBalance(hashPhoneNumber(victim))).toBe(5_000n);
  });
});
