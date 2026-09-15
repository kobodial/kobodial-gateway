import { sql } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * A phone number registered with this gateway, indexed by its SHA-256
 * hash. The contract is the source of truth for balance and nonce; this
 * table only tracks which phone hashes this gateway has registered, so
 * a USSD session can tell "not yet registered" apart from "registered,
 * ask the chain for the rest" without an RPC round trip on every menu
 * keystroke.
 *
 * phoneHash is lowercase hex, never a raw phone number — see
 * src/crypto/hash.ts. There is no PIN hash column here: the contract
 * is the only place a PIN hash is ever stored, so a database leak alone
 * can never expose it.
 */
export const wallets = sqliteTable("wallets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  phoneHash: text("phone_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * In-progress USSD session state, keyed by the sessionId Africa's
 * Talking assigns. USSD is a sequence of stateless HTTP requests
 * correlated only by that sessionId — this table is the memory across
 * them, and it is a DB table rather than an in-process Map specifically
 * because consecutive requests in the same session are not guaranteed
 * to hit the same server instance.
 *
 * `step` names where in a menu flow the caller is; `data` holds
 * whatever the flow has collected so far (recipient hash, amount, etc.)
 * as JSON text — deliberately never a raw PIN, see src/ussd/state.ts.
 * A session row is deleted once its flow completes or is abandoned; it
 * is not a permanent record, unlike the transactions table below.
 */
export const ussdSessions = sqliteTable("ussd_sessions", {
  sessionId: text("session_id").primaryKey(),
  phoneHash: text("phone_hash").notNull(),
  step: text("step").notNull(),
  data: text("data").notNull().default("{}"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * A durable record of every contract call this gateway has attempted,
 * for the dashboard and for tracing a user's "it didn't work" report
 * back to what actually happened on-chain. Only hashed identifiers and
 * amounts — never a raw phone number or PIN, so this table is safe to
 * expose read-only through the dashboard API without becoming a PII
 * leak in its own right.
 */
export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", {
    enum: ["register", "fund", "send", "cash_out", "change_pin"],
  }).notNull(),
  fromPhoneHash: text("from_phone_hash"),
  toPhoneHash: text("to_phone_hash"),
  /**
   * Stored as text, not a number: contract amounts are i128 and can
   * exceed Number.MAX_SAFE_INTEGER. Kept as the exact decimal string
   * passed to the contract so nothing is lossy on the way in or out.
   */
  amount: text("amount"),
  status: text("status", { enum: ["success", "failed"] }).notNull(),
  /** The contract's Error variant name (InvalidPin, InvalidNonce, ...) when status is "failed". */
  errorCode: text("error_code"),
  /** The Stellar transaction hash, when this attempt reached submission. */
  txHash: text("tx_hash"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * A cash-in/cash-out agent: the person who takes physical cash and funds a
 * wallet, or pays cash out against one. Agents are the operators of
 * KoboDial, not its end users.
 *
 * phone_hash, not a raw number — deliberately. Agents are business
 * counterparties an operator might reasonably want to phone, which is an
 * argument for storing the number in the clear. But every other table here
 * holds only digests, and that invariant ("this database is safe to expose
 * read-only because it never held PII in the first place") is worth more
 * than the convenience. Hashing is also the reversible choice: a later
 * decision to store contact details can add a column, whereas raw numbers
 * written today cannot be un-leaked. If an operator needs to reach an
 * agent, that belongs in a contact system, not in the ledger's index.
 */
export const agents = sqliteTable("agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** SHA-256 hex of the agent's phone number, hashed off-chain like every other phone hash. Unique: an agent enrolls once. */
  phoneHash: text("phone_hash").notNull().unique(),
  /** Where the agent actually handles cash. Free text, required. */
  location: text("location").notNull(),
  status: text("status", { enum: ["active", "suspended"] })
    .notNull()
    .default("active"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
export type UssdSession = typeof ussdSessions.$inferSelect;
export type NewUssdSession = typeof ussdSessions.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
