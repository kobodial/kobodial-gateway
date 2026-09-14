# Security policy

This service holds a relayer key, submits transactions on behalf of
people who cannot inspect what it does, and sits on the path between a
USSD session and someone's money. The honest posture is below.

## Reporting

Report anything that lets a caller move funds they shouldn't, lets an
authorization be replayed, or exposes a PIN or phone number,
**privately** — use GitHub's "Report a vulnerability" on this
repository rather than opening a public issue. Include the request,
the session state, and what you observed.

## What protects a user's money

Not this service. The contract does.

`send` and `cash_out` are authorized on-chain by the user's PIN hash
and the wallet's exact current nonce, checked inside
[kobodial-contracts](https://github.com/kobodial/kobodial-contract).
A compromised gateway can refuse to relay, relay the wrong thing and
have it rejected, or stop working — it cannot move a user's balance
without a PIN that the contract itself verifies. That separation is
the whole design, and it is what the rest of this document is
measured against.

## What the relayer key can do

`RELAYER_SECRET_KEY` is the gateway's own Soroban account and the
contract's `admin`. Whoever holds it can:

- **`register` a phone hash** with a PIN hash of their choosing —
  meaning they can enrol numbers, and can enrol a number that a real
  person has not consented to enrolling.
- **`fund` any wallet**, crediting a balance with no on-chain backing.
  In this MVP `fund` mints tracked balance rather than moving a real
  token, so a compromised relayer key can inflate balances at will.
- **submit `cash_out`**, though still only with the user's correct PIN
  and nonce.
- **pay the network fees** for every relayed action, and exhaust that
  account's XLM.

It cannot spend a user's balance without their PIN. Treat it as a
production secret regardless: it is the difference between the service
running and someone else running it as you.

## Known limitations, stated rather than implied

- **PIN entropy is 4 digits — 10,000 possibilities.** Neither this
  gateway nor the contract rate-limits PIN attempts. A determined
  caller (or the relayer itself) can brute-force a PIN. Rate limiting
  belongs in front of the USSD callback and is not implemented here.
- **The contract's stored `pin_hash` is on public ledger state.**
  Soroban persistent storage is readable by anyone who can construct
  the storage key, whether or not the contract exposes a read function
  for it. Combined with 4-digit entropy, a PIN hash should be assumed
  recoverable offline by anyone motivated. This is a property of the
  underlying contract design, not something this gateway introduces —
  but it's the reason this service stores no PIN hash of its own.
- **One relayer account, one process.** Writes are serialized through
  an in-process mutex so a single instance can't race itself on
  Stellar sequence numbers. Running **more than one instance against
  the same `RELAYER_SECRET_KEY` is not safe** without an external
  sequence-number coordinator, which this MVP does not implement.
- **The dashboard API is unauthenticated.** `/wallets`,
  `/transactions` and `/health` have no access control. They expose
  only hashed identifiers and amounts, never a raw phone number or
  PIN — but they should still sit behind a private network or a proxy
  that adds auth, not on a public interface.
- **The USSD callback is unauthenticated.** Africa's Talking does not
  sign its callbacks. Anyone who can reach `/ussd` can submit a
  payload claiming any `phoneNumber`, and the gateway will act on it —
  meaning they can attempt PINs against any number they choose. The
  contract's PIN check is what stops that from becoming theft;
  restricting the callback to Africa's Talking's source addresses is
  an operator's responsibility and a genuine gap in this MVP.
- **A low-severity advisory in a transitive dependency.** The
  `africastalking` SDK depends on a `joi` version with two published
  prototype-pollution advisories. The vulnerable API paths
  (`object().rename()` with a template target; `__proto__` in custom
  messages) are not reached by anything this service passes to that
  SDK, and the only fix available is a breaking downgrade of the SDK
  itself. Tracked rather than silently ignored.

## What is deliberately not here

SMS receipts, multi-language menus and agent commission tracking are
out of MVP scope and tracked as issues, not partially implemented.
