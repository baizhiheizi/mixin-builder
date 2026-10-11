# Go echo bot (bot-api-go-client v3.25.7)

Minimal Blaze echo bot: replies `echo: <text>` to every inbound `PLAIN_TEXT`.

## Run

```bash
go mod tidy          # resolves transitive deps (mixin, gofrs/uuid, ...)
KEYSTORE=/path/to/keystore.json go run .
```

Behavior:

- Keystore path from `--keystore` or `$KEYSTORE`; missing → usage on stderr, exit 1, no network.
- Only `app_id`, `session_id`, `session_private_key` are read — a messaging-only keystore works; the **spend key is never needed** and never loaded.
- Keystore contents are never logged.

## What it demonstrates

- **Ack semantics**: `SyncAck() == true` makes the SDK send `ACKNOWLEDGE_MESSAGE_RECEIPT {message_id, status:READ}` after `OnMessage` returns (blaze.go `Loop`). Not acking causes gateway retransmit storms.
- **Idempotent echo**: the reply `message_id` is derived deterministically from the inbound `message_id` (`sha256("echo:"+id)` → UUID), so a crash between reply and ack cannot produce duplicate replies on redelivery — the network dedupes by `message_id`.
- **Reconnect backoff**: `Loop` returns on disconnect; the caller re-loops with exponential backoff 1s → 60s cap (×2, ±50% jitter, reset after a healthy 60s run).

## Verify it worked

1. Start the bot, open Messenger, send `/ping` to the bot → you receive exactly one `echo: /ping`.
2. `kill -9` the bot, send another message, restart → the pending message is redelivered, answered exactly once (deterministic `message_id` dedupes) — no duplicate replies.
