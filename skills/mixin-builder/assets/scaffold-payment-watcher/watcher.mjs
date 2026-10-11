// Mixin payment watcher — Blaze (SYSTEM_SAFE_SNAPSHOT) as a *trigger*,
// GET /safe/snapshots as the ledger of truth, credit-once via node:sqlite.
//
// Verified symbols (mixin-builder gt.md 2026-10-11, @mixin.dev/mixin-node-sdk 7.6.0):
//   MixinApi({ keystore }) -> client.safe.fetchSafeSnapshots({ asset?, offset?, limit?, order? })
//   import { BlazeKeystoreClient } from '@mixin.dev/mixin-node-sdk/blaze'
//     new BlazeKeystoreClient(keystore, { parse: true, syncAck: true }).loop({ onMessage })
//   Message category SYSTEM_SAFE_SNAPSHOT arrives on Blaze.
// Protocol: GET /safe/snapshots (offset = created_at ISO8601, order DESC) — docs api/sequencer/snapshots.md.
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
  KEYSTORE=/path/to/keystore.json node watcher.mjs [--no-dry-run] [--asset=<asset_id>] [--db=credits.db]
  or set MIXIN_APP_ID, MIXIN_SESSION_ID, MIXIN_SERVER_PUBLIC_KEY, MIXIN_SESSION_PRIVATE_KEY

Args:
  --no-dry-run    actually insert credits (default: dry-run, prints what would be credited)
  --asset=<id>    only watch this asset id (e.g. c94ac88f-4671-3976-b60a-09064f1811e8 = XIN)
  --db=<path>     sqlite file, default credits.db
  --poll=15       poll interval seconds, default 15

A read-only keystore is enough: spend_private_key is NOT needed (we never sign).
`;

function parseArgs(argv) {
  const opts = { dryRun: true, asset: undefined, db: 'credits.db', pollSec: 15 };
  for (const a of argv) {
    if (a === '--no-dry-run') opts.dryRun = false;
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
const { BlazeKeystoreClient } = await import('@mixin.dev/mixin-node-sdk/blaze');

const client = MixinApi({ keystore });

// ---------- sqlite: credits + cursor state ----------
const db = new DatabaseSync(opts.db);
db.exec(`
  CREATE TABLE IF NOT EXISTS credits (
    snapshot_id TEXT PRIMARY KEY,   -- credit-once invariant: the network dedupes nothing for you
    user_id     TEXT NOT NULL,      -- payer (snapshot opponent)
    asset_id    TEXT NOT NULL,
    amount      TEXT NOT NULL,      -- decimal string; NEVER floats
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function getCursor() {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get('snapshot_cursor');
  return row ? row.value : null;
}
function setCursor(v) {
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('snapshot_cursor', v);
}
function creditOnce(snap) {
  // INSERT OR IGNORE: a snapshot is credited at most once even across restarts and Blaze duplicates.
  const r = db.prepare(
    'INSERT OR IGNORE INTO credits (snapshot_id, user_id, asset_id, amount, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(snap.snapshot_id, snap.user_id, snap.asset_id, snap.amount, snap.created_at);
  return r.changes > 0;
}

// ---------- rate-limit-aware fetch with backoff ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSnapshotsWithBackoff({ limit = 100, offset, order = 'DESC' }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.safe.fetchSafeSnapshots({ limit, offset, order, ...(opts.asset ? { asset: opts.asset } : {}) });
    } catch (err) {
      // HTTP 202 + body code 429 = rate limited (docs api/error-codes.md); also plain 429.
      const status = err?.status ?? err?.originalError?.response?.status;
      const code = err?.code;
      if ((status === 202 && code === 429) || status === 429) {
        const wait = Math.min(60_000, 2 ** attempt * 1000);
        console.error(`rate limited (429), backing off ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (status === 401) throw new Error('401: keystore rejected — check session keys (→ references/common-errors.md)');
      if (attempt < 3) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw err;
    }
  }
}

// ---------- reconciliation loop (the ledger of truth) ----------
async function reconcileOnce() {
  const cursor = getCursor();
  const page = await fetchSnapshotsWithBackoff({ offset: cursor ?? undefined });
  const snaps = (page ?? []).filter(Boolean);
  if (!snaps.length) return;
  // API returns DESC (newest first); process oldest→newest so the cursor never skips.
  for (const s of snaps.slice().reverse()) {
    // incoming credit: positive amount paid to us by an opponent
    const amount = String(s.amount ?? '');
    const positive = !amount.startsWith('-');
    if (positive && s.snapshot_id) {
      if (opts.dryRun) {
        console.log(`[dry-run] would credit snapshot=${s.snapshot_id} user=${s.opponent_id ?? s.user_id} asset=${s.asset_id} amount=${amount}`);
        console.log('          (credit-once would be enforced by sqlite PRIMARY KEY on snapshot_id)');
      } else if (creditOnce({ ...s, user_id: s.opponent_id ?? s.user_id })) {
        console.log(`credited snapshot=${s.snapshot_id} user=${s.opponent_id ?? s.user_id} asset=${s.asset_id} amount=${amount}`);
      } else {
        console.log(`duplicate ignored snapshot=${s.snapshot_id} (sqlite PK)`);
      }
    }
    setCursor(s.created_at); // advance cursor by created_at
  }
}

// ---------- Blaze loop (trigger only — never the source of truth) ----------
let wakePoller;
const blaze = new BlazeKeystoreClient(keystore, {
  parse: true,
  syncAck: true, // SDK acks internally; un-acked frames get re-delivered 10–30× (→ references/blaze.md)
});
const blazeLoop = blaze.loop({
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
blazeLoop.catch((err) => {
  console.error(`blaze loop exited: ${err?.message ?? err}`);
  console.error('poller keeps running on its interval; blaze auto-reconnects inside loop() (node sdk 7.6.0)');
});
