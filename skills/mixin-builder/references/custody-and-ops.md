# Custody and operations

Key custody, leak response, testing discipline, deployment, rate limits, and the full safety-rail list (SKILL.md carries the top-7 short form; this file is the expanded canonical version — change both or neither).

## Key storage

A keystore is `{app_id, session_id, session_private_key, server_public_key, spend_private_key?}` (node: dist/index.d.ts 7.6.0 `AppKeystore`). Two credentials matter:

| Credential | Grants | May touch |
|---|---|---|
| Session private key (Ed25519) + session_id | Full API access as the bot: read balances/snapshots, **send messages, build and submit Safe transactions if it's the money-bot's session** — API auth is one JWT scope `FULL` (docs: app/guide/generate-jwt-token.md) | Server process |
| Spend private key | Final signature over UTXO inputs — **moves funds**; with it alone you still need valid unsigned raw txs, but in your bot it co-locates with everything | Money code path only |

Rules:

- **At rest**: keystore JSON in a secret manager or encrypted env — NEVER in the repo, NEVER in logs (see log redaction below). Same for `spend_key` in Ruby config (ruby: mixin_bot 3.0.2 README `MixinBot.configure`).
- **Separate injection**: messaging workers get session-only keystores (omit `spend_private_key`; partial keystores are valid for reads/OAuth — node: dist/index.d.ts 7.6.0). Only the signing service receives the spend key. This is also the "partial keystores for read-only code" rail.
- **Per-env bots**: create a second app (free) as the test bot; test and prod keystores never share a filesystem path or env name.
- **Backup**: encrypted keystore copy + recovery contacts off-site. Losing the spend key with no backup = funds unrecoverable; Mixin cannot undo it (SKILL.md model).
- **Never in browser bundles**: the Node SDK needs a Buffer polyfill in browsers — don't ship it client-side with keystore material at all; browser code gets OAuth-scoped tokens at most (→ identity-and-keys.md).

## Leak playbook (ordered)

First: identify exactly what leaked. A leaked session key alone ≠ funds gone (spend key separate) — but a full keystore with spend key is a sweep emergency.

1. **Revoke/rotate the session**: node `client.app.updateSafeSession(appID, {session_public_key})` issues a new app session (node: dist/index.d.ts 7.6.0; dashboard equivalent). Any other session material for the app should be re-issued. This kills the attacker's API access even if they hold the old session key.
2. **Sweep funds to a fresh bot**: create a new app, register it safe, transfer all assets to it via the standard transfer flow (→ payments.md) using the *still-private* spend key — the safe-transfer-all pattern: per asset, Σ unspent outputs → single transfer to the new bot's address. **Dry-run first**: build + `POST /safe/transaction/requests` (verify) WITHOUT broadcasting — go `bot.VerifyRawTransaction` / node `client.utxo.verifyTransaction` — inspect inputs/outputs/amounts, then broadcast.
3. **Re-issue keys**: fresh keystores for both bots; rotate any secrets that shared storage with the leak.
4. **Audit snapshots for unknown outgoing**: poll `GET /safe/snapshots` from before the leak window; alarm on any debit (`amount < 0`) whose `opponent_id` is not in your known set (exchanges, your hot wallets, fee receiver `674d6776-d600-4346-af46-58e77d8df185`). → reconciliation.md monitoring.
5. **Post-mortem cursor fix**: if the attacker's activity advanced snapshot history, re-check reconciliation cursors (→ reconciliation.md) so credits stay exactly-once.

## Testing strategy

- **Dedicated test bot** (create a 2nd app — free; docs: app/getting-started/create-app.md). Never dry-run-then-fat-finger against prod.
- **Dry-run discipline** — build + verify WITHOUT broadcasting:
  - Go: `bot.BuildRawTransaction` → `bot.VerifyRawTransaction` (returns view-key signatures) → stop. Never call `SendRawTransaction` (go: transaction.go v3.25.7).
  - Node: `buildSafeTransaction` → `encodeSafeTransaction` → `client.utxo.verifyTransaction([{request_id, raw}])` (unsigned raw; returns the per-input `views` you would sign with) → stop. Never call `signSafeTransaction` + `client.utxo.sendTransactions` in a dry-run (node: dist/index.d.ts 7.6.0).
  - Ruby: `build_safe_transaction` → `verify_raw_transaction`; the gem's rake tasks (`rake test`, `LIVE=1 rake test`, `rake mixin_bot:api_coverage`) are test/coverage harnesses, not broadcast dry-runs (ruby: mixin_bot 3.0.2 README).
- **Idempotency tests**: replay the same `trace_id`/`request_id` (transfers) and same Blaze message_id twice; assert one effect. The network dedupes on request_id/trace, and Blaze redelivers — both paths must be safe (→ blaze.md, → reconciliation.md).
- **UTXO-race tests**: fire two sends of the same asset concurrently; expect `UtxoInsufficientError` ("insufficient total input outputs", code-family 10002) on the loser until the change UTXO settles; go `bot.SendTransactionUntilSufficient` retries every 2s (go: transaction.go v3.25.7) — or re-select outputs after the first tx's snapshot lands.
- **Inscription-skip tests**: UTXO selection must skip inscription-bearing outputs (node `getUnspentOutputsForRecipients(..., {includeInscriptions: false})`; node: dist/index.d.ts 7.6.0) — test that a wallet holding inscriptions still sends normal assets.

## Deployment

- **One Blaze connection per bot** — multiple connections for the same app_id invite duplicate frame delivery and reconnect storms (→ blaze.md). Supervisor restart with exponential backoff; go `BlazeClient.Loop` returns on disconnect and the caller re-loops (go: blaze.go v3.25.7); Node: `blaze-client.mjs` (echo scaffold) reconnects with backoff, because the SDK's `BlazeKeystoreClient` 7.6.0 can't connect (no User-Agent → 10006; → gotchas.md #19); ruby Puma plugin `plugin :mixin_blaze` with `blaze_ack_policy` (ruby: mixin_bot 3.0.2 README).
- **Secrets via env**, conventional names: `MIXIN_APP_ID`, `MIXIN_SESSION_ID`, `MIXIN_PRIVATE_KEY` (session), `MIXIN_SERVER_PUBLIC_KEY`, `MIXIN_SPEND_KEY`. Injected by the secret manager, never baked into images.
- **Log redaction** (substring denylist at the logger): keystore JSON, `spend_private_key`/`spend_key`, PIN/TIP values, full JWTs (`Authorization` headers). Log the `jti`/`X-Request-Id` instead of the token.
- **Structured request ids**: emit `X-Request-Id` on every API call (set your own per request; go `RequestWithId` / `SignAuthenticationTokenWithRequestID`, go: request.go + auth.go v3.25.7) and log it — it's the join key for cross-referencing with server-side investigation. Node `ResponseError` carries `requestId` (node: dist/index.d.ts 7.6.0).

## Rate limits & retries

- Docs publish exactly one line: `429 Too Many Requests` (docs: api/error-codes.md; the protocol carries errors as HTTP 202 + code body). **No published numbers** — treat all limits as undocumented.
- Client policy: one **global token-bucket** (per process, all endpoints share the app's budget); on 202+429 back off exponentially with jitter. Ruby surfaces it as `RateLimitError` with `throttle?` (ruby: mixin_bot 3.0.2 README).
- `500` and `7000`/`7001` (server error / Blaze server error / Blaze operation timeout) are server-side faults, **not** throttles — retry with backoff, don't drop your rate.
- Retry only: idempotent reads, and writes that carry a stable `request_id`/`trace_id` (the network dedupes on them — rotating the id on retry creates duplicate payments). Never retry a withdrawal with a fresh trace to "make sure it went through".

## Full safety-rail list

SKILL.md shows the top 7; this is the expansion:

1. **Never load the spend key in non-money code paths** — partial keystores for read-only/messaging services; the key that moves funds lives only in the signer.
2. **Stable trace/request/message IDs** — the network dedupes on `request_id`/`trace_id`; regenerating on retry duplicates the payment.
3. **Amounts are decimal strings, never floats** — every balance field is a string in the wire format; float math corrupts credits.
4. **Read/dry-run before sign** — verify (`/safe/transaction/requests`) every constructed tx and inspect inputs/outputs before attaching the spend signature.
5. **Validate withdrawal destinations yourself, per chain** — address/tag format per chain (30102 invalid address; withdrawal memo/codes 20131, floors 20127/20134/20135; docs: api/error-codes.md) before submitting; a validated-onchain withdrawal is irreversible.
6. **ACK every processed Blaze frame** — un-acked frames retransmit 10–30× → gateway-scoped IP block (→ blaze.md).
7. **Ghost-key hint/trace uniqueness** — `/safe/keys` requests take receiver-set + index + hint; keep hints/trace unique per payment so ghost-key reuse can't alias two intents (docs: api/sequencer/transactions.md).
8. **Never broadcast via Kernel RPC** — Safe txs MUST go through `POST /safe/transaction` or the sequencer index breaks (docs: api/sequencer/overview.md).
9. **Sequencer registration + TIP before first send** — `POST /safe/users` requires the TIP-PIN migration done; a bot that never registered cannot transact (docs: api/sequencer/registration.md; → identity-and-keys.md).
10. **Credit exactly once from snapshots** — unique(snapshot_id) constraint, Blaze as trigger only (→ reconciliation.md).
11. **Human confirmation before any broadcast (agents)** — an agent operating a wallet shows asset (symbol + `asset_id`/chain), amount, destination and trace, and broadcasts only after an explicit yes. Probes, output listings and verify-only dry-runs are exempt. The network has no undo (SKILL.md rail 7).

## Sources

- docs: api/sequencer/{overview,transactions,registration}.md, api/error-codes.md, app/guide/generate-jwt-token.md, app/getting-started/create-app.md (repo HEAD 2026-10-05)
- go: transaction.go, blaze.go, request.go, auth.go v3.25.7
- node: dist/index.d.ts 7.6.0
- ruby: mixin_bot 3.0.2 README
