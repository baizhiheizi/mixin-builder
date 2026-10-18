# mixin-builder

**English** | [简体中文](README.zh-CN.md)

An agent skill for building on the Mixin Network — messenger bots, web apps with Mixin login, Safe/UTXO payments and custody, Mixin Computer (Solana) calls, and MTG trusted-group programs.

Protocol claims are verified against pinned SDK source and dated. Every mutating flow ends with **how to verify it worked**.

This is an agent skill: you install it into your agent, then build by talking. [Build with your agent](#build-with-your-agent) is the main path; [run the tools directly](#run-the-tools-directly) if you'd rather go manual; [manage a bot wallet](#manage-a-bot-wallet-without-writing-code) needs no code at all.

## Install (into your agent)

```bash
# from GitHub (skills CLI)
npx skills add baizhiheizi/mixin-builder

# or manually: copy the skill into your agent's skills directory
cp -r skills/mixin-builder ~/.agents/skills/   # or .claude/skills/, .codex/skills/, ...
```

No build step. Works with Claude Code, Codex, opencode, and any skills-compatible agent.

## Build with your agent

Open your agent in your project and describe what you're building. The skill routes the agent to the relevant reference, starts from a scaffold, reads live facts with read-only probes, and applies the safety rails: dry-run before live effects, explicit confirmation before signing.

First, get a keystore: create an app at the [developer dashboard](https://developers.mixin.one) → your app → **Secret** → generate `keystore.json`. Keep it private — whoever holds its `spend_private_key` holds the money.

Prompts like these work as-is:

| You say | What the agent does |
|---|---|
| "Build me a Mixin Messenger bot in Node. Keystore at `~/ks.json`." | Starts from `assets/scaffold-bot-echo/node` — Blaze connect, ack only after processing, reconnect backoff — adapts the reply logic to your product, runs it, then verifies with you: send `/ping`, get exactly one `echo: /ping`, including after a `kill -9` restart. |
| "My web app needs Mixin login." | Follows `references/identity-and-keys.md`: OAuth with PKCE, picking scopes, code exchange server-side. Starts from `assets/scaffold-oauth-web` and keeps the client secret out of the browser. |
| "My store sells courses for USDT — accept payments and credit orders." | Follows `references/payments.md` + `reconciliation.md`: pins the `asset_id` (one symbol ≠ one asset), issues a pay link with a stable `trace_id` per order, credits exactly once per `snapshot_id` (from `assets/scaffold-payment-watcher`), dry-run first; handles under/over-pay and refunds. |
| "Send 0.01 BTC to `bc1q…`" | Decimal-string amount, stable `trace_id`, free raw-transaction verification via `/safe/transaction/requests`, signs **only after you confirm** asset/amount/destination/trace, then polls to `spent` and shows you the snapshot as proof. |
| "I know Solidity — how does Mixin differ?" | `references/concepts.md`: kernel / sequencer / Safe / Blaze mapped to EVM notions, UTXO vs accounts, why there's no gas. |
| "My bot's Blaze connection gets `10006 Update required`." | `references/gotchas.md` #19: the gateway requires a `User-Agent: name/version`; the Node SDK's `BlazeKeystoreClient` (7.6.0) doesn't send one — use the scaffold's `blaze-client.mjs`. |
| "What does error `30102` mean?" | `references/common-errors.md`: code → likely cause → fix. |

Requests that move money require confirmation (`SKILL.md` rail #7): the agent shows asset (`asset_id`, not just the symbol), amount, destination, and trace, and waits for your explicit yes before signing.

### Commands

For repeated workflows, the skill ships five slash-command prompts in [`commands/`](skills/mixin-builder/commands/). Copy them into your agent's command directory (`.claude/commands/`, `~/.config/opencode/command/`, …) to use as `/mixin-*`:

| Command | What it does |
|---|---|
| `/mixin-audit` | Audit the project's Mixin API usage — fabricated SDK symbols, safety-rail violations, error handling, reconciliation patterns — with findings by severity and file:line |
| `/mixin-fit` | Analyze the current product and map it onto Mixin capabilities: what to use now/later, what to read, what to scaffold, in what order |
| `/mixin-probe` | Ground live facts read-only: registration state (`has_safe`), exact balances, ledger paging semantics |
| `/mixin-drift` | Compare the project's installed SDK versions against the skill's verified matrix; re-read installed source where they differ |
| `/mixin-error <code\|symptom>` | Look up an error code or symptom (code → cause → fix), then locate the causing pattern in the codebase |

## Run the tools directly

The scaffolds and scripts are plain, dependency-light files — readable as examples, runnable without an agent. Requirements: Node ≥ 20 for `scripts/` (zero npm deps) · Node ≥ 22 for the watcher (`node:sqlite`) · Go ≥ 1.27 · Ruby ≥ 4.0.

```bash
git clone https://github.com/baizhiheizi/mixin-builder.git && cd mixin-builder
SKILL=skills/mixin-builder

# echo bot (node/ go/ ruby/) — Blaze messaging, ack semantics, reconnect backoff
cd $SKILL/assets/scaffold-bot-echo/node && npm install
KEYSTORE=/path/to/keystore.json node index.mjs    # verify: /ping → exactly one echo, even after kill -9

# payment watcher — Blaze trigger + /safe/snapshots reconciliation, credit-once
cd ../../scaffold-payment-watcher && npm install
KEYSTORE=/path/to/keystore.json node watcher.mjs  # dry-run by default; --no-dry-run only when the output looks right

# OAuth web login — redirect + code exchange + profile read (zero-dep)
cd ../scaffold-oauth-web
MIXIN_APP_ID=… MIXIN_CLIENT_SECRET=… PORT=3000 node server.mjs

# read-only live probes (GET only; the spend key is never read)
node $SKILL/scripts/probe.mjs computer                       # Mixin Computer info (no auth)
node $SKILL/scripts/probe.mjs me --keystore ks.json          # auth + Safe-registration state
node $SKILL/scripts/probe.mjs outputs --keystore ks.json     # exact balances, all pages
node $SKILL/scripts/probe.mjs snapshots --keystore ks.json   # recent ledger + paging check
node $SKILL/scripts/probe.mjs snapshot <id> --keystore ks.json
```

Note: if you write your own client instead of using the scaffolds, every HTTP request and the Blaze handshake need a `User-Agent: name/version` header — without it the API returns `10006 Update required` (→ `references/gotchas.md` #19).

## Manage a bot wallet without writing code

No scaffolds, no SDK knowledge. Install the skill into your agent (Claude Code, Codex, any skills-compatible agent), then just talk to it.

You need one file: the bot's `keystore.json`, from the [developer dashboard](https://developers.mixin.one) where you created the bot. Keep it private — whoever holds its `spend_private_key` holds the money.

Prompts like these work as-is; the skill routes the agent to the relevant reference and safety rails:

| You say | What the agent does |
|---|---|
| "My keystore is at `~/keystores/my-bot.json`. What's my bot's balance?" | Runs `scripts/probe.mjs me` (registration state) and `outputs` (all unspent UTXOs summed exactly per `asset_id` — Mixin has no balance field). Read-only: the spend key is never read. |
| "Send 0.01 BTC to `bc1q…`" | Follows `references/payments.md`: decimal-string amount, stable `trace_id`, verifies the raw transaction for free via `/safe/transaction/requests`, only signs after you confirm, then polls to `spent` and shows you the snapshot as proof. |
| "Has anyone paid the bot since yesterday?" | Walks snapshots per `references/reconciliation.md`: payer, asset, amount, trace — deduplicated on `snapshot_id`. |

Sending requires the bot to be Sequencer-registered; if `probe.mjs me` reports `has_safe: false`, the agent walks you through it via `references/identity-and-keys.md`.

## What it covers

15 reference files, ~2,100 lines, every claim sourced and dated:

| Domain | Reference | Highlights |
|---|---|---|
| Mental model, EVM/Telegram/fintech translations | [`references/concepts.md`](skills/mixin-builder/references/concepts.md) | kernel / sequencer / Safe / Blaze, actors, asset model (one symbol ≠ one asset) |
| Keys, auth, identity | [`references/identity-and-keys.md`](skills/mixin-builder/references/identity-and-keys.md) | keystore anatomy + legacy/Safe formats, key separation, JWT, TIP PIN, Sequencer registration, OAuth (PKCE + secret), sub-accounts, app-security |
| Blaze WebSocket | [`references/blaze.md`](skills/mixin-builder/references/blaze.md) | wire protocol, ack covenant, reconnect doctrine, the IP-block incident |
| Messaging | [`references/messaging.md`](skills/mixin-builder/references/messaging.md) | all categories, APP_CARD anatomy, groups/circles, attachments, encrypted messages |
| Payments | [`references/payments.md`](skills/mixin-builder/references/payments.md) | UTXO model, send lifecycle, multisig, withdrawals + fee branching, dust, inscriptions, storage entries |
| Reconciliation | [`references/reconciliation.md`](skills/mixin-builder/references/reconciliation.md) | snapshots as ledger, credit-once, forward cursor paging, order payments (trace → order, under/over-pay, refunds), monitoring |
| Custody & ops | [`references/custody-and-ops.md`](skills/mixin-builder/references/custody-and-ops.md) | key storage, leak playbook, testing, deployment, rate limits |
| Mixin Computer | [`references/computer.md`](skills/mixin-builder/references/computer.md) | registration, system calls (invoice pattern), fees, nonce accounts — built from the Computer repo source; official docs have no Computer section |
| MTG trusted groups | [`references/mtg.md`](skills/mixin-builder/references/mtg.md) | observer/signer/worker, determinism rules, thresholds, FROST |
| Bot-as-app | [`references/webview.md`](skills/mixin-builder/references/webview.md) | card → webview handoff, JS bridge (iOS/Android/desktop differences), design conventions |
| Links & encodings | [`references/schemas.md`](skills/mixin-builder/references/schemas.md) | `mixin://` families verified against all three Messenger clients, pay URIs, MIX/MIN addresses, codes |
| Failure lookup | [`references/gotchas.md`](skills/mixin-builder/references/gotchas.md), [`references/common-errors.md`](skills/mixin-builder/references/common-errors.md) | 21 failure cases; every error code → cause → fix |
| SDK navigation | [`references/sdk-map.md`](skills/mixin-builder/references/sdk-map.md) | canonical source file per topic per language |
| Verification record | [`references/compatibility.md`](skills/mixin-builder/references/compatibility.md) | verified-against matrix + re-verify instructions |

## How content stays accurate

- No SDK symbol appears in the content unless it was read from the pinned SDK source (Go `bot-api-go-client/v3` v3.25.7 · Node `@mixin.dev/mixin-node-sdk` 7.6.0 · Ruby `mixin_bot` 3.0.2 · `safe` v0.28.2 · `multi-party-sig` v0.7.0 · docs repo HEAD · kernel `MixinNetwork/mixin`). Claims that cannot be verified are marked `[UNVERIFIED]` inline.
- `references/sdk-map.md` maps each topic to the exact source file per language; agents are instructed to read the *installed* SDK before emitting code, with the documented REST call as fallback.
- `scripts/check-currency.mjs` checks latest SDK versions, diffs exported-symbol surfaces against `scripts/baseline.json`, syntax-checks every scaffold, and tracks the four first-party Mixin repos (ios-app, android-app, flutter-app, mixin_bot_sdk_dart) via the GitHub compare API — drift is reported only when commits touch the watched files the skill cites. Nonzero exit = drift; `--update` re-baselines after review.
- A scheduled GitHub workflow runs these checks weekly, refreshes the verified-against dates, and opens a PR when drift is found.
- Ephemeral facts (Computer registration price, members/threshold, your registration state) are read at use time via `scripts/probe.mjs`, not copied from the docs.

Full verified-against matrix and re-verify instructions: [`references/compatibility.md`](skills/mixin-builder/references/compatibility.md).

## Layout

```
skills/mixin-builder/
├── SKILL.md            # entry point: model, safety rails, routing, SDK rule, currency block
├── commands/           # 5 optional slash-command prompts (audit / fit / probe / drift / error)
├── references/         # 15 domain files (see table above)
├── scripts/
│   ├── check-currency.mjs   # version + export-surface + scaffold audit (exit ≠ 0 on drift)
│   ├── baseline.json        # expected surfaces, regenerated via --update
│   └── probe.mjs            # read-only live probes (computer / me / outputs / snapshots / snapshot)
├── assets/
│   ├── scaffold-bot-echo/        # echo bot: go/ node/ ruby/
│   ├── scaffold-oauth-web/       # backend-secret OAuth login, zero-dep
│   └── scaffold-payment-watcher/ # Blaze + snapshot reconciliation, credit-once
└── evals/              # 7 release-gate prompts + expected behaviors per domain
```

## Not covered

End-user Messenger support · market/price content · duplicating the official API reference ([developers.mixin.one](https://developers.mixin.one)) · fox-one/4swap/Exin ecosystems beyond pointers · auto-updating SDK snippets inside `SKILL.md`.

## Contributing

Content rules are enforced across the library: every protocol claim carries a source and verified-against date; no SDK symbol without an installed-source pointer or an exercising scaffold; safety rails live in exactly two places (`SKILL.md` + `custody-and-ops.md`) — change both or neither; `SKILL.md` stays under ~350 lines; English README is canonical (`README.zh-CN.md` tracks it).

Before submitting: run `node skills/mixin-builder/scripts/check-currency.mjs` and the relevant prompt from `evals/`. New domains need a reference file, a routing row, and an eval.

## License

[MIT](LICENSE)
