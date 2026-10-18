---
description: Audit this project's Mixin API usage — SDK symbols, safety rails, error handling, reconciliation
argument-hint: [path — defaults to repo root]
---

Audit the current project's Mixin-related code. Load the **mixin-builder** skill first; every reference below is relative to the skill root. Scope: `$ARGUMENTS` or the repo root.

## 1. Find the Mixin surface

- SDK imports: Go `MixinNetwork/bot-api-go-client`, Node `@mixin.dev/mixin-node-sdk`, Ruby `mixin_bot`
- Raw REST: `api.mixin.one`, paths under `/safe/`, `/messages`, `/oauth`, `/apps`
- Blaze: `blaze.mixin.one`, subprotocol `Mixin-Blaze-1`
- Keystores: files named `keystore*.json`, env vars or config holding `spend_private_key` / `session_private_key` / `pin_token`, and any statement that logs keystore fields

## 2. Verify every SDK symbol (resolve-don't-recall)

For each SDK symbol the code calls, open the **installed** source (`node_modules/@mixin.dev/mixin-node-sdk/dist/index.d.ts`, the Go module cache, `gem open mixin_bot`) — `references/sdk-map.md` names the canonical file per topic. A symbol that resolves nowhere is fabricated — a known failure class (`references/gotchas.md` #12) → **Critical**.

## 3. Check the safety rails (`SKILL.md`, all 7)

- Amounts are decimal strings, never JS `Number` / Go `float64` (`gotchas.md` #4)
- `request_id` / `trace_id` / `message_id` stay stable across retries (`gotchas.md` #3)
- Spend key is loaded only in money code paths; messaging handlers run on a narrow keystore (no `spend_private_key`)
- Raw transaction verified via `/safe/transaction/requests` before signing
- Withdrawal destinations validated per chain before signing (`gotchas.md` #7–#8)
- Blaze: ack after processing, handlers idempotent on `message_id`, reconnect with backoff (`references/blaze.md`)
- Every HTTP client sends `User-Agent: name/version` (`gotchas.md` #19)

## 4. Check REST usage and error handling

- Endpoints and params against the tables in `references/payments.md`, `references/messaging.md`, `references/identity-and-keys.md`
- The API returns HTTP **202** with `{code, description}` — code that branches on HTTP status alone misses every error (`references/common-errors.md`)

## 5. Check money-in patterns (if the project accepts payments)

Against `references/reconciliation.md`: the ledger of truth is `GET /safe/snapshots`, never Blaze frames; credits exactly once per `snapshot_id`; ASC cursor paging with a monotonic-offset guard; first run starts at "now" unless backfilling on purpose.

## Output

Report, most severe first:

| Severity | Finding | Where (file:line) | Fix (reference) |
|---|---|---|---|

**Critical** = can lose money or fabricates symbols · **Warning** = breaks under retry/reconnect/error envelope · **Info** = drift from recommended patterns.

End with a "change first" list of at most three items. Propose patches only after the user has seen the findings.
