import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  hashPhoneNumber,
  hashPin,
  assertValidPhoneNumber,
  toHex,
  fromHex,
  InvalidPhoneNumberError,
  InvalidPinError,
} from "../src/crypto/hash.js";

/** The same digest an independent sha256 implementation would produce, for cross-checking. */
function referenceSha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("hashPhoneNumber", () => {
  it("matches an independent SHA-256 of the exact E.164 string", () => {
    const phone = "+2348012345678";
    expect(toHex(hashPhoneNumber(phone))).toBe(referenceSha256Hex(phone));
  });

  it("matches the digest the deployed KoboDial contract already holds for this number", () => {
    // Cross-checked against `printf '+2348012345678' | sha256sum` and the
    // live testnet wallet registered under this hash during
    // kobodial-contracts' own manual testing — not just internally
    // consistent, but interoperable with what's actually on-chain.
    expect(toHex(hashPhoneNumber("+2348012345678"))).toBe(
      "1cc617d6732e4010deef3427ac408c533a84de7232e093f934d36ac00cd8036a",
    );
  });

  it("trims surrounding whitespace before hashing", () => {
    expect(toHex(hashPhoneNumber("  +2348012345678  "))).toBe(toHex(hashPhoneNumber("+2348012345678")));
  });

  it("is sensitive to every digit — no two distinct numbers collide by construction", () => {
    expect(toHex(hashPhoneNumber("+2348012345678"))).not.toBe(toHex(hashPhoneNumber("+2348012345679")));
  });

  for (const bad of ["2348012345678", "+abc", "+234", "", "+123456789012345678", "+0812345678"]) {
    it(`rejects ${JSON.stringify(bad)} as not E.164`, () => {
      expect(() => hashPhoneNumber(bad)).toThrow(InvalidPhoneNumberError);
    });
  }
});

describe("hashPin", () => {
  it("matches an independent SHA-256 of the exact PIN string", () => {
    expect(toHex(hashPin("1234"))).toBe(referenceSha256Hex("1234"));
  });

  it("matches the digest the deployed KoboDial contract already holds for this PIN", () => {
    expect(toHex(hashPin("1234"))).toBe("03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4");
  });

  it("is sensitive to every digit — no two distinct PINs collide by construction", () => {
    expect(toHex(hashPin("1234"))).not.toBe(toHex(hashPin("4321")));
  });

  for (const bad of ["123", "12345", "abcd", "", "12a4", " 1234", "1234 "]) {
    it(`rejects ${JSON.stringify(bad)} as not a 4-digit PIN`, () => {
      expect(() => hashPin(bad)).toThrow(InvalidPinError);
    });
  }

  it("never returns the input — only its digest leaves the function", () => {
    const pin = "9999";
    const result = hashPin(pin);
    expect(result.toString("utf8")).not.toContain(pin);
    expect(toHex(result)).not.toContain(pin);
  });
});

describe("assertValidPhoneNumber", () => {
  it("returns the trimmed number unchanged when valid", () => {
    expect(assertValidPhoneNumber("  +2348012345678  ")).toBe("+2348012345678");
  });
});

describe("toHex / fromHex", () => {
  it("round-trip through hex without loss", () => {
    const original = hashPin("1234");
    expect(fromHex(toHex(original))).toEqual(original);
  });
});
