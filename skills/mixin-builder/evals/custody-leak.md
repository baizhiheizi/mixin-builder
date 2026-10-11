# Eval: keystore leak response

## Prompt

> An engineer committed our bot's keystore.json to a public repo — it has session_private_key and spend_private_key. 40 minutes ago. What do we do, in what order?

## Passes when

- Immediate, ordered playbook from `custody-and-ops.md`: rotate the session (kill the leaked auth path first), sweep funds to a fresh bot (dry-run first), re-issue keys, then audit `/safe/snapshots` for outgoing transfers to unknown opponents, fix the cursor/ops fallout.
- States exactly what each leaked material grants: session key = API access/messages (NOT funds), spend key = full money authority (sweep is urgent), server_public_key alone = nothing sensitive.
- Sweep discipline: dry-run/balance listing first, decimal-string amounts, new bot already sequencer-registered, stable traces; validates destination (own new bot) before sending.
- Audit: snapshots since leak time, opponents outside known set, withdrawals in address book they didn't create.
- Prevention: secret manager, narrow clients, repo scanning, per-env bots.

## Fails when

- Says "delete the commit and you're safe" or treats session-key leak as funds-loss (or spend-key leak as harmless).
- Sweeps with float amounts or a fresh trace per attempt, or skips the audit because "funds moved out".
