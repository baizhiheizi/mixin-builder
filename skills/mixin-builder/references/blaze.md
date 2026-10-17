# Blaze — the bot inbox (WebSocket message loop)

Blaze is the single ingress for a bot: chat messages, system events, transfer notifications, and read receipts all arrive over one authenticated WebSocket. Everything a bot "reacts to" starts here. Sending is done over HTTP (`POST /messages` or the Blaze send helpers); Blaze is read-side + receipts.

## Wire protocol

| Fact | Value |
|---|---|
| URL | `wss://blaze.mixin.one/` (Go default host constant; overridable via `SetBlazeUri`) |
| Subprotocol | `Mixin-Blaze-1` |
| Auth | `Authorization: Bearer <JWT>` — EdDSA token for `GET /` with empty body (`SignAuthenticationToken("GET", "/", "", user)`), one per dial |
| Frames | WebSocket **binary** messages only; payload is **gzip** (Go writes at level 3; reads with `gzip.NewReader`) |
| Keepalive | Go: ping every 9s (`pingPeriod`), read deadline 10s (`pongWait`), write deadline 10s |

Envelope (both directions):

```json
{ "id": "<uuid-v4>", "action": "...", "params": { }, "data": { }, "error": null }
```

- `id` correlates request→response; the server replies with the same id for actions like `LIST_PENDING_MESSAGES` and `ACKNOWLEDGE_MESSAGE_RECEIPT`. Go matches replies through a transaction map and drops late/abandoned responses (go: blaze.go `writeMessageAndWait`, `parseMessage`).
- Action errors come back as `{error: {status, code, description}}`; codes 429, 500–599, 7000 (blaze server error), 7001 (blaze operation timeout) are retryable (go: blaze.go retry loop).

Actions:

| Action | Direction | Meaning |
|---|---|---|
| `LIST_PENDING_MESSAGES` | client→server | Sent immediately after every dial; server resends all un-acked messages. Params: `nil` |
| `CREATE_MESSAGE` | server→client | Inbound message; `data` is a `MessageView` |
| `ACKNOWLEDGE_MESSAGE_RECEIPT` | both | Params `{message_id, status}` (Go uses `"READ"`). Server→client copies carry `data` = MessageView with `source: "ACKNOWLEDGE_MESSAGE_RECEIPT"` (read receipts for messages you sent) |

REST fallbacks the official client uses alongside Blaze (ios-app@master MessageAPI.swift): `POST /acknowledgements` (batch `[{"message_id","status"}]` — Go `PostAcknowledgements`), `POST /messages/acknowledge`, and **`GET /messages/status/:offset`** — a pull-based catch-up that returns messages past a cursor, the client's recovery path when Blaze delivery is in doubt. Useful as a bot-side reconciliation loop keyed on the same offset discipline as snapshot polling (→ reconciliation.md).

MessageView fields (Go): `conversation_id, user_id, message_id, category, data_base64, representative_id, quote_message_id, status, source, created_at, updated_at` (go: blaze.go `MessageView`). `data_base64` is base64 of the category payload (UTF-8 text for PLAIN_TEXT, JSON for APP_CARD, …).

## What arrives

Categories (Node `MessageCategory` union + Go constants; docs: api/messages/category.md):

- **PLAIN_***: TEXT, POST, IMAGE, DATA, VIDEO, AUDIO, STICKER, LIVE, LOCATION, CONTACT — user-typed content. ⚠️ A bot app with the `ENCRYPTED` capability receives the **`ENCRYPTED_*`** twins of these instead of PLAIN_* (→ messaging.md "App capabilities"); a `GROUP`-capable bot in a group chat receives text messages addressed `@700xxxx <text>` (its identity number) directly via `recipient_id`, with `data` cleared on the wire (ios-app@master).
- **APP_CARD / APP_BUTTON_GROUP**: interactive cards/buttons the user tapped; `data_base64` decodes to the card JSON (Go `AppCardView`: app_id, cover_url, title ≤36, description, actions[] ≤6, shareable; full V0/V1 model → messaging.md).
- **MESSAGE_RECALL**: user deleted a message; `data_base64` = recalled `message_id`.
- **SYSTEM_CONVERSATION**: conversation lifecycle (participant add/remove/role); payload `{action, participant_id, user_id?, role?}` (go: `SystemConversationPayload`).
- **SYSTEM_ACCOUNT_SNAPSHOT**: **LEGACY transfers only** (`TransferView`: snapshot_id, counter_user_id, asset_id, amount, trace_id, memo).
- **SYSTEM_SAFE_SNAPSHOT**: Safe snapshot event (`snapshot_id, user_id, opponent_id, transaction_hash, asset_id, amount, memo, created_at`, plus `deposit_hash` / `inscription_hash` where applicable — go: `TransferSafeView`).
- **SYSTEM_SAFE_INSCRIPTION**: inscription movements.
- ENCRYPTED_* categories require per-recipient session keys (`FetchUserSessions`) — see → identity-and-keys.md.

**Money rule**: do NOT treat SYSTEM_ACCOUNT_SNAPSHOT as covering Safe flows — it fires for legacy transfers only. SYSTEM_SAFE_SNAPSHOT is a *notification*, not a ledger: it can be missed (dropped connection, un-acked frame) and is not authoritative. Reconcile balances and payments via `GET /safe/snapshots` polling keyed on `created_at` offset (→ payments.md, reconciliation.md). Use Blaze as a low-latency trigger, the REST snapshot list as truth.

## ACK semantics — the covenant

Delivery is **at-least-once**: any frame you receive but do not ack is re-delivered by the gateway — immediately on your next `LIST_PENDING_MESSAGES` (every reconnect), and via periodic retransmit while you stay connected. `ACKNOWLEDGE_MESSAGE_RECEIPT` is the *only* way a message leaves the pending queue.

This forces a choice, and every SDK exposes it:

| Policy | Order | Crash consequence | Delivery guarantee |
|---|---|---|---|
| **Ack on receipt** (at-most-once) | ack, then run handler | Handler work in flight is lost | May drop messages |
| **Ack after handler** (at-least-once) | run handler, ack on success | Un-acked message is redelivered; handler runs again | Duplicates possible ⇒ **handlers MUST be idempotent on `message_id`** |

There is no third option. If your handler is idempotent, always choose ack-after-handler.

SDK surfaces:

- **Go** (`BlazeListener`): `SyncAck() bool` decides per-listener. `Loop` runs the read loop synchronously: on each inbound message it calls `OnMessage(...)`; if `SyncAck()` returns true it then sends `ACKNOWLEDGE_MESSAGE_RECEIPT {message_id, status:"READ"}` and **waits for the server's confirmation** before reading the next frame. Messages whose `source` is `ACKNOWLEDGE_MESSAGE_RECEIPT` go to `OnAckReceipt` instead. If `OnMessage` or the ack write fails, `Loop` returns — the caller re-loops, and everything un-acked is redelivered. `SyncAck()==false` means *you* must ack (e.g. via `PostAcknowledgements` after durable processing) or the gateway will retransmit forever. (go: blaze.go `Loop`, `writeMessageAndWait`)
- **Node** (`@mixin.dev/mixin-node-sdk/blaze`): ⚠ **7.6.0 can't connect.** It sends no `User-Agent`, so the gateway answers the handshake with HTTP 202 `10006 Update required` and the client stays in CONNECTING forever, silently (live-checked 2026-10-13; → gotchas.md #19). Use `assets/scaffold-bot-echo/node/blaze-client.mjs` (`startBlaze(keystore, {onMessage, onOpen, onError, userAgent})`), which keeps the same protocol and acks after the handler resolves. For reference, the SDK API: `BlazeKeystoreClient(keystore, {parse, syncAck})`, a **factory function, not a class**: `new BlazeKeystoreClient(...)` throws `is not a constructor`. The client acks internally; `syncAck: true` = ack after handler resolves, `false` = ack on receipt (you take responsibility for durability). `parse: true` decodes `data_base64` into `message.data` (PLAIN_TEXT → string, SYSTEM_SAFE_SNAPSHOT → `TransferData`, APP_CARD → object); without it you get raw `data_base64` only. `loop(handler)` returns `void` (not a promise, so there is nothing to `await`/`.catch`) and auto-reconnects internally; `stopLoop()` to end. Handler: `{onMessage, onAckReceipt?, onTransfer?, onConversation?}`. (node: dist/blaze/index.d.ts)
- **Ruby** (`mixin_bot`): `start_blaze_connect` (Faye::WebSocket + EventMachine) or `blaze_async` (async-websocket; caller owns pings). Puma plugin: `plugin :mixin_blaze` with `blaze_handler` + **`blaze_ack_policy :on_receipt | :after_handler`** — exactly the trade-off above: `:on_receipt` is at-most-once (a crash between ack and handler silently loses the message), `:after_handler` is at-least-once (handlers must be idempotent). (ruby: mixin_bot 3.0.2 README)

Domain invariants:

- Idempotency key = `message_id` (stable across redeliveries). Persist processed ids before producing side effects, or make effects naturally idempotent (e.g. payment keyed on `trace_id` → → payments.md).
- Never ack a message whose handler failed "to make it go away" — that converts a retry into a silent loss.
- Ack receipts (`source: "ACKNOWLEDGE_MESSAGE_RECEIPT"`) are informational (user read your message); they are not part of the pending-queue covenant but still arrive as frames.

## Reconnect doctrine

- `Loop` (Go) returns on any disconnect or handler error; **the caller owns reconnecting**. Node's `loop()` reconnects by itself; Ruby's `start_blaze_connect` reconnects, `blaze_async` leaves it to you.
- Reconnect with **global backoff + jitter**: 1s → 2s → 4s → … capped at 60s, ±random fraction, reset after a stable connection (minutes, not seconds). Reconnect storms amplify into gateway-side blocks (below). Rate limits are undocumented — treat 202/429 as backoff signals globally, not per-request.
- **One connection per bot per gateway.** N live connections ⇒ each un-acked message is pushed to all of them ⇒ N× redelivery and N× duplicate handling. Scale out with one Blaze process feeding a work queue, not with more sockets.
- Every dial must send `LIST_PENDING_MESSAGES` (Go/Node/Ruby SDKs do this automatically) — that is what resumes the un-acked queue; skipping it means silently missing messages that arrived while disconnected.
- Multiple bots in one process: separate `BlazeClient`s, one `Loop` goroutine each.

## Case study: the IP block (ohmy.xin, 2026-09-28)

A production bot stopped receiving messages and its host got blocked by the Blaze gateway.

| | |
|---|---|
| Symptom | "Duplicate messages" reported by users; bot host unable to hold a Blaze connection; ~70-minute reconnect storms; 5,794 frames/min sustained; eventually a **gateway-scoped IP block** |
| Cause | The bot never acked `ACKNOWLEDGE_MESSAGE_RECEIPT` for inbound frames. The gateway retransmits un-acked messages **10–30×**, and each reconnect's `LIST_PENDING_MESSAGES` re-pushed the whole pending queue, which the bot again failed to ack — a feedback loop: backlog → reconnect → full backlog again → reconnect storm → block |
| Misdiagnosis to avoid | Treating it as "users double-sending" and adding a dedup cache. Dedup hides the symptom while the pending queue keeps growing; the fix is at the protocol level |
| Fix | (1) Ack correctly per the covenant above (ack-after-handler with idempotent processing). (2) Global backoff with jitter so reconnects can't storm. (3) One connection per bot. (4) Then — and only then — idempotent dispatch absorbs residual duplicates |

Rule of thumb: duplicate messages at steady rate = missing/wrong acks, not user behavior. A dedup cache alone never fixes it and the gateway will eventually block you.

## Handler patterns

- **Decode explicitly**: Go's `OnMessage` hands you `MessageView.DataBase64` — it does NOT base64-decode or JSON-parse for you. Node decodes only with `parse: true`. Ruby yields raw params per `blaze_handler`.
- **Dispatch on `category`**, switch on the PLAIN_/APP_/SYSTEM_ families; ignore unknown categories forward-compatibly.
- **Offload heavy work**: the Go read loop is synchronous — a slow `OnMessage` blocks the entire socket (read deadline is 10s; parseMessage times out pushing to `readBuffer` after 3s). Push to a durable queue and ack when enqueued-or-processed per your policy; never run HTTP fan-out, LLM calls, or tx building inline in the handler.
- **Rate-shape replies**: answering N queued messages instantly after reconnect hammers `POST /messages`; drain your reply queue with pacing and 429 backoff (limits are unpublished → custody-and-ops.md § Rate limits & retries).
- **Read receipts**: use `OnAckReceipt` (Go) / `onAckReceipt` (Node) to learn a user read your outbound message; don't poll.
- **Idempotent dispatch skeleton** (language-neutral):

```
seen = persistent set of message_id
on CREATE_MESSAGE m:
    if m.message_id in seen: ack(m); return      # redelivery — already handled
    result = handle(m)                            # side effects keyed on stable ids
    persist seen.add(m.message_id)
    ack(m)                                        # only after success (ack-after-handler)
```

## OAuth code channel

The same `wss://blaze.mixin.one` host serves a second subprotocol for OAuth QR login: **`Mixin-OAuth-1`**, action `REFRESH_OAUTH_CODE` with params `{client_id, scope, code_challenge, authorization_id}`; the server pushes `data.code_id` (render `mixin://codes/{code_id}`) then `data.authorization_code` for the PKCE exchange. Details, scopes, and keystore construction → identity-and-keys.md. (go: oauthws_test.go; docs: api/oauth/oauth.md)

## Verify it worked

Wire-level acceptance for any Blaze integration:

1. **Connect + receive**: dial with your keystore, send your bot a `PLAIN_TEXT` from a user account. Assert `onMessage`/`OnMessage` fires once with the expected `category: "PLAIN_TEXT"` and that `data_base64` decodes to the sent text. (Also proves subprotocol + gzip handling.)
2. **Single delivery ⇒ acks work**: after the handler completes, watch the socket for ~2 retransmit periods. Receiving the *same* `message_id` again while connected means your ack never reached the server (wrong policy, ack failure swallowed, or you acked a different id).
3. **Ack survives reconnect**: force a disconnect (kill the socket), reconnect (which re-sends `LIST_PENDING_MESSAGES`), and assert the previously handled `message_id` is **not** redelivered. Redelivery after a clean ack = your ack was lost or never sent — fix before shipping.
4. **Read receipts**: from the user side, open the conversation (mark read); assert `OnAckReceipt`/`onAckReceipt` fires with `source: "ACKNOWLEDGE_MESSAGE_RECEIPT"`.

## Sources

- go: blaze.go v3.25.7 (`Loop`, `BlazeListener`, `connectMixinBlaze`, `readPump`/`writePump`, `writeGzipToConn`, `parseMessage`, `writeMessageAndWait`, category constants)
- node: dist/blaze/index.d.ts 7.6.0 (BlazeKeystoreClient, BlazeOptions, BlazeHandler, MessageCategory, MessageView/TransferView/TransferData)
- ruby: mixin_bot 3.0.2 README (`start_blaze_connect`, `blaze_async`, `plugin :mixin_blaze`, `blaze_ack_policy`)
- docs: api/messages/category.md, api/messages/send.md, api/oauth/oauth.md, api/error-codes.md (7000/7001)
- live: ohmy.xin incident 2026-09-28 (retransmit 10–30×, 5,794 frames/min, ~70-min storms, gateway-scoped IP block)
