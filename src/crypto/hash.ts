import { createHash } from "node:crypto";

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

/**
 * SHA-256 of an E.164 phone number, as the contract expects for
 * phone_hash. The raw number is never returned, logged, or stored by
 * this function — only the digest leaves it.
 */
export function hashPhoneNumber(rawPhoneNumber: string): Buffer {
  const validated = assertValidPhoneNumber(rawPhoneNumber);
  return createHash("sha256").update(validated, "utf8").digest();
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
 * SHA-256 of a 4-digit PIN, as the contract expects for pin_hash.
 *
 * This is the one function in the codebase that ever sees a raw PIN.
 * It takes the PIN, hashes it, and returns only the digest — never the
 * input. Every caller must hash at the point of receipt and pass the
 * resulting Buffer onward; nothing downstream of this function should
 * ever hold a raw PIN, and this function itself performs no logging of
 * any kind, on any path, including its own error message.
 */
export function hashPin(rawPin: string): Buffer {
  if (!PIN_PATTERN.test(rawPin)) {
    throw new InvalidPinError();
  }
  return createHash("sha256").update(rawPin, "utf8").digest();
}

/** Lowercase hex — the encoding used for hashes in storage and contract calls. */
export function toHex(buf: Buffer): string {
  return buf.toString("hex");
}

export function fromHex(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}
