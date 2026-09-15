import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { SorobanKoboDialClient } from "../src/contract/client.js";

/**
 * Pins the argument list every write sends to the contract.
 *
 * This exists because of a real defect: `send` and `change_pin` did not
 * pass the admin, which left them authorized only by a pin_hash readable
 * from public chain state (kobodial-contract#10). The contract now
 * requires the admin on every write, and an argument list that is merely
 * in the wrong order fails nowhere locally — it fails on-chain, at the
 * point a user is waiting on a USSD prompt.
 *
 * submitWrite is stubbed, so nothing here touches the network.
 */
describe("contract call arguments", () => {
  let client: SorobanKoboDialClient;
  let relayer: Keypair;
  let calls: { method: string; args: xdr.ScVal[] }[];

  beforeEach(() => {
    relayer = Keypair.random();
    client = new SorobanKoboDialClient({
      rpcUrl: "https://example.invalid",
      contractId: "CCPXFBZNI2HR6TPCA5QIYLQRU5W4IXCEK5Y6ANTXKCRLXCXNRILIQQJU",
      networkPassphrase: "Test SDF Network ; September 2015",
      relayerSecretKey: relayer.secret(),
    });

    calls = [];
    // submitWrite is private to TypeScript only; replacing it keeps this
    // test entirely offline while still exercising the real arg builders.
    (client as unknown as Record<string, unknown>).submitWrite = async (
      method: string,
      args: xdr.ScVal[],
    ) => {
      calls.push({ method, args });
      return "stub-tx-hash";
    };
  });

  const hash = (byte: number) => Buffer.alloc(32, byte);

  /** Every admin-authorized write must name the admin as its first argument. */
  const expectsAdminFirst: [string, () => Promise<string>][] = [
    ["register", () => client.register(hash(1), hash(2))],
    ["fund", () => client.fund(hash(1), 100n)],
    ["send", () => client.send(hash(1), hash(2), 100n, hash(3), 0)],
    ["change_pin", () => client.changePin(hash(1), hash(2), hash(3))],
    ["cash_out", () => client.cashOut(hash(1), 100n, hash(2), 0)],
  ];

  for (const [method, invoke] of expectsAdminFirst) {
    it(`${method} passes the admin address as its first argument`, async () => {
      await invoke();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(method);
      expect(scValToNative(calls[0]!.args[0]!)).toBe(relayer.publicKey());
    });
  }

  it("send passes from, to, amount, pin and nonce after the admin", async () => {
    await client.send(hash(0xaa), hash(0xbb), 250n, hash(0xcc), 7);
    const args = calls[0]!.args;
    expect(args).toHaveLength(6);
    expect(Buffer.from(scValToNative(args[1]!)).toString("hex")).toBe(hash(0xaa).toString("hex"));
    expect(Buffer.from(scValToNative(args[2]!)).toString("hex")).toBe(hash(0xbb).toString("hex"));
    expect(scValToNative(args[3]!)).toBe(250n);
    expect(Buffer.from(scValToNative(args[4]!)).toString("hex")).toBe(hash(0xcc).toString("hex"));
    expect(scValToNative(args[5]!)).toBe(7);
  });

  it("change_pin passes the phone hash, then old and new PIN hashes", async () => {
    await client.changePin(hash(1), hash(2), hash(3));
    const args = calls[0]!.args;
    expect(args).toHaveLength(4);
    expect(Buffer.from(scValToNative(args[1]!)).toString("hex")).toBe(hash(1).toString("hex"));
    expect(Buffer.from(scValToNative(args[2]!)).toString("hex")).toBe(hash(2).toString("hex"));
    expect(Buffer.from(scValToNative(args[3]!)).toString("hex")).toBe(hash(3).toString("hex"));
  });

  it("amounts cross the boundary as i128, not as a lossy number", async () => {
    const huge = 170141183460469231731687303715884105727n;
    await client.fund(hash(1), huge);
    expect(scValToNative(calls[0]!.args[2]!)).toBe(huge);
  });
});
