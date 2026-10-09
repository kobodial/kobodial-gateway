# A full run against the live deployment

Everything below was executed against the deployed gateway and the contract on
Stellar testnet. The transaction hashes are real.

- **Gateway:** https://kobodial-gateway-i05s.onrender.com
- **Dashboard:** https://kobodial-dashboard.vercel.app
- **Contract:** [`CDQKYOYWBUAFZUZIAX4YDTLWYTYWPAV3AOSCUJJ2PWNRCECVV5F6XX73`](https://stellar.expert/explorer/testnet/contract/CDQKYOYWBUAFZUZIAX4YDTLWYTYWPAV3AOSCUJJ2PWNRCECVV5F6XX73)

The gateway sleeps after about fifteen minutes idle. Wake it first, or the
first command below will be slow:

```sh
curl https://kobodial-gateway-i05s.onrender.com/health
# {"status":"ok"}
```

## What a USSD session is, mechanically

Africa's Talking posts one HTTP request per keystroke to `POST /ussd`, with a
`sessionId`, the caller's `phoneNumber`, and `text` — the accumulated input so
far, joined by `*`. The reply is plain text prefixed `CON` (expect more input)
or `END` (session over). The commands below are exactly what the aggregator
sends, so you can drive a real session without a phone.

```sh
U=https://kobodial-gateway-i05s.onrender.com
dial() {
  curl -s -X POST "$U/ussd" \
    --data-urlencode "sessionId=$1" \
    --data-urlencode "phoneNumber=+2348012345678" \
    --data-urlencode "text=$2"; echo
}
```

## 1. Register a wallet

```sh
dial demo-1 ""              # CON Welcome to KoboDial / 1. Send Money / 2. Check Balance / 3. Change PIN / 4. Register
dial demo-1 "4"             # CON Choose a 4-digit PIN for your KoboDial wallet
dial demo-1 "4*1234"        # CON Re-enter your PIN to confirm
dial demo-1 "4*1234*1234"   # END Registration successful! You can now send and receive money.
```

That last step submitted a real transaction. The gateway signed it with the
relayer key; the user holds no key and never sees one.

> `register` → [`b4d645fe…`](https://stellar.expert/explorer/testnet/tx/b4d645feedaeda6f0d61923ce45b0d7d8496d968c7f9e331bac68167940721e4)

## 2. Check the balance

```sh
dial demo-2 "2"             # CON Enter your PIN to view your balance
dial demo-2 "2*1234"        # END Your balance is 0
```

## 3. See it from the operator side

```sh
curl -s $U/wallets | head -c 200
# {"wallets":[{"id":1,"phoneHash":"56d031c8…","createdAt":"2026-10-06T12:46:53.085Z"},…
```

Newest first. There is more than one row: the wallet used for the lockout
section below is in there too, and it may still be locked when you look.

The same rows render on the [dashboard](https://kobodial-dashboard.vercel.app),
which reads them server-side from this API.

## What the ledger does and does not reveal

The stored key for `+2348012345678` is
`56d031c880f717d063d69bbb19386370410cbe24b6e75b0539f78fa5e152f860`.

That is **not** `sha256("+2348012345678")`, which is `1cc617d6…`. The
difference is the point. Both `phone_hash` and `pin_hash` are written to
Soroban persistent storage, which is public, and both inputs are small enough
to enumerate — 10,000 possible PINs, and a national mobile range of a few tens
of millions of numbers, against a hash that runs billions of times a second on
a GPU.

So an unkeyed digest of either value discloses it. Anyone with the ledger could
recover every user's PIN and, worse, every user's phone number — the whole user
base deanonymized from public data, permanently, since a number cannot be
rotated like a PIN.

Both are therefore derived with **HMAC-SHA-256 under a secret pepper** the
chain never sees. An attacker holding the entire ledger cannot test a single
candidate. See [docs/SECURITY.md](docs/SECURITY.md) for the arithmetic, and for
what the pepper does _not_ protect against.

## The PIN lockout, run for real

A 4-digit PIN is 10,000 guesses. Peppering closes the offline attack; it does
nothing about guessing online, one session at a time. Note the **fresh
sessionId per attempt** — a `sessionId` is chosen by whoever is dialling, so
per-session counting would limit nothing.

```sh
for i in 1 2 3 4 5; do
  dial "guess-$i" "2" > /dev/null
  dial "guess-$i" "2*0000"
done
```

```
END Incorrect PIN. 4 attempts left before your wallet locks.
END Incorrect PIN. 3 attempts left before your wallet locks.
END Incorrect PIN. 2 attempts left before your wallet locks.
END Incorrect PIN. 1 attempt left before your wallet locks.
END Too many incorrect PIN attempts. Your wallet is locked for 15 minutes.
```

And the **correct** PIN is refused while locked — otherwise the lock would be
bypassed by the one guess that matters:

```sh
dial after "2" > /dev/null
dial after "2*1234"
# END Too many incorrect PIN attempts. Your wallet is locked for 15 minutes.
```

A failure during a lock does not extend it, so an attacker cannot hold someone
out of their own wallet by guessing once every few minutes.

## What this run does not establish

- **Nothing here is audited.** It is a testnet project and should not hold
  anything of value.
- **The gateway is custodial.** It holds the relayer key, which is also the
  contract admin, so a compromised gateway can act for every wallet. The key is
  rotatable ([contract two-step handover](https://github.com/kobodial/kobodial-contract#rotating-the-admin)),
  and separating the relayer from the admin is tracked as an issue.
- **A 4-digit PIN is weak** whatever the rate limit. The lockout makes
  exhausting it impractical; it does not make the PIN strong, and it does
  nothing about SIM swap, where the attacker controls the number itself.
- **The pepper protects against reading the ledger, not against breaching the
  gateway.** Whoever holds it can enumerate exactly as described above.
