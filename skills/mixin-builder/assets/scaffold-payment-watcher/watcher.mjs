// Mixin payment watcher — Blaze (SYSTEM_SAFE_SNAPSHOT) as a *trigger*,
// GET /safe/snapshots as the ledger of truth, credit-once via node:sqlite.
//
// Verified symbols (mixin-builder references/compatibility.md 2026-10-11, @mixin.dev/mixin-node-sdk 7.6.0):
//   MixinApi({ keystore }) -> client.safe.fetchSafeSnapshots({ asset?, offset?, limit?, order? })
//   Blaze via ./blaze-client.mjs, not the SDK's BlazeKeystoreClient: 7.6.0 sends no User-Agent, the
//   gateway answers the handshake with 10006 "Update required" and the SDK hangs silently (live-checked 2026-10-13).
//   Message category SYSTEM_SAFE_SNAPSHOT arrives on Blaze.
// Protocol: GET /safe/snapshots?offset=<created_at RFC3339NANO>&order=ASC — docs api/sequencer/snapshots.md.
//   `order` is not in the docs or in Node's SafeSnapshotsRequest type, but the Ruby gem (mixin_bot 3.0.2
//   safe_snapshots) sends it and axios passes it through. The watcher asserts the page really is
//   ascending and past the cursor, and stops loudly if not. Check with `probe.mjs snapshots`.
// Errors: HTTP 202 + code 429 = rate limit; backoff and retry (docs api/error-codes.md).

import { accessSync, constants, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error('node:sqlite is required (Node >= 22). Upgrade Node or run with --experimental-sqlite on early 22.x.');
  process.exit(1);
}

const USAGE = `Usage:
  KEYSTORE=/path/to/keystore.json node watcher.mjs [--no-dry-run] [--since=<RFC3339>] [--asset=<asset_id>] [--db=credits.db]
  or set MIXIN_APP_ID, MIXIN_SESSION_ID, MIXIN_SERVER_PUBLIC_KEY, MIXIN_SESSION_PRIVATE_KEY

Args:
  --no-dry-run    actually insert credits (default: dry-run, prints what would be credited)
  --since=<ts>    first run only: start from this created_at (default: now — history is NOT credited)
  --asset=<id>    only watch this asset id (e.g. c94ac88f-4671-3976-b60a-09064f1811e8 = XIN)
  --db=<path>     sqlite file, default credits.db
  --poll=15       poll interval seconds, default 15

A read-only keystore is enough: spend_private_key is NOT needed (we never sign).
`;

function parseArgs(argv) {
  const opts = { dryRun: true, since: undefined, asset: undefined, db: 'credits.db', pollSec: 15 };
  for (const a of argv) {
    if (a === '--no-dry-run') opts.dryRun = false;
    else if (a.startsWith('--since=')) opts.since = new Date(a.slice(8)).toISOString();
    else if (a.startsWith('--asset=')) opts.asset = a.slice(8);
    else if (a.startsWith('--db=')) opts.db = a.slice(5);
    else if (a.startsWith('--poll=')) opts.pollSec = Number(a.slice(7));
    else { console.error(`unknown arg: ${a}\n\n${USAGE}`); process.exit(1); }
  }
  return opts;
}

function loadKeystore() {
  if (process.env.KEYSTORE) {
    // JSON keystore file: { app_id, session_id, server_public_key, session_private_key, ... }
    return JSON.parse(readFileSync(process.env.KEYSTORE, 'utf8'));
  }
  const { MIXIN_APP_ID, MIXIN_SESSION_ID, MIXIN_SERVER_PUBLIC_KEY, MIXIN_SESSION_PRIVATE_KEY } = process.env;
  if (MIXIN_APP_ID && MIXIN_SESSION_ID && MIXIN_SERVER_PUBLIC_KEY && MIXIN_SESSION_PRIVATE_KEY) {
    return {
      app_id: MIXIN_APP_ID,
      session_id: MIXIN_SESSION_ID,
      server_public_key: MIXIN_SERVER_PUBLIC_KEY,
      session_private_key: MIXIN_SESSION_PRIVATE_KEY,
    };
  }
  return null;
}

const opts = parseArgs(process.argv.slice(2));
const keystore = loadKeystore();
if (!keystore) {
  console.error('missing keystore: set KEYSTORE=<path> or the four MIXIN_* env vars\n');
  console.error(USAGE);
  process.exit(1);
}

const { MixinApi } = await import('@mixin.dev/mixin-node-sdk');
const { startBlaze } = await import('./blaze-client.mjs');

const client = MixinApi({ keystore });

// ---------- sqlite: credits + cursor state ----------
const db = new DatabaseSync(opts.db);
db.exec(`
  CREATE TABLE IF NOT EXISTS credits (
    snapshot_id TEXT PRIMARY KEY,   -- credit-once invariant: the network dedupes nothing for you
    user_id     TEXT NOT NULL,      -- payer (snapshot opponent)
    asset_id    TEXT NOT NULL,
    amount      TEXT NOT NULL,      -- decimal string; NEVER floats
    request_id  TEXT,               -- payer's trace: match it to the order you issued the pay link for
    memo        TEXT,               -- hex-encoded extra (decode with Buffer.from(memo, 'hex'))
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Dry-run keeps its own cursor: if it advanced the live one, switching to --no-dry-run
// would skip every snapshot the dry-run had already printed.
const CURSOR_KEY = opts.dryRun ? 'snapshot_cursor_dry_run' : 'snapshot_cursor';
function getCursor() {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(CURSOR_KEY);
  return row ? row.value : null;
}
function setCursor(v) {
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CURSOR_KEY, v);
}
if (!getCursor()) {
  // No cursor yet: start at --since or now. Starting from the beginning would credit all past payments.
  const start = opts.since ?? new Date().toISOString();
  setCursor(start);
  console.log(`no cursor yet — starting at ${start}${opts.since ? '' : ' (pass --since=<RFC3339> to backfill)'}`);
}
function creditOnce(snap) {
  // INSERT OR IGNORE: a snapshot is credited at most once even across restarts and Blaze duplicates.
  // The cursor moves in the same sqlite transaction, so a crash can't credit without advancing it, or advance it without crediting.
  db.exec('BEGIN');
  try {
    const r = db.prepare(
      'INSERT OR IGNORE INTO credits (snapshot_id, user_id, asset_id, amount, request_id, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(snap.snapshot_id, snap.opponent_id, snap.asset_id, snap.amount, snap.request_id ?? null, snap.memo ?? null, snap.created_at);
    setCursor(snap.created_at);
    db.exec('COMMIT');
    return r.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- rate-limit-aware fetch with backoff ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = 100;

async function fetchSnapshotsWithBackoff(offset) {
  for (let attempt = 0; ; attempt++) {
    try {
      // `order` isn't in the Node type, but axios passes it through as a query param (see header).
      return await client.safe.fetchSafeSnapshots({ limit: PAGE, offset, order: 'ASC', ...(opts.asset ? { asset: opts.asset } : {}) });
    } catch (err) {
      // HTTP 202 + body code 429 = rate limited (docs api/error-codes.md); also plain 429.
      const status = err?.status ?? err?.originalError?.response?.status;
      const code = err?.code;
      if ((status === 202 && code === 429) || status === 429 || code === 429) {
        const wait = Math.min(60_000, 2 ** attempt * 1000);
        console.error(`rate limited (429), backing off ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (status === 401 || code === 401) throw new Error('401: keystore rejected — check session keys (→ references/common-errors.md)');
      if (attempt < 3) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw err;
    }
  }
}

// ---------- reconciliation loop (the ledger of truth) ----------
// Drains every page past the cursor, oldest first. The cursor is a created_at, and
// several snapshots can share one, so the offset is re-read inclusively and the
// snapshot_id primary key absorbs the overlap.
async function reconcileOnce() {
  for (;;) {
    const cursor = getCursor();
    const page = ((await fetchSnapshotsWithBackoff(cursor)) ?? []).filter(Boolean);
    if (!page.length) return;
    if (page.some((s, i) => i > 0 && s.created_at < page[i - 1].created_at) || page[0].created_at < cursor) {
      // The server ignored order=ASC (or semantics changed). Stop rather than walk the cursor backwards.
      throw new Error(`snapshots page is not ascending from cursor ${cursor} — refusing to advance. Run scripts/probe.mjs snapshots and see references/reconciliation.md`);
    }
    let progressed = false;
    for (const s of page) {
      if (s.created_at > cursor) progressed = true;
      handleSnapshot(s);
    }
    if (page.length < PAGE) return; // caught up
    if (!progressed) {
      // A full page sharing one created_at: the API can't page past it with a timestamp cursor.
      throw new Error(`>${PAGE} snapshots share created_at=${cursor}; raise PAGE or page by asset`);
    }
  }
}

function handleSnapshot(s) {
  const amount = String(s.amount ?? '');
  const incoming = amount !== '' && !amount.startsWith('-') && !/^0(\.0*)?$/.test(amount);
  let skip = null;
  if (!incoming) skip = 'outgoing/zero';
  else if (s.deposit) skip = 'on-chain deposit (no Mixin payer — attribute via your per-user deposit entry)';
  else if (!s.opponent_id) skip = 'no opponent';

  if (opts.dryRun) {
    if (!skip) console.log(`[dry-run] would credit snapshot=${s.snapshot_id} user=${s.opponent_id} asset=${s.asset_id} amount=${amount} trace=${s.request_id ?? '-'}`);
    setCursor(s.created_at);
    return;
  }
  if (skip) { setCursor(s.created_at); return; }
  if (creditOnce(s)) console.log(`credited snapshot=${s.snapshot_id} user=${s.opponent_id} asset=${s.asset_id} amount=${amount} trace=${s.request_id ?? '-'}`);
  else console.log(`duplicate ignored snapshot=${s.snapshot_id} (sqlite PK)`);
}

// ---------- Blaze loop (trigger only — never the source of truth) ----------
let wakePoller;
// blaze-client acks each frame after onMessage resolves; un-acked frames are re-delivered 10–30× (→ references/blaze.md).
startBlaze(keystore, {
  userAgent: 'mixin-payment-watcher/1.0',
  onOpen: () => console.log('blaze connected (trigger only)'),
  onError: (err) => console.error(err.message),
  onMessage(msg) {
    // Any SYSTEM_SAFE_SNAPSHOT nudges the poller; reconciliation still reads /safe/snapshots.
    if (msg?.category === 'SYSTEM_SAFE_SNAPSHOT') {
      console.log(`blaze trigger: ${msg.category} snapshot=${msg.data?.snapshot_id ?? '?'} — polling`);
      wakePoller?.();
    }
    return Promise.resolve();
  },
});

// ---------- poller: every 15s, plus immediate on Blaze trigger ----------
function startPoller() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileOnce();
    } catch (err) {
      console.error(`reconcile error: ${err.message}`);
    } finally {
      running = false;
    }
  };
  wakePoller = () => { tick(); };
  setInterval(tick, opts.pollSec * 1000);
  tick();
}

console.log(`payment watcher starting (mode=${opts.dryRun ? 'DRY-RUN' : 'LIVE'}, asset=${opts.asset ?? 'ALL'}, db=${opts.db})`);
startPoller();
