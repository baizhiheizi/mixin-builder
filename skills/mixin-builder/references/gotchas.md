# Gotchas — ranked war stories (symptom → cause → fix)

Ordered by how often they bite. Each entry: what you see, why it happens, the fix, and how to prevent it. Error-code lookups: `common-errors.md`. Deeper domain context: linked references.

## 1. Blaze retransmit storm → gateway IP block

**Symptom:** every inbound message arrives 10–30×; frame rates of thousands/minute; ~70-minute reconnect storms; eventually your server IP is blocked *per gateway* (bot works from other IPs, dies from yours).
**Cause:** not acking `ACKNOWLEDGE_MESSAGE_RECEIPT` (or acking frames you never processed and crashing mid-loop). The gateway treats un-acked as undelivered and re-sends, forever.
**Fix:** ack every frame your handler processed — after processing, not before (`syncAck: true` in Node `BlazeKeystoreClient`, `SyncAck() bool` in Go `BlazeListener`, `blaze_ack_policy :after_handler` in the Ruby Puma plugin) — plus one global reconnect backoff (1s→2s→…→60s, jitter). Handlers stay idempotent on `message_id` because at-least-once redelivery is a design property, not a bug.
**Evidence:** ohmy.xin incident 2026-09-28 (5,794 frames/min observed). Details: `blaze.md` §3–5.

## 2. Change-UTXO not yet spendable → "insufficient" with balance showing

**Symptom:** balance queries show enough, but the send fails with `insufficient total input outputs` (Go: `UtxoInsufficientError`) — classically right after another send (fee tx after a withdrawal, second entry of an invoice, batch payouts).
**Cause:** UTXO model — the change output of the just-submitted transaction isn't in your unspent set yet (pending state / same-input conflict). "Balance" is Σ unspent, not a number you can re-spend instantly.
**Fix:** bounded retry with the **same trace/request id** (Go: `SendTransactionUntilSufficient` retries every 2s), or pre-consolidate before batching. Never widen the amount or rotate the trace to "make it go through".
**Prevent:** sequential payouts with per-step confirmation, or a UTXO allocator that reserves outputs. `payments.md` §6.

## 3. Duplicate outgoing transfer after a retry

**Symptom:** user paid twice; two snapshots with different traces for one intent.
**Cause:** retry loop generated a new `trace_id`/`request_id` per attempt. The network dedupes *per id* — new id = new transaction.
**Fix:** derive the trace deterministically from the business intent (uuid v5 over `intent:order_id`), persist it before the first attempt, reuse it across process restarts. Idempotency is your job; the network only makes it *possible*.
**Prevent:** ledger constraint on trace before send; `custody-and-ops.md` §3.

## 4. Amount corruption at 8 decimals

**Symptom:** amounts off by tiny amounts; `20120 Transfer amount too small` or user credited 0.09999999.
**Cause:** floats. JS `Number` (or Go `float64`) through JSON parse/format rounds; 8-decimal assets overflow binary fractions.
**Fix:** decimal strings end-to-end (`"0.00000001"`); Go `decimal`/`common.Integer`, Node `BigNumber` (SDK-internal), Ruby `BigDecimal`. Parse API amounts as strings, never re-serialize through float.

## 5. `SYSTEM_ACCOUNT_SNAPSHOT` trusted for Safe payments

**Symptom:** credits missed (or double) for Safe transfers; bot "didn't notice" payments it received.
**Cause:** `SYSTEM_ACCOUNT_SNAPSHOT` fires for *legacy* transfers only. Safe money movement surfaces via `SYSTEM_SAFE_SNAPSHOT` on Blaze and `/safe/snapshots` on REST — and Blaze frames can be redelivered.
**Fix:** Blaze = trigger, `/safe/snapshots` = truth, credit-once keyed on `snapshot_id`. `reconciliation.md` §2.

## 6. Withdrawal fee surprise — two transactions, not one

**Symptom:** withdrawal "succeeded" but nothing left the chain; or fee tx rejected (`20124`/`20135`); or you paid a fortune in the withdrawal asset because you didn't branch.
**Cause:** fee branching — if the fee is quoted in the withdrawal asset, one tx carries [destination, cashier-fee, change]; if quoted in the *chain* asset, you must send **two** linked transactions (withdrawal + fee referencing the withdrawal raw hash).
**Fix:** quote per call (`GET /safe/assets/:id/fees?destination=`), branch on which asset the fee is in; Go `SendWithdrawal` returns a slice whose length tells you the branch. Fresh quote every withdrawal. `payments.md` §5.

## 7. Destination first output, no ghost key — withdrawal builds "weird"

**Symptom:** hand-built withdrawal rejected at verify; or works but fee lands wrong.
**Cause:** withdrawal layout is fixed: output 0 = chain destination (`Destination`+`Tag`, **no ghost key**, type 161), then cashier fee, then change.
**Fix:** use SDK withdrawal builders (`SendWithdrawal` / Node pattern in `payments.md`); don't compose it from a transfer template.

## 8. Wrong-chain / malformed withdrawal destination = gone

**Symptom:** `30102 Invalid address format` (best case) or funds left, never arrived (worst case).
**Cause:** Mixin validates format loosely per chain; tag/memo semantics (XRP/XLM/etc.) are chain-specific; nothing maps addresses to chains for you.
**Fix:** validate destination per chain *before* building (checksum, prefix, length), require tag when the chain uses one, address-book entries (`CreateAddress`) for recurring destinations, small-value first send. Safety rail #5.

## 9. Ghost key index/hint mismatch → send to wrong-looking output

**Symptom:** transfer verifies but recipient says they never got it; or verify rejects with view-key count mismatch.
**Cause:** ghost keys are per (receivers, **index**, hint). Index must equal the output slot; receivers get sorted; hint derives from the trace. Reused hint across different traces, or index drift after appending a change output, breaks the mapping.
**Fix:** build recipients first (incl. change), then request ghost keys with index = array position, hint derived from the single trace (`UniqueObjectId(trace, "OUTPUT", i)` pattern); assert `views.length == inputs.length` before signing. `payments.md` §3.

## 10. Blaze handler receives every message twice (benign case)

**Symptom:** duplicates right after a deploy/restart, then stops.
**Cause:** redelivery of un-acked messages from before the restart (at-least-once covenant) — *not* a bug if your handler is idempotent; it's the system working.
**Fix:** dedupe on `message_id` in the handler (or a short-lived seen-cache); if duplicates never stop, see gotcha #1.
**Distinguish:** duplicates that persist = ack bug; duplicates only around restarts = redelivery, expected.

## 11. Extra > 256 bytes silently unsupported

**Symptom:** MTG/Computer operations with big payloads fail at build or verify.
**Cause:** general tx `extra` cap is 256 B (kernel limit; Go `object.go` errors `too large extra`).
**Fix:** storage-entry pattern — XIN storage tx carries the payload (cost `ceil(len/1024) × 0.0001 XIN`), operational tx references its hash. Node: `attachStorageEntry`; Go: `CreateObjectStorageTransaction`. `payments.md` §8.

## 12. Go SDK "missing" functions that older guides cite

**Symptom:** code from a 2024–2026 blog/agent transcript won't compile: `PostMessage2`, `SelectOutputsForRecipients`, `SafeSnapshotsRead`, `GetMe`, `ParticipantsConversation`, `BuildSafeTransaction`…
**Cause:** those names never existed (or refer to other SDKs). A known failure mode of Mixin skill/blog content — ~25 fabricated Go names in the audited prior set.
**Fix:** resolve from installed source per `sdk-map.md`; real names there. The hallucinated→real table in `compatibility.md`'s process covers the recurring ones.

## 13. `429 Too Many Requests` under load

**Symptom:** bursts of `202 + 429` after batch jobs; no published rate-limit numbers anywhere.
**Cause:** Mixin throttles per token/app; the docs document the code and nothing else.
**Fix:** global token bucket + exponential backoff honoring 202/429; batch REST where the API allows (`PostMessages`, `sendTransactions` arrays); keep Blaze as the push channel instead of polling `/safe/snapshots` hot. `custody-and-ops.md` §5.

## 14. Sequencer rejection on first-ever send

**Symptom:** fresh bot's transfers rejected; `/safe/me` shows not registered.
**Cause:** Sequencer registration (TIP PIN + `POST /safe/users`) is a hard prerequisite — bots created before the Sequencer era don't have it implicitly.
**Fix:** TIP migrate (`identity-and-keys.md` §4) then register (§5); `client.safe.checkRegisteration()` / `GET /safe/me` to verify.

## 15. `mixin://pay` link opens empty sheet

**Symptom:** pay URI renders but amount/asset missing.
**Cause:** unescaped parameters (memo with `&`/space breaks the query), float-formatted amount, or recipient given as mainnet address where a UUID/MIX was expected.
**Fix:** URL-encode every value, decimal-string amounts, recipient as uuid / MIX / members+threshold per `buildMixinOneSafePaymentUri`. `schemas.md` §2, §6.
