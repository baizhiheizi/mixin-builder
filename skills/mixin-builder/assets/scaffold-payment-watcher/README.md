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
node watcher.mjs --since=2026-10-01T00:00:00Z                   # first run only: backfill from this time
```

Env: `KEYSTORE=<path to keystore.json>` **or** the four vars `MIXIN_APP_ID`, `MIXIN_SESSION_ID`, `MIXIN_SERVER_PUBLIC_KEY`, `MIXIN_SESSION_PRIVATE_KEY`. Missing → usage + exit 1.

## Architecture

Two loops:

| Loop | What | Why |
|---|---|---|
| Blaze | `startBlaze(keystore, { onMessage })` from `blaze-client.mjs`; on `SYSTEM_SAFE_SNAPSHOT` → wake the poller | push latency; acks after the handler resolves — un-acked frames are re-delivered 10–30× (see `references/blaze.md`). Not the SDK's `BlazeKeystoreClient`: 7.6.0 sends no `User-Agent`, gets `10006`, and hangs silently |
| Poller | every 15s: `client.safe.fetchSafeSnapshots({ limit: 100, offset: cursor, order: 'ASC' })`, draining pages until caught up; credit + cursor advance commit in one sqlite transaction | snapshots REST is the source of truth; survives Blaze downtime |

Cursor rules:

- **First run starts at "now"**, not at the beginning of history — otherwise every past payment would be credited on day one. Pass `--since=<RFC3339>` to backfill on purpose.
- **Dry-run has its own cursor** (`snapshot_cursor_dry_run`). Before this split, a dry-run advanced the live cursor, and switching to `--no-dry-run` silently skipped everything the dry-run had shown.
- **ASC paging.** `offset` is a `created_at` cursor. Paging DESC from a cursor returns *older* rows, which walks the cursor backwards so new payments are never seen. `order` isn't in the docs or in Node's TS type (the Ruby gem sends it), so the watcher checks that each page is ascending and past the cursor, and throws instead of moving the cursor backwards. Run `node ../../scripts/probe.mjs snapshots --keystore ks.json` once to see the server's behaviour with your keystore.

Blaze messages are **never** trusted for amounts or treated as "already credited" — they only make the poller run sooner.

## Credit-once invariant

```sql
CREATE TABLE credits (
  snapshot_id TEXT PRIMARY KEY,  -- one credit per snapshot, ever
  user_id TEXT NOT NULL,         -- payer = snapshot opponent_id
  asset_id TEXT NOT NULL,
  amount TEXT NOT NULL,          -- decimal string, never floats
  request_id TEXT,               -- payer's trace: match to the order you issued the pay link for
  memo TEXT,                     -- hex-encoded extra
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
3. **Cursor**: `SELECT * FROM state;` — `snapshot_cursor` (live) advances to the newest `created_at`; after restart the poller resumes from there without rescanning.

## Notes

- Credited = positive `amount` **and** a Mixin `opponent_id` **and** no `deposit` view. On-chain deposits have no Mixin payer; attribute them through per-user deposit entries (`references/payments.md` § Receiving (c)). For "which order did this pay for", use `request_id` (the trace you put in the pay link). See `references/reconciliation.md` § Order payments.
- Snapshot field reference: `SafeSnapshot{ snapshot_id, user_id, opponent_id, asset_id, amount (string), created_at, ... }` (Go SDK v3.25.7 `snapshot.go`; Node returns the same shape snake_case).
- For production: reuse one long-lived sqlite file, add an alert when the cursor stalls (no new snapshots while Blaze reports activity), and read `references/reconciliation.md` before writing your own credit logic.

## Sources

- node: `@mixin.dev/mixin-node-sdk` 7.6.0 — `client.safe.fetchSafeSnapshots`, `BlazeKeystoreClient` (`dist/index.d.ts`, `dist/blaze/index.d.ts`)
- docs: `api/sequencer/snapshots.md`, `api/error-codes.md` (developers.mixin.one HEAD 2026-10-05)
- go: `snapshot.go` v3.25.7 (`SafeSnapshots`, offset = created_at ISO8601)
- verified 2026-10-11 against mixin-builder ground truth
