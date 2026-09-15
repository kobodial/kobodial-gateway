import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { wallets, transactions } from "../src/db/schema.js";
import { UssdMenuHandler } from "../src/ussd/menu.js";
import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import { MockKoboDialClient } from "./mockContract.js";

describe("dashboard routes", () => {
  let db: Db;
  let app: Express;
  let contract: MockKoboDialClient;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    const menu = new UssdMenuHandler(db, contract);
    app = createApp({
      db,
      menu,
      contract,
      logger: createLogger("error"),
      africasTalkingUsername: "sandbox",
      africasTalkingApiKey: "x",
    });
  });

  it("GET /health reports ok against a working database", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /wallets returns only hashed identifiers, newest first", async () => {
    await db.insert(wallets).values([{ phoneHash: "aaa" }, { phoneHash: "bbb" }]);
    const res = await request(app).get("/wallets");
    expect(res.status).toBe(200);
    expect(res.body.wallets.map((w: { phoneHash: string }) => w.phoneHash)).toEqual(["bbb", "aaa"]);
  });

  it("GET /transactions returns logged rows, newest first, with no raw PII columns", async () => {
    await db.insert(transactions).values([
      { kind: "register", fromPhoneHash: "aaa", status: "success", txHash: "tx1" },
      {
        kind: "send",
        fromPhoneHash: "aaa",
        toPhoneHash: "bbb",
        amount: "100",
        status: "success",
        txHash: "tx2",
      },
    ]);
    const res = await request(app).get("/transactions");
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(2);
    expect(res.body.transactions[0].kind).toBe("send");
    // Structurally: only the columns schema.ts actually defines exist.
    const allowedKeys = new Set([
      "id",
      "kind",
      "fromPhoneHash",
      "toPhoneHash",
      "amount",
      "status",
      "errorCode",
      "txHash",
      "createdAt",
    ]);
    for (const row of res.body.transactions) {
      for (const key of Object.keys(row)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }
  });

  it("rejects an out-of-range limit with 400", async () => {
    const res = await request(app).get("/wallets?limit=9999");
    expect(res.status).toBe(400);
  });

  it("paginates with limit and offset", async () => {
    await db.insert(wallets).values([{ phoneHash: "aaa" }, { phoneHash: "bbb" }, { phoneHash: "ccc" }]);
    const res = await request(app).get("/wallets?limit=1&offset=1");
    expect(res.status).toBe(200);
    expect(res.body.wallets).toHaveLength(1);
    expect(res.body.wallets[0].phoneHash).toBe("bbb");
  });
});

describe("USSD route (HTTP layer)", () => {
  let app: Express;
  let db: Db;
  let contract: MockKoboDialClient;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    const menu = new UssdMenuHandler(db, contract);
    app = createApp({
      db,
      menu,
      contract,
      logger: createLogger("error"),
      africasTalkingUsername: "sandbox",
      africasTalkingApiKey: "x",
    });
  });

  it("responds with the CON prefix, text/plain, and 200 when a flow continues", async () => {
    const res = await request(app)
      .post("/ussd")
      .type("form")
      .send({ sessionId: "http1", phoneNumber: "+2348012345678", text: "" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text.startsWith("CON ")).toBe(true);
  });

  it("responds with the END prefix when a flow terminates", async () => {
    const res = await request(app)
      .post("/ussd")
      .type("form")
      .send({ sessionId: "http2", phoneNumber: "+2348012345678", text: "9" });
    expect(res.text.startsWith("END ")).toBe(true);
  });

  it("never returns a raw JSON error body, even on a malformed request", async () => {
    // A phoneNumber that isn't E.164 — this is exactly the failure mode
    // found while manually verifying this route against a real curl
    // request during development (see menu.ts's error-logging comment).
    const res = await request(app)
      .post("/ussd")
      .type("form")
      .send({ sessionId: "http3", phoneNumber: "not-a-number", text: "" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text.startsWith("END ")).toBe(true);
  });
});

describe("dashboard list pagination", () => {
  let db: Db;
  let app: Express;
  let contract: MockKoboDialClient;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    const menu = new UssdMenuHandler(db, contract);
    app = createApp({
      db,
      menu,
      contract,
      logger: createLogger("error"),
      africasTalkingUsername: "sandbox",
      africasTalkingApiKey: "x",
    });
  });

  it("reports a total that counts every row, not just the page returned", async () => {
    await db.insert(wallets).values(Array.from({ length: 12 }, (_, i) => ({ phoneHash: `hash${i}` })));
    const res = await request(app).get("/wallets?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.wallets).toHaveLength(5);
    expect(res.body.total).toBe(12);
  });

  it("rejects a limit above the cap instead of silently clamping it", async () => {
    // Clamping would hand back 200 rows to a client that asked for 1000
    // and believed it had everything. A 400 cannot be misread.
    const res = await request(app).get("/wallets?limit=1000");
    expect(res.status).toBe(400);
  });

  it("echoes the defaults when the client sends no pagination at all", async () => {
    // This is the case the echo exists for: nothing was asked for, so
    // without it the client cannot tell which window it is holding.
    const res = await request(app).get("/wallets");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
  });

  it("echoes the offset so a client can tell which page it is holding", async () => {
    await db.insert(wallets).values(Array.from({ length: 6 }, (_, i) => ({ phoneHash: `w${i}` })));
    const res = await request(app).get("/wallets?limit=2&offset=4");
    expect(res.body.offset).toBe(4);
    expect(res.body.total).toBe(6);
    expect(res.body.wallets).toHaveLength(2);
  });

  it("reports total 0 on an empty table rather than omitting the field", async () => {
    // An absent total and a total of zero mean different things to a
    // client; the field must always be present.
    const res = await request(app).get("/transactions");
    expect(res.body.total).toBe(0);
    expect(res.body.transactions).toEqual([]);
  });

  it("counts transactions independently of the page size", async () => {
    await db.insert(transactions).values(
      Array.from({ length: 7 }, (_, i) => ({
        kind: "send" as const,
        fromPhoneHash: "aaa",
        toPhoneHash: "bbb",
        amount: String(i),
        status: "success" as const,
      })),
    );
    const res = await request(app).get("/transactions?limit=3");
    expect(res.body.transactions).toHaveLength(3);
    expect(res.body.total).toBe(7);
  });
});

describe("transaction filtering", () => {
  let db: Db;
  let app: Express;
  let contract: MockKoboDialClient;

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    const menu = new UssdMenuHandler(db, contract);
    app = createApp({
      db,
      menu,
      contract,
      logger: createLogger("error"),
      africasTalkingUsername: "sandbox",
      africasTalkingApiKey: "x",
    });
    await db.insert(transactions).values([
      { kind: "register", fromPhoneHash: "aaa", status: "success" },
      { kind: "fund", toPhoneHash: "aaa", amount: "500", status: "success" },
      { kind: "send", fromPhoneHash: "aaa", toPhoneHash: "bbb", amount: "100", status: "success" },
      {
        kind: "send",
        fromPhoneHash: "aaa",
        toPhoneHash: "bbb",
        amount: "999",
        status: "failed",
        errorCode: "InvalidPin",
      },
      { kind: "cash_out", fromPhoneHash: "bbb", amount: "50", status: "success" },
    ]);
  });

  it("returns only the requested kind", async () => {
    const res = await request(app).get("/transactions?kind=send");
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(2);
    expect(res.body.transactions.every((t: { kind: string }) => t.kind === "send")).toBe(true);
  });

  it("returns only the requested status", async () => {
    const res = await request(app).get("/transactions?status=failed");
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].errorCode).toBe("InvalidPin");
  });

  it("applies kind and status together rather than either one", async () => {
    const res = await request(app).get("/transactions?kind=send&status=success");
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].amount).toBe("100");
  });

  it("counts the filtered set, not the whole table", async () => {
    // The failure this guards: a total of 5 next to 2 visible rows reads
    // as though the view is hiding three results.
    const res = await request(app).get("/transactions?kind=send");
    expect(res.body.total).toBe(2);
  });

  it("rejects an unknown kind instead of returning an empty list", async () => {
    // An empty result must mean "nothing matched", never "you spelled it
    // wrong" — otherwise a typo reads as a factual answer about the data.
    const res = await request(app).get("/transactions?kind=withdrawal");
    expect(res.status).toBe(400);
  });

  it("rejects an unknown status for the same reason", async () => {
    const res = await request(app).get("/transactions?status=pending");
    expect(res.status).toBe(400);
  });

  it("returns everything when no filter is given", async () => {
    const res = await request(app).get("/transactions");
    expect(res.body.transactions).toHaveLength(5);
    expect(res.body.total).toBe(5);
  });

  it("accepts every kind the schema declares", async () => {
    // Pins the filter to the table definition: a kind added to schema.ts
    // without being filterable would fail here.
    for (const kind of ["register", "fund", "send", "cash_out", "change_pin"]) {
      const res = await request(app).get(`/transactions?kind=${kind}`);
      expect(res.status, `kind=${kind} should be accepted`).toBe(200);
    }
  });

  it("composes filtering with paging", async () => {
    const res = await request(app).get("/transactions?kind=send&limit=1");
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.total).toBe(2);
  });
});

describe("GET /wallets/:phoneHash/balance", () => {
  let db: Db;
  let app: Express;
  let contract: MockKoboDialClient;

  /** 64 hex characters, the shape hashPhoneNumber actually produces. */
  const hash = "a".repeat(64);

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    const menu = new UssdMenuHandler(db, contract);
    app = createApp({
      db,
      menu,
      contract,
      logger: createLogger("error"),
      africasTalkingUsername: "sandbox",
      africasTalkingApiKey: "x",
    });
  });

  it("returns the balance the contract reports", async () => {
    contract.seedWallet(Buffer.from(hash, "hex"), Buffer.alloc(32), 1250n);
    const res = await request(app).get(`/wallets/${hash}/balance`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ phoneHash: hash, balance: "1250" });
  });

  it("returns the balance as a string, so i128 values survive the wire", async () => {
    // Larger than Number.MAX_SAFE_INTEGER: as a JSON number this would
    // come back altered, and the alteration is silent.
    const huge = 170141183460469231731687303715884105727n;
    contract.seedWallet(Buffer.from(hash, "hex"), Buffer.alloc(32), huge);
    const res = await request(app).get(`/wallets/${hash}/balance`);
    expect(res.body.balance).toBe(huge.toString());
    expect(typeof res.body.balance).toBe("string");
  });

  it('returns zero as "0" rather than omitting it', async () => {
    contract.seedWallet(Buffer.from(hash, "hex"), Buffer.alloc(32), 0n);
    const res = await request(app).get(`/wallets/${hash}/balance`);
    expect(res.body.balance).toBe("0");
  });

  it("404s a wallet the contract does not know", async () => {
    const res = await request(app).get(`/wallets/${"b".repeat(64)}/balance`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("WalletNotFound");
  });

  it("502s when the chain cannot be reached, rather than reporting absence", async () => {
    // The distinction this pins: an unreachable RPC says nothing about
    // whether the wallet exists. Collapsing it into the 404 would tell an
    // operator the wallet is gone during an outage.
    contract.getBalance = async () => {
      throw new Error("rpc timeout");
    };
    const res = await request(app).get(`/wallets/${hash}/balance`);
    expect(res.status).toBe(502);
    expect(res.body.detail).toContain("rpc timeout");
  });

  it("rejects a malformed hash before calling the contract at all", async () => {
    let called = false;
    contract.getBalance = async () => {
      called = true;
      return 0n;
    };
    const res = await request(app).get("/wallets/not-a-hash/balance");
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("rejects uppercase hex, since stored hashes are lowercase", async () => {
    const res = await request(app).get(`/wallets/${"A".repeat(64)}/balance`);
    expect(res.status).toBe(400);
  });

  it("rejects a hash of the wrong length", async () => {
    const res = await request(app).get(`/wallets/${"a".repeat(63)}/balance`);
    expect(res.status).toBe(400);
  });
});
