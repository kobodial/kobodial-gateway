---
name: Feature request
about: Suggest something for the gateway
labels: enhancement
---

**What someone on a feature phone is trying to do**

Start from the person and the phone: what they want to accomplish,
what they'd dial, and what's stopping them today.

**What the screens would say**

USSD gives you ~140 characters per screen and a numeric keypad. A
sketch of the actual prompts is worth more than a description of the
feature.

**How it stays authorized**

If it moves money, say which PIN check and which nonce authorize it,
and what happens when the relayer submits something the user never
approved. The gateway never authorizes on its own authority — a
proposal that needs it to is a proposal to change the trust model, and
that's worth saying out loud.

**Scope note**

SMS receipts, multi-language menus and agent commission tracking are
deliberately out of MVP scope. Discussion welcome; they just won't be
merged into the MVP.
