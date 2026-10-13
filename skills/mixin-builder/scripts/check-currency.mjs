#!/usr/bin/env node
// check-currency.mjs — automated currency audit for the mixin-builder skill.
// Verifies: latest SDK versions, exported-symbol surfaces, scaffold syntax.
// Exit != 0 on drift (version bump, symbol added/removed, scaffold break).
//
// Usage:
//   node check-currency.mjs            # audit against scripts/baseline.json
//   node check-currency.mjs --update   # re-baseline after human review of the diff
//   node check-currency.mjs --deep     # re-extract surfaces even when versions match
//
// Sources of truth (NEVER the GitHub releases API — it lags tags; see compatibility.md):
//   Go    : https://proxy.golang.org/github.com/!mixin!network/bot-api-go-client/v3/@latest
//   Node  : https://registry.npmjs.org/@mixin.dev/mixin-node-sdk/latest
//   Ruby  : https://rubygems.org/api/v1/gems/mixin_bot.json
//   Docs  : https://api.github.com/repos/MixinNetwork/developers.mixin.one/commits?path=developers-docs/docs
//           (date of the latest default-branch commit touching doc content — repo pushed_at
//            also moves on dependabot/branch pushes and raised false drift alarms)
//   Computer: https://computer.mixin.one/ (live version string)
// Zero npm deps. Needs `tar` (bsdtar handles zip+tgz) or `unzip` for surface extraction.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BASELINE = path.join(HERE, "baseline.json");
const SKILL_ROOT = path.resolve(HERE, "..");
const ASSETS = path.join(SKILL_ROOT, "assets");

const GO_MODULE_PATH = "github.com/!mixin!network/bot-api-go-client/v3";
const failures = [];
const notes = [];

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

async function json(url) {
  const res = await fetch(url, { headers: { "User-Agent": "mixin-builder-check-currency" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ---------- surface extraction ----------

function extractDir(file, dest, kind) {
  fs.mkdirSync(dest, { recursive: true });
  if (kind === "zip") {
    try { sh("tar", ["-xf", file, "-C", dest]); return; } catch { /* fall through */ }
    sh("unzip", ["-q", file, "-d", dest]);
  } else {
    sh("tar", ["-xzf", file, "-C", dest]);
  }
}

// Descend single-child directories until we reach the dir that holds .go files
// (module zips unpack to nested github.com/<org>/<repo>/<ver>/).
function findPkgDir(start) {
  let d = start;
  for (;;) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.endsWith(".go"))) return d;
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 1) { d = path.join(d, dirs[0].name); continue; }
    return null;
  }
}

function goSurface(dir) {
  // { "transaction.go": ["BuildRawTransaction", "SendTransaction", ...], ... }
  const out = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go")).sort()) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const syms = new Set();
    for (const m of src.matchAll(/^(?:func|type)\s+([A-Z]\w+)/gm)) syms.add(m[1]);
    out[f] = [...syms].sort();
  }
  return out;
}

function nodeSurface(pkgDir) {
  const names = new Set();
  const read = (rel) => {
    const p = path.join(pkgDir, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  };
  for (const src of [read("dist/index.d.ts"), read("dist/blaze/index.d.ts")]) {
    for (const m of src.matchAll(/declare (?:const|function) ([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    const exp = /export \{([^}]+)\}/.exec(src)?.[1] ?? "";
    for (const n of exp.split(",")) {
      const t = n.trim().split(/\s+as\s+/)[0];
      if (t) names.add(t);
    }
  }
  return [...names].sort();
}

// ---------- checks ----------

async function checkGo(baseline, update, deep) {
  const latest = await json(`https://proxy.golang.org/${GO_MODULE_PATH}/@latest`);
  const v = latest.Version;
  if (v === baseline.go?.version && !deep) {
    console.log(`go    : ${v} (matches baseline)`);
    return baseline.go;
  }
  if (!baseline.go || v !== baseline.go.version) {
    notes.push(`go version: baseline ${baseline.go?.version ?? "—"} -> latest ${v}`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixin-go-"));
  const zip = path.join(tmp, "mod.zip");
  const res = await fetch(`https://proxy.golang.org/${GO_MODULE_PATH}/@v/${v}.zip`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  extractDir(zip, path.join(tmp, "x"), "zip");
  const pkg = findPkgDir(path.join(tmp, "x"));
  if (!pkg) {
    failures.push(`go surface: no .go files found in ${v} zip (extraction failed?)`);
    return baseline.go ?? { version: v, surface: {} };
  }
  const surface = goSurface(pkg);
  fs.rmSync(tmp, { recursive: true, force: true });
  const prev = baseline.go?.surface ?? {};
  const fresh = Object.keys(prev).length === 0;
  const diff = fresh ? null : diffSurfaces(prev, surface);
  if (diff) failures.push(`go surface drift (${v}):\n${diff}`);
  else console.log(`go    : ${v} — ${fresh ? "baseline created" : "surface OK"} (${Object.keys(surface).length} files)`);
  return { version: v, surface };
}

async function checkNode(baseline, update, deep) {
  const meta = await json("https://registry.npmjs.org/@mixin.dev/mixin-node-sdk/latest");
  const v = meta.version;
  if (v === baseline.node?.version && !deep) {
    console.log(`node  : ${v} (matches baseline)`);
    return baseline.node;
  }
  if (!baseline.node || v !== baseline.node.version) notes.push(`node version: baseline ${baseline.node?.version ?? "—"} -> latest ${v}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixin-node-"));
  const tgz = path.join(tmp, "pkg.tgz");
  const res = await fetch(meta.dist.tarball);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  extractDir(tgz, path.join(tmp, "x"), "tgz");
  const surface = nodeSurface(path.join(tmp, "x", "package"));
  fs.rmSync(tmp, { recursive: true, force: true });
  const prev = baseline.node?.surface ?? [];
  const fresh = prev.length === 0;
  const added = surface.filter((s) => !prev.includes(s));
  const removed = fresh ? [] : prev.filter((s) => !surface.includes(s));
  if (!fresh && (added.length || removed.length)) {
    failures.push(`node surface drift (${v}): +[${added}] -[${removed}]`);
  } else console.log(`node  : ${v} — ${fresh ? "baseline created" : "surface OK"} (${surface.length} exports)`);
  return { version: v, surface };
}

async function checkSimple(baseline, key, url, pick, label) {
  const data = await json(url);
  const v = pick(data);
  const prev = baseline[key]?.version;
  const first = prev === undefined;
  if (!first && v !== prev) {
    notes.push(`${key} version: baseline ${prev} -> latest ${v}`);
    failures.push(`${label} changed: ${prev} -> ${v} (review references/*, then --update)`);
  } else console.log(`${key.padEnd(5)}: ${v} (${first ? "baseline created" : "matches baseline"})`);
  return { ...baseline[key], version: v, raw: data };
}

async function checkComputer(baseline) {
  const res = await fetch("https://computer.mixin.one/");
  if (!res.ok) { failures.push(`computer.mixin.one -> HTTP ${res.status}`); return baseline.computer; }
  const info = await res.json();
  const summary = {
    version: info.version,
    members: info.members?.members?.length,
    threshold: info.members?.threshold,
    operation_price: info.params?.operation?.price,
  };
  const prev = baseline.computer;
  const drift = ["version", "members", "threshold", "operation_price"]
    .filter((k) => prev && prev[k] !== summary[k])
    .map((k) => `${k}: ${prev[k]} -> ${summary[k]}`);
  if (drift.length) notes.push(`computer: ${drift.join(", ")} (update references/computer.md live values if material)`);
  else console.log(`computer: ${summary.version} — ${summary.members}/${summary.threshold}, ${summary.operation_price} XIN register`);
  return summary;
}

function diffSurfaces(prev, next) {
  const lines = [];
  const files = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const f of [...files].sort()) {
    const a = prev[f] ?? [], b = next[f] ?? [];
    const add = b.filter((s) => !a.includes(s));
    const del = a.filter((s) => !b.includes(s));
    if (add.length || del.length) lines.push(`  ${f}: +[${add}] -[${del}]`);
  }
  return lines.length ? lines.join("\n") : null;
}

function checkScaffolds() {
  // Node scaffolds: syntax check.
  const mjs = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) mjs.push(p);
    }
  };
  walk(ASSETS);
  for (const f of mjs) {
    try { sh(process.execPath, ["--check", f]); } catch (e) { failures.push(`scaffold syntax: ${f}\n${e.message}`); }
  }
  console.log(`scaffold: ${mjs.length} .mjs files pass node --check`);
  // Ruby: syntax check when ruby exists.
  try {
    const rbs = [];
    const walkRb = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walkRb(p);
        else if (e.name.endsWith(".rb")) rbs.push(p);
      }
    };
    walkRb(ASSETS);
    for (const f of rbs) { try { sh("ruby", ["-c", f]); } catch (e) { failures.push(`scaffold syntax: ${f}\n${e.message}`); } }
    console.log(`scaffold: ${rbs.length} .rb files pass ruby -c`);
  } catch { console.log("scaffold: ruby not installed — .rb not checked (CI covers)"); }
  // Go: build when a real toolchain exists (skip version-manager shims that error).
  try {
    sh("sh", ["-c", "command -v go >/dev/null && go version >/dev/null 2>&1"]);
    const gos = path.join(ASSETS, "scaffold-bot-echo", "go");
    if (fs.existsSync(gos)) {
      try { sh("go", ["build", "-o", fs.mkdtempSync(path.join(os.tmpdir(), "mixin-gobuild-")) + path.sep, "./..."], { cwd: gos }); /* -o tmp dir: a bare build drops the binary into the scaffold */ console.log("scaffold: go build OK"); }
      catch (e) { failures.push(`go scaffold build failed:\n${e.message}`); }
    }
  } catch { console.log("scaffold: go not installed — go scaffold not compiled (CI covers)"); }
}

// ---------- main ----------

const flags = new Set(process.argv.slice(2));
const update = flags.has("--update");
const deep = flags.has("--deep") || update; // --update must re-extract surfaces: a version-match early return would otherwise re-commit a stale/tampered baseline silently.
let baseline = {};
try { baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")); }
catch { notes.push("no baseline.json — generating fresh (first run)"); }

const next = {
  generatedAt: new Date().toISOString(),
  go: await checkGo(baseline, update, deep),
  node: await checkNode(baseline, update, deep),
  ruby: await checkSimple(baseline, "ruby", "https://rubygems.org/api/v1/gems/mixin_bot.json", (d) => d.version, "ruby mixin_bot"),
  docs: await checkSimple(baseline, "docs", "https://api.github.com/repos/MixinNetwork/developers.mixin.one/commits?path=developers-docs/docs&per_page=1", (d) => d[0]?.commit?.committer?.date, "docs content last commit"),
  computer: await checkComputer(baseline),
};
checkScaffolds();

if (update) {
  delete next.ruby.raw; delete next.docs.raw;
  fs.writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
  console.log(`\nbaseline.json updated (${next.generatedAt}). Commit it with the matching references/ changes.`);
} else if (notes.length) {
  console.log("\nNOTES:");
  for (const n of notes) console.log(`  - ${n}`);
}

if (failures.length) {
  console.error("\nDRIFT DETECTED:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nReview references/ against the drift, fix content, then re-run with --update.");
  process.exit(1);
}
console.log("\nOK — skill content is current.");
