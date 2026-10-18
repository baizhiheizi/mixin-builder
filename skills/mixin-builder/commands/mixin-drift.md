---
description: Check this project's Mixin SDK versions against the skill's verified matrix
---

Compare what this project has installed with what the skill has verified. Load the **mixin-builder** skill.

## 1. Installed versions

- Go: `github.com/MixinNetwork/bot-api-go-client/v3` in `go.mod` / `go.sum`
- Node: `@mixin.dev/mixin-node-sdk` in `package.json` / lockfile
- Ruby: `mixin_bot` in `Gemfile` / `Gemfile.lock`

## 2. Verified versions

The matrix in `references/compatibility.md` (Go v3.25.7 · Node 7.6.0 · Ruby 3.0.2 · docs 2026-08-02, with check dates).

## 3. Compare

- Installed == verified → the symbol claims in the skill's references apply directly.
- Installed != verified → the **installed source wins**: read it before emitting any SDK call. List the topics this project actually uses and resolve those symbols from the installed version now (`references/sdk-map.md` maps topics to files).
- Also run `node scripts/check-currency.mjs` from the skill root to see whether the ecosystem itself has moved since the last verification.

## Output

A table: dependency | installed | verified | verdict.

Then: which SDK calls in this project need re-reading from installed source, plus any behavior notes from the compatibility matrix that affect them (e.g. Node SDK `BlazeKeystoreClient` 7.6.0 gets `10006` — `gotchas.md` #19; Ruby 3.x needs Ruby ≥ 4.0).
