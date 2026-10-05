import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { createApp } from "../src/app.js";
import { UssdMenuHandler } from "../src/ussd/menu.js";
import { Hasher } from "../src/crypto/hash.js";
import { createLogger } from "../src/logger.js";
import { MockKoboDialClient } from "./mockContract.js";

const TEST_PEPPER = "k".repeat(64);
const hasher = new Hasher(TEST_PEPPER);

/**
 * The dashboard API is unauthenticated, and the balance route reaches the
 * contract over RPC on every call. Unthrottled, a caller can drive unbounded
 * RPC traffic through the gateway, exhausting the provider's own rate limit
 * and degrading the USSD path — which is the part that matters, because a
 * slow dashboard is an inconvenience and a failed USSD session is someone
 * unable to reach their money.
 */
describe("dashboard rate limit", () => {
  let db: Db;
  let contract: MockKoboDialClient;
  let app: Express;

  const build = (max: number) => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    contract = new MockKoboDialClient();
    return createApp({
      db,
      menu: new UssdMenuHandler(db, contract, hasher),
      contract,
      hasher,
      logger: createLogger("error"),
      africasTalkingUsername: "sandbox",
      africasTalkingApiKey: "x",
      rateLimit: { max, windowMs: 60_000 },
    });
  };

  beforeEach(() => {
    app = build(3);
  });

  it("serves requests up to the limit, then answers 429", async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).get("/wallets");
      expect(ok.status, `request ${i + 1} should be allowed`).not.toBe(429);
    }

    const limited = await request(app).get("/wallets");
    expect(limited.status).toBe(429);
  });

  it("uses the same error envelope as the rest of the API", async () => {
    for (let i = 0; i < 3; i++) await request(app).get("/wallets");
    const limited = await request(app).get("/wallets");

    // A client should parse one shape, not special-case 429.
    expect(limited.body).toHaveProperty("error");
    expect(typeof limited.body.error).toBe("string");
  });

  it("advertises the limit, so a client can back off rather than guess", async () => {
    const res = await request(app).get("/wallets");
    expect(res.headers).toHaveProperty("ratelimit");
  });

  it("never throttles /health", async () => {
    // Health checks arrive from the hosting platform on a fixed schedule. A
    // 429 there reads as the service being down and gets the instance
    // restarted — the limiter causing an outage it exists to prevent.
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get("/health");
      expect(res.status, `health check ${i + 1}`).not.toBe(429);
    }
  });

  it("never throttles the USSD callback", async () => {
    // Africa's Talking posts every interaction from their own infrastructure,
    // so all real traffic shares a small set of addresses and would land in
    // one bucket. Throttling it would drop legitimate sessions at exactly the
    // busy moments the service exists for.
    const limited = build(1);
    await request(limited).get("/wallets");

    for (let i = 0; i < 5; i++) {
      const res = await request(limited)
        .post("/ussd")
        .type("form")
        .send({ sessionId: `s${i}`, phoneNumber: "+2348012345678", text: "" });
      expect(res.status, `callback ${i + 1}`).not.toBe(429);
    }
  });

  it("counts the dashboard and the callback separately", async () => {
    // Exhausting the dashboard budget must not leave the USSD path throttled.
    const tight = build(1);
    await request(tight).get("/wallets");
    expect((await request(tight).get("/wallets")).status).toBe(429);

    const callback = await request(tight)
      .post("/ussd")
      .type("form")
      .send({ sessionId: "after", phoneNumber: "+2348012345678", text: "" });
    expect(callback.status).not.toBe(429);
  });
});
