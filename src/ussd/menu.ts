import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import { wallets, transactions } from "../db/schema.js";
import type { KoboDialClient } from "../contract/client.js";
import { ContractError, ContractErrorCode } from "../contract/errors.js";
import {
  assertValidPhoneNumber,
  hashPhoneNumber,
  hashPin,
  toHex,
  fromHex,
  InvalidPhoneNumberError,
  InvalidPinError,
} from "../crypto/hash.js";
import { UssdSessionStore } from "./sessionStore.js";
import { UssdStep, type UssdSessionState } from "./types.js";
import * as msg from "./messages.js";

export interface UssdRequest {
  sessionId: string;
  /** The caller's own number, as Africa's Talking reports it — E.164. */
  phoneNumber: string;
  /** The full '*'-joined accumulation of every input this session has made so far. */
  text: string;
}

/**
 * What the route layer hands to Africa's Talking's SDK middleware, which
 * adds the "CON "/"END " prefix itself from endSession — see the file
 * comment in src/ussd/messages.ts for why that split exists.
 */
export interface UssdResponse {
  text: string;
  endSession: boolean;
}

/** The newest single input in a USSD session's accumulated text. Empty string means "just dialled in." */
function latestInput(text: string): string {
  const parts = text.split("*");
  return parts[parts.length - 1] ?? "";
}

/** A whole-integer amount: no decimals, no leading zero, at least 1. */
const AMOUNT_PATTERN = /^[1-9]\d*$/;

/**
 * The contract's balances are i128, and the Soroban SDK throws when
 * handed a bigger value. Without this bound an absurd amount typed into
 * a handset would surface as the generic "something went wrong" and be
 * logged as if it were a bug, rather than as the input mistake it is.
 */
const I128_MAX = 170141183460469231731687303715884105727n;

type TxKind = "register" | "fund" | "send" | "cash_out" | "change_pin";

/**
 * Drives one USSD session's state machine. Depends on KoboDialClient
 * (the interface, not the concrete Soroban class) and on Db directly for
 * session persistence and the transaction/wallet logs, so a test can
 * substitute a mock contract client while still exercising a real
 * in-memory database end to end.
 */
export class UssdMenuHandler {
  private readonly sessions: UssdSessionStore;

  constructor(
    private readonly db: Db,
    private readonly contract: KoboDialClient,
    private readonly logger?: Logger,
  ) {
    this.sessions = new UssdSessionStore(db);
  }

  async handle(req: UssdRequest): Promise<UssdResponse> {
    // Computed once, before anything else, for two reasons: every
    // session operation below is scoped to it (a sessionId alone is an
    // unauthenticated claim — see UssdSessionStore), and a phone number
    // malformed enough to fail here should fail before any step handler
    // runs rather than partway through one.
    let callerHash: string;
    try {
      callerHash = toHex(hashPhoneNumber(req.phoneNumber));
    } catch (err) {
      this.logger?.error("ussd request carried an unusable phone number", {
        sessionId: req.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { text: msg.GENERIC_ERROR, endSession: true };
    }

    try {
      const session = await this.sessions.load(req.sessionId, callerHash);
      const input = latestInput(req.text);
      const result = await this.dispatch(session, input, req);

      if (result.next) {
        await this.sessions.save(req.sessionId, callerHash, result.next);
      } else {
        await this.sessions.clear(req.sessionId, callerHash);
      }
      // A step produced a next state exactly when the flow should keep
      // going — that presence/absence is the same fact Africa's Talking
      // calls endSession, derived here rather than duplicated as a
      // second flag every step handler would otherwise have to set
      // consistently by hand.
      return { text: result.message, endSession: !result.next };
    } catch (err) {
      // Anything not already turned into a specific USSD message by a
      // step handler above is a bug or an infrastructure failure, not
      // something the caller did wrong. They see the generic message;
      // the real cause is logged here, server-side, since this is the
      // one place it's still available to log — once we return, it's
      // gone.
      this.logger?.error("ussd session handler threw unexpectedly", {
        sessionId: req.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.sessions.clear(req.sessionId, callerHash).catch(() => undefined);
      return { text: msg.GENERIC_ERROR, endSession: true };
    }
  }

  private async dispatch(
    session: UssdSessionState,
    input: string,
    req: UssdRequest,
  ): Promise<{ next?: UssdSessionState; message: string }> {
    switch (session.step) {
      case UssdStep.Welcome:
        return this.stepWelcome(input);
      case UssdStep.SendEnterRecipient:
        return this.stepSendEnterRecipient(input, req.phoneNumber);
      case UssdStep.SendEnterAmount:
        return this.stepSendEnterAmount(input, session);
      case UssdStep.SendEnterPin:
        return this.stepSendEnterPin(input, session, req.phoneNumber);
      case UssdStep.BalanceEnterPin:
        return this.stepBalanceEnterPin(input, req.phoneNumber);
      case UssdStep.ChangePinEnterOld:
        return this.stepChangePinEnterOld(input);
      case UssdStep.ChangePinEnterNew:
        return this.stepChangePinEnterNew(input, session);
      case UssdStep.ChangePinConfirmNew:
        return this.stepChangePinConfirmNew(input, session, req.phoneNumber);
      case UssdStep.RegisterEnterPin:
        return this.stepRegisterEnterPin(input);
      case UssdStep.RegisterConfirmPin:
        return this.stepRegisterConfirmPin(input, session, req.phoneNumber);
    }
  }

  private stepWelcome(input: string): { next?: UssdSessionState; message: string } {
    if (input === "") {
      return { next: { step: UssdStep.Welcome, data: {} }, message: msg.WELCOME_MENU };
    }
    switch (input) {
      case "1":
        return { next: { step: UssdStep.SendEnterRecipient, data: {} }, message: msg.SEND_ASK_RECIPIENT };
      case "2":
        return { next: { step: UssdStep.BalanceEnterPin, data: {} }, message: msg.BALANCE_ASK_PIN };
      case "3":
        return { next: { step: UssdStep.ChangePinEnterOld, data: {} }, message: msg.CHANGE_PIN_ASK_OLD };
      case "4":
        return { next: { step: UssdStep.RegisterEnterPin, data: {} }, message: msg.REGISTER_ASK_PIN };
      default:
        return { message: msg.INVALID_CHOICE };
    }
  }

  private stepSendEnterRecipient(
    input: string,
    callerPhoneNumber: string,
  ): { next?: UssdSessionState; message: string } {
    let recipient: string;
    try {
      // Validated (and trimmed) here for display; hashed later, at the
      // point send() actually needs it — this step never touches the
      // recipient's hash at all.
      recipient = assertValidPhoneNumber(input);
    } catch (e) {
      if (e instanceof InvalidPhoneNumberError) return { message: msg.SEND_INVALID_RECIPIENT };
      throw e;
    }
    if (recipient === callerPhoneNumber.trim()) {
      return { message: msg.SEND_SELF };
    }
    return {
      next: { step: UssdStep.SendEnterAmount, data: { recipientPhoneNumber: recipient } },
      message: msg.SEND_ASK_AMOUNT(recipient),
    };
  }

  private stepSendEnterAmount(
    input: string,
    session: UssdSessionState,
  ): { next?: UssdSessionState; message: string } {
    if (!AMOUNT_PATTERN.test(input)) {
      return { message: msg.SEND_INVALID_AMOUNT };
    }
    if (BigInt(input) > I128_MAX) {
      return { message: msg.SEND_AMOUNT_TOO_LARGE };
    }
    const recipient = session.data.recipientPhoneNumber!;
    return {
      next: { step: UssdStep.SendEnterPin, data: { recipientPhoneNumber: recipient, amount: input } },
      message: msg.SEND_ASK_PIN(input, recipient),
    };
  }

  private async stepSendEnterPin(
    input: string,
    session: UssdSessionState,
    callerPhoneNumber: string,
  ): Promise<{ next?: UssdSessionState; message: string }> {
    let pinHash: Buffer;
    try {
      pinHash = hashPin(input);
    } catch (e) {
      if (e instanceof InvalidPinError) return { message: msg.INVALID_PIN_FORMAT };
      throw e;
    }

    const recipientPhoneNumber = session.data.recipientPhoneNumber!;
    const amountStr = session.data.amount!;
    const amount = BigInt(amountStr);
    const senderHash = hashPhoneNumber(callerPhoneNumber);
    const recipientHash = hashPhoneNumber(recipientPhoneNumber);

    let nonce: number;
    try {
      nonce = await this.contract.getNonce(senderHash);
    } catch (e) {
      if (e instanceof ContractError) {
        await this.logTransaction({
          kind: "send",
          fromPhoneHash: toHex(senderHash),
          amount: amountStr,
          status: "failed",
          errorCode: ContractErrorCode[e.code],
        });
        return { message: msg.contractErrorMessage(e.code, "send_sender") };
      }
      throw e;
    }

    try {
      const txHash = await this.contract.send(senderHash, recipientHash, amount, pinHash, nonce);
      await this.logTransaction({
        kind: "send",
        fromPhoneHash: toHex(senderHash),
        toPhoneHash: toHex(recipientHash),
        amount: amountStr,
        status: "success",
        txHash,
      });
      try {
        const balance = await this.contract.getBalance(senderHash);
        return { message: msg.SEND_SUCCESS(amountStr, recipientPhoneNumber, balance) };
      } catch {
        // The send already succeeded and is logged; failing to fetch the
        // balance afterward is not a transaction failure, so this still
        // reports success rather than telling the user something went
        // wrong when their money did in fact move.
        return { message: `Sent ${amountStr} to ${recipientPhoneNumber}.` };
      }
    } catch (e) {
      if (e instanceof ContractError) {
        // getNonce above already confirmed the sender is registered, so
        // a WalletNotFound from send() itself can only be about the
        // recipient.
        const context = e.code === ContractErrorCode.WalletNotFound ? "send_recipient" : "send_sender";
        await this.logTransaction({
          kind: "send",
          fromPhoneHash: toHex(senderHash),
          toPhoneHash: toHex(recipientHash),
          amount: amountStr,
          status: "failed",
          errorCode: ContractErrorCode[e.code],
        });
        return { message: msg.contractErrorMessage(e.code, context) };
      }
      throw e;
    }
  }

  private async stepBalanceEnterPin(
    input: string,
    callerPhoneNumber: string,
  ): Promise<{ next?: UssdSessionState; message: string }> {
    let pinHash: Buffer;
    try {
      pinHash = hashPin(input);
    } catch (e) {
      if (e instanceof InvalidPinError) return { message: msg.INVALID_PIN_FORMAT };
      throw e;
    }

    const callerHash = hashPhoneNumber(callerPhoneNumber);
    // get_balance takes no PIN and the contract exposes no read-only PIN
    // check, so the gateway verifies the PIN the only way that keeps the
    // contract as the sole authority: submitting change_pin with the same
    // hash as both old and new. A correct PIN passes the contract's own
    // `old_pin_hash` check and re-sets the PIN to the identical value —
    // no functional change, but a real submitted transaction, which is
    // the trade-off: a balance check costs a network fee and a submit,
    // not just a free simulate, because nothing here trusts a PIN
    // comparison the gateway made on its own. Deliberately not logged to
    // the transactions table — see the note in menu.ts's file comment
    // and README's design notes.
    try {
      await this.contract.changePin(callerHash, pinHash, pinHash);
    } catch (e) {
      if (e instanceof ContractError) {
        return { message: msg.contractErrorMessage(e.code, "balance") };
      }
      throw e;
    }

    const balance = await this.contract.getBalance(callerHash);
    return { message: msg.BALANCE_SUCCESS(balance) };
  }

  private stepChangePinEnterOld(input: string): { next?: UssdSessionState; message: string } {
    let oldPinHash: Buffer;
    try {
      oldPinHash = hashPin(input);
    } catch (e) {
      if (e instanceof InvalidPinError) return { message: msg.INVALID_PIN_FORMAT };
      throw e;
    }
    return {
      next: { step: UssdStep.ChangePinEnterNew, data: { oldPinHash: toHex(oldPinHash) } },
      message: msg.CHANGE_PIN_ASK_NEW,
    };
  }

  private stepChangePinEnterNew(
    input: string,
    session: UssdSessionState,
  ): { next?: UssdSessionState; message: string } {
    let newPinHash: Buffer;
    try {
      newPinHash = hashPin(input);
    } catch (e) {
      if (e instanceof InvalidPinError) return { message: msg.INVALID_PIN_FORMAT };
      throw e;
    }
    return {
      next: {
        step: UssdStep.ChangePinConfirmNew,
        data: { oldPinHash: session.data.oldPinHash!, newPinHash: toHex(newPinHash) },
      },
      message: msg.CHANGE_PIN_ASK_CONFIRM,
    };
  }

  private async stepChangePinConfirmNew(
    input: string,
    session: UssdSessionState,
    callerPhoneNumber: string,
  ): Promise<{ next?: UssdSessionState; message: string }> {
    let confirmHash: Buffer;
    try {
      confirmHash = hashPin(input);
    } catch (e) {
      if (e instanceof InvalidPinError) return { message: msg.INVALID_PIN_FORMAT };
      throw e;
    }
    if (toHex(confirmHash) !== session.data.newPinHash) {
      return { message: msg.CHANGE_PIN_MISMATCH };
    }

    const callerHash = hashPhoneNumber(callerPhoneNumber);
    const oldPinHash = fromHex(session.data.oldPinHash!);
    const newPinHash = fromHex(session.data.newPinHash!);

    try {
      const txHash = await this.contract.changePin(callerHash, oldPinHash, newPinHash);
      await this.logTransaction({
        kind: "change_pin",
        fromPhoneHash: toHex(callerHash),
        status: "success",
        txHash,
      });
      return { message: msg.CHANGE_PIN_SUCCESS };
    } catch (e) {
      if (e instanceof ContractError) {
        await this.logTransaction({
          kind: "change_pin",
          fromPhoneHash: toHex(callerHash),
          status: "failed",
          errorCode: ContractErrorCode[e.code],
        });
        return { message: msg.contractErrorMessage(e.code, "change_pin_old") };
      }
      throw e;
    }
  }

  private stepRegisterEnterPin(input: string): { next?: UssdSessionState; message: string } {
    let pinHash: Buffer;
    try {
      pinHash = hashPin(input);
    } catch (e) {
      if (e instanceof InvalidPinError) return { message: msg.INVALID_PIN_FORMAT };
      throw e;
    }
    return {
      next: { step: UssdStep.RegisterConfirmPin, data: { pinHash: toHex(pinHash) } },
      message: msg.REGISTER_ASK_CONFIRM,
    };
  }

  private async stepRegisterConfirmPin(
    input: string,
    session: UssdSessionState,
    callerPhoneNumber: string,
  ): Promise<{ next?: UssdSessionState; message: string }> {
    let confirmHash: Buffer;
    try {
      confirmHash = hashPin(input);
    } catch (e) {
      if (e instanceof InvalidPinError) return { message: msg.INVALID_PIN_FORMAT };
      throw e;
    }
    if (toHex(confirmHash) !== session.data.pinHash) {
      return { message: msg.REGISTER_MISMATCH };
    }

    const callerHash = hashPhoneNumber(callerPhoneNumber);
    const pinHash = fromHex(session.data.pinHash!);

    try {
      const txHash = await this.contract.register(callerHash, pinHash);
      await this.db
        .insert(wallets)
        .values({ phoneHash: toHex(callerHash) })
        .onConflictDoNothing();
      await this.logTransaction({
        kind: "register",
        fromPhoneHash: toHex(callerHash),
        status: "success",
        txHash,
      });
      return { message: msg.REGISTER_SUCCESS };
    } catch (e) {
      if (e instanceof ContractError) {
        await this.logTransaction({
          kind: "register",
          fromPhoneHash: toHex(callerHash),
          status: "failed",
          errorCode: ContractErrorCode[e.code],
        });
        return { message: msg.contractErrorMessage(e.code, "register") };
      }
      throw e;
    }
  }

  private async logTransaction(entry: {
    kind: TxKind;
    fromPhoneHash?: string;
    toPhoneHash?: string;
    amount?: string;
    status: "success" | "failed";
    errorCode?: string;
    txHash?: string;
  }): Promise<void> {
    await this.db.insert(transactions).values(entry);
  }
}
