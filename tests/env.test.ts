import { describe, it, expect } from "vitest";
import { loadEnv, PLACEHOLDER_API_KEY } from "../src/config/env.js";

/**
 * The environment contract. Two properties matter here and pull in opposite
 * directions: anything the running service genuinely needs must stop the boot
 * when it is missing, and anything it does not need must not.
 *
 * Getting the second one wrong is not harmless. Requiring an Africa's Talking
 * API key that the USSD path never authenticates with blocked a deployment on
 * a credential nothing used.
 */
const REQUIRED = {
  RPC_URL: "https://soroban-testnet.stellar.org",
  CONTRACT_ID: "CDQKYOYWBUAFZUZIAX4YDTLWYTYWPAV3AOSCUJJ2PWNRCECVV5F6XX73",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  RELAYER_SECRET_KEY: "S" + "A".repeat(55),
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  HASH_PEPPER: "a".repeat(64),
};

describe("loadEnv", () => {
  it("accepts a configuration with no Africa's Talking credentials", () => {
    const env = loadEnv({ ...REQUIRED });
    expect(env.AFRICAS_TALKING_USERNAME).toBe("sandbox");
    expect(env.AFRICAS_TALKING_API_KEY).toBe(PLACEHOLDER_API_KEY);
  });

  it("keeps real Africa's Talking credentials when they are given", () => {
    const env = loadEnv({
      ...REQUIRED,
      AFRICAS_TALKING_USERNAME: "kobodial",
      AFRICAS_TALKING_API_KEY: "atsk_real",
    });
    expect(env.AFRICAS_TALKING_USERNAME).toBe("kobodial");
    expect(env.AFRICAS_TALKING_API_KEY).toBe("atsk_real");
  });

  it("uses a placeholder that is recognisable rather than plausible", () => {
    // It ends up in a log line. A value that looked like a credential would
    // invite someone to go looking for where it came from.
    expect(PLACEHOLDER_API_KEY).toMatch(/unset/);
  });

  for (const key of Object.keys(REQUIRED)) {
    it(`still refuses to start without ${key}`, () => {
      const partial = { ...REQUIRED } as Record<string, string>;
      delete partial[key];
      expect(() => loadEnv(partial)).toThrow(new RegExp(key));
    });
  }

  it("rejects a pepper that is too short to be worth having", () => {
    expect(() => loadEnv({ ...REQUIRED, HASH_PEPPER: "tooshort" })).toThrow(/HASH_PEPPER/);
  });

  it("rejects a malformed contract id and relayer key", () => {
    expect(() => loadEnv({ ...REQUIRED, CONTRACT_ID: "not-a-contract" })).toThrow(/CONTRACT_ID/);
    expect(() => loadEnv({ ...REQUIRED, RELAYER_SECRET_KEY: "GABC" })).toThrow(/RELAYER_SECRET_KEY/);
  });
});
