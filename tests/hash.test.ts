import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import {
  Hasher,
  assertValidPhoneNumber,
  digestsEqual,
  toHex,
  fromHex,
  InvalidPhoneNumberError,
  InvalidPinError,
  InvalidPepperError,
  MIN_PEPPER_LENGTH,
} from "../src/crypto/hash.js";

const PEPPER = "a".repeat(64);
const OTHER_PEPPER = "b".repeat(64);
const hasher = new Hasher(PEPPER);
const other = new Hasher(OTHER_PEPPER);

/** What an independent HMAC implementation produces, for cross-checking. */
function referenceMacHex(pepper: string, domain: string, value: string): string {
  return createHmac("sha256", Buffer.from(pepper, "utf8"))
    .update(domain)
    .update("\0")
    .update(value, "utf8")
    .digest("hex");
}

describe("Hasher.phone", () => {
  it("matches an independent HMAC-SHA-256 under the pepper", () => {
    const phone = "+2348012345678";
    expect(toHex(hasher.phone(phone))).toBe(referenceMacHex(PEPPER, "kobodial/phone/v1", phone));
  });

  it("trims surrounding whitespace before deriving", () => {
    expect(toHex(hasher.phone("  +2348012345678  "))).toBe(toHex(hasher.phone("+2348012345678")));
  });

  it("is sensitive to every digit — no two distinct numbers collide by construction", () => {
    expect(toHex(hasher.phone("+2348012345678"))).not.toBe(toHex(hasher.phone("+2348012345679")));
  });

  for (const bad of ["2348012345678", "+abc", "+234", "", "+123456789012345678", "+0812345678"]) {
    it(`rejects ${JSON.stringify(bad)} as not E.164`, () => {
      expect(() => hasher.phone(bad)).toThrow(InvalidPhoneNumberError);
    });
  }
});

describe("Hasher.pin", () => {
  it("matches an independent HMAC-SHA-256 under the pepper", () => {
    expect(toHex(hasher.pin("1234"))).toBe(referenceMacHex(PEPPER, "kobodial/pin/v1", "1234"));
  });

  it("is sensitive to every digit — no two distinct PINs collide by construction", () => {
    expect(toHex(hasher.pin("1234"))).not.toBe(toHex(hasher.pin("4321")));
  });

  for (const bad of ["123", "12345", "abcd", "", "12a4", " 1234", "1234 "]) {
    it(`rejects ${JSON.stringify(bad)} as not a 4-digit PIN`, () => {
      expect(() => hasher.pin(bad)).toThrow(InvalidPinError);
    });
  }

  it("never returns the input — only its digest leaves the method", () => {
    const pin = "9999";
    const result = hasher.pin(pin);
    expect(result.toString("utf8")).not.toContain(pin);
    expect(toHex(result)).not.toContain(pin);
  });
});

// The reason this module exists. Both digests are written to Soroban
// persistent storage, which anyone can read, and both inputs come from a
// small enumerable space — 10,000 PINs, and a national mobile range for
// phone numbers. An unkeyed digest of either is therefore a disclosure of
// the input, not a protection of it.
describe("the pepper is what makes a published digest useless to an attacker", () => {
  it("does not produce the plain SHA-256 an off-the-shelf table would cover", () => {
    // The scheme this replaced. Anyone holding the ledger could hash all
    // 10,000 PINs and read every wallet's PIN straight off it.
    const plain = createHash("sha256").update("1234", "utf8").digest("hex");
    expect(toHex(hasher.pin("1234"))).not.toBe(plain);

    const plainPhone = createHash("sha256").update("+2348012345678", "utf8").digest("hex");
    expect(toHex(hasher.phone("+2348012345678"))).not.toBe(plainPhone);
  });

  it("gives a different digest under a different pepper, for the same input", () => {
    // Without this, the pepper would not be load-bearing and an attacker
    // would not need it to reproduce the digests.
    expect(toHex(hasher.pin("1234"))).not.toBe(toHex(other.pin("1234")));
    expect(toHex(hasher.phone("+2348012345678"))).not.toBe(toHex(other.phone("+2348012345678")));
  });

  it("separates the phone and PIN domains", () => {
    // Same secret, same primitive, two different roles. Without domain
    // separation a value valid as both would derive the same digest in
    // each, and a digest from one role could be replayed into the other.
    const value = "1234";
    const asPin = toHex(hasher.pin(value));
    const asPhoneDomain = referenceMacHex(PEPPER, "kobodial/phone/v1", value);
    expect(asPin).not.toBe(asPhoneDomain);
  });

  it("is deterministic, so a wallet stays reachable across restarts", () => {
    // The flip side of peppering: the digest must be stable for a given
    // pepper, or a registered wallet becomes unreachable on the next boot.
    expect(toHex(new Hasher(PEPPER).phone("+2348012345678"))).toBe(
      toHex(new Hasher(PEPPER).phone("+2348012345678")),
    );
  });
});

describe("Hasher construction", () => {
  it(`rejects a pepper shorter than ${MIN_PEPPER_LENGTH} characters`, () => {
    expect(() => new Hasher("short")).toThrow(InvalidPepperError);
    expect(() => new Hasher("c".repeat(MIN_PEPPER_LENGTH - 1))).toThrow(InvalidPepperError);
  });

  it("rejects an empty or whitespace-only pepper", () => {
    // The failure that would otherwise be silent: an unset environment
    // variable arriving as "" and the service starting anyway.
    expect(() => new Hasher("")).toThrow(InvalidPepperError);
    expect(() => new Hasher("   ")).toThrow(InvalidPepperError);
  });

  it("does not echo the pepper in its error, since that message reaches logs", () => {
    const secret = "s".repeat(10);
    try {
      new Hasher(secret);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });
});

describe("digestsEqual", () => {
  it("is true for identical digests and false for different ones", () => {
    expect(digestsEqual(hasher.pin("1234"), hasher.pin("1234"))).toBe(true);
    expect(digestsEqual(hasher.pin("1234"), hasher.pin("4321"))).toBe(false);
  });

  it("returns false rather than throwing on a length mismatch", () => {
    // timingSafeEqual throws on unequal lengths, and that throw would
    // itself be the signal the comparison is meant to withhold.
    expect(digestsEqual(Buffer.alloc(32), Buffer.alloc(16))).toBe(false);
  });
});

describe("assertValidPhoneNumber", () => {
  it("returns the trimmed number unchanged when valid", () => {
    expect(assertValidPhoneNumber("  +2348012345678  ")).toBe("+2348012345678");
  });
});

describe("toHex / fromHex", () => {
  it("round-trip through hex without loss", () => {
    const original = hasher.pin("1234");
    expect(fromHex(toHex(original))).toEqual(original);
  });
});
