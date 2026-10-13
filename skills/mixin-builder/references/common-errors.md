# Common errors — code → cause → fix

Mixin returns errors as HTTP **202** with a JSON `{code, description, extra}` envelope (and HTTP 500 for true server faults). Source: docs `api/error-codes.md`, verified 2026-10-11; SDK exposure: Go `error.go` (`Error{Status, Code, Description, Extra}`), Node `ResponseError{code, description, status, extra, requestId}`, Ruby `MixinBot::APIError` (`retryable?`, `throttle?`).

## Envelope codes

| Code | Meaning | Cause you most likely have | Fix |
|---|---|---|---|
| 400 | body can't be parsed | malformed JSON, wrong content type | serialize with the SDK; `Content-Type: application/json` |
| 401 | Unauthorized | bad/expired JWT, signed URI ≠ request URI (query included), wrong key (session vs OAuth), missing `X-Request-Id` | re-sign per request; sign `method+uri+body` exactly as sent; check `identity-and-keys.md` § Request auth |
| 403 | Forbidden | scope missing (OAuth) or endpoint needs different auth | request the scope (`PROFILE:READ` is mandatory); use bot keystore where user token used |
| 404 | endpoint not found | typo'd path, or legacy path on Sequencer era | check endpoint against `payments.md`/docs `api/sequencer/*` |
| 429 | Too Many Requests | rate limit (numbers undocumented) | global backoff, batch endpoints, Blaze over polling — `custody-and-ops.md` § Rate limits & retries |
| 10002 | invalid field — **detail in `extra`** | schema violation (amount float, bad uuid, over-long field) | read `extra`; fix field; don't retry unchanged |
| 10006 | app update required | **missing or non-`name/version` `User-Agent`** on a REST call or the Blaze WebSocket handshake: Node's `fetch` sends `node`, and the `ws` library (Node SDK 7.6.0 `BlazeKeystoreClient`) sends none (live-checked 2026-10-13) | send `User-Agent: my-bot/1.0` or similar; for Node Blaze use the echo scaffold's `blaze-client.mjs` (→ gotchas.md #19) |
| 10104 | address generating | deposit entry being provisioned | retry later (minutes) |
| 10105 | locked by another transaction | outputs already referenced by a pending tx | wait for settle or use other outputs; same trace retry is safe |
| 20116 | group chat is full | >256 participants | split groups / circles |
| 20117 | Insufficient balance | spendable (unspent!) total < amount+fee | check `safeOutputs` sum, not UI balance; consolidate (`payments.md` § Dust & consolidation) |
| 20120 | Transfer amount too small | below asset dust | raise amount or skip; never pad-and-split into dust sends |
| 20123 | too many apps | app quota on the account | free tier = 2 apps (`app.properties()`) |
| 20124 | Insufficient fee | fee asset balance short (two-tx withdrawal branch) | fund the chain asset, re-quote |
| 20125 | paid by someone else | trace id already used by a *different* payer | your trace collided — derive traces from unique intent |
| 20127 | withdraw too small | below withdrawal floor for asset | accumulate or skip |
| 20131 | withdrawal memo format incorrect | tag/memo missing or malformed for chain | set tag where chain requires (XRP/XLM…), per-chain validation |
| 20133 | too many circles for conversation | circle attach limit | prune circles |
| 20134 | withdraw too large | above cap | split across txs |
| 20135 | withdraw fee too small | stale/hardcoded fee | **always re-quote** `fetchFee`/`ReadAssetFee` — `payments.md` § Withdrawals |
| 20150 | receivers duplicate/invalid | multisig `receivers` bad (dupes, wrong count vs threshold) | dedupe + validate member uuids, sort before sending |
| 30102 | Invalid address format | destination wrong for chain | per-chain validation before build — safety rail #5 |
| 500 | internal | server side, occasionally your body triggering an edge | retry with backoff once; then report/avoid |
| 7000 | Blaze server error | gateway fault | reconnect with backoff; not your payload |
| 7001 | Blaze operation timeout | WS round-trip timed out (e.g. ack wait) | check ack flow (`blaze.md`); reconnect |

## Error shapes that aren't envelope codes

**`insufficient total input outputs`** — surfaces as Go `*UtxoInsufficientError{TotalInput, TotalOutput}` or a 10002-family message: inputs < outputs at build time. Almost always change-UTXO timing, not true poverty. Same-trace retry; `gotchas.md` #2.

**401 that's actually a signing mismatch** — `sig` claim is `sha256(method + URI + query + body)`. Sorted-params clients that re-encode the query differently at send time get 401 with a perfectly valid key. Sign the exact final URI string. (`identity-and-keys.md` § Request auth)

**`invalid view keys count`** — verify returned fewer view-key signatures than your tx has inputs. You appended inputs after verifying, or mixed traces. Re-run verify for the final raw. (`payments.md` § Sending money)

**Node fetch of computer.mixin.one 404s** — the Node SDK ships Computer *encoders* only; there is no client namespace for it. Call `https://computer.mixin.one` directly with fetch. (`computer.md` § Public read/write API, `sdk-map.md`)

**`too many references` / extra-size errors** — Go `SendTransactionWithOutputs` caps references at 2; general `extra` cap is 256 B. Use storage entries for big payloads. (`payments.md` § Large extras)

## Handling policy

- **Retry** (with same trace/id): 401-after-refresh, 429, 500, 7000/7001, 10105, 10104.
- **Never blind-retry**: 10002 (fix the field), 20125 (trace collision), 30102 (validate), 20131/20135 (fix memo/fee).
- **Surface `extra`** to logs on every 10002 — it names the offending field.
- Ruby: gate retries on `error.retryable?`, throttle on `error.throttle?`; other languages replicate that split per the table above.
