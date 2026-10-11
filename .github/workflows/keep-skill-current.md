---
emoji: 🔄
name: Keep mixin-builder current
description: Weekly currency check of the mixin-builder skill — refreshes the verified-against date when checks pass, and updates references + baseline via PR when SDK/docs/Computer drift is detected.
on:
  schedule: weekly
  workflow_dispatch:
permissions:
  contents: read
strict: true
network:
  allowed: [defaults, github, api.github.com, node, go, ruby, computer.mixin.one]
safe-outputs:
  create-pull-request:
    title-prefix: "[currency] "
    labels: [automation, currency]
    draft: false
    expires: 14d
    close-older-pull-requests: true
    close-older-key: keep-skill-current
    allowed-files:
      - "skills/mixin-builder/references/**"
      - "skills/mixin-builder/scripts/baseline.json"
      - "skills/mixin-builder/SKILL.md"
  noop:
    report-as-issue: false
runs-on:
  - self-hosted
  - linux
  - agentic
runs-on-slim:
  - self-hosted
  - linux
  - slim
imports:
  - shared/engine-minimax.md
---

# Keep the mixin-builder skill current

You maintain the `mixin-builder` agent skill in this repository. Its core promise
is that every SDK symbol in its content was **verified against a pinned source
version**, recorded in `skills/mixin-builder/references/compatibility.md` with a
date. Your job: re-verify on schedule, keep that date honest, and fix drift.

## Steps

1. Run the automated audit (Node ≥ 20 is preinstalled):

   ```bash
   node skills/mixin-builder/scripts/check-currency.mjs --deep
   node skills/mixin-builder/scripts/probe.mjs computer
   ```

   `check-currency` compares latest Go (`proxy.golang.org`), Node
   (`registry.npmjs.org`), Ruby (`rubygems.org`), docs repo (`api.github.com`)
   and Computer (`computer.mixin.one`) against `scripts/baseline.json`; exit
   code 1 means drift. `probe` prints live Computer values (version, members,
   threshold, registration price).

2. Branch on the exit code:

   **Exit 0 (no drift):** Check the "Last full verification" date in
   `references/compatibility.md`. If it is **older than 14 days**, this run
   legitimately re-verified everything — update that date line to today (UTC),
   and refresh the Computer row's height/version live values if they changed.
   Also update the date in the currency block of `SKILL.md` if present.
   Create a pull request titled `[currency] verification refreshed <date>`
   with a body listing exactly which checks ran and their results.
   If the date is already within 14 days and nothing changed: **noop** with a
   one-line summary (e.g. "currency check green, verification date current").

   **Exit 1 (drift):** Fix the skill, then open a PR.
   - Read the drift output: it names added/removed exported symbols per SDK and
     version changes.
   - For each changed surface, download the new SDK version's source (Go module
     zip from `proxy.golang.org`, Node tarball from npm, Ruby gem) and **read
     the actual files** before editing. Update `references/sdk-map.md` tables,
     the affected domain references, and `references/compatibility.md` matrix.
   - Update `scripts/baseline.json` by running
     `node skills/mixin-builder/scripts/check-currency.mjs --update` and
     re-running the check to confirm it exits 0.
   - If Computer live values changed materially (members, threshold, price),
     update `references/computer.md` — citing the probe output and date.
   - Create a pull request titled `[currency] <what drifted>` whose body lists:
     each version bump, each symbol added/removed, which reference files
     changed and why.

## Hard rules

- **Never invent SDK symbols.** Only names visible in the downloaded source of
  the pinned version, or already in the baseline diff. When unsure, write
  `[UNVERIFIED]` or omit.
- Touch **only** files under `allowed-files`. Do not modify scripts, scaffolds,
  evals, or this workflow.
- Preserve house style: every claim carries a source and date; compatibility.md
  stays the single truth anchor; no safety-rail duplication across files.
- If a check fails for infrastructure reasons (network, registry outage), do
  not edit content — report the failure in the PR body or noop message and
  leave content untouched.
- One PR per run. Superseded open PRs from this workflow are closed
  automatically.
