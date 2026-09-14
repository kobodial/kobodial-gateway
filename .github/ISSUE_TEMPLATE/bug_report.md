---
name: Bug report
about: Something in the gateway behaves wrong
labels: bug
---

**What happened**

**What you expected instead**

**The USSD session**

Walk through it the way the caller experienced it — the menu choices
in order, and what each screen said back:

1. Dialled the service code → (screen text)
2. Chose … → (screen text)
3. …

**Never paste a real PIN, or a real phone number, into a public
issue.** Use a placeholder — the phone hash from `GET /wallets` is
fine if you need to identify a specific wallet.

**Environment**

- Mode: Africa's Talking sandbox / simulator / real short code
- `CONTRACT_ID` and network (testnet / mainnet)
- Anything in the server logs at the time (they contain no PINs or
  phone numbers by design — safe to paste)

**Does it move money, replay an authorization, or expose a PIN?**

If so, please don't post it publicly — see SECURITY.md.
