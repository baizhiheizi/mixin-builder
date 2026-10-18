---
description: Map the current product onto Mixin capabilities — what to use, what to read, what to scaffold
argument-hint: [product description — optional, defaults to reading the repo]
---

Decide which Mixin capabilities this product should use. Load the **mixin-builder** skill; references are relative to the skill root.

## 1. Understand the product

Read the project README, manifest, and entry points. Determine: who the users are (Messenger users / web users / both), what moves (messages, money, or both), and what the product already does. If `$ARGUMENTS` is given, treat it as the product description. If the scenario is still ambiguous after reading the repo, ask **one** clarifying question — do not guess.

## 2. Evaluate the capability map

Judge each capability against the scenario; cite the reference when you recommend or reject it.

| Need | Capability | Read | Scaffold |
|---|---|---|---|
| Reach users in Messenger | Bot: text, cards, groups | `messaging.md`, `blaze.md` | `scaffold-bot-echo` |
| Rich in-chat UI | APP_CARD → webview, JS bridge | `webview.md`, `messaging.md` § 2 | — |
| Web login with Mixin identity | OAuth (PKCE + backend secret) | `identity-and-keys.md` § OAuth | `scaffold-oauth-web` |
| Accept payments | Receiving + reconciliation | `payments.md` § Receiving, `reconciliation.md` | `scaffold-payment-watcher` |
| Refunds / payouts | Transfers (send lifecycle) | `payments.md` | — |
| Custody beyond one key | Multisig | `payments.md` § Multisig | — |
| Off-chain fees / withdrawals | Withdrawals (two-tx fee shape) | `payments.md` § Withdrawals | — |
| Solana execution | Mixin Computer (invoice pattern) | `computer.md` | — |
| Own trusted group / clearing | MTG (Go) | `mtg.md` | — |
| In-app entry points | `mixin://` deep links, pay URIs | `schemas.md` | — |

## 3. Prerequisites and sequencing

For each recommended capability, list prerequisites (keystore, Sequencer registration — `has_safe` must be true before sending, OAuth scopes) and what to verify at each step. Typical build order: messaging → login → receiving → sending last.

## Output

- **Recommended now / later / not a fit** — one line each, with the reason and the reference
- A build sequence whose first three steps are concrete
- The top risk for this scenario (e.g. stores accepting symbol-named assets: wrong-chain payments, `gotchas.md` #16)
