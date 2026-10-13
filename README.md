# mixin-builder

One deep agent skill for building on the Mixin Network — messenger bots, web apps with Mixin login, Safe/UTXO payments and custody, Mixin Computer (Solana) calls, and MTG trusted-group programs.

Protocol truth over SDK transcripts. War stories over API tables. Every mutating flow ends with **how to verify it worked**.

## Install

```bash
# from GitHub (skills CLI)
npx skills add baizhiheizi/mixin-builder

# or manually: copy the skill into your agent's skills directory
cp -r skills/mixin-builder ~/.agents/skills/   # or .claude/skills/, .codex/skills/, ...
```

No build step. The scripts are plain Node (≥ 20) with zero npm dependencies.

## Quick start

Pick a scaffold, add a keystore, run:

```bash
# echo bot — Blaze messaging, ack semantics, reconnect backoff (Go / Node / Ruby)
cd skills/mixin-builder/assets/scaffold-bot-echo/node
npm install && KEYSTORE=/path/to/keystore.json node index.mjs

# payment watcher — Blaze trigger + /safe/snapshots reconciliation, credit-once ledger
cd ../scaffold-payment-watcher
npm install && node watcher.mjs --dry-run          # dry-run is the default

# OAuth web login — redirect + code exchange + profile read (zero-dep)
cd ../scaffold-oauth-web
MIXIN_APP_ID=… MIXIN_CLIENT_SECRET=… PORT=3000 node server.mjs
```

Ground live facts instead of trusting prose:

```bash
node skills/mixin-builder/scripts/probe.mjs computer        # Mixin Computer info (no auth)
node skills/mixin-builder/scripts/probe.mjs me --keystore ks.json
node skills/mixin-builder/scripts/probe.mjs outputs --keystore ks.json     # exact balances, all pages
node skills/mixin-builder/scripts/probe.mjs snapshots --keystore ks.json   # recent ledger + paging check
```

## Manage a bot wallet without writing code

No scaffolds, no SDK knowledge. Install the skill into your agent (Claude Code, Codex, any skills-compatible agent), then just talk to it.

You need one file: the bot's `keystore.json`, from the [developer dashboard](https://developers.mixin.one) where you created the bot. Keep it private — whoever holds its `spend_private_key` holds the money.

Prompts like these work as-is; the skill routes the agent to the right reference and rails:

| You say | What the agent does |
|---|---|
| "My keystore is at `~/keystores/my-bot.json`. What's my bot's balance?" | Runs `scripts/probe.mjs me` (registration state) and `outputs` (all unspent UTXOs summed exactly per `asset_id` — Mixin has no balance field). Read-only: the spend key is never read. |
| "Send 0.01 BTC to `bc1q…`" | Follows `references/payments.md`: decimal-string amount, stable `trace_id`, verifies the raw transaction for free via `/safe/transaction/requests`, only signs after you confirm, then polls to `spent` and shows you the snapshot as proof. |
| "Has anyone paid the bot since yesterday?" | Walks snapshots per `references/reconciliation.md`: payer, asset, amount, trace — deduplicated on `snapshot_id`. |

Sending requires the bot to be Sequencer-registered; if `probe.mjs me` reports `has_safe: false`, the agent walks you through it via `references/identity-and-keys.md`.

## What it covers

| Domain | Reference | Highlights |
|---|---|---|
| Mental model, EVM/Telegram/fintech translations | `references/concepts.md` | kernel / sequencer / Safe / Blaze, actors, asset model (one symbol ≠ one asset) |
| Keys, auth, identity | `references/identity-and-keys.md` | keystore anatomy + legacy/Safe formats, key separation, JWT, TIP PIN, Sequencer registration, OAuth (PKCE + secret), sub-accounts, app-security |
| Blaze WebSocket | `references/blaze.md` | wire protocol, ack covenant, reconnect doctrine, the IP-block incident |
| Messaging | `references/messaging.md` | all categories, APP_CARD anatomy, groups/circles, attachments, encrypted messages |
| Payments | `references/payments.md` | UTXO model, send lifecycle, multisig, withdrawals + fee branching, dust, inscriptions, storage entries |
| Reconciliation | `references/reconciliation.md` | snapshots as ledger, credit-once, forward cursor paging, order payments (trace → order, under/over-pay, refunds), monitoring |
| Custody & ops | `references/custody-and-ops.md` | key storage, leak playbook, testing, deployment, rate limits |
| Mixin Computer | `references/computer.md` | registration, system calls (invoice pattern), fees, nonce accounts — the only written Computer reference in any language |
| MTG trusted groups | `references/mtg.md` | observer/signer/worker, determinism rules, thresholds, FROST |
| Bot-as-app | `references/webview.md` | card → webview handoff, JS bridge, design conventions |
| Links & encodings | `references/schemas.md` | `mixin://` families, pay URIs, MIX/MIN addresses, codes |
| Failure lookup | `references/gotchas.md`, `references/common-errors.md` | 19 war stories; every error code → cause → fix |
| SDK navigation | `references/sdk-map.md` | canonical source file per topic per language |
| Truth anchor | `references/compatibility.md` | verified-against matrix + re-verify instructions |

## How it stays true

Mixin skills historically died by inventing SDK symbols. This one is built so that can't happen:

- **Anti-hallucination by construction** — no SDK symbol appears in the content unless it was read from the pinned SDK source (Go `bot-api-go-client/v3` v3.25.7 · Node `@mixin.dev/mixin-node-sdk` 7.6.0 · Ruby `mixin_bot` 3.0.2 · `safe` v0.28.2 · `multi-party-sig` v0.7.0 · docs repo HEAD · kernel `MixinNetwork/mixin`). Anything unverifiable is marked `[UNVERIFIED]` inline.
- **Resolve-don't-recall** — `references/sdk-map.md` points to the exact source file per topic; agents are instructed to read the *installed* SDK before emitting code, with the documented REST call as fallback.
- **Automated drift alarm** — `scripts/check-currency.mjs` checks latest SDK versions, diffs exported-symbol surfaces against `scripts/baseline.json`, and syntax-checks every scaffold. Nonzero exit = drift; `--update` re-baselines after review.
- **Live probes over stale numbers** — ephemeral facts (Computer registration price, members/threshold, your registration state) are probed at use time via `scripts/probe.mjs`, never copied from prose.

Full verified-against matrix and re-verify instructions: [`skills/mixin-builder/references/compatibility.md`](skills/mixin-builder/references/compatibility.md).

## Layout

```
skills/mixin-builder/
├── SKILL.md            # entry point: model, safety rails, routing, SDK rule, currency block
├── references/         # 15 domain files (see table above)
├── scripts/
│   ├── check-currency.mjs   # version + export-surface + scaffold audit (exit ≠ 0 on drift)
│   ├── baseline.json        # expected surfaces, regenerated via --update
│   └── probe.mjs            # read-only live probes (computer / me / outputs / snapshots / snapshot)
├── assets/
│   ├── scaffold-bot-echo/       # echo bot: go/ node/ ruby/
│   ├── scaffold-oauth-web/      # backend-secret OAuth login, zero-dep
│   └── scaffold-payment-watcher/ # Blaze + snapshot reconciliation, credit-once
└── evals/              # release-gate prompts + expected behaviors per domain
```

## Not covered

End-user Messenger support · market/price content · duplicating the official API reference (it's good — [developers.mixin.one](https://developers.mixin.one)) · fox-one/4swap/Exin ecosystems beyond pointers · auto-updating SDK snippets inside `SKILL.md`.

## Contributing

Content rules are enforced across the library: every protocol claim carries a source and verified-against date; no SDK symbol without an installed-source pointer or an exercising scaffold; safety rails live in exactly two places (`SKILL.md` + `custody-and-ops.md`) — change both or neither; `SKILL.md` stays under ~350 lines; English is canonical.

Before submitting: run `node skills/mixin-builder/scripts/check-currency.mjs` and the relevant prompt from `evals/`. New domains need a reference file, a routing row, and an eval.

## License

MIT
