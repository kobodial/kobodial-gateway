import {
  Keypair,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import { ContractError, ContractCallFailedError, parseContractErrorCode } from "./errors.js";

/**
 * The read-write surface the USSD layer needs from KoboDial. Kept as an
 * interface, separate from the concrete Soroban-backed implementation
 * below, so tests can drive the entire USSD state machine against a
 * hand-written mock — no network, no signing, no testnet — while still
 * type-checking against the exact same shape production code depends on.
 *
 * Every phone hash, PIN hash and amount here is already hashed/typed by
 * the caller (see src/crypto/hash.ts) — this layer's job is only to
 * shuttle them to and from the chain, never to validate or hash them
 * itself.
 */
export interface KoboDialClient {
  /** Every write returns the Stellar transaction hash it submitted, for the transaction log. */
  register(phoneHash: Buffer, pinHash: Buffer): Promise<string>;
  fund(phoneHash: Buffer, amount: bigint): Promise<string>;
  send(fromHash: Buffer, toHash: Buffer, amount: bigint, pinHash: Buffer, nonce: number): Promise<string>;
  changePin(phoneHash: Buffer, oldPinHash: Buffer, newPinHash: Buffer): Promise<string>;
  cashOut(phoneHash: Buffer, amount: bigint, pinHash: Buffer, nonce: number): Promise<string>;
  getBalance(phoneHash: Buffer): Promise<bigint>;
  getNonce(phoneHash: Buffer): Promise<number>;
}

export interface SorobanKoboDialClientOptions {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  relayerSecretKey: string;
}

/** ScVal wrapper for a 32-byte hash Buffer. */
function bytes32(b: Buffer) {
  return nativeToScVal(b, { type: "bytes" });
}

/**
 * A tiny FIFO async mutex, exactly enough to keep this single process
 * from racing itself.
 *
 * Every write to the contract is a transaction signed and submitted by
 * the same relayer account, and Stellar transactions from one account
 * must use strictly increasing sequence numbers. Two USSD requests
 * arriving milliseconds apart — plausible the moment this service has
 * more than a handful of users — would otherwise both fetch the same
 * starting sequence number and one submission would be rejected.
 * Serializing "fetch account, build, sign, submit" through this queue
 * makes that race impossible within one process.
 *
 * It does NOT make it impossible across processes: running more than
 * one instance of this gateway against the same RELAYER_SECRET_KEY
 * still needs an external sequence-number coordinator, which this MVP
 * does not implement. See SECURITY.md.
 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * Talks to a deployed KoboDial contract over Soroban RPC. register, fund
 * and cashOut sign as the relayer's own account, which must be the same
 * address the contract was deployed with --admin — the contract checks
 * that identity itself, so a mismatched RELAYER_SECRET_KEY fails loudly
 * on the very first admin call rather than silently.
 */
export class SorobanKoboDialClient implements KoboDialClient {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly relayer: Keypair;
  private readonly networkPassphrase: string;
  private readonly writeMutex = new Mutex();

  constructor(opts: SorobanKoboDialClientOptions) {
    this.server = new rpc.Server(opts.rpcUrl);
    this.contract = new Contract(opts.contractId);
    this.relayer = Keypair.fromSecret(opts.relayerSecretKey);
    this.networkPassphrase = opts.networkPassphrase;
  }

  /** The relayer's own public address — the contract's admin. */
  get relayerAddress(): string {
    return this.relayer.publicKey();
  }

  private adminArg() {
    return nativeToScVal(this.relayerAddress, { type: "address" });
  }

  /**
   * Simulates a call and returns its decoded return value, without ever
   * signing or submitting anything. Used for read views (getBalance,
   * getNonce) and as the first step of every write, so a doomed call
   * (wrong PIN, stale nonce) is caught for free before spending a real
   * submission and a real sequence number on it.
   */
  private async simulate(method: string, args: ReturnType<typeof nativeToScVal>[]): Promise<unknown> {
    const account = await this.server.getAccount(this.relayerAddress);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) {
      const code = parseContractErrorCode(sim.error);
      if (code !== undefined) throw new ContractError(code);
      throw new ContractCallFailedError(`simulation failed for ${method}: ${sim.error}`);
    }
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new ContractCallFailedError(`simulation for ${method} needs a state restore before it can run`);
    }
    // result is typed optional because some simulated transactions carry
    // no invocation (e.g. a plain payment); every call this client makes
    // is exactly one contract invocation, so its absence here would mean
    // the SDK or the RPC node returned something unexpected.
    if (!sim.result) {
      throw new ContractCallFailedError(`simulation for ${method} succeeded but returned no result`);
    }
    return scValToNative(sim.result.retval);
  }

  /**
   * Runs a write: simulate (to fail fast and for free on a contract
   * error), then assemble, sign, submit and poll to a final status.
   * Serialized through writeMutex — see the class comment on Mutex.
   */
  private async submitWrite(method: string, args: ReturnType<typeof nativeToScVal>[]): Promise<string> {
    return this.writeMutex.run(async () => {
      const account = await this.server.getAccount(this.relayerAddress);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call(method, ...args))
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        const code = parseContractErrorCode(sim.error);
        if (code !== undefined) throw new ContractError(code);
        throw new ContractCallFailedError(`simulation failed for ${method}: ${sim.error}`);
      }

      const assembled = rpc.assembleTransaction(tx, sim).build();
      assembled.sign(this.relayer);

      const sendResult = await this.server.sendTransaction(assembled);
      if (sendResult.status === "ERROR") {
        throw new ContractCallFailedError(
          `submitting ${method} was rejected before entering the ledger`,
          sendResult.errorResult,
        );
      }

      const final = await this.server.pollTransaction(sendResult.hash, { attempts: 15 });
      if (final.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        throw new ContractCallFailedError(
          `${method} (tx ${sendResult.hash}) had not confirmed after the polling window; check its status before retrying, since it may still land`,
        );
      }
      if (final.status === rpc.Api.GetTransactionStatus.FAILED) {
        // Simulation already ruled out every contract-level Err this call
        // could raise. A failure here happened after that check passed —
        // most likely another transaction from this same account landed
        // in between (a sequence-number race) or a resource limit was
        // hit. Not enough is known to name a specific cause honestly, so
        // this surfaces as a retryable failure rather than a guess.
        throw new ContractCallFailedError(
          `${method} (tx ${sendResult.hash}) failed after simulation succeeded`,
        );
      }
      return sendResult.hash;
    });
  }

  async register(phoneHash: Buffer, pinHash: Buffer): Promise<string> {
    return this.submitWrite("register", [this.adminArg(), bytes32(phoneHash), bytes32(pinHash)]);
  }

  async fund(phoneHash: Buffer, amount: bigint): Promise<string> {
    return this.submitWrite("fund", [
      this.adminArg(),
      bytes32(phoneHash),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }

  async send(
    fromHash: Buffer,
    toHash: Buffer,
    amount: bigint,
    pinHash: Buffer,
    nonce: number,
  ): Promise<string> {
    return this.submitWrite("send", [
      bytes32(fromHash),
      bytes32(toHash),
      nativeToScVal(amount, { type: "i128" }),
      bytes32(pinHash),
      nativeToScVal(nonce, { type: "u32" }),
    ]);
  }

  async changePin(phoneHash: Buffer, oldPinHash: Buffer, newPinHash: Buffer): Promise<string> {
    return this.submitWrite("change_pin", [bytes32(phoneHash), bytes32(oldPinHash), bytes32(newPinHash)]);
  }

  async cashOut(phoneHash: Buffer, amount: bigint, pinHash: Buffer, nonce: number): Promise<string> {
    return this.submitWrite("cash_out", [
      this.adminArg(),
      bytes32(phoneHash),
      nativeToScVal(amount, { type: "i128" }),
      bytes32(pinHash),
      nativeToScVal(nonce, { type: "u32" }),
    ]);
  }

  async getBalance(phoneHash: Buffer): Promise<bigint> {
    const result = await this.simulate("get_balance", [bytes32(phoneHash)]);
    return result as bigint;
  }

  async getNonce(phoneHash: Buffer): Promise<number> {
    const result = await this.simulate("get_nonce", [bytes32(phoneHash)]);
    return result as number;
  }
}
