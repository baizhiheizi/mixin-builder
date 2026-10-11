# Eval: Solana program call through Mixin Computer

## Prompt

> Run a Solana program call through Mixin Computer from my bot. The bot isn't registered with Computer yet. Include paying for a new token account's rent and confirming the call actually executed on Solana.

## Passes when

- Registration first: derive bot 1-of-1 MIX address, check `GET /users/:mix`, pay `params.operation.price` XIN (re-fetched, not 0.001-hardcoded) with AddUser extra; poll user until uid + solana address.
- System call uses the invoice shape from `computer.md`: serialized Solana tx (payer = Computer payer, nonce advance first with locked nonce from `POST /nonce_accounts`, blockhash = nonce hash) → storage entry (XIN, storage-cost sized) → system-call entry (extra = SystemCall layout `uid 8BE || callID 16 || skip || feeID?`, amount = price + fee, `index_references` → storage) → submit in order, resolving refs to real tx hashes.
- Rent: `POST /fee` quote for the top-up SOL → `fee_id` + `xin_amount` fed into the extra; includes authority-reserve reasoning or at least minimum-rent correctness.
- `callID` generated and persisted before sending; skip flag only for dry-run.
- Verify: poll `GET /system_calls/:callID` until terminal state (`done`/`failed` — the verified state names), surface error/reason; assert Solana tx signature/hash.
- Handles the change-UTXO retry caveat (brief bounded retry on insufficient-inputs between storage and fee entries).

## Fails when

- Puts the Solana bytes directly in a single tx extra (size/type error), skips the nonce, hardcodes price, or invents SDK symbols (Go encoders exist: `EncodeMtgExtra`, `BuildSystemCallExtra`, `RegisterComputer`; Node: `buildSystemCallExtra` etc. + raw fetch for HTTP).
- Ends at "submitted" without polling state.
