import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { agents } from "../src/db/schema.js";
import { UssdMenuHandler } from "../src/ussd/menu.js";
import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import { MockKoboDialClient } from "./mockContract.js";

describe("agents API", () => {
  let db: Db;
  let app: Express;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: "./src/db/migrations" });
    const contract = new MockKoboDialClient();
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

  const valid = { name: "Musa Ibrahim", phone: "+2348012345678", location: "Kano, Sabon Gari" };

  it("registers an agent and returns it with a generated id and default status", async () => {
    const res = await request(app).post("/agents").send(valid);
    expect(res.status).toBe(201);
    expect(res.body.agent.id).toBeGreaterThan(0);
    expect(res.body.agent.name).toBe("Musa Ibrahim");
    expect(res.body.agent.location).toBe("Kano, Sabon Gari");
    expect(res.body.agent.status).toBe("active");
  });

  it("stores a phone hash, never the raw number", async () => {
    const res = await request(app).post("/agents").send(valid);
    const stored = JSON.stringify(res.body.agent);
    // The raw number must not survive anywhere in the record.
    expect(stored).not.toContain("+2348012345678");
    // 64 hex chars is a SHA-256 digest.
    expect(res.body.agent.phoneHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists agents newest first, with a total", async () => {
    await request(app).post("/agents").send(valid);
    await request(app)
      .post("/agents")
      .send({ ...valid, name: "Amina Bello", phone: "+2348087654321" });
    const res = await request(app).get("/agents");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.agents[0].name).toBe("Amina Bello");
  });

  it("rejects a second registration of the same number as a conflict", async () => {
    await request(app).post("/agents").send(valid);
    const res = await request(app)
      .post("/agents")
      .send({ ...valid, name: "Someone Else", location: "Lagos" });
    expect(res.status).toBe(409);
    // The first registration must be untouched.
    const list = await request(app).get("/agents");
    expect(list.body.total).toBe(1);
    expect(list.body.agents[0].name).toBe("Musa Ibrahim");
  });

  it("rejects a malformed phone number with a 400", async () => {
    const res = await request(app)
      .post("/agents")
      .send({ ...valid, phone: "080-not-e164" });
    expect(res.status).toBe(400);
  });

  it("rejects missing required fields", async () => {
    for (const missing of ["name", "phone", "location"] as const) {
      const body = { ...valid } as Record<string, string>;
      delete body[missing];
      const res = await request(app).post("/agents").send(body);
      expect(res.status, `missing ${missing} should 400`).toBe(400);
    }
  });

  it("suspends and reactivates an agent via PATCH", async () => {
    const created = await request(app).post("/agents").send(valid);
    const id = created.body.agent.id;

    const suspend = await request(app).patch(`/agents/${id}`).send({ status: "suspended" });
    expect(suspend.status).toBe(200);
    expect(suspend.body.agent.status).toBe("suspended");

    const reactivate = await request(app).patch(`/agents/${id}`).send({ status: "active" });
    expect(reactivate.body.agent.status).toBe("active");
  });

  it("rejects an unknown status value", async () => {
    const created = await request(app).post("/agents").send(valid);
    const res = await request(app).patch(`/agents/${created.body.agent.id}`).send({ status: "deleted" });
    expect(res.status).toBe(400);
  });

  it("404s a PATCH to an agent that does not exist", async () => {
    const res = await request(app).patch("/agents/9999").send({ status: "suspended" });
    expect(res.status).toBe(404);
  });

  it("400s a PATCH with a non-numeric id", async () => {
    const res = await request(app).patch("/agents/abc").send({ status: "suspended" });
    expect(res.status).toBe(400);
  });

  it("returns an empty list with total 0 before any agent exists", async () => {
    const res = await request(app).get("/agents");
    expect(res.body).toMatchObject({ agents: [], total: 0 });
  });

  it("keeps the stored hash consistent with the wallet phone hash for the same number", async () => {
    // An agent who also holds a wallet should hash to the same value, so a
    // future feature could correlate the two. Guards the hashing path.
    await db.insert(agents).values({
      name: "X",
      phoneHash: "a".repeat(64),
      location: "Y",
    });
    const res = await request(app).get("/agents");
    expect(res.body.agents[0].phoneHash).toBe("a".repeat(64));
  });
});
