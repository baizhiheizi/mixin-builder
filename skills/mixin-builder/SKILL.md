---
name: mixin-builder
description: Build on the Mixin Network — messenger bots, web apps with Mixin OAuth login, Safe/UTXO payments, transfers, multisig, withdrawals, inscriptions, snapshot reconciliation, Blaze WebSocket messaging, keystore/session-key/spend-key/TIP-PIN management, MIX/MIN addresses, mixin:// deep links, app cards and webviews, Mixin Computer (MVM, Solana system calls), and MTG trusted-group programs. Covers the Go SDK (bot-api-go-client), Node SDK (@mixin.dev/mixin-node-sdk), Ruby (mixin_bot), and raw REST against api.mixin.one / blaze.mixin.one. Use when the user says Mixin, Mixin bot, Mixin Messenger bot, keystore, session key, spend key, TIP PIN, Blaze, Safe, UTXO, output, snapshot, ghost key, multisig request, withdrawal, deposit entry, inscription, collectible, MixAddress, MIN invoice, pay URI, mixin:// link, app card, OAuth/QR login, Sequencer, MVM, Mixin Computer, system call, nonce account, MTG, trusted group, observer/signer, FROST/MPC — or asks to explain Mixin to an EVM/Solidity, Telegram-bot, or fintech developer.
---

# mixin-builder — building safely on the Mixin Network

One skill, deep references. This file is the entry point: mental model, safety rails, routing, and the SDK-resolution rule. Everything deeper lives in `references/`.

## What Mixin is (read this first)

Mixin is a peer-to-peer network with four moving parts:

- **Kernel** — stores and validates transactions. Final arbiter; no smart contracts, no gas.
- **Sequencer** — indexes kernel data and exposes the developer API: `https://api.mixin.one`, paths under `/safe/*`. Registration (per bot/user) required before sending.
- **Safe** — the money model: **UTXOs**, not accounts. Every send is assembled and signed client-side, then verified and broadcast via the Sequencer.
- **Blaze** — the push channel: `wss://blaze.mixin.one`, subprotocol `Mixin-Blaze-1`, gzip binary frames. Delivers messages, transfer events, and group events to your bot.

The Messenger app is the (reference) wallet UI, and **a bot is a user**: your `app_id` *is* a `user_id`, with a keystore instead of a phone number.

The custody insight that shapes everything else: **you hold the spend key; Mixin cannot undo your mistakes.** There are no chargebacks, no admin rescue, no rollbacks. Every flow below assumes you act accordingly.

Money movement = Safe transactions built from unspent outputs, signed with the Ed25519 **spend key**. Read flows (messages, profiles, output listings) need only the session key.

## Safety rails

Each rail exists because skipping it loses money or floods the network. Expanded set with rationale: `references/custody-and-ops.md`.

1. **Never load the spend key in non-money code paths.** Build narrow clients (messaging keystore without `spend_private_key`). A message-handler bug then cannot sign anything.
2. **Stable IDs for every intent: `request_id`, `trace_id`, `message_id`.** The network deduplicates on them; rotating an ID inside a retry loop creates the duplicate transfer you were retrying to avoid.
3. **Amounts are decimal strings, never floats.** `"0.00000001"`, not `1e-8`, not `0.1+0.2`. JS `Number` and Go `float64` both silently corrupt asset amounts at 8 decimals.
4. **Read or dry-run before you sign.** List outputs, quote fees, verify the raw transaction (`/safe/transaction/requests`) before submitting. Verification is free; signing is not.
5. **Validate withdrawal destinations yourself, per chain, before signing.** Wrong-chain or malformed destinations = permanently lost funds (`30102` is your last warning, not your first line of defense).
6. **ACK every Blaze frame you process — and only after processing.** Un-acked frames are re-delivered (handlers must be idempotent on `message_id`); never acking gets your IP blocked by the gateway.

## Task routing

| Intent | Read | Run |
|---|---|---|
| "explain Mixin / coming from EVM, Telegram bots, fintech" | `concepts.md` | — |
| Create a bot, send messages, cards, groups, attachments | `messaging.md`, `blaze.md` | `assets/scaffold-bot-echo/` |
| Bot reconnect storm, duplicate messages, WS flooding | `blaze.md`, `gotchas.md` | — |
| Accept payments, credit users | `payments.md` (§ receiving), `reconciliation.md` | `assets/scaffold-payment-watcher/` |
| Send transfers, multisig, withdrawals (fees!), inscriptions | `payments.md` | — |
| "why is my balance wrong" / UTXO dust / consolidation | `payments.md` §6, `gotchas.md` | — |
| Mixin login for a web app (OAuth, PKCE, scopes) | `identity-and-keys.md` | `assets/scaffold-oauth-web/` |
| Keystore anatomy, keys, TIP PIN, Sequencer registration, sub-accounts | `identity-and-keys.md` | — |
| Key leaked / custody / backups / testing / deploy / rate limits | `custody-and-ops.md` | — |
| Ledger reconciliation, credit-once, cursors, monitoring | `reconciliation.md` | `assets/scaffold-payment-watcher/` |
| Solana through Mixin (Computer/MVM): register user, system calls, fees, nonces | `computer.md` | — |
| Build your own trusted group (Go): observer/signer/worker, determinism, FROST | `mtg.md` | — |
| Bot-as-app: cards → webview, JS bridge, design rules | `webview.md`, `messaging.md` §2 | — |
| Deep links, pay URIs, MIX/MIN addresses, codes | `schemas.md` | — |
| An error code / failure symptom | `common-errors.md`, `gotchas.md` | — |
| Which SDK call / file for topic X in language Y | `sdk-map.md` | — |

## SDK resolution rule (anti-hallucination)

Mixin skills historically died by inventing SDK symbols (~25 fabricated Go function names in one audited set). Therefore:

1. **Never emit an SDK symbol from memory.** Open `references/sdk-map.md` → it names the canonical source file per topic per language.
2. **Resolve against the installed version**: read the actual SDK in the user's project (`node_modules/@mixin.dev/mixin-node-sdk/dist/index.d.ts`, the Go module source, `gem open mixin_bot`) before writing code against it.
3. **Fallback**: the documented REST call (`developers.mixin.one/docs/api`, endpoint tables in `references/payments.md` etc.) is always correct; prefer it when the SDK surface is uncertain.
4. Symbols cited in this skill's references were verified against pinned versions (below) — but SDKs move; the installed source wins.

## Currency block

Verified against (full matrix + re-verify steps: `references/compatibility.md`):

- Go `bot-api-go-client/v3` **v3.25.7** · Node `@mixin.dev/mixin-node-sdk` **7.6.0** · Ruby `mixin_bot` **3.0.2** · docs repo HEAD pushed **2026-10-05** · `computer.mixin.one` **v0.9.1** (7 members / threshold 5, registration 0.001 XIN) — all checked **2026-10-11**.

Before relying on SDK specifics (or if anything here contradicts the installed SDK), run:

```bash
node scripts/check-currency.mjs   # latest versions + export diff + scaffold checks; nonzero exit = drift
node scripts/probe.mjs            # read-only live probes: /me, outputs, computer info
```

Ephemeral facts (prices, fees, computer params) are probed at use time, never copied from prose.
