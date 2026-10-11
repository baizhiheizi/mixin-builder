# scaffold-payment-watcher — credit accounts when users pay

Blaze (`SYSTEM_SAFE_SNAPSHOT`) is used **only as a trigger**; `GET /safe/snapshots` (via `client.safe.fetchSafeSnapshots`) is the **ledger of truth**. Credits are recorded **exactly once** per snapshot, keyed on `snapshot_id` in sqlite. Node ≥ 22 (uses `node:sqlite`).

Requires: `@mixin.dev/mixin-node-sdk` ^7.6.0 (only runtime dep). A **read-only keystore** is enough — `spend_private_key` is never needed because nothing is signed.

## Run

```bash
npm install

# 1. dry-run FIRST (doctrine: read/dry-run before any live effect)
KEYSTORE=./keystore.json node watcher.mjs

# 2. when the dry-run output looks right:
KEYSTORE=./keystore.json node watcher.mjs --no-dry-run

# options
node watcher.mjs --asset=c94ac88f-4671-3976-b60a-09064f1811e8   # XIN only
```

Env: `KEYSTORE=<path to keystore.json>` **or** the four vars `MIXIN_APP_ID`, `MIXIN_SESSION_ID`, `MIXIN_SERVER_PUBLIC_KEY`, `MIXIN_SESSION_PRIVATE_KEY`. Missing → usage + exit 1.

## Architecture

Two loops:

| Loop | What | Why |
|---|---|---|
| Blaze | `new BlazeKeystoreClient(keystore, { parse: true, syncAck: true }).loop({ onMessage })`; on `SYSTEM_SAFE_SNAPSHOT` → wake the poller | push latency; SDK acks internally (`syncAck: true`) — un-acked frames are re-delivered 10–30× (see `references/blaze.md`) |
| Poller | every 15s: `client.safe.fetchSafeSnapshots({ limit: 100, offset: cursor, order: 'DESC' })` → reverse → process oldest→newest → advance cursor (`created_at`) | snapshots REST is the source of truth; survives Blaze downtime |

Blaze messages are **never** trusted for amounts or treated as "already credited" — they only make the poller run sooner.

## Credit-once invariant

```sql
CREATE TABLE credits (
  snapshot_id TEXT PRIMARY KEY,  -- one credit per snapshot, ever
  user_id TEXT NOT NULL,         -- payer = snapshot opponent_id
  asset_id TEXT NOT NULL,
  amount TEXT NOT NULL,          -- decimal string, never floats
  created_at TEXT NOT NULL
);
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- cursor
```

`INSERT OR IGNORE INTO credits ...` — a snapshot is credited at most once even if Blaze re-delivers it, the poller re-reads it, or the process crashes mid-run. Only rows that actually inserted (`changes > 0`) count as credits.

## Rate limits & errors

The API reports errors as **HTTP 202 with a JSON code**; `429` = rate limit (docs `api/error-codes.md`). The watcher backs off exponentially (1s → 60s cap) on 202/429, retries other errors 3×, and exits no loop on `401` (bad session keys → `references/common-errors.md`).

## Verify it worked

1. **Dry-run**: send a small transfer to the bot's mix address, watch `[dry-run] would credit snapshot=<uuid> ...` within ~15s (or instantly via Blaze trigger).
2. **Restart mid-stream**: `kill` the process while snapshots are arriving, restart with `--no-dry-run`, then check
   `sqlite3 credits.db 'SELECT snapshot_id, COUNT(*) FROM credits GROUP BY snapshot_id HAVING COUNT(*) > 1;'`
   → **must return zero rows**. Blaze duplicates during downtime print `duplicate ignored snapshot=... (sqlite PK)` instead of crediting.
3. **Cursor**: `SELECT * FROM state WHERE key='snapshot_cursor';` advances to the newest `created_at`; after restart the poller resumes from there without rescanning.

## Notes

- Deposit/credit direction is inferred from a positive `amount` with an opponent; snapshot field reference: `SafeSnapshot{ snapshot_id, user_id, opponent_id, asset_id, amount (string), created_at, ... }` (Go SDK v3.25.7 `snapshot.go`; Node returns the same shape snake_case).
- For production: reuse one long-lived sqlite file, add an alert when the cursor stalls (no new snapshots while Blaze reports activity), and read `references/reconciliation.md` before writing your own credit logic.

## Sources

- node: `@mixin.dev/mixin-node-sdk` 7.6.0 — `client.safe.fetchSafeSnapshots`, `BlazeKeystoreClient` (`dist/index.d.ts`, `dist/blaze/index.d.ts`)
- docs: `api/sequencer/snapshots.md`, `api/error-codes.md` (developers.mixin.one HEAD 2026-10-05)
- go: `snapshot.go` v3.25.7 (`SafeSnapshots`, offset = created_at ISO8601)
- verified 2026-10-11 against mixin-builder ground truth
