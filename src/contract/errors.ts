/**
 * Mirrors the Error enum in kobodial-contracts' src/error.rs exactly.
 * The numeric values matter: they are how a Soroban host reports a
 * contract error (as "Error(Contract, #N)"), and this file's only job
 * is to translate that number back into the same name the Rust side
 * uses, so a change on the contract side is a one-line diff here too.
 */
export enum ContractErrorCode {
  WalletNotFound = 1,
  InvalidPin = 2,
  InvalidNonce = 3,
  InsufficientBalance = 4,
  Unauthorized = 5,
  AlreadyRegistered = 6,
}

export class ContractError extends Error {
  constructor(public readonly code: ContractErrorCode) {
    super(`contract error: ${ContractErrorCode[code]} (#${code})`);
    this.name = "ContractError";
  }
}

/**
 * A failure the gateway can't attribute to a specific contract Error
 * variant — a network error, an RPC timeout, a transaction that failed
 * on submission after passing simulation (a rare race, e.g. another
 * relayed action landing between simulate and submit). The distinction
 * from ContractError matters to the USSD layer: a ContractError usually
 * means "tell the user something specific"; this usually means "tell
 * the user to try again."
 */
export class ContractCallFailedError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ContractCallFailedError";
  }
}

const SIM_ERROR_PATTERN = /Error\(Contract, #(\d+)\)/;

/**
 * Extracts a contract error code from a Soroban simulation's error
 * string, if the failure was a contract-level Err(...) rather than
 * something else (a resource limit, a network error, a malformed
 * request). Returns undefined when the string doesn't match that
 * shape — callers should fall back to a generic failure in that case
 * rather than assuming a code that isn't there.
 */
export function parseContractErrorCode(simulationError: string): ContractErrorCode | undefined {
  const match = SIM_ERROR_PATTERN.exec(simulationError);
  if (!match) return undefined;
  const code = Number(match[1]);
  return code in ContractErrorCode ? (code as ContractErrorCode) : undefined;
}
