---
description: Ground live facts read-only — registration state, exact balances, ledger paging
argument-hint: [me|outputs|snapshots|computer|all — defaults to all]
---

Run the skill's read-only probes and report what they establish. Load the **mixin-builder** skill. Probes are GET-only; the spend key is never read.

## 1. Locate the keystore

Check the `KEYSTORE` env var, then common paths (`./keystore.json`, `~/keystores/*.json`). If not found, ask for the path. Never print keystore contents.

## 2. Run

`$ARGUMENTS` (default `all`) selects from `scripts/probe.mjs`:

- `me` — auth works + `has_safe` registration flag. If `has_safe: false`, messaging works but sending is impossible: point to `references/identity-and-keys.md` § Sequencer registration before any payment work.
- `outputs` — exact balance per `asset_id` (Σ unspent UTXOs, all pages, deduped — Mixin has no balance field). More than ~100 UTXOs on one asset → consolidation warning (`references/payments.md` § Dust & consolidation).
- `snapshots` — recent ledger + the ASC cursor-paging check that payment flows rely on. If the check fails, do not use created_at cursor paging as documented (`references/reconciliation.md`).
- `computer` — live Mixin Computer params (version, members/threshold, registration price; no auth).

## 3. Report

State each fact together with the probe that produced it. Then flag anything that contradicts what the project's code or config assumes — e.g. code assumes a registered bot, or a non-zero balance, or that paging is safe.
