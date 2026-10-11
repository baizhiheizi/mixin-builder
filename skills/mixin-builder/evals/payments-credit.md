# Eval: credit accounts when users pay

## Prompt

> Build a bot that credits a user's internal account when they pay me in USDT. Payments arrive as transfers to the bot and sometimes via a mixin:// pay link. Make sure nobody gets credited twice.

## Passes when

- Receiving design: direct transfers observed via Blaze (`SYSTEM_SAFE_SNAPSHOT` as trigger only) with `/safe/snapshots` as ledger of truth; explains why `SYSTEM_ACCOUNT_SNAPSHOT` is insufficient (legacy-only).
- Credit-once: unique constraint on `snapshot_id` (or `transaction_hash`+output_index), idempotent processing, restart-safe cursor (`created_at` offset persisted after credit).
- Pay link: `mixin://pay?...` (or `https://mixin.one/pay/...`) with URL-encoded params, decimal-string amount, `trace` bound to the order; credits only when the snapshot matching the trace/amount/opponent appears — never on link click.
- Amounts decimal strings end-to-end; spend key not required anywhere (read-only keystore acceptable).
- Starts from `assets/scaffold-payment-watcher/`, runs dry-run first, and the answer ends with verification: restart mid-stream → zero double credits; duplicate Blaze frames ignored via PK.
- Rate-limit posture: poll with backoff honoring 429, not hot-looping.

## Fails when

- Credits on Blaze frame alone (redelivery ⇒ double credit) with no snapshot reconciliation.
- Uses float amounts, or trusts client-declared amounts without matching the snapshot.
- Requires `spend_private_key` for a receive-only flow.
