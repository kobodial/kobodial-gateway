# Security notes

## What the ledger publishes

KoboDial stores a wallet on-chain under `phone_hash`, with `pin_hash` inside it.
Soroban persistent storage is **public**: anyone can read every wallet entry off
the ledger, for every user, at any time.

That makes the choice of digest a security decision rather than an
implementation detail, because both inputs come from a small enumerable space.

| Input                  | Space            | Cost to enumerate             |
| ---------------------- | ---------------- | ----------------------------- |
| 4-digit PIN            | 10,000           | instant                       |
| Nigerian mobile number | tens of millions | seconds on commodity hardware |

SHA-256 is designed to be fast, and runs in the billions of hashes per second
on a GPU. So an **unkeyed** digest of either value does not conceal it. Given
the ledger:

- every wallet's PIN can be recovered by hashing all 10,000 candidates;
- every wallet's phone number can be recovered by hashing a country's numbering
  plan and matching against the stored keys.

The second is the more serious of the two. It deanonymizes the entire user base
from public data, and unlike a PIN it cannot be changed afterwards.

**Salting does not fix this.** A salt has to be stored alongside the digest to
be usable, so it gets published too. Salts stop one precomputed table covering
every user; they do nothing against 10,000 candidates tested per user.

## What the gateway does instead

Both identifiers are derived with **HMAC-SHA-256 under a secret pepper**
(`HASH_PEPPER`), in `src/crypto/hash.ts`. The pepper never leaves the gateway
and never appears on-chain, so an attacker holding the whole ledger cannot test
even a single candidate — they cannot compute the digest at all.

The phone and PIN domains are separated (`kobodial/phone/v1`,
`kobodial/pin/v1`), so a digest derived in one role cannot be replayed into the
other.

`HASH_PEPPER` is **required**. There is no default and no fallback: the service
refuses to start without it. A default would silently reinstate exactly the
scheme described above, and the failure would be invisible.

Generate one with:

```sh
openssl rand -hex 32
```

## What this does not protect against

- **A compromised gateway.** Whoever holds the pepper can enumerate exactly as
  described. The pepper moves the attack from "anyone with the public ledger"
  to "someone who has breached the gateway" — a large improvement, not
  immunity.
- **A weak PIN, online.** 4 digits is 10,000 guesses. The pepper stops offline
  attacks; it does nothing about an attacker guessing through the USSD flow.
  Rate limiting and lockout are tracked separately.
- **SIM swap or aggregator compromise.** The phone number is the account
  identifier, so anyone who controls the number controls the session.

## Rotating the pepper is a migration, not a config change

Every stored `phone_hash` is derived from the pepper. Change it and every
existing wallet becomes unreachable — the gateway will compute a different
`phone_hash` for the same number and the contract will report no such wallet.
The funds are not lost, but no USSD session can reach them.

The same applies to adopting the pepper in the first place. Wallets registered
under the previous unkeyed SHA-256 scheme are **not** reachable by a gateway
running with a pepper.

For the testnet deployment the accepted path is to re-register: the balances are
test funds and the wallet set is small. A deployment holding real value would
need a migration that, for each wallet, moves the balance from the old
`phone_hash` to the new one — which requires the gateway to still know each
number, and so must be run before the old scheme is switched off.

## Reporting

Security issues can be raised as a GitHub issue on this repository. This is an
unaudited testnet project and should not be used to hold anything of value.
