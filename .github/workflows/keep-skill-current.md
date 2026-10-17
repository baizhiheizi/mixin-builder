---
emoji: 🔄
name: Keep mixin-builder current
description: Weekly currency check of the mixin-builder skill — refreshes the verified-against date when checks pass, and updates references + baseline via PR when SDK/docs/Computer or Mixin client-repo drift is detected.
on:
  schedule: weekly
  workflow_dispatch:
permissions:
  contents: read
strict: true
network:
  allowed: [defaults, github, api.github.com, raw.githubusercontent.com, codeload.github.com, node, go, ruby, computer.mixin.one]
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
  - shared/mcp.md
---

# Keep the mixin-builder skill current

You maintain the `mixin-builder` agent skill in this repository. Its core promise
is that every SDK symbol and every client-behavior claim in its content was
**verified against a pinned source version**, recorded in
`skills/mixin-builder/references/compatibility.md` with a date and file-level
citations. Your job: re-verify on schedule, keep that date honest, and fix drift.

Drift sources, all covered by one script:

| Source | What is watched |
|---|---|
| Go / Node / Ruby SDKs | Latest version + exported-symbol surfaces |
| `developers.mixin.one` docs | Last commit touching `developers-docs/docs` |
| `computer.mixin.one` | Live version/members/threshold/price |
| `MixinNetwork/ios-app` · `android-app` · `flutter-app` · `mixin_bot_sdk_dart` | Default-branch commits touching the **watched files** — the exact files cited in `references/*` (URL routers, message-category & app-card models, capability handling, webview bridges, Blaze params, Dart wire-format VOs). List lives in `REPOS` inside the script. These repos push daily, so SHA-only tracking would always fire; commits outside the watched paths are recorded as baseline refresh, not drift. |

## Steps

1. Run the automated audit (Node ≥ 20 is preinstalled):

   ```bash
   node skills/mixin-builder/scripts/check-currency.mjs --deep
   node skills/mixin-builder/scripts/probe.mjs computer
   ```

   `check-currency` compares latest Go (`proxy.golang.org`), Node
   (`registry.npmjs.org`), Ruby (`rubygems.org`), docs repo (`api.github.com`),
   Computer (`computer.mixin.one`), and the four Mixin repos (`api.github.com`
   compare API, watched-path filtering) against `scripts/baseline.json`; exit
   code 1 means drift. `probe` prints live Computer values (version, members,
   threshold, registration price).

2. Branch on the exit code:

   **Exit 0 (no drift):** Check the "Last full verification" date in
   `references/compatibility.md`. If it is **older than 14 days**, this run
   legitimately re-verified everything — update that date line to today (UTC),
   and refresh the Computer row's height/version live values if they changed.
   Also refresh the repo matrix rows' pinned SHAs (`ios-app`, `android-app`,
   `flutter-app`, `mixin_bot_sdk_dart`) to the values now recorded in
   `baseline.json` `repos` — keep rows in the form `master @ YYYY-MM-DD`.
   Also update the date in the currency block of `SKILL.md` if present.
   Create a pull request titled `[currency] verification refreshed <date>`
   with a body listing exactly which checks ran and their results.
   If the date is already within 14 days and nothing changed: **noop** with a
   one-line summary (e.g. "currency check green, verification date current").

   **Exit 1 (drift):** Fix the skill, then open a PR.
   - Read the drift output. Four shapes exist: SDK version/surface changes,
     docs-repo moves, Computer value changes, and **client-repo drift** (a
     commit range that touched watched files — the output names each file).
   - **SDK drift**: download the new SDK version's source (Go module zip from
     `proxy.golang.org`, Node tarball from npm, Ruby gem) and **read the actual
     files** before editing. Update `references/sdk-map.md` tables, the
     affected domain references, and `references/compatibility.md` matrix.
   - **Client-repo drift**: shallow-clone the repo at the new HEAD
     (`git clone --depth 1 https://github.com/MixinNetwork/<repo>`) or fetch
     the changed files from `raw.githubusercontent.com`, then re-verify every
     claim that cites them. Map files to references:

     | Watched file(s) | Reference to check |
     |---|---|
     | `MixinURL.swift`, `SafeURL.swift` + `Wallet/Payment/*URL.swift`, `UrlWindow.swift`; `UrlInterpreterActivity.kt`, `LinkBottomSheetDialogFragment.kt`, `Constants.kt` Scheme, `UrlExtension.kt`; `uri_utils.dart`, `constants.dart` | `schemas.md` §1/§1b (deep-link tables + platform divergence matrix) |
     | `Message.swift` / `Message.kt` (categories), `AppCardData.swift` / `action_card_data.dart`, `MultisigResponse.swift`, `BlazeMessageParam.*`, `SendMessageService*`, `EncryptCategory.kt`, `App.kt` | `messaging.md` (category table, capabilities, APP_CARD model, send params), `blaze.md` |
     | `WebViewMessageHandler.swift`, `MixinWebViewController.swift`, `MixinWebContext.swift`, `WebFragment.kt`, `web_view/*` | `webview.md` (bridge matrix, getAssets gating, context fields) |
     | `MultisigURL.swift` + `checkMultisig`; multisig branch of `LinkBottomSheetDialogFragment.kt` | `payments.md` § Multisig (mobile sheet semantics) |
     | `mixin_bot_sdk_dart` `lib/src/vo/{app,user,mixin_response}.dart` | wire-format claims (`capabilites` spelling) in `messaging.md` + `gotchas.md` #20 |

     Update the per-client rows in `references/compatibility.md` (SHA + date,
     plus client version if evident — iOS `Info.plist` `CFBundleShortVersionString`,
     flutter `pubspec.yaml` `version`), and fold any behavioral change into the
     affected reference with a source citation. If a watched file's change
     turns out to be cosmetic (refactor, comments) with no behavioral delta,
     say so explicitly in the PR body and change no content.
   - Update `scripts/baseline.json` by running
     `node skills/mixin-builder/scripts/check-currency.mjs --update` and
     re-running the check to confirm it exits 0.
   - If Computer live values changed materially (members, threshold, price),
     update `references/computer.md` — citing the probe output and date.
   - Create a pull request titled `[currency] <what drifted>` whose body lists:
     each version bump, each symbol added/removed, each client-repo commit
     range (repo, old→new SHA, watched files touched), which reference files
     changed and why.

## Hard rules

- **Never invent SDK symbols or client behaviors.** Only names/behaviors
  visible in the downloaded source of the pinned version, in the baseline
  diff, or read directly from the drifted repo at the new HEAD. When unsure,
  write `[UNVERIFIED]` or omit.
- Touch **only** files under `allowed-files`. Do not modify scripts, scaffolds,
  evals, or this workflow — that includes the `REPOS` watch lists: if a drift
  report feels mis-scoped, note it in the PR body for a human instead of
  editing the script.
- Preserve house style: every claim carries a source and date; compatibility.md
  stays the single truth anchor; no safety-rail duplication across files.
- Cross-platform claims must stay cross-platform: when a mobile-only file
  changes, re-check the equivalent surface in the other clients (iOS ↔
  Android ↔ flutter-app) before editing a divergence-matrix row — divergence is
  the norm, not the exception.
- If a check fails for infrastructure reasons (network, registry or API
  outage, GitHub rate limit), do not edit content — report the failure in the
  PR body or noop message and leave content untouched.
- One PR per run. Superseded open PRs from this workflow are closed
  automatically.
