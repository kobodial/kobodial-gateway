import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { UssdSessionStore } from "../src/ussd/sessionStore.js";
import { UssdStep } from "../src/ussd/types.js";

describe("UssdSessionStore", () => {
  let db: Db;
  let store: UssdSessionStore;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    store = new UssdSessionStore(db);
  });

  const owner = "ownerhash";

  it("returns the welcome step for a sessionId that has never been saved", async () => {
    expect(await store.load("never-seen", owner)).toEqual({ step: UssdStep.Welcome, data: {} });
  });

  it("round-trips whatever step and data were saved", async () => {
    await store.save("s1", owner, {
      step: UssdStep.SendEnterPin,
      data: { recipientPhoneNumber: "+2348099999999", amount: "150" },
    });
    expect(await store.load("s1", owner)).toEqual({
      step: UssdStep.SendEnterPin,
      data: { recipientPhoneNumber: "+2348099999999", amount: "150" },
    });
  });

  it("a second save on the same sessionId updates rather than conflicting", async () => {
    await store.save("s2", owner, { step: UssdStep.Welcome, data: {} });
    await store.save("s2", owner, { step: UssdStep.RegisterEnterPin, data: {} });
    expect(await store.load("s2", owner)).toEqual({ step: UssdStep.RegisterEnterPin, data: {} });
  });

  it("clear() removes the row, so a subsequent load falls back to welcome", async () => {
    await store.save("s3", owner, { step: UssdStep.ChangePinEnterOld, data: {} });
    await store.clear("s3", owner);
    expect(await store.load("s3", owner)).toEqual({ step: UssdStep.Welcome, data: {} });
  });

  it("clearing an already-clear or unknown sessionId does not throw", async () => {
    await expect(store.clear("was-never-saved", owner)).resolves.toBeUndefined();
  });

  it("keeps two different sessionIds fully independent", async () => {
    await store.save("a", "hashA", { step: UssdStep.SendEnterAmount, data: { amount: "1" } });
    await store.save("b", "hashB", { step: UssdStep.SendEnterAmount, data: { amount: "2" } });
    expect((await store.load("a", "hashA")).data.amount).toBe("1");
    expect((await store.load("b", "hashB")).data.amount).toBe("2");
  });
});
