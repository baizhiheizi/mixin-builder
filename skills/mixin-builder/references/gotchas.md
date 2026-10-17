# Gotchas — ranked war stories (symptom → cause → fix)

Ordered by how often they bite (16–19 added 2026-10-12/13, not yet ranked). Each entry: what you see, why it happens, the fix, and how to prevent it. Error-code lookups: `common-errors.md`. Deeper domain context: linked references.

## 1. Blaze retransmit storm → gateway IP block

**Symptom:** every inbound message arrives 10–30×; frame rates of thousands/minute; ~70-minute reconnect storms; eventually your server IP is blocked *per gateway* (bot works from other IPs, dies from yours).
**Cause:** not acking `ACKNOWLEDGE_MESSAGE_RECEIPT` (or acking frames you never processed and crashing mid-loop). The gateway treats un-acked as undelivered and re-sends, forever.
**Fix:** ack every frame your handler processed — after processing, not before (Node: `blaze-client.mjs` in the echo scaffold acks after the handler, since the SDK's `BlazeKeystoreClient` can't connect, see #19; `SyncAck() bool` in Go `BlazeListener`, `blaze_ack_policy :after_handler` in the Ruby Puma plugin) — plus one global reconnect backoff (1s→2s→…→60s, jitter). Handlers stay idempotent on `message_id` because at-least-once redelivery is a design property, not a bug.
**Evidence:** ohmy.xin incident 2026-09-28 (5,794 frames/min observed). Details: `blaze.md` § ACK semantics, § Reconnect doctrine, § Case study.

## 2. Change-UTXO not yet spendable → "insufficient" with balance showing

**Symptom:** balance queries show enough, but the send fails with `insufficient total input outputs` (Go: `UtxoInsufficientError`) — classically right after another send (fee tx after a withdrawal, second entry of an invoice, batch payouts).
**Cause:** UTXO model — the change output of the just-submitted transaction isn't in your unspent set yet (pending state / same-input conflict). "Balance" is Σ unspent, not a number you can re-spend instantly.
**Fix:** bounded retry with the **same trace/request id** (Go: `SendTransactionUntilSufficient` retries every 2s), or pre-consolidate before batching. Never widen the amount or rotate the trace to "make it go through".
**Prevent:** sequential payouts with per-step confirmation, or a UTXO allocator that reserves outputs. `payments.md` § Dust & consolidation.

## 3. Duplicate outgoing transfer after a retry

**Symptom:** user paid twice; two snapshots with different traces for one intent.
**Cause:** retry loop generated a new `trace_id`/`request_id` per attempt. The network dedupes *per id* — new id = new transaction.
**Fix:** derive the trace deterministically from the business intent (uuid v5 over `intent:order_id`), persist it before the first attempt, reuse it across process restarts. Idempotency is your job; the network only makes it *possible*.
**Prevent:** ledger constraint on trace before send; `custody-and-ops.md` § Rate limits & retries.

## 4. Amount corruption at 8 decimals

**Symptom:** amounts off by tiny amounts; `20120 Transfer amount too small` or user credited 0.09999999.
**Cause:** floats. JS `Number` (or Go `float64`) through JSON parse/format rounds; 8-decimal assets overflow binary fractions.
**Fix:** decimal strings end-to-end (`"0.00000001"`); Go `decimal`/`common.Integer`, Node `BigNumber` (SDK-internal), Ruby `BigDecimal`. Parse API amounts as strings, never re-serialize through float.

## 5. `SYSTEM_ACCOUNT_SNAPSHOT` trusted for Safe payments

**Symptom:** credits missed (or double) for Safe transfers; bot "didn't notice" payments it received.
**Cause:** `SYSTEM_ACCOUNT_SNAPSHOT` fires for *legacy* transfers only. Safe money movement surfaces via `SYSTEM_SAFE_SNAPSHOT` on Blaze and `/safe/snapshots` on REST — and Blaze frames can be redelivered.
**Fix:** Blaze = trigger, `/safe/snapshots` = truth, credit-once keyed on `snapshot_id`. `reconciliation.md` § Credit-once pattern.

## 6. Withdrawal fee surprise — two transactions, not one

**Symptom:** withdrawal "succeeded" but nothing left the chain; or fee tx rejected (`20124`/`20135`); or you paid a fortune in the withdrawal asset because you didn't branch.
**Cause:** fee branching — if the fee is quoted in the withdrawal asset, one tx carries [destination, cashier-fee, change]; if quoted in the *chain* asset, you must send **two** linked transactions (withdrawal + fee referencing the withdrawal raw hash).
**Fix:** quote per call (`GET /safe/assets/:id/fees?destination=`), branch on which asset the fee is in; Go `SendWithdrawal` returns a slice whose length tells you the branch. Fresh quote every withdrawal. `payments.md` § Withdrawals.

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
**Fix:** build recipients first (incl. change), then request ghost keys with index = array position, hint derived from the single trace (`UniqueObjectId(trace, "OUTPUT", i)` pattern); assert `views.length == inputs.length` before signing. `payments.md` § Sending money.

## 10. Blaze handler receives every message twice (benign case)

**Symptom:** duplicates right after a deploy/restart, then stops.
**Cause:** redelivery of un-acked messages from before the restart (at-least-once covenant) — *not* a bug if your handler is idempotent; it's the system working.
**Fix:** dedupe on `message_id` in the handler (or a short-lived seen-cache); if duplicates never stop, see gotcha #1.
**Distinguish:** duplicates that persist = ack bug; duplicates only around restarts = redelivery, expected.

## 11. Extra > 256 bytes silently unsupported

**Symptom:** MTG/Computer operations with big payloads fail at build or verify.
**Cause:** general tx `extra` cap is 256 B (kernel limit; Go `object.go` errors `too large extra`).
**Fix:** storage-entry pattern — XIN storage tx carries the payload (cost `ceil(len/1024) × 0.0001 XIN`), operational tx references its hash. Node: `attachStorageEntry`; Go: `CreateObjectStorageTransaction`. `payments.md` § Large extras.

## 12. Go SDK "missing" functions that older guides cite

**Symptom:** code from a 2024–2026 blog/agent transcript won't compile: `PostMessage2`, `SelectOutputsForRecipients`, `SafeSnapshotsRead`, `GetMe`, `ParticipantsConversation`, `BuildSafeTransaction`…
**Cause:** those names never existed (or refer to other SDKs). A known failure mode of Mixin skill/blog content — ~25 fabricated Go names in the audited prior set.
**Fix:** resolve from installed source per `sdk-map.md`; real names there; `compatibility.md` explains how they were verified.

## 13. `429 Too Many Requests` under load

**Symptom:** bursts of `202 + 429` after batch jobs; no published rate-limit numbers anywhere.
**Cause:** Mixin throttles per token/app; the docs document the code and nothing else.
**Fix:** global token bucket + exponential backoff honoring 202/429; batch REST where the API allows (`PostMessages`, `sendTransactions` arrays); keep Blaze as the push channel instead of polling `/safe/snapshots` hot. `custody-and-ops.md` § Rate limits & retries.

## 14. Sequencer rejection on first-ever send

**Symptom:** fresh bot's transfers rejected; `/safe/me` shows not registered.
**Cause:** Sequencer registration (TIP PIN + `POST /safe/users`) is a hard prerequisite — bots created before the Sequencer era don't have it implicitly.
**Fix:** TIP migrate (`identity-and-keys.md` § TIP PIN) then register (§ Sequencer registration); `client.safe.checkRegisteration()` / `GET /safe/me` to verify: check `has_safe === true`, since an unregistered bot gets a normal user object back.

## 15. `mixin://pay` link opens empty sheet

**Symptom:** pay URI renders but amount/asset missing.
**Cause:** unescaped parameters (memo with `&`/space breaks the query), float-formatted amount, or recipient given as mainnet address where a UUID/MIX was expected.
**Fix:** URL-encode every value, decimal-string amounts, recipient as uuid / MIX / members+threshold per `buildMixinOneSafePaymentUri`. `schemas.md` §2, §6.

## 16. "User paid USDT but the order isn't paid" — wrong-chain asset

**Symptom:** a snapshot for the right amount arrives, but your matcher rejects it; or worse, it accepts a payment in an asset you can't withdraw where you expected.
**Cause:** one symbol, many assets. USDT on Ethereum, Tron, Polygon, BSC, Solana… each has its own `asset_id` and `chain_id`. Matching or hardcoding by `symbol` conflates them.
**Fix:** key orders and pay links on `asset_id`; confirm each hardcoded id once with `GET /safe/assets/:id` (`symbol`, `chain_id`, `asset_key` = contract address). Wrong-asset payments go to the refund branch. `concepts.md` § Asset model, `reconciliation.md` § Order payments.

## 17. Payment watcher stops seeing new payments after the first page

**Symptom:** the first poll credits the latest payments, then nothing new ever arrives, even though `/safe/snapshots` without an offset shows them. Or the stored cursor moves *backwards* in time.
**Cause:** paging `order=DESC` from a `created_at` offset returns rows *older* than the cursor; reversing the page and advancing to its newest row walks the cursor backwards.
**Fix:** `order=ASC&offset=<cursor>`, drain until a short page, inclusive offset + `UNIQUE(snapshot_id)`, assert each page is ascending. Check the server's behavior with `scripts/probe.mjs snapshots`. `reconciliation.md` § Cursor management.

## 18. 401 on every call with a freshly downloaded keystore

**Symptom:** `401 Unauthorized` from the first request; or the Node SDK throws on signing; or a "missing app_id" error.
**Cause:** legacy keystore shape (`client_id`, `private_key` base64url, `pin_token`) fed to code expecting `app_id`, `session_private_key` hex, `server_public_key`.
**Fix:** map the fields (`identity-and-keys.md` § Keystore formats), or let `probe.mjs` / Ruby `MixinBot.configure` accept both. Verify with `node scripts/probe.mjs me --keystore ks.json` before writing any code.

## 19. `10006 Update required` from a hand-rolled HTTP client

**Symptom:** every signed request from your own `fetch` code returns HTTP 202 `{"code":10006,"description":"Update required."}`, while SDK REST calls with the same keystore work. Or a Node bot using the SDK's `BlazeKeystoreClient` never receives a single message and logs nothing (the WebSocket handshake gets the same 202 and the SDK waits forever). Easy to misread as a broken keystore or a dashboard setting.
**Cause:** api.mixin.one and blaze.mixin.one check `User-Agent`. Missing, `node` (Node's `fetch` default) and `x` are rejected; `name/version` strings such as `my-bot/1.0`, `Go-http-client/1.1`, `axios/1.7.9` pass. Node's `ws` library (used by the SDK's Blaze client) sends none. Live-checked 2026-10-13 with the same JWT.
**Fix:** set an explicit `User-Agent` such as `my-bot/1.0` on every HTTP request and WebSocket handshake. Go (`Bot-API-Go-Client` for REST, Go's default for Blaze) and Ruby (`mixin_bot/<version>`) already do. For Node Blaze use `assets/scaffold-bot-echo/node/blaze-client.mjs`. `common-errors.md` 10006.

## 20. Bot suddenly receives only ciphertext — `ENCRYPTED` capability

**Symptom:** a bot that worked on `PLAIN_*` starts receiving `ENCRYPTED_TEXT`/`ENCRYPTED_IMAGE`…; `data_base64` no longer decodes to readable payloads.
**Cause:** the app dashboard was granted the `ENCRYPTED` capability — Messenger then sends user→bot messages as `ENCRYPTED_*` (session-encrypted) instead of `PLAIN_*` (verified ios-app@master `SendMessageService+Sending.swift`). The capability is opted into per app, often without realizing the inbox contract changes with it.
**Fix:** either implement the encrypted-message pipeline (messaging.md §5: `POST /sessions/fetch`, ECDH per-session keys, AES-CBC body) or have the capability removed. Same family: `GROUP` capability routes group `@700xxxx ` text to the bot directly. Check `capabilities` on the app object — note the API JSON key is misspelled **`capabilites`**.

## 21. APP_CARD silently renders nothing — missing `shareable` in new-style cards

**Symptom:** a new-style card (no legacy `action`) sends fine but the recipient's iOS client shows no card at all.
**Cause:** iOS decodes V1 cards with `shareable` as a **required** key (`AppCardData.V1Content.init(from:)`, ios-app@master) — omit it and the whole payload fails to decode. Docs describe it as optional-with-default, which iOS does not honor.
**Fix:** always include `"shareable": true|false` in V1 cards (and remember forwarding additionally requires every action to be a `mixin`/`http`/`https` URL — `input:` actions make the card unforwardable). Legacy `action`-style cards don't need it.
