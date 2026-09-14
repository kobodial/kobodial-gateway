import { describe, it, expect } from "vitest";
import { parseContractErrorCode, ContractErrorCode, ContractError } from "../src/contract/errors.js";

describe("parseContractErrorCode", () => {
  it("extracts the code from the exact error string a live simulation produced", () => {
    // Captured verbatim from a real testnet simulation of cash_out with a
    // stale nonce, during this gateway's development.
    const real = `HostError: Error(Contract, #3)

Event log (newest first):
   0: [Diagnostic Event] contract:CCPXFBZNI2HR6TPCA5QIYLQRU5W4IXCEK5Y6ANTXKCRLXCXNRILIQQJU, topics:[error, Error(Contract, #3)], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"`;
    expect(parseContractErrorCode(real)).toBe(ContractErrorCode.InvalidNonce);
  });

  it.each([
    [1, ContractErrorCode.WalletNotFound],
    [2, ContractErrorCode.InvalidPin],
    [3, ContractErrorCode.InvalidNonce],
    [4, ContractErrorCode.InsufficientBalance],
    [5, ContractErrorCode.Unauthorized],
    [6, ContractErrorCode.AlreadyRegistered],
  ])("maps code #%i to %s, matching kobodial-contracts' error.rs exactly", (code, expected) => {
    expect(parseContractErrorCode(`Error(Contract, #${code})`)).toBe(expected);
  });

  it("returns undefined for a code outside the known enum range", () => {
    expect(parseContractErrorCode("Error(Contract, #999)")).toBeUndefined();
  });

  it("returns undefined for a string that isn't a contract error at all", () => {
    expect(parseContractErrorCode("connection reset by peer")).toBeUndefined();
    expect(parseContractErrorCode("")).toBeUndefined();
  });
});

describe("ContractError", () => {
  it("carries the code and names it in the message", () => {
    const err = new ContractError(ContractErrorCode.InvalidPin);
    expect(err.code).toBe(ContractErrorCode.InvalidPin);
    expect(err.message).toContain("InvalidPin");
    expect(err.message).toContain("#2");
    expect(err.name).toBe("ContractError");
  });
});
