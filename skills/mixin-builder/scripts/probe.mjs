#!/usr/bin/env node
// probe.mjs — read-only live probes for the mixin-builder skill.
// Grounds ephemeral facts (computer params, registration state, outputs) at use time.
// Zero dependencies, Node >= 20. NEVER sends transactions — GET only.
//
// Usage:
//   node probe.mjs computer                          # Mixin Computer info (no auth)
//   node probe.mjs me --keystore ./keystore.json     # GET /safe/me (registration state)
//   node probe.mjs outputs --keystore ./keystore.json [--asset ASSET_ID] [--state unspent]
//   node probe.mjs snapshot <snapshot_id> --keystore ./keystore.json
//   node probe.mjs snapshots --keystore ./keystore.json [--asset ASSET_ID]   # recent ledger + paging check
//
// Keystore: JSON with app_id, session_id, session_private_key (hex or base64).
// Legacy dashboard keystores ({client_id, session_id, private_key, pin_token, pin}) are accepted too.
// Read-only: session key only — spend_private_key is never read, never required.
// Exit codes: 0 ok · 1 usage · 2 network/API error.
import fs from "node:fs";
import crypto from "node:crypto";
import process from "node:process";

const API = "https://api.mixin.one";
const COMPUTER = "https://computer.mixin.one";

function usage(exit = 1) {
  console.error(`Usage:
  node probe.mjs computer
  node probe.mjs me --keystore <path>
  node probe.mjs outputs --keystore <path> [--asset <uuid>] [--state unspent]
  node probe.mjs snapshot <snapshot_id> --keystore <path>
  node probe.mjs snapshots --keystore <path> [--asset <uuid>]`);
  process.exit(exit);
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out.flags[key] = true;
      else { out.flags[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// ---- keystore + JWT (EdDSA), per docs app/guide/generate-jwt-token.md ----

function loadKeystore(path) {
  let ks;
  try { ks = JSON.parse(fs.readFileSync(path, "utf8")); }
  catch (e) { fatal(`cannot read keystore ${path}: ${e.message}`); }
  // Legacy dashboard format → Safe-era field names (same mapping as mixin_bot's Configuration).
  if (!ks.app_id && ks.client_id) {
    ks = { ...ks, app_id: ks.client_id, session_private_key: ks.session_private_key ?? ks.private_key };
    console.error("probe: legacy keystore format (client_id/private_key) — mapped to app_id/session_private_key. See references/identity-and-keys.md § Keystore formats.");
  }
  for (const f of ["app_id", "session_id", "session_private_key"]) {
    if (!ks[f]) fatal(`keystore missing field: ${f}`);
  }
  return ks;
}

function seedFromKeyMaterial(key) {
  // Accepts: 64-byte hex (seed||pub), 32-byte hex seed, or base64 (raw-url or std) of either.
  if (/^[0-9a-fA-F]{128}$/.test(key)) return Buffer.from(key.slice(0, 64), "hex"); // 64B: first 32 = seed
  if (/^[0-9a-fA-F]{64}$/.test(key)) return Buffer.from(key, "hex");
  for (const enc of ["base64url", "base64"]) {
    try {
      const b = Buffer.from(key, enc);
      if (b.length === 64) return b.subarray(0, 32);
      if (b.length === 32) return b;
    } catch { /* try next */ }
  }
  fatal("session_private_key is not 32/64-byte hex or base64");
}

function ed25519PrivateFromSeed(seed) {
  // PKCS#8 DER wrapper for an Ed25519 seed: fixed prefix + 32-byte key.
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function signToken(ks, method, uri, body = "") {
  const seed = seedFromKeyMaterial(ks.session_private_key);
  const priv = ed25519PrivateFromSeed(seed);
  const sig = crypto.createHash("sha256").update(`${method}${uri}${body}`).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT" };
  const claims = {
    uid: ks.app_id,
    sid: ks.session_id,
    iat: now,
    exp: now + 60 * 30,
    jti: crypto.randomUUID(),
    sig,
    scp: "FULL",
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sigBytes = crypto.sign(null, Buffer.from(signingInput), priv);
  return `${signingInput}.${b64u(sigBytes)}`;
}

// membersHash: sha256 over sorted member UUIDs (16 bytes each) — matches Go
// crypto.HashMembers / Node hashMembers used by /safe/outputs.
function membersHash(members) {
  const bytes = members
    .map((u) => {
      const b = uuidToBytes(u);
      if (!b) fatal(`invalid member uuid: ${u}`);
      return b;
    })
    .sort(Buffer.compare);
  return crypto.createHash("sha256").update(Buffer.concat(bytes)).digest("hex");
}

function uuidToBytes(u) {
  const m = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(u);
  if (!m) return null;
  return Buffer.from(u.replace(/-/g, ""), "hex");
}

async function apiGet(path, token) {
  const res = await fetch(API + path, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-Request-Id": crypto.randomUUID(),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (json.error && json.error.code > 0) {
    fatal(`API ${path} -> ${json.error.code} ${json.error.description} (status ${res.status})`, 2);
  }
  return json.data ?? json;
}

function fatal(msg, code = 2) {
  console.error(`probe: ${msg}`);
  process.exit(code);
}

const stamp = () => new Date().toISOString();

// ---- commands ----

async function cmdComputer() {
  const res = await fetch(COMPUTER + "/");
  if (!res.ok) fatal(`computer.mixin.one -> HTTP ${res.status}`, 2);
  const info = await res.json();
  console.log(`# Mixin Computer @ ${stamp()}`);
  console.log(`version     : ${info.version}`);
  console.log(`height      : ${info.height}`);
  console.log(`observer    : ${info.observer}`);
  console.log(`payer (SOL) : ${info.payer}`);
  console.log(`members     : ${info.members?.members?.length} / threshold ${info.members?.threshold} (app ${info.members?.app_id})`);
  console.log(`registration: ${info.params?.operation?.price} ${info.params?.operation?.asset === "c94ac88f-4671-3976-b60a-09064f1811e8" ? "XIN" : info.params?.operation?.asset}`);
  console.log(`\nNOTE: price/members/height are ephemeral — cite this probe, not prose.`);
}

async function cmdMe(ksPath) {
  const ks = loadKeystore(ksPath);
  const token = signToken(ks, "GET", "/safe/me");
  const me = await apiGet("/safe/me", token);
  console.log(`# GET /safe/me @ ${stamp()}`);
  console.log(JSON.stringify(me, null, 2));
  console.log(`\nsequencer-registered: ${Boolean(me?.user_id)}; if this fails with 401 → JWT/signing issue (see references/identity-and-keys.md § Request auth).`);
}

// Exact 8-decimal fixed-point sum: balances are decimal strings and floats corrupt them.
function toUnits(amount) {
  const neg = amount.startsWith("-");
  const [i, f = ""] = amount.replace("-", "").split(".");
  const v = BigInt(i || "0") * 100000000n + BigInt((f + "00000000").slice(0, 8));
  return neg ? -v : v;
}
function fromUnits(v) {
  const neg = v < 0n; if (neg) v = -v;
  return `${neg ? "-" : ""}${v / 100000000n}.${(v % 100000000n).toString().padStart(8, "0")}`;
}

async function cmdOutputs(ksPath, flags) {
  const ks = loadKeystore(ksPath);
  const byAsset = {};
  const seen = new Set();
  let offset = 0, total = 0;
  for (;;) {
    const params = new URLSearchParams({
      members: membersHash([ks.app_id]),
      threshold: "1",
      offset: String(offset),
      limit: "500",
      state: flags.state || "unspent",
      order: "ASC",
    });
    if (flags.asset) params.set("asset", flags.asset);
    const path = `/safe/outputs?${params.toString()}`;
    const outs = await apiGet(path, signToken(ks, "GET", path));
    const list = Array.isArray(outs) ? outs : [];
    for (const o of list) {
      if (seen.has(o.output_id)) continue; // offset is inclusive — same dedupe as Go AssetBalanceWithSafeUser
      seen.add(o.output_id);
      const a = (byAsset[o.asset_id] ??= { sum: 0n, count: 0, inscriptions: 0 });
      a.sum += toUnits(String(o.amount)); a.count++;
      if (o.inscription_hash) a.inscriptions++;
    }
    total = seen.size;
    if (list.length < 500) break;
    const next = list[list.length - 1].sequence; // offset = numeric UTXO sequence (docs api/sequencer/outputs.md)
    if (next <= offset) break;
    offset = next;
  }
  console.log(`# GET /safe/outputs state=${flags.state || "unspent"} (${total} outputs, all pages) @ ${stamp()}`);
  console.log(`members = [${ks.app_id}] threshold 1 — balance = Σ unspent outputs; there is no balance field.`);
  for (const [a, v] of Object.entries(byAsset)) {
    const warn = v.count > 100 ? "  ⚠ >100 UTXOs: consolidate (references/payments.md § Dust & consolidation)" : "";
    const ins = v.inscriptions ? ` (${v.inscriptions} inscription UTXOs, not spendable as value)` : "";
    console.log(`${a}  ${fromUnits(v.sum)}  in ${v.count} UTXOs${ins}${warn}`);
  }
  if (!total) console.log("(no outputs) — not registered yet? run: node probe.mjs me --keystore <path>");
  console.log("asset_id → symbol/chain: GET /safe/assets/<asset_id> (references/concepts.md § Asset model)");
}

async function cmdSnapshots(ksPath, flags) {
  // Read-only: shows the newest snapshots and checks the paging contract the payment watcher
  // relies on (offset = created_at cursor, order=ASC returns rows at/after the offset, oldest first).
  const ks = loadKeystore(ksPath);
  const get = async (q) => {
    const params = new URLSearchParams({ limit: "20", ...q });
    if (flags.asset) params.set("asset", flags.asset);
    const path = `/safe/snapshots?${params.toString()}`;
    const r = await apiGet(path, signToken(ks, "GET", path));
    return Array.isArray(r) ? r : [];
  };
  const recent = await get({});
  console.log(`# GET /safe/snapshots (default order, 20) @ ${stamp()}`);
  for (const s of recent) console.log(`${s.created_at}  ${s.amount.padStart(18)}  ${s.asset_id}  opp=${s.opponent_id || "-"}  trace=${s.request_id || "-"}${s.deposit ? "  [deposit]" : ""}${s.withdrawal ? "  [withdrawal]" : ""}`);
  if (recent.length < 2) { console.log("\n(need ≥ 2 snapshots to check paging semantics)"); return; }
  const times = recent.map((s) => s.created_at).sort();
  const mid = times[Math.floor(times.length / 2)];
  const asc = await get({ offset: mid, order: "ASC" });
  const ascOk = asc.length > 0 && asc.every((s, i) => s.created_at >= mid && (i === 0 || s.created_at >= asc[i - 1].created_at));
  console.log(`\npaging check: offset=${mid} order=ASC → ${asc.length} rows, ${ascOk ? "ascending and ≥ offset ✓ (cursor paging is safe)" : "NOT ascending/after offset ✗ — do not use created_at cursor paging as written in references/reconciliation.md; report this"}`);
}

async function cmdSnapshot(id, ksPath) {
  const ks = loadKeystore(ksPath);
  const path = `/safe/snapshots/${id}`;
  const token = signToken(ks, "GET", path);
  const snap = await apiGet(path, token);
  console.log(`# GET /safe/snapshots/${id} @ ${stamp()}`);
  console.log(JSON.stringify(snap, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const ksPath = args.flags.keystore || process.env.KEYSTORE;
try {
  if (cmd === "computer") await cmdComputer();
  else if (cmd === "me") { ksPath || usage(); await cmdMe(ksPath); }
  else if (cmd === "outputs") { ksPath || usage(); await cmdOutputs(ksPath, args.flags); }
  else if (cmd === "snapshots") { ksPath || usage(); await cmdSnapshots(ksPath, args.flags); }
  else if (cmd === "snapshot") { args._[1] && ksPath ? await cmdSnapshot(args._[1], ksPath) : usage(); }
  else usage();
} catch (e) {
  fatal(e.message, 2);
}
