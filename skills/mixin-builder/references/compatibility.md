# Compatibility — verified-against matrix

Last full verification: **2026-10-11** (method below). This file is the skill's truth anchor: every SDK symbol used in the references was read from these exact versions. Re-verify before extending content, and after any SDK release.

## Matrix

| Layer | Pinned / verified | Where checked | Notes |
|---|---|---|---|
| Go SDK `github.com/MixinNetwork/bot-api-go-client/v3` | **v3.25.7** (tag hash `95adbb4e`, released 2026-09-15) | module zip from `https://proxy.golang.org/github.com/!mixin!network/bot-api-go-client/v3/@v/v3.25.7.zip` | ⚠️ GitHub `releases/latest` says v3.24.7 — the releases API is stale; tags are ahead. **Always use the Go module proxy**, not the releases API. |
| Mixin Computer | **v0.9.1-a37afa3**, height 455620165, 7 members / threshold 5, operation price **0.001 XIN** | live `GET https://computer.mixin.one/` on 2026-10-11 | Ephemeral values (height, price, members) — always re-probe; `scripts/probe.mjs computer` does it. |
| MTG libraries | `github.com/MixinNetwork/safe` **v0.28.2** (mtg package) · `github.com/MixinNetwork/multi-party-sig` **v0.7.0** (frost) | module-proxy zips, exports listed for `mtg.md` | `github.com/MixinNetwork/computer` HEAD (config/example.toml, solana/{node,observer,signer}.go, store/) read for `mtg.md` + `computer.md`. |
| Official docs `developers.mixin.one` | docs content last changed **2026-08-02** (`48398f1`; default branch, `developers-docs/docs`) | `codeload.github.com/MixinNetwork/developers.mixin.one/tar.gz/HEAD` | MTG section deleted (commit `48398f1`); App-Security dashboard tab (commit `bd4dc94`, 2026-09-02) still undocumented. |
| Endpoints | `api.mixin.one` REST, `wss://blaze.mixin.one` (subprotocols `Mixin-Blaze-1`, `Mixin-OAuth-1`) | SDK source + docs | Stable since 2026; blaze subprotocol confirmed in Go SDK `blaze.go` + `oauthws_test.go`. |

## What was verified, and how

1. **Export surfaces** — every exported Go func/type grepped per file from the v3.25.7 zip; Node surface read from `dist/index.d.ts` + `dist/blaze/index.d.ts`; Ruby surface from the 3.0.2 README/API map. Symbols in `references/*` come only from these lists (plus `github.com/MixinNetwork/safe`'s `mtg` package for `mtg.md`, fetched the same way).
2. **Prior-art correction** — the previous skill generation contained fabricated symbols (`PostMessage2`, `SafeSnapshotsRead`, `GhostKeyForRecipients`, `BuildSafeTransaction` as a Go name, `GetMe`, …). `gotchas.md` #12 lists the recurring ones. If you find a symbol in the wild that is not in `sdk-map.md`'s file map, assume it is invented until proven from source.
3. **Live probes** — Computer info, npm registry, Go proxy, Rubygems (all 2026-10-11).

## Re-verify instructions (quarterly, or on demand)

```bash
node scripts/check-currency.mjs            # versions + export diffs + scaffold typecheck; exit≠0 = drift
node scripts/check-currency.mjs --update   # rewrite the expected-surface baseline after review
node scripts/probe.mjs computer            # live computer params
```

Manual pass (each quarter):

1. Diff the docs repo (`git log` since last check) — watch `api/sequencer/`, `api/messages/`, dashboard features.
2. Download new SDK versions, diff exported symbols against the baseline (`check-currency.mjs` automates).
3. Ecosystem pulse: fox-one org, `an-lee/mixin_bot`, Pando/Exin status.
4. Update this matrix + the SKILL.md currency block in the same commit; bump `references/` claims that moved.

## Known drift risks (checked next cycle)

- Node SDK `collectible`/inscription surface is moving fast (2026-09 additions: inscriptions, multisig `receivers`).
- Blaze hardening landed 2026-08 in both SDKs; ack semantics stable but options may grow.
- App-Security `POST /apps/:appId/security` payload shape still dashboard-only `[UNVERIFIED]`.

## Sources

- Module proxy: proxy.golang.org · npm registry · rubygems.org API · codeload.github.com — all fetched 2026-10-11.
- Audit origin: LixvYang/mixin-skills#2 (fabricated-symbol findings that motivated this file).
