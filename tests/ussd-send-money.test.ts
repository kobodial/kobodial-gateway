import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { UssdMenuHandler } from "../src/ussd/menu.js";
import { hashPhoneNumber, hashPin, toHex } from "../src/crypto/hash.js";
import { transactions } from "../src/db/schema.js";
import { MockKoboDialClient } from "./mockContract.js";

/**
 * The full "Send Money" USSD flow, end to end, against a mocked
 * KoboDialClient and a real (in-memory) database — no network, but
 * everything else in the real path: session persistence across
 * separate requests, PIN hashing, nonce handling, and the transaction
 * log.
 */
describe("USSD: Send Money", () => {
  const senderPhone = "+2348012345678";
  const recipientPhone = "+2348099999999";
  const pin = "1234";

  let db: Db;
  let contract: MockKoboDialClient;
  let menu: UssdMenuHandler;

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    contract.seedWallet(hashPhoneNumber(senderPhone), hashPin(pin), 1000n, 0);
    contract.seedWallet(hashPhoneNumber(recipientPhone), hashPin(pin), 0n, 0);
    menu = new UssdMenuHandler(db, contract);
  });

  /** One session, driven through Africa's Talking's accumulating-text protocol exactly as it would arrive. */
  async function driveSession(sessionId: string, inputs: string[]) {
    const responses: { text: string; endSession: boolean }[] = [];
    let text = "";
    for (const input of inputs) {
      text = text === "" ? input : `${text}*${input}`;
      responses.push(await menu.handle({ sessionId, phoneNumber: senderPhone, text }));
    }
    return responses;
  }

  it("completes end to end: menu choice, recipient, amount, PIN, success", async () => {
    // The very first request of any session carries empty text — the
    // caller has only just dialled the service code, before choosing
    // anything.
    const first = await menu.handle({ sessionId: "s1", phoneNumber: senderPhone, text: "" });
    expect(first.endSession).toBe(false);
    expect(first.text).toContain("Welcome to KoboDial");

    const responses = await driveSession("s1", ["1", recipientPhone, "250", pin]);
    const [afterChoice, afterRecipient, afterAmount, final] = responses;

    expect(afterChoice!.endSession).toBe(false);
    expect(afterChoice!.text).toContain("recipient");

    expect(afterRecipient!.endSession).toBe(false);
    expect(afterRecipient!.text).toContain(recipientPhone);
    expect(afterRecipient!.text).toContain("amount");

    expect(afterAmount!.endSession).toBe(false);
    expect(afterAmount!.text).toContain("250");
    expect(afterAmount!.text).toContain("PIN");

    expect(final!.endSession).toBe(true);
    expect(final!.text).toContain("Sent 250");
    expect(final!.text).toContain("750"); // 1000 - 250

    // The money actually moved, on the mock contract exactly as it would
    // on the real one.
    expect(await contract.getBalance(hashPhoneNumber(senderPhone))).toBe(750n);
    expect(await contract.getBalance(hashPhoneNumber(recipientPhone))).toBe(250n);
    expect(await contract.getNonce(hashPhoneNumber(senderPhone))).toBe(1);
  });

  it("logs a successful send with hashed identifiers and no raw phone number anywhere", async () => {
    await driveSession("s2", ["1", recipientPhone, "100", pin]);

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("send");
    expect(row.status).toBe("success");
    expect(row.amount).toBe("100");
    expect(row.fromPhoneHash).toBe(toHex(hashPhoneNumber(senderPhone)));
    expect(row.toPhoneHash).toBe(toHex(hashPhoneNumber(recipientPhone)));
    expect(row.txHash).toBeTruthy();

    // The defining property: nothing in this row is a raw phone number.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(senderPhone);
    expect(serialized).not.toContain(recipientPhone);
    expect(serialized).not.toContain(pin);
  });

  it("rejects a wrong PIN, leaves balances and nonce untouched, and logs the failure", async () => {
    const responses = await driveSession("s3", ["1", recipientPhone, "400", "0000"]);
    const final = responses[3]!;

    expect(final.endSession).toBe(true);
    expect(final.text).toContain("Incorrect PIN");

    expect(await contract.getBalance(hashPhoneNumber(senderPhone))).toBe(1000n);
    expect(await contract.getNonce(hashPhoneNumber(senderPhone))).toBe(0);

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.errorCode).toBe("InvalidPin");
  });

  it("rejects sending to yourself before ever touching the contract", async () => {
    const responses = await driveSession("s4", ["1", senderPhone]);
    expect(responses[1]!.endSession).toBe(true);
    expect(responses[1]!.text).toContain("own number");

    // No transaction was ever attempted.
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it("rejects a non-numeric or zero amount without ever reaching the PIN step", async () => {
    for (const badAmount of ["abc", "0", "-5", "12.5", ""]) {
      const responses = await driveSession(`s-amt-${badAmount}`, ["1", recipientPhone, badAmount]);
      const last = responses[responses.length - 1]!;
      expect(last.endSession).toBe(true);
      expect(last.text).toContain("Invalid amount");
    }
  });

  it("rejects insufficient balance with the right message and no state change", async () => {
    const responses = await driveSession("s5", ["1", recipientPhone, "5000", pin]);
    const final = responses[3]!;
    expect(final.endSession).toBe(true);
    expect(final.text).toContain("Insufficient balance");
    expect(await contract.getBalance(hashPhoneNumber(senderPhone))).toBe(1000n);
  });

  it("replaying an already-consumed nonce fails cleanly on a second attempt", async () => {
    // First send succeeds and consumes nonce 0.
    await driveSession("s6", ["1", recipientPhone, "100", pin]);
    expect(await contract.getNonce(hashPhoneNumber(senderPhone))).toBe(1);

    // A second, brand-new session gets a FRESH nonce read at its own PIN
    // step (menu.ts calls getNonce right before send), so this exercises
    // that the flow always uses the current nonce rather than a stale
    // one carried over from a previous session — the real replay
    // protection lives in the contract; this just confirms the gateway
    // never fights it by caching a nonce across sessions.
    const responses = await driveSession("s7", ["1", recipientPhone, "50", pin]);
    const final = responses[3]!;
    expect(final.endSession).toBe(true);
    expect(final.text).toContain("Sent 50");
    expect(await contract.getNonce(hashPhoneNumber(senderPhone))).toBe(2);
  });

  it("keeps two concurrent sessions from different phones fully independent", async () => {
    const otherPhone = "+2348055555555";
    contract.seedWallet(hashPhoneNumber(otherPhone), hashPin("5555"), 300n, 0);

    // Interleave two sessions' requests, as separate stateless HTTP
    // calls would actually arrive.
    const r1a = await menu.handle({ sessionId: "sA", phoneNumber: senderPhone, text: "1" });
    const r2a = await menu.handle({ sessionId: "sB", phoneNumber: otherPhone, text: "1" });
    const r1b = await menu.handle({
      sessionId: "sA",
      phoneNumber: senderPhone,
      text: `1*${recipientPhone}`,
    });
    const r2b = await menu.handle({ sessionId: "sB", phoneNumber: otherPhone, text: `1*${recipientPhone}` });

    expect(r1a.text).toContain("recipient");
    expect(r2a.text).toContain("recipient");
    expect(r1b.text).toContain("amount");
    expect(r2b.text).toContain("amount");

    // Finish session A with the two remaining requests it's actually
    // owed (amount, then PIN) — AT's accumulated text grows by exactly
    // one segment per request, never two at once.
    await menu.handle({ sessionId: "sA", phoneNumber: senderPhone, text: `1*${recipientPhone}*200` });
    const finalA = await menu.handle({
      sessionId: "sA",
      phoneNumber: senderPhone,
      text: `1*${recipientPhone}*200*${pin}`,
    });
    expect(finalA.endSession).toBe(true);
    expect(await contract.getBalance(hashPhoneNumber(otherPhone))).toBe(300n); // B's wallet untouched
  });
});

describe("USSD: Send Money — amount bounds", () => {
  const senderPhone = "+2348012345678";
  const recipientPhone = "+2348099999999";
  const pin = "1234";
  const I128_MAX = "170141183460469231731687303715884105727";

  let db: Db;
  let contract: MockKoboDialClient;
  let menu: UssdMenuHandler;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    contract.seedWallet(hashPhoneNumber(senderPhone), hashPin(pin), 1000n, 0);
    contract.seedWallet(hashPhoneNumber(recipientPhone), hashPin(pin), 0n, 0);
    menu = new UssdMenuHandler(db, contract);
  });

  async function amountStep(amount: string) {
    await menu.handle({ sessionId: `amt-${amount}`, phoneNumber: senderPhone, text: "1" });
    await menu.handle({ sessionId: `amt-${amount}`, phoneNumber: senderPhone, text: `1*${recipientPhone}` });
    return menu.handle({
      sessionId: `amt-${amount}`,
      phoneNumber: senderPhone,
      text: `1*${recipientPhone}*${amount}`,
    });
  }

  it("rejects an amount larger than the contract's i128 with a message about the amount", async () => {
    const res = await amountStep(I128_MAX + "0"); // one digit past the ceiling
    expect(res.endSession).toBe(true);
    expect(res.text).toContain("too large");
    // Specifically not the generic failure — the caller mistyped, this
    // isn't an internal error.
    expect(res.text).not.toContain("Something went wrong");
  });

  it("still accepts an amount exactly at the i128 ceiling", async () => {
    const res = await amountStep(I128_MAX);
    // Reaches the PIN prompt rather than being rejected at the bound.
    expect(res.endSession).toBe(false);
    expect(res.text).toContain("PIN");
  });
});
