# Reconciliation: snapshots are the ledger of truth

The kernel settles UTXO transactions; the sequencer indexes them into **snapshots** — one row per balance change per participant. Never credit a user from a Blaze event alone: treat Blaze `SYSTEM_SAFE_SNAPSHOT` as a *trigger* and `GET /safe/snapshots` as the *source of truth* (Blaze can redeliver, drop, or arrive out of order). → payments.md for the UTXO model, → blaze.md for ack semantics.

## The snapshots endpoint

`GET /safe/snapshots?app=UUID&asset=UUID&opponent=UUID&offset=RFC3339NANO&limit=500` (docs: api/sequencer/snapshots.md)

- `app`, `asset`, `opponent` are **mutually exclusive** — one filter per call, not composable (docs: api/sequencer/snapshots.md). With bot auth, `app` aggregates activity across sub-users.
- `offset` is a **created_at RFC3339NANO cursor**, not a row number. `limit` caps the page (docs example 500). `order` supported by SDKs (Node `fetchSafeSnapshots({asset?, opponent?, offset?, limit?, order?})`).
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
- Restart = re-read from the cursor (start `offset` = last processed `created_at`), never from "now".
- **Clock caveat**: `created_at` ordering is not guaranteed unique — two snapshots can share a timestamp. Mitigate: page with `limit` + `order=DESC` from the cursor, then **reverse the page** before processing (oldest first), and rely on the `UNIQUE(snapshot_id)` constraint as the final guard for stragglers at the boundary. On restart, re-read one extra page before the cursor to catch late-written rows.
- Cursors are per-bot, per-filter-shape: if you poll with `asset=` filters, keep a cursor per asset (filters are mutually exclusive anyway).

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
- go: snapshot.go, output.go, transaction.go v3.25.7 (`/tmp/sdksrc/github.com/MixinNetwork/bot-api-go-client/v3@v3.25.7/`)
- node: dist/index.d.ts, dist/blaze/index.d.ts 7.6.0 (`/tmp/sdksrc/node/package/`)
- ruby: mixin_bot 3.0.2 README (`/tmp/sdksrc/mixin_bot_README.md`)
