import { ContractErrorCode } from "../contract/errors.js";

/**
 * Every string a caller sees, in one place, each kept comfortably under
 * the ~140-character budget a USSD screen actually has.
 *
 * These are bare message bodies, deliberately with no "CON "/"END "
 * prefix baked in — Africa's Talking's protocol distinguishes "show
 * this and keep the session open" from "show this and end the
 * session," but the SDK's Express middleware (src/routes/ussd.ts) adds
 * that prefix itself from a separate endSession flag, so embedding it
 * in the text here would be a second, competing way to say the same
 * thing. UssdMenuHandler derives that flag structurally, from whether
 * a step produced a next session state — see src/ussd/menu.ts.
 */

export const WELCOME_MENU =
  "Welcome to KoboDial\n1. Send Money\n2. Check Balance\n3. Change PIN\n4. Register";

export const INVALID_CHOICE = "Invalid choice. Please dial the code again.";

export const SEND_ASK_RECIPIENT = "Enter recipient's phone number, e.g. +2348012345678";
export const SEND_INVALID_RECIPIENT =
  "Invalid phone number. Please dial again and enter it starting with your country code, e.g. +234...";
export const SEND_SELF = "You cannot send money to your own number.";
export const SEND_ASK_AMOUNT = (phone: string): string => `Send to ${phone}\nEnter amount to send`;
export const SEND_INVALID_AMOUNT =
  "Invalid amount. Please dial again and enter a whole number greater than 0.";
export const SEND_AMOUNT_TOO_LARGE =
  "That amount is too large. Please dial again and enter a smaller amount.";
export const SEND_ASK_PIN = (amount: string, phone: string): string =>
  `Send ${amount} to ${phone}\nEnter your PIN to confirm`;
export const SEND_SUCCESS = (amount: string, phone: string, balance: bigint): string =>
  `Sent ${amount} to ${phone}.\nYour new balance: ${balance}`;

export const BALANCE_ASK_PIN = "Enter your PIN to view your balance";
export const BALANCE_SUCCESS = (balance: bigint): string => `Your balance is ${balance}`;

export const CHANGE_PIN_ASK_OLD = "Enter your current PIN";
export const CHANGE_PIN_ASK_NEW = "Enter your new 4-digit PIN";
export const CHANGE_PIN_ASK_CONFIRM = "Re-enter your new PIN to confirm";
export const CHANGE_PIN_MISMATCH = "New PIN entries did not match. Please dial again to retry.";
export const CHANGE_PIN_SUCCESS = "Your PIN has been changed successfully.";

export const REGISTER_ASK_PIN = "Choose a 4-digit PIN for your KoboDial wallet";
export const REGISTER_ASK_CONFIRM = "Re-enter your PIN to confirm";
export const REGISTER_MISMATCH = "PIN entries did not match. Please dial again to retry.";
export const REGISTER_SUCCESS = "Registration successful! You can now send and receive money.";

export const INVALID_PIN_FORMAT = "PIN must be exactly 4 digits. Please dial again to retry.";
export const NOT_REGISTERED = "This number is not registered. Dial again and choose Register first.";
export const GENERIC_ERROR = "Something went wrong. Please try again later.";

/**
 * The same contract error means a different sentence depending on which
 * flow raised it — InvalidPin on a balance check reads differently to a
 * user than InvalidPin while sending. Every context handles every code
 * explicitly (no default fallthrough) so a new error variant on the
 * contract side is a compile error here until someone decides what it
 * should say, rather than silently rendering the generic message.
 */
export function contractErrorMessage(
  code: ContractErrorCode,
  context: "send_sender" | "send_recipient" | "balance" | "change_pin_old" | "cash_out" | "register",
): string {
  switch (context) {
    case "send_sender":
      switch (code) {
        case ContractErrorCode.InvalidPin:
          return "Incorrect PIN. Transaction cancelled.";
        case ContractErrorCode.InvalidNonce:
          return "Your session expired. Please dial again to retry.";
        case ContractErrorCode.InsufficientBalance:
          return "Insufficient balance for this transaction.";
        case ContractErrorCode.WalletNotFound:
          return NOT_REGISTERED;
        case ContractErrorCode.Unauthorized:
        case ContractErrorCode.AlreadyRegistered:
          return GENERIC_ERROR;
      }
      break;
    case "send_recipient":
      switch (code) {
        case ContractErrorCode.WalletNotFound:
          return "Recipient is not registered on KoboDial.";
        case ContractErrorCode.InvalidPin:
        case ContractErrorCode.InvalidNonce:
        case ContractErrorCode.InsufficientBalance:
        case ContractErrorCode.Unauthorized:
        case ContractErrorCode.AlreadyRegistered:
          return GENERIC_ERROR;
      }
      break;
    case "balance":
      switch (code) {
        case ContractErrorCode.InvalidPin:
          return "Incorrect PIN.";
        case ContractErrorCode.WalletNotFound:
          return NOT_REGISTERED;
        case ContractErrorCode.InvalidNonce:
        case ContractErrorCode.InsufficientBalance:
        case ContractErrorCode.Unauthorized:
        case ContractErrorCode.AlreadyRegistered:
          return GENERIC_ERROR;
      }
      break;
    case "change_pin_old":
      switch (code) {
        case ContractErrorCode.InvalidPin:
          return "Incorrect current PIN. Please dial again to retry.";
        case ContractErrorCode.WalletNotFound:
          return NOT_REGISTERED;
        case ContractErrorCode.InvalidNonce:
        case ContractErrorCode.InsufficientBalance:
        case ContractErrorCode.Unauthorized:
        case ContractErrorCode.AlreadyRegistered:
          return GENERIC_ERROR;
      }
      break;
    case "cash_out":
      switch (code) {
        case ContractErrorCode.InvalidPin:
          return "Incorrect PIN. Cash-out cancelled.";
        case ContractErrorCode.InvalidNonce:
          return "Your session expired. Please dial again to retry.";
        case ContractErrorCode.InsufficientBalance:
          return "Insufficient balance for this cash-out.";
        case ContractErrorCode.WalletNotFound:
          return NOT_REGISTERED;
        case ContractErrorCode.Unauthorized:
        case ContractErrorCode.AlreadyRegistered:
          return GENERIC_ERROR;
      }
      break;
    case "register":
      switch (code) {
        case ContractErrorCode.AlreadyRegistered:
          return "This number is already registered.";
        case ContractErrorCode.WalletNotFound:
        case ContractErrorCode.InvalidPin:
        case ContractErrorCode.InvalidNonce:
        case ContractErrorCode.InsufficientBalance:
        case ContractErrorCode.Unauthorized:
          return GENERIC_ERROR;
      }
      break;
  }
  return GENERIC_ERROR;
}
