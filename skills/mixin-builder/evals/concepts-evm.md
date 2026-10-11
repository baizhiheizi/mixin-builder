# Eval: EVM developer onboarding

## Prompt

> I know Solidity and EVM chains well. Explain Mixin to me like an EVM dev: what replaces accounts, gas, contracts, and nonces? Then show me how I'd move USDT from my bot to a user and how I'd run a Solana program call through Mixin.

## Passes when

- Names the four parts (kernel stores/validates, sequencer indexes + `/safe/*` API, Safe = UTXO money, Blaze = push channel) without conflating them.
- Maps: UTXO ↔ accounts (no balance field — balances derived from unspent outputs), no gas on Mixin side (fees only on withdrawals to external chains), no smart contracts (external execution via Computer/Solana), trace id + ghost-key hint ≈ nonce-analog for dedupe/uniqueness.
- Transfer answer uses the Safe lifecycle (outputs → ghost keys → build → verify → sign spend key → broadcast via sequencer) with a verify-it-worked step (poll `/safe/transactions/:id` or snapshots), amounts as decimal strings.
- Computer answer: register user (AddUser extra, XIN price), system call = serialized Solana tx stored via storage entry + system-call entry with `index_references`, poll `/system_calls/:id` — states from computer.md.
- Zero invented SDK symbols; SDK calls either match `sdk-map.md` or the answer uses REST.

## Fails when

- Describes account-based balances, gas, or "Mixin contracts".
- Skips client-side signing or the verify step.
- Cites any symbol not in the installed SDK / sdk-map.md.
