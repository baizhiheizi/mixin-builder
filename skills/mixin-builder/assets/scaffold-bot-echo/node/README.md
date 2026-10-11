# Node echo bot (@mixin.dev/mixin-node-sdk 7.6.0)

Minimal Blaze echo bot: replies `echo: <text>` to every inbound `PLAIN_TEXT`.

## Run

```bash
npm install
KEYSTORE=/path/to/keystore.json node index.mjs
```

Behavior:

- Keystore path from `--keystore` or `$KEYSTORE`; missing → usage on stderr, exit 1, no network.
- Only `app_id`, `session_id`, `session_private_key` are used — a messaging-only keystore works; the **spend key is never needed**.
- Keystore contents are never logged.

## What it demonstrates

- **Ack semantics**: `BlazeKeystoreClient(keystore, { parse: true, syncAck: true })` decodes gzipped frames and sends `ACKNOWLEDGE_MESSAGE_RECEIPT` itself after `onMessage` resolves — handlers never ack manually. Not acking causes gateway retransmit storms.
- **Idempotent echo**: the reply `message_id` is `sha256("echo:" + inbound_id)` formatted as a UUID, so a crash between reply and ack cannot produce duplicate replies on redelivery — the network dedupes by `message_id`.
- **Reconnect**: `client.loop(handler)` reconnects internally; the outer loop only catches fatal errors (bad keystore, handler rejection) with backoff 1s → 60s cap (×2, jitter).

## Verify it worked

1. Start the bot, open Messenger, send `/ping` to the bot → you receive exactly one `echo: /ping`.
2. `kill -9` the bot, send another message, restart → the pending message is redelivered, answered exactly once (deterministic `message_id` dedupes) — no duplicate replies.
