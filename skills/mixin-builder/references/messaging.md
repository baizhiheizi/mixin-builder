# Messaging

Protocol-first reference for sending messages via `POST /messages`, receiving them over Blaze, and managing conversations. Wire semantics here; connection/ack loop details → `blaze.md`; attachments upload flow below; payments in message bodies → `payments.md`.

## Message envelope

`POST /messages` — authorized (JWT `FULL` for bots). Body is an **array** of message objects; returns empty JSON on success (docs: api/messages/send.md):

```json
[
  {
    "conversation_id": "UUID",
    "recipient_id": "UUID",
    "message_id": "UUID",
    "category": "PLAIN_TEXT",
    "representative_id": "UUID",
    "quote_message_id": "UUID",
    "data_base64": "Base64 encoded data"
  }
]
```

`data_base64` = base64 of the category payload (Go SDK uses RawURL encoding; go: blaze.go v3.25.7). `representative_id` and `quote_message_id` are optional. Sending is also possible in-band over the Blaze websocket (`CREATE_MESSAGE` action with the same params) — Go `BlazeClient.SendMessage`/`SendPlainText`/`SendAppCard`/`SendRecallMessage` use that path (go: blaze.go v3.25.7).

SDKs: Go `PostMessage` / `PostMessageRequest(*MessageRequest)` / `PostMessages(batch)`; Node `client.message.sendOne/sendBatch(MessageRequest[])`; Ruby via the API modules (go: message.go; node: dist/index.d.ts 7.6.0; ruby: mixin_bot 3.0.2 README).

Extra send params the official client uses over Blaze `CREATE_MESSAGE` (ios-app@master `BlazeMessageParam.swift`; REST accepts the same fields where the SDKs expose them):

| Param | Type | Meaning |
|---|---|---|
| `mentions` | array of user uuids | mention pings — iOS derives them from `@identity_number` occurrences in group text |
| `silent` | bool | deliver without a push notification |
| `expire_in` | int64 seconds | per-message TTL (disappearing message); conversation-level default via `PATCH /conversations/:id` `{"duration": seconds}` (iOS `updateExpireIn`, Node `conversation.disappearDuration`) |

## 1. Categories

Bots can **send** only `PLAIN_*`, `APP_CARD`, `APP_BUTTON_GROUP`, and `MESSAGE_RECALL`. `SYSTEM_*` categories are inbound-only (arrive via Blaze). `MESSAGE_PIN` and `SYSTEM_ACCOUNT_SNAPSHOT` are user-client/System categories — bots receive them, never emit them (docs: api/messages/category.md; node MessageCategory union).

| Category | `data_base64` payload (after decode) | Direction |
|---|---|---|
| `PLAIN_TEXT` | UTF-8 text | bot ↔ user |
| `PLAIN_POST` | Markdown text | bot ↔ user |
| `PLAIN_STICKER` | JSON `{"sticker_id": "UUID"}` | bot ↔ user |
| `PLAIN_IMAGE` | JSON `{attachment_id, mime_type, width, height, size, thumbnail}` | bot ↔ user |
| `PLAIN_DATA` (file) | JSON `{attachment_id, mime_type, size, name}` | bot ↔ user |
| `PLAIN_VIDEO` | JSON `{attachment_id, mime_type, width, height, size, duration, thumbnail}` | bot ↔ user |
| `PLAIN_AUDIO` | JSON `{attachment_id, mime_type, size, waveform, duration, created_at}` | bot ↔ user |
| `PLAIN_LIVE` | JSON `{width, height, thumb_url, url}` (url = HLS m3u8) | bot ↔ user |
| `PLAIN_LOCATION` | JSON `{longitude, latitude, name, address}` | bot ↔ user |
| `PLAIN_CONTACT` | JSON `{"user_id": "UUID"}` | bot ↔ user |
| `PLAIN_TRANSCRIPT` | JSON — bundle of quoted messages (user-client "forward/combine" feature; iOS renders it) | user clients, bot receives |
| `PLAIN_JSON` | client-internal control channel (device transfer, batch acks) — never emit | internal |
| `APP_CARD` | JSON, see next section | bot → user |
| `APP_BUTTON_GROUP` | JSON array, see next section | bot → user |
| `MESSAGE_RECALL` | JSON `{"message_id": "<recalled message UUID>"}` (go: blaze.go `SendRecallMessage` v3.25.7) | bot → user |
| `SYSTEM_CONVERSATION` | group lifecycle JSON `{action, participant_id, user_id?, role?, expire_in?}`; actions CREATE/UPDATE/ADD/REMOVE/JOIN/EXIT/ROLE/EXPIRE (ios-app@master) | inbound only |
| `SYSTEM_ACCOUNT_SNAPSHOT` | legacy transfer notification JSON (type, snapshot_id, opponent_id, asset_id, amount, trace_id, memo) | inbound only |
| `SYSTEM_SAFE_SNAPSHOT` | Safe snapshot notification (also delivered via Blaze onTransfer) | inbound only |
| `SYSTEM_SAFE_INSCRIPTION` | inscription events | inbound only |
| `SYSTEM_USER` / `SYSTEM_CIRCLE` / `SYSTEM_SESSION` | user/circle/session lifecycle events (user clients emit/consume; bots may observe) | inbound only |
| `MESSAGE_PIN` | JSON `{action: "PIN"\|"UNPIN", message_ids: [...]}` | user clients |

Also in the wild (ios-app@master MessageCategory): `SIGNAL_*` (user↔user Signal-encrypted twins of PLAIN_*), `WEBRTC_AUDIO_*` + `WEBRTC_ICE_CANDIDATE` (1:1 calls), `KRAKEN_*` (group calls), `ENCRYPTED_*` (§5). Ignore unknown categories forward-compatibly.

(docs: api/messages/category.md + src responses.js; node: dist/index.d.ts 7.6.0 MessageCategory; ios-app@master Message.swift)

### App capabilities change what arrives (ios-app@master, verified 2026-10-17)

The app object carries a `capabilities` array (⚠️ the API JSON key is **misspelled `capabilites`** — iOS decodes both `CodingKeys.capabilities = "capabilites"` and its SQL column uses the typo):

| Capability | Effect |
|---|---|
| `ENCRYPTED` | iOS sends user→bot messages as **`ENCRYPTED_*`** instead of `PLAIN_*` (SendMessageService+Sending.swift). A bot opted into ENCRYPTED **must** implement session decryption (§5) or it receives ciphertext only. Groups: only `_TEXT` is upgraded, and only for the addressed bot (below). |
| `GROUP` | makes the app a group bot: iOS routes group text messages prefixed `@700xxxx ` (the bot's identity number + space) directly to that bot via `recipient_id`; other group traffic stays SIGNAL_* among users (SendMessageService.swift `groupMessageRecipientAppId`). |
| `IMMERSIVE` | webview runs immersive (→ webview.md). |

### Attachments (images/files/video/audio)

Media categories require `attachment_id` obtained first:

1. `POST /attachments` with empty body fields (`attachment_id`, `upload_url`, `view_url` all `""`) → response returns `attachment_id`, `upload_url`, `view_url`.
2. Upload raw bytes to `upload_url` (pre-signed S3 POST; docs link AWS sigv4 post-example).
3. Send PLAIN_IMAGE/DATA/VIDEO/AUDIO with that `attachment_id` in the JSON payload.

SDKs: Go `CreateAttachment`/`AttachmentShow` (go: attachment.go); Node `client.attachment` helpers; Ruby API modules (docs: api/messages/attachment-upload.md).

## 2. APP_CARD anatomy

iOS decodes the card as **two generations** (ios-app@master `AppCardData.swift`): if a non-empty legacy `action` string is present the whole card parses as **V0** (legacy); otherwise as **V1** (new style). So `action` doesn't just "take precedence" — it selects the model; never mix generations.

V0 (legacy) — exactly what Go's helper builds:

```json
{
  "app_id": "7404c815-0393-4ea3-b08efe4c72da",
  "icon_url": "https://…/logo.png",
  "title": "Mixin",
  "description": "Hello World.",
  "action": "https://mixin.one",
  "shareable": true,
  "updated_at": "2026-10-17T00:00:00Z"
}
```

V1 (new style, no `action` key):

```json
{
  "app_id": "7404c815-0393-4ea3-b9f2-b08efe4c72da",
  "cover_url": "https://…/cover.png",
  "cover": {"url": "https://…/cover.png", "mime_type": "image/png", "width": 1280, "height": 800, "thumbnail": "<blurhash>"},
  "title": "Mixin",
  "description": "Hello World.",
  "actions": [
    { "label": "Mixin Website", "color": "#ABABAB", "action": "https://mixin.one" }
  ],
  "shareable": true,
  "updated_at": "2026-10-17T00:00:00Z"
}
```

| Field | Generation | Constraint | Notes |
|---|---|---|---|
| `app_id` | both | uuid | required in V1 (iOS `decode`, not optional); sender identity |
| `title` | V0 required / V1 optional | V0: 1 ≤ len ≤ 36 | V1 falls back to `description` in digests |
| `description` | V0 required / V1 optional | 1 ≤ len ≤ 1024 | iOS link-detects identity numbers inside it |
| `cover_url` | V1 | image URL, 16:10 aspect | plain-string cover |
| `cover` | V1 | object `{url, mime_type, width, height, thumbnail}` | richer than `cover_url`: `thumbnail` is a **blurhash** string rendered instantly; ratio computed from width/height. iOS prefers `cover` when present with a usable `url` |
| `actions[]` | V1 | 0–6 entries | `{label, color, action}`; omitted → no buttons (iOS decodes to `[]`) |
| `action` | V0 only | URL string | **legacy** — its presence forces V0 parsing; ignored in V1 |
| `shareable` | V1 **required** / V0 optional | bool | ⚠️ iOS V1 decode **fails without the key** (renders nothing) — always send it. Forwarding also requires every action to be `mixin`/`http`/`https` (no `input:` actions) |
| `icon_url` | V0 required | URL | legacy thumbnail |
| `updated_at` | both | ISO timestamp | client-side cache hint |

### Action schemas

Tap routing (ios-app@master `ConversationViewController`): every action first goes through the deep-link router (→ schemas.md) — `mixin://…` opens in-app (profile, pay sheet, send, …); `http(s)://` opens the webview; anything else is "external" (also: `https` with host ≠ `mixin.one` counts as external).

| `action` value | Behavior |
|---|---|
| `https://…` | Opens webview; domain **must be whitelisted in the dashboard** (Resource Patterns) — iOS re-checks `app.resourcePatterns` against the URL before opening, including for signature requests `[VERIFIED ios-app@master]` |
| `mixin://users/:user_id` | Open a user profile (docs: schema.md) |
| `mixin://conversations/:conversation_id?user=user_id` | Jump to a conversation (docs: schema.md) |
| `mixin://pay?recipient=&asset=&amount=&memo=&trace=` | Open payment sheet (docs: schema.md) |
| `mixin://send?category=CATEGORY&conversation=CONV_ID&data=DATA` | Pre-fill a message draft (docs: schema.md) |
| `input:<text>` | Button tap auto-sends `<text>` to the bot as a text message (docs: app/design/user-interaction.md; verified `openInputAction` ios-app@master — sent as the user's message, encrypted per conversation policy) |
| `input:share` | ❌ **does not exist** — no handler anywhere in ios-app@master (2026-10-17); do not use |

Go helper `BlazeClient.SendAppCard(convId, recipientId, title, description, action, iconUrl)` builds the **legacy** shape (no cover/actions/shareable) — for new-style cards marshal the JSON yourself and use `PostMessageRequest` (go: blaze.go v3.25.7). Node: `client.message.sendAppCard(userID, payload)`.

### APP_BUTTON_GROUP

Payload = JSON **array** of `{label, color, action}` objects; `1 ≤ size(label) ≤ 36`, `1 ≤ size(array) ≤ 6`; action schema same as card actions. Node: `client.message.sendAppButton` (docs: api/messages/category.md responses; node: dist/index.d.ts 7.6.0).

## 3. Idempotency

- `message_id` is the dedupe key: the server treats a repeated `message_id` as the same message — one visible delivery.
- Derive `message_id` deterministically from intent (uuid v5-style hash of `intent + conversation_id + recipient`) so a retried `POST /messages` after a timeout/5xx cannot double-send. Go: `UuidFromString`/`UuidFromBytes` (go: uuid.go).
- Batch limits: **≤ 100 messages per `POST /messages`, request body ≤ 128 KB** (docs: api/messages/send.md; node: sendBatch doc 7.6.0). Oversize → split batches, not payloads.
- This same key discipline is mandatory for Blaze handlers: un-acked messages are re-delivered on reconnect, so handlers must be idempotent on `message_id` → `blaze.md`.

## 4. Conversations

Two shapes:

- **CONTACT** — 1:1 conversation with a **deterministic id**: `UniqueConversationId(userId, peerId)` (Go, sorts ids internally) / `uniqueConversationID(userID, recipientID)` (Node). No creation call needed for sending; `CreateContactConversation` (Go) / `conversation.createContact(userID)` (Node) materializes it explicitly.
- **GROUP** — random UUID created by you: `CreateGroupConversation` (Go) / `conversation.createGroup(conversationID, name, ParticipantRequest[])` (Node). Max group size constraint surfaces as error 20116 "group full" (docs: api/error-codes.md).

Participant management: Go `UpdateParticipants(ctx, conv, action, ...)`; Node `conversation.updateParticipants(convID, 'ADD'|'REMOVE'|'ROLE', participants)` plus convenience `addParticipants` / `removeParticipants` / `setAdmin` / `revokeAdmin`. Read via `ConversationShow` (Go) / `conversation.fetch` (Node). Other verified Node ops: `joinGroup(codeID)`, `exitGroup`, `resetGroupCode`, `updateGroupInfo` (use for group name/announcement), `mute(convID, seconds)`, `unmute`, `disappearDuration`. Also `RotateConversation` / `JoinConversation` exist in Go (go: conversation.go; node: dist/index.d.ts 7.6.0).

**Circles**: user-side contact grouping (conversations can belong to circles). REST: `GET /circles`, create/update/delete, `GET /circles/:id`, list items, add/remove conversations — scopes `CIRCLES:READ` / `CIRCLES:WRITE`; too many circles → error 20133. Node client exposes `client.circle` (docs: api/circles/*.md).

## 5. Encrypted messages

`ENCRYPTED_*` categories carry the same logical payloads but wrapped for user↔user privacy. Bots normally send PLAIN_*; encrypted sending is needed when operating on behalf of a user (e.g. OAuth keystores) or messaging users who require it.

- Fetch recipient session public keys: `POST /sessions/fetch` with an array of user_ids → per-user sessions (Ed25519 public keys; a user may have several sessions; non-existent users are silently dropped). Go: `FetchUserSessions` (go: session.go); Ruby uses the `session_store` pattern (CacheStoreAdapter caching sessions; ruby: mixin_bot 3.0.2 README); Node via `client.user` session helpers.
- Binary layout of the encrypted blob (docs: api/messages/encrypted.md):

```
version(1B) || session_size(2B LE, ≤510) || sender public key
|| encrypted message key per receiver session…
|| nonce || encrypted message data
```

Each per-session key block = `session_id || AESCBC(message_key, shared_secret, iv)` where `shared_secret = ECDH(sender session private key, receiver session public key)`; the random per-message key AES-CBC-encrypts the body. Send via `POST /encrypted_messages` (array payload; returns per-message status array); Go `PostEncryptedMessages` / `EncryptMessageData` / `DecryptMessageData`.
- Conversation **checksum** = md5 hex of sorted (ASC) `session_id` values — use `GenerateUserChecksum` semantics to detect new devices/sessions and re-fetch (docs: api/messages/encrypted.md; go: user.go `GenerateUserChecksum`).

## 6. Users & discovery

- **Search by identity number / phone**: `GET /search/:q` (scope PROFILE:READ). ⚠️ Rate-limited hard: on 429 wait **12 hours** before retrying (docs limitation note, api/users/search.md). Go `SearchUser(ctx, keyword, accessToken)`; Node `user.search(identityNumberOrPhone)`; Ruby `search_user`.
- **Fetch profiles**: `GET /users/:id`, `POST /users/fetch` (batch of ids). Go `GetUser`/`GetUsers`; Node `user.fetch(id)` / `user.fetchList(ids)`.
- **Relationships / contacts**: `user.friends()`, `user.blockings()`, `updateRelationships` (Node); REST docs api/users/relationships.md, api/users/contacts.md.
- **Representative sending**: with the OAuth scope `MESSAGES:REPRESENT`, set `representative_id` on the message object so the message appears sent by the represented user through your app (go: `MessageRequest.RepresentativeId`; docs: api/oauth/scope.md).

## 7. Verify it worked

- **Send (REST)**: `POST /messages` returns empty JSON on success — treat non-202/exception as failure. For delivery confirmation, watch the sender side: Blaze `onAckReceipt` (`ACKNOWLEDGE_MESSAGE_RECEIPT` frames) reports recipient read/delivery state per `message_id` (node: blaze handler `onAckReceipt`; go: `BlazeListener.OnAckReceipt`). Assert the frame's `message_id` matches.
- **Send (Blaze)**: `BlazeClient.SendMessage` waits synchronously for the server ack (`writeMessageAndWait`) — an error return means not accepted (go: blaze.go v3.25.7).
- **Recall**: send `MESSAGE_RECALL` with the target `message_id`, then assert the peer's client shows the original as recalled; over Blaze the recall is itself acknowledged via the ack receipt.
- **Card / buttons**: only tap-through on a **real device** confirms `action`/`actions` render and the URL scheme fires — new-style fields silently vanish on Messenger < 1.9.0.
- **Idempotency**: send the same `message_id` twice with different data; assert exactly one message is visible and the first payload wins.
- **Batch**: response is empty JSON — verify by observing deliveries/acks for every `message_id` in the batch, not the response body.

## Sources

- docs: api/messages/{category,send,read,encrypted,attachment-upload,attachment-download}.md, src/components/api/APIResponse/responses.js (repo MixinNetwork/developers.mixin.one HEAD 2026-10-05)
- docs: api/users/{search,sessions,relationships,contacts}.md, api/circles/*, api/error-codes.md, schema.md, api/oauth/scope.md
- go: bot-api-go-client v3.25.7 — blaze.go, message.go, conversation.go, utils.go, uuid.go, session.go, user.go, attachment.go
- node: @mixin.dev/mixin-node-sdk 7.6.0 dist/index.d.ts, dist/blaze/index.d.ts
- ruby: mixin_bot 3.0.2 README
- iOS client: MixinNetwork/ios-app master @ 2026-10-17 (v6.3.4) — Message.swift (categories), AppCardData.swift (V0/V1), AppButtonData.swift, ConversationViewController.swift (input actions, card tap routing), SendMessageService+Sending.swift + SendMessageService.swift (capabilities, @700 addressing, send params), BlazeMessageParam.swift, SystemConversationMessagePayload.swift
