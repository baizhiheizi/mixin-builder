# Reconciliation: snapshots are the ledger of truth

The kernel settles UTXO transactions; the sequencer indexes them into **snapshots** — one row per balance change per participant. Never credit a user from a Blaze event alone: treat Blaze `SYSTEM_SAFE_SNAPSHOT` as a *trigger* and `GET /safe/snapshots` as the *source of truth* (Blaze can redeliver, drop, or arrive out of order). → payments.md for the UTXO model, → blaze.md for ack semantics.

## The snapshots endpoint

`GET /safe/snapshots?app=UUID&asset=UUID&opponent=UUID&offset=RFC3339NANO&limit=500` (docs: api/sequencer/snapshots.md)

- `app`, `asset`, `opponent` are **mutually exclusive** — one filter per call, not composable (docs: api/sequencer/snapshots.md). With bot auth, `app` aggregates activity across sub-users.
- `offset` is a **created_at RFC3339NANO cursor**, not a row number. `limit` caps the page (docs example 500). `order` is undocumented (see § Cursor management). Node `fetchSafeSnapshots({app?, asset?, opponent?, offset?, limit?})`; Ruby `safe_snapshots(order:)`.
- Snapshot fields (docs `_partials/_resp.safe.snapshots.md`; go: snapshot.go `SafeSnapshot` struct v3.25.7):

| Field | Meaning |
|---|---|
| `snapshot_id` | Stable UUID of this balance change — **the dedupe key** |
| `user_id` / `opponent_id` | Whose balance moved / counterparty (opponent optional) |
| `transaction_hash` | Kernel transaction hash (one tx → multiple snapshots) |
| `asset_id`, `kernel_asset_id` | Safe asset UUID + kernel asset hash |
| `amount` | Signed decimal **string** — positive = credit, negative = debit |
| `memo` | Extra payload, hex encoding |
| `request_id` | The request_id you submitted with the tx (traceability) |
| `created_at` | RFC3339NANO — the cursor field |
| `deposit` | `*SafeDepositView`: deposit_hash, deposit_index, sender, destination, tag |
| `withdrawal` | `*SafeWithdrawalView`: withdrawal_hash, receiver |

SDK pointers: go `bot.SafeSnapshots(ctx, limit, app, assetId, opponent, offset, su)` / `bot.SafeSnapshotById(ctx, id, su)` (go: snapshot.go v3.25.7); node `client.safe.fetchSafeSnapshots(params)` / `client.safe.fetchSafeSnapshot(id)` (node: dist/index.d.ts 7.6.0); ruby `MixinBot.api.safe_snapshots` (ruby: mixin_bot 3.0.2 README).

## Credit-once pattern (the invariant)

Crediting a user balance from snapshots MUST be exactly-once in effect, even though delivery is at-least-once.

1. **DB constraint**, pick one:
   - `UNIQUE(snapshot_id)` — simplest; one row per balance change.
   - `UNIQUE(transaction_hash, output_index)` — needed only if you reconcile from raw outputs instead of snapshots.
2. **Process idempotently**: `INSERT ... ON CONFLICT DO NOTHING`; if conflict, skip and continue — never increment balance twice, never error the batch.
3. **Trigger vs truth**: on Blaze `SYSTEM_SAFE_SNAPSHOT` (category exists in Node's MessageCategory union; node: dist/blaze/index.d.ts 7.6.0), wake the poller; the poller reads `/safe/snapshots` and credits from what it reads. Blaze frames carry no guarantee of delivery order or completeness — the poll is authoritative.
4. Amount handling: `amount` is a signed decimal string; parse with a decimal type, never a float. Credit on `amount > 0` with your `user_id` as the snapshot's user; a debit snapshot is a spend you already initiated (match by `request_id`).

Anti-pattern: crediting inside the Blaze handler directly off the frame. Blaze redelivers un-acked and re-delivered messages on reconnect (→ blaze.md) → double credits.

## Cursor management

- Persist `(bot_id, last_processed_created_at)` in the same transaction as the credit insert.
- **Page forward: `order=ASC&offset=<cursor>`**, process rows in returned order, and set the cursor to each row's `created_at` as you go. Keep fetching until a page comes back shorter than `limit`. **Never page DESC from a cursor**: with a `created_at` offset, DESC returns rows *older* than the cursor. Reversing such a page and advancing to its newest row walks the cursor backwards, and new payments are never seen. (An earlier version of this file and of the payment-watcher scaffold had exactly this bug.)
- `order` is not in the docs table or Node's `SafeSnapshotsRequest` type. The Ruby gem's `safe_snapshots` sends it, and Node's axios client passes extra params through unchanged. Before you rely on it, check with `scripts/probe.mjs snapshots --keystore ks.json`, and assert in code that each page is ascending and at or after the cursor. If it isn't, stop instead of advancing.
- **Shared timestamps**: `created_at` is not unique, so treat the offset as inclusive. You will re-read the boundary rows, and `UNIQUE(snapshot_id)` makes that harmless. If a full page shares one `created_at`, a timestamp cursor can't page past it; split by `asset=` or raise `limit`.
- **First run**: start the cursor at "now" (or an explicit backfill time), never at the beginning of history. Otherwise every past payment gets credited on day one.
- **Dry-run gets its own cursor.** If a dry-run advances the live cursor, the first live run silently skips everything the dry-run printed.
- Cursors are per-bot, per-filter-shape: if you poll with `asset=` filters, keep a cursor per asset (filters are mutually exclusive anyway).

## Order payments (pay link → snapshot → order)

The most common builder flow: "user pays for order #123". The trace you put in the pay link becomes the payer's transaction `request_id`, and that shows up on your incoming snapshot. Use it as the join key.

1. **Issue**: create the order row first, with `trace_id = uuidv5(order_id)` (or a random uuid stored on the order), `asset_id`, an exact decimal-string `amount` and `expires_at`. Render `https://mixin.one/pay/<bot MIX>?asset=…&amount=…&trace=<trace_id>&memo=…` (→ schemas.md §2, URL-encode every value) or `mixin://pay?…`. The memo is optional context and is hex-encoded on the snapshot. Never use it as the only key: users and wallets can edit or drop it.
2. **Match**: in the credit-once poller, for each incoming snapshot (`amount > 0`, no `deposit`), look up an order by `snapshot.request_id`. Then check `asset_id` **exactly**: USDT-on-Tron is not USDT-on-Ethereum (→ concepts.md § Asset model). Compare `amount` as decimals, not floats.
3. **Decide**, in the same DB transaction as the credit row:

   | Case | Action |
   |---|---|
   | trace matches, asset matches, amount == expected | mark order paid (`paid_snapshot_id = snapshot_id`) |
   | amount < expected | partial: hold it, or refund (below); never mark paid |
   | amount > expected | mark paid, refund or credit the excess per your policy |
   | wrong asset / expired / order already paid | refund |
   | no matching trace | "unattributed": credit by `opponent_id` if your product allows, else queue for review or refund |

4. **Refund** = an ordinary transfer back to `opponent_id`, with `trace_id = uuidv5("refund:" + snapshot_id)`. It is deterministic, so a retried refund can never double-pay (→ payments.md § Sending money). This path needs the spend key, so run it in the payments service, not in the watcher.
5. **Tell the user**: send a message or card to the payer. Go `SafeNotifySnapshot` / Ruby `create_safe_snapshot_notification` attach the snapshot receipt to the conversation.

Direct lookups: Ruby has `safe_snapshot_by_trace(trace_id)` → `GET /safe/snapshots/trace/:trace_id` (mixin_bot 3.0.2 source; not in the official docs or the Go/Node SDKs `[UNVERIFIED for other SDKs]`). Useful for a "check payment" button. The poller above stays the source of truth.

**Verify it worked**: pay a test order from a second account with an exact amount. Then pay again with the same link. The same trace maps to the same transaction request, so the wallet should treat it as already paid (a *different* payer reusing a trace gets `20125`). If a second snapshot does arrive for a paid order, it must land in the "already paid → refund" branch. Finally pay 1 unit of dust in the wrong asset and assert a refund snapshot to that payer with the deterministic refund trace.

## Monitoring queries

- **Balance per asset** = Σ unspent outputs: `GET /safe/outputs?...&state=unspent` — node `client.utxo.safeOutputs({state, limit, ...})` then `client.utxo.safeAssetBalance` (returns decimal string; node: dist/index.d.ts 7.6.0); go `bot.ListUnspentOutputs(ctx, membersHash, threshold, assetId, su)` (state=unspent, limit 500; go: output.go v3.25.7).
- **Pending deposits**: node `client.safe.pendingDeposits` (node: dist/index.d.ts 7.6.0). Chain deposits appear as snapshots with a `deposit` view only after finality — surface "seen on chain but not credited" rows to operators.
- **Outgoing tx states**: `GET /safe/transactions/:id` (docs: api/sequencer/transactions.md); go `bot.GetTransactionById(ctx, requestId, su)`, node `client.utxo.fetchTransaction(id)` (node: dist/index.d.ts 7.6.0). Poll until the corresponding snapshot appears (match `request_id` or `transaction_hash`).
- **Mismatch alarm (run on a schedule)**: per asset, compare Σ(snapshot amounts since genesis) vs Σ(unspent outputs). Drift means you dropped or double-counted a snapshot page — re-poll from the divergence point. Assert per asset: `snapshot_sum == outputs_sum`.
- Notify users proactively: go `bot.SafeNotifySnapshot(ctx, snapshotID, message, su)` / ruby `create_safe_snapshot_notification` push a snapshot card into the conversation (go: snapshot.go; ruby: mixin_bot 3.0.2 README).

## Verify it worked

Kill-test (credit-once): start the watcher, let it credit a batch, `kill -9` mid-batch, restart from the persisted cursor, run the same pages again. Assert: `COUNT(credits) == COUNT(DISTINCT snapshot_id)` and Σ(credits) == Σ(snapshot `amount > 0` for your user_id over the window) — zero double credits. Also assert the cursor advanced past the last credited `created_at`.

## Sources

- docs: api/sequencer/snapshots.md, api/sequencer/transactions.md, `_partials/_resp.safe.snapshots.md` (repo HEAD 2026-10-05)
- go: snapshot.go, output.go, transaction.go v3.25.7
- node: dist/index.d.ts, dist/blaze/index.d.ts 7.6.0
- ruby: mixin_bot 3.0.2 README
