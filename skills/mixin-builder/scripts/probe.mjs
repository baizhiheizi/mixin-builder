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
//
// Keystore: JSON with app_id, session_id, session_private_key (hex or base64).
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
  node probe.mjs snapshot <snapshot_id> --keystore <path>`);
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
  console.log(`\nsequencer-registered: ${Boolean(me?.user_id)}; if this fails with 401 → JWT/signing issue (see references/identity-and-keys.md §3).`);
}

async function cmdOutputs(ksPath, flags) {
  const ks = loadKeystore(ksPath);
  const params = new URLSearchParams({
    members: membersHash([ks.app_id]),
    threshold: "1",
    state: flags.state || "unspent",
    limit: "50",
    order: "ASC",
  });
  if (flags.asset) params.set("asset", flags.asset);
  const path = `/safe/outputs?${params.toString()}`;
  const token = signToken(ks, "GET", path);
  const outs = await apiGet(path, token);
  const list = Array.isArray(outs) ? outs : [];
  const byAsset = {};
  for (const o of list) byAsset[o.asset_id] = (byAsset[o.asset_id] || 0) + Number(o.amount);
  console.log(`# GET /safe/outputs (first ${list.length}) @ ${stamp()}`);
  for (const [a, sum] of Object.entries(byAsset)) console.log(`${a}  ≈ ${sum.toFixed(8)}  (display only — use decimal strings in code)`);
  if (!list.length) console.log("(no outputs in range)");
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
  else if (cmd === "snapshot") { args._[1] && ksPath ? await cmdSnapshot(args._[1], ksPath) : usage(); }
  else usage();
} catch (e) {
  fatal(e.message, 2);
}
