/**
 * Every state a USSD session can be in. The welcome menu is step zero for
 * a session Africa's Talking has never sent an empty `text` for yet; every
 * other step means "the caller has answered one prompt in this flow and
 * the gateway is waiting for the next answer."
 */
export enum UssdStep {
  Welcome = "welcome",
  SendEnterRecipient = "send_enter_recipient",
  SendEnterAmount = "send_enter_amount",
  SendEnterPin = "send_enter_pin",
  BalanceEnterPin = "balance_enter_pin",
  ChangePinEnterOld = "change_pin_enter_old",
  ChangePinEnterNew = "change_pin_enter_new",
  ChangePinConfirmNew = "change_pin_confirm_new",
  RegisterEnterPin = "register_enter_pin",
  RegisterConfirmPin = "register_confirm_pin",
}

/**
 * Whatever a flow has collected so far, across the stateless requests
 * that make up one USSD session. Only what's necessary to finish the
 * flow ever lives here, and PINs are never here as raw digits — see
 * the comments on each field. This is persisted as the `data` column's
 * JSON text in ussd_sessions.
 */
export interface UssdSessionData {
  /** SendMoney: the recipient's phone number, as entered — not yet a hash, since it's shown back to the caller for confirmation. */
  recipientPhoneNumber?: string;
  /** SendMoney: the amount, as entered, kept as a decimal string (never a float) until it's parsed into a bigint at the final step. */
  amount?: string;
  /**
   * ChangePin: the SHA-256 hex digest of the old PIN, computed the instant
   * it was received. Never the raw PIN — see src/crypto/hash.ts.
   */
  oldPinHash?: string;
  /** ChangePin: hex digest of the new PIN, held only until the confirmation step compares it against a second hash. */
  newPinHash?: string;
  /** Register: hex digest of the chosen PIN, held only until confirmation. */
  pinHash?: string;
}

/** A session row's whole state: which step, and what's been collected. */
export interface UssdSessionState {
  step: UssdStep;
  data: UssdSessionData;
}

/** What every step handler returns: the caller's own phone hash is threaded in separately. */
export interface UssdResult {
  /** The next state to persist, or undefined to end and delete the session row. */
  next?: UssdSessionState;
  /** The text shown on the phone. Kept under ~140 characters throughout — see src/ussd/messages.ts. */
  message: string;
}
