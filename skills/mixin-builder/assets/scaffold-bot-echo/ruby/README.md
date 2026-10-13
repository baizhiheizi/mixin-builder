# Ruby echo bot (mixin_bot ~> 3.0)

Requires **Ruby ≥ 4.0**: mixin_bot 3.x declares `required_ruby_version >= 4.0.0`, so `bundle install` fails on 3.4 with "Could not find compatible versions".

Minimal Blaze echo bot: replies `echo: <text>` to every inbound `PLAIN_TEXT`.

## Run

```bash
bundle install        # or: gem install mixin_bot faye-websocket eventmachine
KEYSTORE=/path/to/keystore.json ruby echo.rb
```

Behavior:

- Keystore path from `--keystore` or `$KEYSTORE`; missing → usage, exit 1, no network.
- Only `app_id`, `session_id`, `session_private_key` are configured — a messaging-only keystore works; the **spend key is never needed**.
- Keystore contents are never logged.

## What it demonstrates

- **Ack semantics**: `on_message` sends `ACKNOWLEDGE_MESSAGE_RECEIPT` (status READ) immediately after parsing, before handling — the gateway stops redelivering. Not acking causes retransmit storms. (`mixin_bot`'s Puma plugin calls this `:on_receipt`; the alternative `:after_handler` policy requires idempotent handlers — see `references/blaze.md`.)
- **Idempotent echo**: the reply `message_id` is `sha256("echo:" + inbound_id)` formatted as a UUID, so a crash between reply and ack cannot produce duplicate replies on redelivery — the network dedupes by `message_id`.
- **Reconnect backoff**: `start_blaze_connect(reconnect: false)` + own `on_close` hook; exponential backoff 1s → 60s cap (×2, jitter), reset after a healthy 60s run.
- **Send over REST**: replies go through `API.send_text_message` (`POST /messages`), not the socket — recommended for workers.

## Verify it worked

1. Start the bot, open Messenger, send `/ping` to the bot → you receive exactly one `echo: /ping`.
2. `kill -9` the bot, send another message, restart → the pending message is redelivered (`LIST_PENDING_MESSAGES` on open), answered exactly once (deterministic `message_id` dedupes) — no duplicate replies.
