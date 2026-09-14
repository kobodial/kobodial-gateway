import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { UssdMenuHandler } from "../src/ussd/menu.js";
import { hashPhoneNumber, hashPin, toHex } from "../src/crypto/hash.js";
import { transactions, wallets } from "../src/db/schema.js";
import { MockKoboDialClient } from "./mockContract.js";

describe("USSD: Register", () => {
  const phone = "+2348012345678";
  let db: Db;
  let contract: MockKoboDialClient;
  let menu: UssdMenuHandler;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    menu = new UssdMenuHandler(db, contract);
  });

  async function drive(sessionId: string, inputs: string[]) {
    let text = "";
    let last!: { text: string; endSession: boolean };
    for (const input of inputs) {
      text = text === "" ? input : `${text}*${input}`;
      last = await menu.handle({ sessionId, phoneNumber: phone, text });
    }
    return last;
  }

  it("registers on matching PIN confirmation, and records the wallet locally", async () => {
    const final = await drive("r1", ["4", "1234", "1234"]);
    expect(final.endSession).toBe(true);
    expect(final.text).toContain("successful");

    expect(await contract.getBalance(hashPhoneNumber(phone))).toBe(0n);

    const rows = await db.select().from(wallets);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phoneHash).toBe(toHex(hashPhoneNumber(phone)));

    const txRows = await db.select().from(transactions);
    expect(txRows).toHaveLength(1);
    expect(txRows[0]!.kind).toBe("register");
    expect(txRows[0]!.status).toBe("success");
  });

  it("rejects a PIN confirmation that doesn't match the first entry", async () => {
    const final = await drive("r2", ["4", "1234", "5678"]);
    expect(final.endSession).toBe(true);
    expect(final.text).toContain("did not match");

    // Nothing was ever submitted to the contract.
    expect(await db.select().from(wallets)).toHaveLength(0);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it("rejects registering a number that's already registered", async () => {
    contract.seedWallet(hashPhoneNumber(phone), hashPin("1111"), 0n, 0);
    const final = await drive("r3", ["4", "1234", "1234"]);
    expect(final.endSession).toBe(true);
    expect(final.text).toContain("already registered");
  });

  it("rejects a PIN that isn't exactly 4 digits before ever contacting the contract", async () => {
    const final = await drive("r4", ["4", "12345"]);
    expect(final.endSession).toBe(true);
    expect(final.text).toContain("4 digits");
  });
});

describe("USSD: Check Balance", () => {
  const phone = "+2348012345678";
  let db: Db;
  let contract: MockKoboDialClient;
  let menu: UssdMenuHandler;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    contract.seedWallet(hashPhoneNumber(phone), hashPin("1234"), 4000n, 1);
    menu = new UssdMenuHandler(db, contract);
  });

  async function drive(sessionId: string, inputs: string[]) {
    let text = "";
    let last!: { text: string; endSession: boolean };
    for (const input of inputs) {
      text = text === "" ? input : `${text}*${input}`;
      last = await menu.handle({ sessionId, phoneNumber: phone, text });
    }
    return last;
  }

  it("reveals the balance only after the correct PIN", async () => {
    const final = await drive("b1", ["2", "1234"]);
    expect(final.endSession).toBe(true);
    expect(final.text).toContain("4000");
  });

  it("never reveals the balance on a wrong PIN", async () => {
    const final = await drive("b2", ["2", "9999"]);
    expect(final.endSession).toBe(true);
    expect(final.text).not.toContain("4000");
    expect(final.text).toContain("Incorrect PIN");
  });

  it("does not touch the wallet's nonce as a side effect of checking a balance", async () => {
    await drive("b3", ["2", "1234"]);
    expect(await contract.getNonce(hashPhoneNumber(phone))).toBe(1); // unchanged from setup
  });

  it("does not log a balance check to the transaction table", async () => {
    await drive("b4", ["2", "1234"]);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });
});

describe("USSD: Change PIN", () => {
  const phone = "+2348012345678";
  let db: Db;
  let contract: MockKoboDialClient;
  let menu: UssdMenuHandler;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    contract.seedWallet(hashPhoneNumber(phone), hashPin("1234"), 500n, 0);
    menu = new UssdMenuHandler(db, contract);
  });

  async function drive(sessionId: string, inputs: string[]) {
    let text = "";
    let last!: { text: string; endSession: boolean };
    for (const input of inputs) {
      text = text === "" ? input : `${text}*${input}`;
      last = await menu.handle({ sessionId, phoneNumber: phone, text });
    }
    return last;
  }

  it("changes the PIN when the old PIN is correct and the new PIN is confirmed", async () => {
    const final = await drive("c1", ["3", "1234", "5678", "5678"]);
    expect(final.endSession).toBe(true);
    expect(final.text).toContain("changed successfully");

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("change_pin");
    expect(rows[0]!.status).toBe("success");
  });

  it("the new PIN actually authorizes afterward, and the old one no longer does", async () => {
    await drive("c2", ["3", "1234", "5678", "5678"]);

    // Old PIN, now stale, should fail.
    await expect(
      contract.send(hashPhoneNumber(phone), hashPhoneNumber("+2348099999999"), 10n, hashPin("1234"), 0),
    ).rejects.toThrow();

    // New PIN works.
    contract.seedWallet(hashPhoneNumber("+2348099999999"), hashPin("0000"), 0n, 0);
    await expect(
      contract.send(hashPhoneNumber(phone), hashPhoneNumber("+2348099999999"), 10n, hashPin("5678"), 0),
    ).resolves.toBeTruthy();
  });

  it("rejects the wrong old PIN without ever asking for a new one taking effect", async () => {
    const final = await drive("c3", ["3", "0000", "5678", "5678"]);
    expect(final.endSession).toBe(true);
    expect(final.text).toContain("Incorrect current PIN");

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.errorCode).toBe("InvalidPin");
  });

  it("rejects mismatched new-PIN confirmation before ever contacting the contract", async () => {
    const final = await drive("c4", ["3", "1234", "5678", "0000"]);
    expect(final.endSession).toBe(true);
    expect(final.text).toContain("did not match");
    expect(await db.select().from(transactions)).toHaveLength(0);
  });
});

describe("USSD: welcome menu and unknown steps", () => {
  it("shows the welcome menu on empty text", async () => {
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    const menu = new UssdMenuHandler(db, new MockKoboDialClient());
    const result = await menu.handle({ sessionId: "w1", phoneNumber: "+2348012345678", text: "" });
    expect(result.endSession).toBe(false);
    expect(result.text).toContain("1. Send Money");
    expect(result.text).toContain("2. Check Balance");
    expect(result.text).toContain("3. Change PIN");
    expect(result.text).toContain("4. Register");
  });

  it("rejects an unrecognised menu choice", async () => {
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    const menu = new UssdMenuHandler(db, new MockKoboDialClient());
    const result = await menu.handle({ sessionId: "w2", phoneNumber: "+2348012345678", text: "9" });
    expect(result.endSession).toBe(true);
    expect(result.text).toContain("Invalid choice");
  });
});
