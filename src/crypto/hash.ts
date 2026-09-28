import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * E.164: a leading '+', then 1-15 digits, the first of which is 1-9.
 * Africa's Talking's USSD callback already sends phoneNumber in this
 * form; this is a defensive check, not a normalization step — a phone
 * number in any other shape hashes to something the contract has never
 * seen, so rejecting it early is better than silently minting an
 * unreachable wallet.
 */
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export class InvalidPhoneNumberError extends Error {
  constructor(reason: string) {
    super(`invalid phone number: ${reason}`);
    this.name = "InvalidPhoneNumberError";
  }
}

/**
 * Validates that a phone number is E.164 and returns it trimmed. Throws
 * InvalidPhoneNumberError otherwise — callers should map this to a short
 * USSD error, never let it bubble up as an unhandled exception with the
 * number attached.
 */
export function assertValidPhoneNumber(raw: string): string {
  const trimmed = raw.trim();
  if (!E164_PATTERN.test(trimmed)) {
    throw new InvalidPhoneNumberError("expected E.164 format, e.g. +2348012345678");
  }
  return trimmed;
}

/** Exactly four digits — the PIN length every USSD prompt in this service asks for. */
const PIN_PATTERN = /^\d{4}$/;

export class InvalidPinError extends Error {
  constructor() {
    super("PIN must be exactly 4 digits");
    this.name = "InvalidPinError";
  }
}

/**
 * Domain separators. Without them, HMAC(pepper, x) for a phone number and
 * for a PIN come from the same function, and a value that happened to be
 * valid as both would produce the same digest in two different roles.
 */
const PHONE_DOMAIN = "kobodial/phone/v1";
const PIN_DOMAIN = "kobodial/pin/v1";

/** The shortest pepper worth having: 32 bytes of hex. */
export const MIN_PEPPER_LENGTH = 64;

export class InvalidPepperError extends Error {
  constructor(reason: string) {
    super(`invalid hash pepper: ${reason}`);
    this.name = "InvalidPepperError";
  }
}

/**
 * Derives the identifiers the contract stores, keyed by a secret pepper.
 *
 * ## Why a pepper, and not a plain hash
 *
 * `phone_hash` and `pin_hash` are written to Soroban **persistent storage,
 * which is public**. Anyone can read every wallet's entry off the ledger.
 * That makes an unkeyed digest a disclosure, not a protection, because both
 * inputs come from a small enumerable space:
 *
 * - **A PIN is 4 digits — 10,000 candidates.** Hashing all of them takes
 *   under a millisecond, so an unkeyed `pin_hash` *is* the PIN.
 * - **A phone number is not secret enough to hash.** A national mobile
 *   range is a few tens of millions of numbers, and SHA-256 runs in the
 *   billions per second on commodity hardware. Enumerating a country's
 *   numbering plan against the ledger recovers the phone number behind
 *   every wallet — the whole user base, deanonymized, from public data.
 *
 * Salting does not fix this. A salt has to be stored next to the digest to
 * be usable, so it would be published too, and a per-user salt only stops
 * one attacker precomputing *one* table for *all* users. Against a 10,000
 * candidate space it buys nothing.
 *
 * What does fix it is a key the ledger never sees. HMAC-SHA-256 under a
 * secret pepper means an attacker holding the entire ledger still cannot
 * test a single candidate, because they cannot compute the digest at all.
 * The security of every stored identifier rests on this pepper staying on
 * the gateway.
 *
 * ## What this does not do
 *
 * The pepper protects against someone reading the ledger. It does not
 * protect against the gateway itself being compromised — whoever holds the
 * pepper can enumerate exactly as described above. Rotating it is a
 * migration, not a config change: every stored `phone_hash` is derived from
 * it, so old wallets become unreachable. See docs/SECURITY.md.
 */
export class Hasher {
  private readonly pepper: Buffer;

  constructor(pepper: string) {
    if (typeof pepper !== "string" || pepper.trim().length < MIN_PEPPER_LENGTH) {
      // Deliberately does not echo the value, even when it is the empty
      // string: this message reaches logs.
      throw new InvalidPepperError(
        `expected at least ${MIN_PEPPER_LENGTH} characters of high-entropy secret`,
      );
    }
    this.pepper = Buffer.from(pepper.trim(), "utf8");
  }

  /**
   * The contract's `phone_hash` for an E.164 number. The raw number is
   * never returned, logged, or stored by this method — only the digest
   * leaves it.
   */
  phone(rawPhoneNumber: string): Buffer {
    const validated = assertValidPhoneNumber(rawPhoneNumber);
    return this.mac(PHONE_DOMAIN, validated);
  }

  /**
   * The contract's `pin_hash` for a 4-digit PIN.
   *
   * This is the one place in the codebase that ever sees a raw PIN. It
   * takes the PIN, derives the digest, and returns only that — never the
   * input. Every caller must derive at the point of receipt and pass the
   * resulting Buffer onward; nothing downstream should ever hold a raw
   * PIN, and this method performs no logging of any kind, on any path,
   * including its own error message.
   */
  pin(rawPin: string): Buffer {
    if (!PIN_PATTERN.test(rawPin)) {
      throw new InvalidPinError();
    }
    return this.mac(PIN_DOMAIN, rawPin);
  }

  private mac(domain: string, value: string): Buffer {
    return createHmac("sha256", this.pepper).update(domain).update("\0").update(value, "utf8").digest();
  }
}

/**
 * Compares two digests without leaking where they first differ.
 *
 * Length is checked first because timingSafeEqual throws on a mismatch,
 * and that throw would itself be the signal the comparison is meant to
 * withhold.
 */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Lowercase hex — the encoding used for hashes in storage and contract calls. */
export function toHex(buf: Buffer): string {
  return buf.toString("hex");
}

export function fromHex(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}
