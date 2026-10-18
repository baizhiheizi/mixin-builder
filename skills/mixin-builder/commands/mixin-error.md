---
description: Look up a Mixin error code or failure symptom and locate its cause in this codebase
argument-hint: <code or symptom — e.g. 30102 | 10006 | "duplicate transfer">
---

Diagnose a Mixin error. `$ARGUMENTS` is an error code or a symptom. Load the **mixin-builder** skill.

## 1. Look up

- Code → `references/common-errors.md`. Note: errors arrive as HTTP **202** with `{code, description, extra}` — don't rely on HTTP status alone.
- Symptom → `references/gotchas.md` (21 numbered failure cases) and `references/common-errors.md` § non-envelope shapes.

## 2. Explain

code → most likely cause → fix, quoting the reference. If the lookup matches nothing, say so — do not invent a cause. Check the SDK source per `references/sdk-map.md`, and mark anything speculative as `[UNVERIFIED]`.

## 3. Locate in this project

Search the codebase for the pattern the reference names:

- `10006` → an HTTP/WS client without `User-Agent: name/version`
- duplicate transfer → a retry loop that regenerates `trace_id`
- "insufficient" with balance showing → spending a change UTXO too early (`gotchas.md` #2)
- watcher misses payments → DESC paging walking the cursor backwards (`gotchas.md` #17)

Report file:line matches and the smallest fix for each.
