# Contributing to kobodial-gateway

This service stands between a feature phone and someone's money, on
behalf of a user who cannot read the code, cannot inspect a
transaction, and gets about 140 characters to understand whatever
happened. That shapes what a change needs here.

## Getting set up

```sh
nvm use                 # Node 22, per .nvmrc
npm install
cp .env.example .env    # fill in CONTRACT_ID and RELAYER_SECRET_KEY
npm run db:migrate
npm run dev
```

`npm test` needs none of that — every test mocks the contract and
builds its own in-memory database, so the suite runs on a fresh clone
with no keys, no network and no database.

## Before you push

```sh
npm run lint      # eslint + prettier --check
npm test
npm run build     # also type-checks
```

CI runs exactly these. `npm run format` fixes formatting in place.

## The rules that aren't negotiable

**A raw PIN never outlives the expression that receives it.**
`hashPin()` in `src/crypto/hash.ts` is the only function that ever
sees one. Hash at the point of receipt; pass the digest onward. Never
assign a raw PIN to anything that persists — not a session field, not
a database column, not a log line. `ChangePin` and `Register` compare
two PINs across separate USSD requests by comparing their *digests*,
and any new flow that needs the same must do it the same way.

**Never log a request body.** Africa's Talking's `text` field
accumulates every keystroke of a session, `*`-joined — by the time a
caller reaches a PIN prompt, its last segment *is* their PIN. There is
deliberately no helper in `src/logger.ts` for logging a body, and
adding one would defeat the rule above no matter how careful every
other layer is.

**No raw phone numbers in the database.** The schema stores SHA-256
hex digests. The dashboard API is safe to expose read-only precisely
because of what was never written, not because of filtering applied on
the way out — keep it that way.

**The contract decides authorization, not this service.** The gateway
never judges whether a PIN is correct on its own authority; it asks
the contract and reports the answer. That is why checking a balance
costs a real transaction (see the comment in
`src/ussd/menu.ts`'s balance step). If you find yourself caching a PIN
hash locally to make something faster, stop — that trade is discussed
in `SECURITY.md` and was declined deliberately.

**Typed errors, short messages.** A contract error maps to a specific
sentence a user can act on, in `src/ussd/messages.ts`, under ~140
characters. `contractErrorMessage` has no default case on purpose: a
new error variant on the contract side should be a compile error here
until someone decides what it should say.

## Testing a change

Tests live in `tests/`, use vitest, and drive the real state machine
against `MockKoboDialClient`, which enforces the same rules the real
contract does. A change to a USSD flow needs a test that walks the
flow the way Africa's Talking actually delivers it — accumulated text
growing by exactly one `*`-joined segment per request — and needs to
cover the failure path, not just the success one. Most bugs in a
service like this live in "what happens when the user gets it wrong."

If your change touches the contract client, say in the PR whether you
verified it against live testnet and how; the committed suite is
deliberately offline and cannot check that for you.

## Scope

SMS receipts, multi-language menus and agent commission tracking are
deliberately out of scope for the MVP and tracked as issues. A PR that
adds one of those will likely be asked to wait, not because the idea
is wrong but because the MVP's boundary is intentional.

## Commits

Explain why in the message, not what — the diff covers what.
