# kobodial-gateway

The USSD gateway for **KoboDial** — a phone-number-keyed smart wallet on
Stellar/Soroban, operated entirely from a feature phone. No smartphone,
no wallet app, no private key in the user's hands.

This service is the bridge between a USSD session and the
[KoboDial contract](https://github.com/kobodial/kobodial-contract).

## Why a gateway exists at all

A wallet normally works because its owner holds a private key and signs
their own transactions. Someone on a basic phone cannot: there is no
wallet app in a USSD session, nowhere to keep a key, and no way to sign
anything. So a backend relayer submits every transaction instead.

That would usually mean "custodial" — the operator holds the money and
the user holds a promise. KoboDial splits it differently:

- **The relayer submits.** It signs and pays for every transaction.
- **The contract authorizes.** `send` and `cash_out` only execute if the
  payload carries the user's correct **PIN hash** and the wallet's
  **exact current nonce**, both checked on-chain.

So a compromised or dishonest gateway can refuse to relay, or relay
something the contract rejects. It cannot move a user's balance. What it
_can_ still do — enrol numbers, credit unbacked balance, exhaust its own
fee account — is set out plainly in [SECURITY.md](SECURITY.md), which is
worth reading before running this anywhere real.

## How a request flows

```
  Feature phone            Africa's Talking          kobodial-gateway                   Soroban
       │                         │                          │                              │
       │  dials *384*1#          │                          │                              │
       ├────────────────────────►│                          │                              │
       │                         │  POST /ussd              │                              │
       │                         │  sessionId, phoneNumber, │                              │
       │                         │  text="1*+234…*250*1234" │                              │
       │                         ├─────────────────────────►│                              │
       │                         │                          │                              │
       │                         │                   ┌──────┴───────┐                      │
       │                         │                   │ load session │  ussd_sessions       │
       │                         │                   │ by sessionId │◄──── (SQLite) ───────┤
       │                         │                   └──────┬───────┘                      │
       │                         │                          │                              │
       │                         │                   last segment = "1234"                 │
       │                         │                   step = SendEnterPin                   │
       │                         │                          │                              │
       │                         │                   hashPin("1234") ──► digest            │
       │                         │                   hashPhoneNumber() ─► digest           │
       │                         │                          │                              │
       │                         │                          │  get_nonce(from_hash)        │
       │                         │                          ├─────────────────────────────►│
       │                         │                          │◄─────────────────────────────┤
       │                         │                          │            nonce = 7         │
       │                         │                          │                              │
       │                         │                          │  simulate send(...)          │
       │                         │                          ├─────────────────────────────►│
       │                         │                          │   ✗ InvalidPin/InvalidNonce  │
       │                         │                          │     → stop here, no fee      │
       │                         │                          │   ✓ → sign, submit, poll     │
       │                         │                          │◄─────────────────────────────┤
       │                         │                          │                              │
       │                         │                   ┌──────┴───────┐                      │
       │                         │                   │ log txn,     │  transactions        │
       │                         │                   │ clear session│────► (SQLite)        │
       │                         │                   └──────┬───────┘                      │
       │                         │  "END Sent 250 to …"     │                              │
       │                         │◄─────────────────────────┤                              │
       │  screen shows result    │                          │                              │
       │◄────────────────────────┤                          │                              │
```

Two details in there matter more than they look:

**Session state lives in the database, not in memory.** USSD is a series
of independent HTTP requests correlated only by `sessionId`. Nothing
guarantees two requests in one session reach the same server instance,
so an in-process `Map` would silently lose the flow behind a load
balancer.

**Every write simulates before it submits.** A wrong PIN or a stale
nonce is caught by simulation — free, no signature, no sequence number
consumed — and turned into a specific USSD message. Only a call that
would actually succeed gets signed and submitted.

## The menu

```
Welcome to KoboDial
1. Send Money      → recipient → amount → PIN   → send()
2. Check Balance   → PIN                        → get_balance()
3. Change PIN      → old → new → confirm new    → change_pin()
4. Register        → new PIN → confirm          → register()
```

`cash_out` exists on the contract but is not on this menu: it's an
agent-side action (someone hands over physical cash), not something a
user initiates alone from their own handset.

### A note on Check Balance

`get_balance` takes no PIN, and the contract exposes no PIN-verification
view. So to check a PIN before revealing a balance — without the gateway
ever judging a PIN on its own authority — this service submits
`change_pin(phone_hash, pin, pin)`: the same hash as both old and new.
A correct PIN passes the contract's own check and re-sets the PIN to the
value it already had; a wrong one fails with `InvalidPin`.

The trade-off is real and deliberate: a balance check costs a submitted
transaction and a network fee rather than a free read. The alternative —
caching each user's PIN hash locally and comparing it here — would be
faster and is explicitly declined, because it would make this service
something that decides whether a PIN is correct. See
[SECURITY.md](SECURITY.md).

## Errors a caller actually sees

Contract errors map to short, specific sentences — a USSD screen has
about 140 characters, and "something went wrong" is useless to someone
standing at an agent's kiosk.

| Contract error               | What the caller reads                                                |
| ---------------------------- | -------------------------------------------------------------------- |
| `InvalidPin`                 | Incorrect PIN. Transaction cancelled.                                |
| `InvalidNonce`               | Your session expired. Please dial again to retry.                    |
| `InsufficientBalance`        | Insufficient balance for this transaction.                           |
| `WalletNotFound` (sender)    | This number is not registered. Dial again and choose Register first. |
| `WalletNotFound` (recipient) | Recipient is not registered on KoboDial.                             |
| `AlreadyRegistered`          | This number is already registered.                                   |

The same code reads differently depending on the flow that raised it —
`InvalidPin` while sending is not the same sentence as `InvalidPin` while
changing a PIN.

## Setup

Requires Node 22 (see `.nvmrc`) and a deployed KoboDial contract.

```sh
nvm use
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable                   | What it is                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `RPC_URL`                  | Soroban RPC endpoint (testnet default provided)                                                                |
| `CONTRACT_ID`              | Your deployed KoboDial contract (`C…`)                                                                         |
| `NETWORK_PASSPHRASE`       | Must match the network `RPC_URL` serves                                                                        |
| `RELAYER_SECRET_KEY`       | The relayer's Soroban secret (`S…`) — **must be the same account the contract was deployed with as `--admin`** |
| `DATABASE_URL`             | SQLite path, e.g. `file:./kobodial-gateway.sqlite`                                                             |
| `AFRICAS_TALKING_USERNAME` | `sandbox` for the sandbox app                                                                                  |
| `AFRICAS_TALKING_API_KEY`  | From your Africa's Talking account                                                                             |
| `PORT`                     | Defaults to 3000                                                                                               |

Then:

```sh
npm run db:migrate
npm run dev
```

Configuration is validated at startup — a missing or malformed
`CONTRACT_ID` or `RELAYER_SECRET_KEY` fails immediately with a message
naming it, rather than surfacing mid-session on someone's handset.

### Checking it locally, without Africa's Talking

The USSD callback is an ordinary form-encoded POST, so `curl` is enough:

```sh
curl -X POST http://localhost:3000/ussd \
  --data-urlencode "sessionId=test-1" \
  --data-urlencode "phoneNumber=+2348012345678" \
  --data-urlencode "text=" \
  --data-urlencode "serviceCode=*384*1#"
# → CON Welcome to KoboDial …

curl -X POST http://localhost:3000/ussd \
  --data-urlencode "sessionId=test-1" \
  --data-urlencode "phoneNumber=+2348012345678" \
  --data-urlencode "text=4" \
  --data-urlencode "serviceCode=*384*1#"
# → CON Choose a 4-digit PIN for your KoboDial wallet
```

Use `--data-urlencode`, not `-d`. In a form-encoded body a bare `+` means
a space, so `-d "phoneNumber=+234…"` arrives as `" 234…"` and fails
validation. (This is not hypothetical — it's exactly what happened the
first time this was tested by hand.)

Keep appending one `*`-joined segment per request, the way Africa's
Talking does: `text=4`, then `text=4*1234`, then `text=4*1234*1234`.

## Deploying

The service ships a production Dockerfile and a compose file:

```sh
docker compose up -d --build     # reads CONTRACT_ID, RELAYER_SECRET_KEY, etc. from .env
curl http://localhost:3000/health
```

Africa's Talking needs to reach the gateway over the public internet, so
the simulator walkthrough below needs a public HTTPS URL — a container
host, or a tunnel while developing. Full instructions, including what to
set as a secret and how to isolate a callback that isn't arriving, are
in [DEPLOYMENT.md](DEPLOYMENT.md).

## Testing against Africa's Talking's simulator

This is the live demo for this repo. The simulator calls your gateway
over the public internet, so it needs a publicly reachable HTTPS URL —
either a deployment, or a tunnel to your laptop (`ngrok http 3000` or
similar) while developing.

1. **Create a free account** at
   [account.africastalking.com](https://account.africastalking.com) and
   open the **sandbox** app. Sandbox needs no short-code registration
   and costs nothing — real short codes are out of scope here.
2. **Copy your sandbox API key** into `AFRICAS_TALKING_API_KEY`, leaving
   `AFRICAS_TALKING_USERNAME=sandbox`.
3. **Expose the gateway.** Deploy it, or run `ngrok http 3000` and take
   the `https://…` forwarding URL.
4. **Create a USSD channel** in the sandbox dashboard under USSD. Pick a
   service code (the sandbox assigns something like `*384*NNNN#`) and set
   the callback URL to your public URL plus `/ussd` —
   e.g. `https://your-host.example/ussd`.
5. **Open the simulator** at
   [simulator.africastalking.com](https://simulator.africastalking.com),
   enter any phone number in E.164 form (this becomes the wallet's
   identity — it's hashed, never stored raw), and connect.
6. **Dial your service code** in the simulator. You should get the
   KoboDial welcome menu. Choose **4** to register, pick a PIN, confirm
   it — then **2** to check your balance, and **1** to send to another
   number you've registered the same way.

Watch `GET /transactions` while you do it: each completed action appears
with its real Stellar transaction hash, hashed identifiers only.

If the simulator shows nothing, check that the callback URL ends in
`/ussd`, that it's HTTPS, and that the gateway logs show the request
arriving — a request that never arrives is a tunnel or callback-URL
problem, not a gateway one.

## Dashboard API

Read-only, unauthenticated, intended for a private network or behind a
proxy that adds access control.

| Endpoint            | Returns                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `GET /health`       | `{"status":"ok"}`, backed by a real database query                          |
| `GET /wallets`      | Registered wallets — phone **hashes** only, newest first                    |
| `GET /transactions` | Every contract call attempted, with status, error code and transaction hash |

Both lists take `?limit=` (1–200, default 50) and `?offset=`.

Nothing here needs redacting on the way out: the database only ever held
SHA-256 digests in the first place.

## What's stored, and what isn't

|                  | Where                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Raw phone number | **Nowhere.** Hashed on receipt, only the digest is used or stored.                           |
| Raw PIN          | **Nowhere.** `hashPin()` is the only function that sees one; only its digest travels onward. |
| PIN hash         | **Only on-chain**, in the contract. This service stores none.                                |
| Session state    | `ussd_sessions`, keyed by `sessionId`, deleted when the flow ends                            |
| Transaction log  | `transactions` — hashes, amounts, status, tx hash                                            |

Africa's Talking's `text` field accumulates every keystroke of a session,
so mid-flow it literally contains the caller's PIN. This service
therefore never logs a request body, anywhere, for any route.

## Project layout

```
src/
  config/     environment loading and validation (zod)
  crypto/     phone/PIN hashing — the only place a raw PIN exists
  contract/   Soroban client, typed contract errors
  ussd/       the session state machine, session store, message copy
  routes/     the AT callback and the dashboard API
  db/         drizzle schema, client, migrations
tests/        vitest — offline, contract mocked, in-memory database
```

## Development

```sh
npm run dev       # tsx watch
npm test          # vitest — no keys, no network, no database needed
npm run lint      # eslint + prettier --check
npm run format    # prettier --write
npm run build     # tsc → dist/
npm start         # run the build
```

The test suite is deliberately offline: the contract is mocked and each
test builds its own in-memory database, so CI needs no secrets, no
funded relayer key and no testnet availability.

That means the suite cannot check the real contract integration — that
was verified separately, by hand, against the live testnet contract
`CCPXFBZNI2HR6TPCA5QIYLQRU5W4IXCEK5Y6ANTXKCRLXCXNRILIQQJU`: registering
a wallet, sending real balance between two wallets and watching both
sides and the nonce update, then confirming a replayed nonce returns
`InvalidNonce` and a wrong PIN returns `InvalidPin`. If you change
`src/contract/`, re-run that kind of check yourself and say so in the PR.

## Out of scope for the MVP

SMS receipts, multi-language menus, and agent commission tracking — all
tracked as issues rather than half-built.

## License

MIT — see [LICENSE](LICENSE).
