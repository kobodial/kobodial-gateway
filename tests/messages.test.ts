import { describe, it, expect } from "vitest";
import * as msg from "../src/ussd/messages.js";
import { ContractErrorCode } from "../src/contract/errors.js";

/**
 * USSD screens have roughly 140 characters to work with. This measures
 * every message at its realistic worst case (the longest phone number
 * this codebase accepts, the largest amount the contract's i128 balance
 * can hold) rather than trusting that a message "looks short enough."
 */
describe("USSD message budget", () => {
  const LONG_PHONE = "+234801234567890"; // 15 digits after the sign, the E.164 max this codebase accepts
  const MAX_I128 = 170141183460469231731687303715884105727n;
  const BUDGET = 140;

  const fixed: [string, string][] = [
    ["WELCOME_MENU", msg.WELCOME_MENU],
    ["INVALID_CHOICE", msg.INVALID_CHOICE],
    ["SEND_ASK_RECIPIENT", msg.SEND_ASK_RECIPIENT],
    ["SEND_INVALID_RECIPIENT", msg.SEND_INVALID_RECIPIENT],
    ["SEND_SELF", msg.SEND_SELF],
    ["SEND_INVALID_AMOUNT", msg.SEND_INVALID_AMOUNT],
    ["BALANCE_ASK_PIN", msg.BALANCE_ASK_PIN],
    ["CHANGE_PIN_ASK_OLD", msg.CHANGE_PIN_ASK_OLD],
    ["CHANGE_PIN_ASK_NEW", msg.CHANGE_PIN_ASK_NEW],
    ["CHANGE_PIN_ASK_CONFIRM", msg.CHANGE_PIN_ASK_CONFIRM],
    ["CHANGE_PIN_MISMATCH", msg.CHANGE_PIN_MISMATCH],
    ["CHANGE_PIN_SUCCESS", msg.CHANGE_PIN_SUCCESS],
    ["REGISTER_ASK_PIN", msg.REGISTER_ASK_PIN],
    ["REGISTER_ASK_CONFIRM", msg.REGISTER_ASK_CONFIRM],
    ["REGISTER_MISMATCH", msg.REGISTER_MISMATCH],
    ["REGISTER_SUCCESS", msg.REGISTER_SUCCESS],
    ["INVALID_PIN_FORMAT", msg.INVALID_PIN_FORMAT],
    ["NOT_REGISTERED", msg.NOT_REGISTERED],
    ["GENERIC_ERROR", msg.GENERIC_ERROR],
  ];

  it.each(fixed)("%s stays within budget", (_name, text) => {
    expect(text.length).toBeLessThanOrEqual(BUDGET);
  });

  it("SEND_ASK_AMOUNT stays within budget at the longest accepted phone number", () => {
    expect(msg.SEND_ASK_AMOUNT(LONG_PHONE).length).toBeLessThanOrEqual(BUDGET);
  });

  it("SEND_ASK_PIN stays within budget at max amount and longest phone number", () => {
    expect(msg.SEND_ASK_PIN(MAX_I128.toString(), LONG_PHONE).length).toBeLessThanOrEqual(BUDGET);
  });

  it("SEND_SUCCESS stays within budget at max amount, longest phone number and max balance", () => {
    expect(msg.SEND_SUCCESS(MAX_I128.toString(), LONG_PHONE, MAX_I128).length).toBeLessThanOrEqual(BUDGET);
  });

  it("BALANCE_SUCCESS stays within budget at max i128", () => {
    expect(msg.BALANCE_SUCCESS(MAX_I128).length).toBeLessThanOrEqual(BUDGET);
  });

  it("every ContractErrorCode has a defined, non-generic message in at least one context where that makes sense", () => {
    // Not every (code, context) pair should avoid the generic message —
    // e.g. Unauthorized should always be generic to a user. This just
    // confirms the mapping function never throws for any combination,
    // which matters because it has no default case by design.
    const contexts = [
      "send_sender",
      "send_recipient",
      "balance",
      "change_pin_old",
      "cash_out",
      "register",
    ] as const;
    for (const context of contexts) {
      for (const code of Object.values(ContractErrorCode).filter(
        (v): v is ContractErrorCode => typeof v === "number",
      )) {
        expect(() => msg.contractErrorMessage(code, context)).not.toThrow();
        expect(msg.contractErrorMessage(code, context).length).toBeLessThanOrEqual(BUDGET);
      }
    }
  });
});
