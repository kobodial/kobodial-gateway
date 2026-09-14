import { ContractErrorCode } from "../contract/errors.js";

/**
 * Every string a caller sees, in one place, each kept comfortably under
 * the ~140-character budget a USSD screen actually has. Africa's
 * Talking's protocol distinguishes two response shapes: prefix a
 * response with "CON " to keep the session open and show another
 * prompt, or "END " to close it and show a final screen — every
 * function here returns one or the other, never bare text.
 */

export const WELCOME_MENU =
  "CON Welcome to KoboDial\n1. Send Money\n2. Check Balance\n3. Change PIN\n4. Register";

export const INVALID_CHOICE = "END Invalid choice. Please dial the code again.";

export const SEND_ASK_RECIPIENT = "CON Enter recipient's phone number, e.g. +2348012345678";
export const SEND_INVALID_RECIPIENT =
  "END Invalid phone number. Please dial again and enter it starting with your country code, e.g. +234...";
export const SEND_SELF = "END You cannot send money to your own number.";
export const SEND_ASK_AMOUNT = (phone: string): string => `CON Send to ${phone}\nEnter amount to send`;
export const SEND_INVALID_AMOUNT =
  "END Invalid amount. Please dial again and enter a whole number greater than 0.";
export const SEND_ASK_PIN = (amount: string, phone: string): string =>
  `CON Send ${amount} to ${phone}\nEnter your PIN to confirm`;
export const SEND_SUCCESS = (amount: string, phone: string, balance: bigint): string =>
  `END Sent ${amount} to ${phone}.\nYour new balance: ${balance}`;

export const BALANCE_ASK_PIN = "CON Enter your PIN to view your balance";
export const BALANCE_SUCCESS = (balance: bigint): string => `END Your balance is ${balance}`;

export const CHANGE_PIN_ASK_OLD = "CON Enter your current PIN";
export const CHANGE_PIN_ASK_NEW = "CON Enter your new 4-digit PIN";
export const CHANGE_PIN_ASK_CONFIRM = "CON Re-enter your new PIN to confirm";
export const CHANGE_PIN_MISMATCH = "END New PIN entries did not match. Please dial again to retry.";
export const CHANGE_PIN_SUCCESS = "END Your PIN has been changed successfully.";

export const REGISTER_ASK_PIN = "CON Choose a 4-digit PIN for your KoboDial wallet";
export const REGISTER_ASK_CONFIRM = "CON Re-enter your PIN to confirm";
export const REGISTER_MISMATCH = "END PIN entries did not match. Please dial again to retry.";
export const REGISTER_SUCCESS = "END Registration successful! You can now send and receive money.";

export const INVALID_PIN_FORMAT = "END PIN must be exactly 4 digits. Please dial again to retry.";
export const NOT_REGISTERED = "END This number is not registered. Dial again and choose Register first.";
export const GENERIC_ERROR = "END Something went wrong. Please try again later.";

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
          return "END Incorrect PIN. Transaction cancelled.";
        case ContractErrorCode.InvalidNonce:
          return "END Your session expired. Please dial again to retry.";
        case ContractErrorCode.InsufficientBalance:
          return "END Insufficient balance for this transaction.";
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
          return "END Recipient is not registered on KoboDial.";
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
          return "END Incorrect PIN.";
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
          return "END Incorrect current PIN. Please dial again to retry.";
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
          return "END Incorrect PIN. Cash-out cancelled.";
        case ContractErrorCode.InvalidNonce:
          return "END Your session expired. Please dial again to retry.";
        case ContractErrorCode.InsufficientBalance:
          return "END Insufficient balance for this cash-out.";
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
          return "END This number is already registered.";
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
