# Node echo bot (@mixin.dev/mixin-node-sdk 7.6.0)

Minimal Blaze echo bot: replies `echo: <text>` to every inbound `PLAIN_TEXT`.

## Run

```bash
npm install
KEYSTORE=/path/to/keystore.json node index.mjs
```

You should see `blaze connected as <app_id>` within a few seconds. If you see `blaze handshake HTTP 202 ... 10006` instead, the `User-Agent` is missing or not in `name/version` form.

Behavior:

- Keystore path from `--keystore` or `$KEYSTORE`; missing → usage on stderr, exit 1, no network.
- Only `app_id`, `session_id`, `session_private_key` are used — a messaging-only keystore works; the **spend key is never needed**.
- Keystore contents are never logged.

## What it demonstrates

- **Blaze connection** (`blaze-client.mjs`): the SDK's `BlazeKeystoreClient` (7.6.0) opens the socket without a `User-Agent`. The gateway rejects that handshake with `10006 Update required` and the SDK waits forever, silently. `blaze-client.mjs` is a ~90-line replacement that sends `User-Agent: mixin-echo-bot/1.0` and reuses the SDK's `signAccessToken`, `decodeMessage` and `sendRaw`. Drop it once the SDK sends a User-Agent.
- **Ack semantics**: `ACKNOWLEDGE_MESSAGE_RECEIPT` is sent only after `onMessage` resolves. A handler that throws leaves the message un-acked, so the gateway redelivers it. Never ack before processing, and never skip acking processed messages: un-acked frames are re-sent 10–30× (→ `references/blaze.md`).
- **Idempotent echo**: the reply `message_id` is `sha256("echo:" + inbound_id)` formatted as a UUID, so a crash between reply and ack cannot produce duplicate replies on redelivery — the network dedupes by `message_id`.
- **Reconnect**: on close, reconnect with backoff 1s → 60s cap (×2, 0.5–1.5× jitter), reset after a successful open. A dead socket (no ping for 30s) is terminated and reconnected.

## Verify it worked

1. Start the bot, open Messenger, send `/ping` to the bot → you receive exactly one `echo: /ping`.
2. `kill -9` the bot, send another message, restart → the pending message is redelivered, answered exactly once (deterministic `message_id` dedupes) — no duplicate replies.
