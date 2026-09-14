import type { KoboDialClient } from "../src/contract/client.js";
import { ContractError, ContractErrorCode } from "../src/contract/errors.js";

/**
 * An in-memory stand-in for KoboDialClient, shared across test files.
 * Mirrors the real contract's actual rules closely enough to exercise
 * the USSD state machine faithfully — exact-match nonce, PIN check,
 * insufficient-balance check — without ever touching a network.
 */
export class MockKoboDialClient implements KoboDialClient {
  private nonces = new Map<string, number>();
  private balances = new Map<string, bigint>();
  private pins = new Map<string, string>();
  private registered = new Set<string>();
  private txCounter = 0;

  private nextTxHash(): string {
    this.txCounter += 1;
    return `mocktx-${this.txCounter}`;
  }

  /** Test setup helper: seed a wallet as if it had already been registered on-chain. */
  seedWallet(phoneHash: Buffer, pinHash: Buffer, balance = 0n, nonce = 0): void {
    const key = phoneHash.toString("hex");
    this.registered.add(key);
    this.pins.set(key, pinHash.toString("hex"));
    this.balances.set(key, balance);
    this.nonces.set(key, nonce);
  }

  async register(phoneHash: Buffer, pinHash: Buffer): Promise<string> {
    const key = phoneHash.toString("hex");
    if (this.registered.has(key)) throw new ContractError(ContractErrorCode.AlreadyRegistered);
    this.registered.add(key);
    this.pins.set(key, pinHash.toString("hex"));
    this.balances.set(key, 0n);
    this.nonces.set(key, 0);
    return this.nextTxHash();
  }

  async fund(phoneHash: Buffer, amount: bigint): Promise<string> {
    const key = phoneHash.toString("hex");
    if (!this.registered.has(key)) throw new ContractError(ContractErrorCode.WalletNotFound);
    this.balances.set(key, (this.balances.get(key) ?? 0n) + amount);
    return this.nextTxHash();
  }

  async send(
    fromHash: Buffer,
    toHash: Buffer,
    amount: bigint,
    pinHash: Buffer,
    nonce: number,
  ): Promise<string> {
    const from = fromHash.toString("hex");
    const to = toHash.toString("hex");
    if (!this.registered.has(from)) throw new ContractError(ContractErrorCode.WalletNotFound);
    if (this.pins.get(from) !== pinHash.toString("hex"))
      throw new ContractError(ContractErrorCode.InvalidPin);
    if (this.nonces.get(from) !== nonce) throw new ContractError(ContractErrorCode.InvalidNonce);
    const balance = this.balances.get(from) ?? 0n;
    if (balance < amount) throw new ContractError(ContractErrorCode.InsufficientBalance);
    if (!this.registered.has(to)) throw new ContractError(ContractErrorCode.WalletNotFound);
    this.balances.set(from, balance - amount);
    this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
    this.nonces.set(from, nonce + 1);
    return this.nextTxHash();
  }

  async changePin(phoneHash: Buffer, oldPinHash: Buffer, newPinHash: Buffer): Promise<string> {
    const key = phoneHash.toString("hex");
    if (!this.registered.has(key)) throw new ContractError(ContractErrorCode.WalletNotFound);
    if (this.pins.get(key) !== oldPinHash.toString("hex"))
      throw new ContractError(ContractErrorCode.InvalidPin);
    this.pins.set(key, newPinHash.toString("hex"));
    return this.nextTxHash();
  }

  async cashOut(phoneHash: Buffer, amount: bigint, pinHash: Buffer, nonce: number): Promise<string> {
    const key = phoneHash.toString("hex");
    if (!this.registered.has(key)) throw new ContractError(ContractErrorCode.WalletNotFound);
    if (this.pins.get(key) !== pinHash.toString("hex")) throw new ContractError(ContractErrorCode.InvalidPin);
    if (this.nonces.get(key) !== nonce) throw new ContractError(ContractErrorCode.InvalidNonce);
    const balance = this.balances.get(key) ?? 0n;
    if (balance < amount) throw new ContractError(ContractErrorCode.InsufficientBalance);
    this.balances.set(key, balance - amount);
    this.nonces.set(key, nonce + 1);
    return this.nextTxHash();
  }

  async getBalance(phoneHash: Buffer): Promise<bigint> {
    const key = phoneHash.toString("hex");
    if (!this.registered.has(key)) throw new ContractError(ContractErrorCode.WalletNotFound);
    return this.balances.get(key) ?? 0n;
  }

  async getNonce(phoneHash: Buffer): Promise<number> {
    const key = phoneHash.toString("hex");
    if (!this.registered.has(key)) throw new ContractError(ContractErrorCode.WalletNotFound);
    return this.nonces.get(key) ?? 0;
  }
}
