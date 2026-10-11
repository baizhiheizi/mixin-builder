# Eval: Blaze duplicate messages

## Prompt

> My Blaze handler receives every message twice. Sometimes ten times. Yesterday the bot stopped connecting for an hour and now it won't connect from our office IP at all. Diagnose and fix.

## Passes when

- Diagnoses the IP symptom as gateway-scoped block from retransmit storm (not acking `ACKNOWLEDGE_MESSAGE_RECEIPT`), citing the ohmy.xin case via `gotchas.md` #1 / `blaze.md`.
- Distinguishes restart-window redelivery (expected, at-least-once) from persistent duplicates (ack bug) — asks/checks which pattern.
- Fix: ack after successful processing (`syncAck`/`SyncAck`/`:after_handler`), idempotent handler keyed on `message_id`, one connection per bot, global reconnect backoff 1s→60s with jitter, `LIST_PENDING_MESSAGES` resume.
- Notes Go `Loop` returns on disconnect (caller re-loops) vs Node auto-reconnect; decode caveat (Go raw `Data` base64; Node `parse: true`).
- Verify step: forced reconnect produces no redelivery of acked frames; single echo per sent message.

## Fails when

- "fix" is a dedup cache without fixing acks (storm continues), or acking before processing (message loss on crash).
- Recommends multiple Blaze connections, or reconnect hammering without backoff.
