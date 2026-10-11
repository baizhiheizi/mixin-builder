# Mixin Computer (Solana runtime)

Mixin Computer ("Safe Trusted Computer") is an MTG worker that executes **Solana transactions** on behalf of registered Mixin users. The MTG group receives XIN payments; a deterministic state machine (group consensus + MPC signer + observer node) drives Solana. Live group at v0.9.1: **7 members, threshold 5**, payer `BaEPep2hKPNLyafnv51foxRbymh5BbZ2H6DKRiKww4ka` (live: computer.mixin.one 2026-10-11).

Core invariants (from the computer repo README, verified in source):

- The group **never** acts on external environment directly; it only reacts to Mixin outputs (user txs or observer notifications carrying Solana tx hashes). A notified Solana tx is treated as a deterministic fact (no-fork assumption); if a member can't find it, the member panics.
- The Solana group account and user accounts **never pay fees** — a dedicated fee payer account pays all SOL costs, keeping group/user balances pure.
- User accounts on Solana are controlled by the group MPC, not the user. You build unsigned Solana txs; the group signs and broadcasts.
- You never hold SOL for the payer. Rent/top-up SOL is bought by sending extra XIN with a `fee_id` (see Fee quotes).

Deployment config shape (`config/example.toml`, verified in MixinNetwork/computer HEAD 2026-10-11): `[computer]` — `app-id` (group id), `threshold` (MPC threshold, "recommended to be 2/3 of the mtg members count"), `asset-id`, `observer-id`, `operation-price-asset-id`/`operation-price-amount` (XIN price per operation), `mixin-rpc`, `solana-rpc`, `solana-key` (payer key, group-held), `mpc-key-number`; `[computer.mtg.genesis]` — `members[]`, `threshold` ("must not be smaller than the mpc threshold"), `epoch`. The HTTP node listens on port **7081** behind computer.mixin.one (`solana/http.go:44`).

→ custody-and-ops.md for key custody rails; → transactions.md for Safe tx building/signing; → payments.md for plain transfers.

## Public read/write API (computer.mixin.one, no auth)

CORS-enabled, port 7081 origin (`solana/http.go:26-48`). Go SDK wraps all of these in `computer.go` (constant `computerUri = "https://computer.mixin.one"`); Node/Ruby SDKs ship **no computer client** — call these over fetch/axios directly (Node encoding helpers exist, see below).

| Endpoint | Purpose | Response (verified keys) |
|---|---|---|
| `GET /` | node info | `version`, `observer`, `payer`, `members{app_id, members[], threshold}`, `params.operation{asset, price}`, `height` (Solana block checkpoint) |
| `GET /users/:addr` | user lookup by **MIX address** | `id` (uid decimal string), `mix_address`, `chain_address` (user's Solana account); **404 `{"error":"user"}`** if unknown |
| `GET /deployed_assets` | assets mintable on Solana | array of `{asset_id, chain_id, name, symbol, address, decimals, uri, price_usd}` |
| `GET /address_lookup_tables` | Solana ALTs usable to shrink txs | `[]string` of table addresses |
| `GET /system_calls/:id` | system call status by **callID uuid** | `{id, type, user_id, nonce_account, raw, state, hash, refund_traces[], subs[], reason?}` |
| `GET /nonce_accounts/:mix` | nonces already bound to a MIX address | `[{address, call_id}]` (path param, not query) |
| `POST /deployed_assets` | request deploying external Mixin assets | body `{"assets":[assetId...]}` → `{assets:[...]}`; **400 `{"error":"chain"}`** if any asset's chain is Solana |
| `POST /nonce_accounts` | lock a spare nonce for a user | body `{"mix":"MIX..."}` (registered users only; 404 `user` if not) → `{mix, nonce_address, nonce_hash}`; **429 `nonce limit`** if too many nonces held |
| `POST /fee` | quote rent SOL in XIN | body `{"sol_amount":"0.05"}` → `{fee_id, xin_amount}` |

Sources: `solana/http.go` (routes lines 33-42, handlers), Go `computer.go v3.25.7`. Prices/members/payer are **live values — re-fetch `GET /` every run**; operation price was `0.001` XIN on 2026-10-11 (live probe, gt.md) while the repo example ships `0.0001` — never hardcode.

## Identity mapping

Four identifiers, three namespaces:

| Identifier | Form | Who has it |
|---|---|---|
| Mixin user/app UUID | 36-char uuid | every Mixin account |
| 1-of-1 MIX address | `MIX…` of `([userID], threshold 1)` | every user — the canonical user address |
| Computer uid | decimal string, serialized as **8 big-endian bytes**; user uids are > 2^48, system uids sit in [2^32, 2^48] (README) | registered users only |
| Solana address | base58 | user's `chain_address` (group-controlled), plus group payer & nonce accounts |

**Every computer API that takes "mix" wants the 1-of-1 MIX address**, not a raw uuid. Build it:

- Go: `NewUUIDMixAddress([]string{userId}, 1).String()` (mix.go v3.25.7) — this is exactly what `RegisterComputer` does internally.
- Node: `buildMixAddress({uuidMembers: [appId], threshold: 1})` then `.encode()`/`.toString()` per helper shape (node: dist/index.d.ts 7.6.0).

`uid → 8 BE bytes`: `ComputerUserIDToBytes(uid)` = big-endian fill of `big.Int`, must fit 64 bits (go: computer.go v3.25.7). Never LE.

## Binary extra format

All instructions ride the Safe transaction `extra` field:

```
mtgExtra = base64rawurl( appIdUuidBytes(16) || operationType(1B) || payload )
```

`appIdUuidBytes` = the **computer group's app_id** from `GET /` (live: `0acfe278-714f-4cfc-ae52-70ce34e3eb11`, 2026-10-11), NOT your app id. Payload per operation type (constants `OperationTypeAddUser=1, SystemCall=2, UserDeposit=3` — Go computer.go; README "Add a User"/"Make System Calls"):

| Type | Payload bytes |
|---|---|
| AddUser (1) | UTF-8 **MIX address** (the caller's 1-of-1 address) |
| SystemCall (2) | `uid 8B BE \|\| callID 16B uuid \|\| skipFlag 1B (0/1) \|\| feeID 16B uuid (optional)` |
| UserDeposit (3) | reserved — do not construct |

Semantics (README, verified): uid in the SystemCall payload is the **asset recipient** — an invalid/nonexistent uid **loses the assets**. `skipFlag=1` disables the automatic post-process call (refund leftovers / sweep received assets back to the MIX account) — i.e. a dry-run that does not broadcast post-settlement movements. `feeID` + extra XIN amount buys the equivalent SOL for rent-exempt accounts created during the call. One transaction = one system call; Solana tx bytes must live in a **storage transaction** referenced by the system-call tx.

**Use the SDK helpers; never hand-concatenate** (uuid byte order, BE integers, and base64rawurl (no padding) are easy to get wrong):

- Go (v3.25.7): `EncodeOperationMemo(op, payload)` → memo; `EncodeMtgExtra(appId, memo)` → base64rawurl string; `BuildSystemCallExtra(uid, callID, skipProcess, feeID)` → payload (feeID `""` = omit); `DecodeComputerExtraBase64` for parsing.
- Node (7.6.0): `encodeMtgExtra(app_id, extra)`, `buildComputerExtra(operation, extra)`, `buildSystemCallExtra(uid, cid, skipPostProcess, fid?)`, `userIdToBytes(uid)`, `checkSystemCallSize(buf)` against **`MAX_SOLANA_TX_SIZE = 1232`** — check before submitting; a Solana tx over 1232 bytes can never confirm.

## Register a user

**Go one-shot:** `RegisterComputer(ctx, su)` (computer.go v3.25.7). Internally: fetch `GET /` → build caller 1-of-1 MIX → extra = AddUser → pay `params.operation.price` XIN to the MTG group MIX address (`NewUUIDMixAddress(info.Members.Members, threshold)`) → `SendTransaction` with trace `UniqueObjectId(mix, "computer_register")`. Because the trace is **deterministically derived from the MIX address**, re-running is idempotent (same trace = same Mixin tx; the network rejects duplicates rather than double-charging).

**Manual (Node/Ruby/any):**

1. `GET /` → group `members.members`, `threshold`, `params.operation.{asset, price}`.
2. Build your 1-of-1 MIX address (see Identity mapping).
3. `GET /users/:mix` — if 200, already registered (grab `id`/`chain_address`); if 404, proceed.
4. extra = `encodeMtgExtra(groupAppId, buildComputerExtra(1, utf8(mix)))`; pay `price` XIN (decimal string) to the group MTG MIX address via a normal Safe transfer, trace deterministic (e.g. Go's `UniqueObjectId(mix, "computer_register")` or Node `uniqueObjectId`-style derivation; Node: use `blake3Hash`-based helper or persist your own uuid — pick one and store it).
5. Poll `GET /users/:mix` until it returns `id` + `chain_address`.

**Verify it worked:** poll `GetComputerUser(ctx, mix)` (Go returns `nil, nil` on 404) or `GET /users/:mix` until non-404; ~30s typical. Registration is one Mixin confirmation + one group action; no Solana movement until your first system call.

## System calls (invoice pattern)

The reliable end-to-end shape. Prerequisites: registered user (`uid`, `chain_address`), Solana tx builder (@solana/web3.js or Go solana packages).

1. **Generate callID** (uuid) — persist it **before** sending anything; it is both the extra field and the `GET /system_calls/:callID` lookup key.
2. **Lock a nonce**: `POST /nonce_accounts {"mix": mixAddr}` → `{nonce_address, nonce_hash}`. One nonce per call; a locked nonce is consumed by exactly one system call (`call_id` binding visible in `GET /nonce_accounts/:mix`). Lock immediately before building the tx — the nonce hash is your durable blockhash.
3. **Build the Solana tx**: payer = `payer` from `GET /`; **first instruction = advance nonce** on `nonce_address`; use `nonce_hash` as the tx blockhash (durable, no 60s expiry); versioned message; signers = none (group MPC signs). Check size ≤ 1232 (`checkSystemCallSize`, Node). Use `GET /address_lookup_tables` if needed to fit.
4. **Rent/top-up (optional)**: if the call creates accounts needing SOL rent, estimate the SOL amount and `POST /fee {"sol_amount": "..."}` → `{fee_id, xin_amount}`. Include `fee_id` in the SystemCall extra and `price + xin_amount` as the payment amount.
5. **Storage entry**: the serialized Solana tx bytes go in a XIN **storage transaction** — `extra > 256B` can't ride a normal tx (→ transactions.md); cost = `ceil(len/1024) * 0.0001` XIN (`estimateStorageCost` / `getRecipientForStorage` Node; `EstimateStorageCost`/`CreateObjectStorageTransaction` Go).
6. **System-call entry**: XIN payment to the group MTG address, amount = `price (+ xin_amount if fee)`, extra = SystemCall extra (with your uid, callID, skipFlag, feeID?), `references = [storage tx hash]` (resolve the storage request to its real transaction hash first).
7. **Submit entries in order**: storage tx first, wait for its hash, then the system-call tx referencing it. With a MIN invoice, entries pay atomically in sequence; each operational tx resolves its index references into real hashes before signing.
8. **Poll**: `GET /system_calls/:callID`. State machine (server source `solana/http.go` + `store/call.go`): `initial → pending → done | failed`. Terminal success is **`done`** (not "confirmed"). On `failed`, the response carries `reason` (from `store.ReadFailReason`) and `refund_traces[]` — refund XIN moves back to your MIX address under those trace ids. `subs[]` shows observer-generated sub-calls (prepare/post-process) with their own `state`/`hash`.

`skipFlag=1` (skipPostProcess): the group still executes your Solana tx but does **not** propose the post-process call — use for dry-runs/quotes where leftover assets may be burned rather than refunded.

**Change-UTXO caveat:** if submission fails with "insufficient total input outputs" (`UtxoInsufficientError` in Go; code-10002 family), a prior storage/change UTXO may not be spendable yet — retry briefly with backoff instead of minting a new trace.

**Verify it worked:** `GetComputerSystemCall(ctx, callID)` → assert `state == "done"` and `hash` is a non-empty Solana tx signature; on Solana, confirm the signature (`getSignatureStatuses`) reached finality. On `failed`, read `reason` and check `refund_traces` landed via `SafeSnapshots` filtering by request id.

## Deployed assets & external assets

- `GET /deployed_assets` lists assets the group has already minted on Solana; each entry's Solana asset id is derivable as `UniqueObjectId(SolanaChainId, address)` where `SolanaChainId = "64692c23-8971-4cf4-84a7-4dd1271dd887"` (go: computer.go/chain.go v3.25.7 `GetSolanaAssetId`).
- `ComputerDeployExternalAsset(ctx, []string{assetId})` (Go) / `POST /deployed_assets {"assets":[...]}`: registers a **non-Solana Mixin asset** (BTC, ETH, …) so it becomes mintable on Solana by the group. Both the SDK (client-side check `asset != SolanaChainId`) and the server (rejects `asset.ChainID == SafeSolanaChainId` with 400 `{"error":"chain"}`) refuse Solana-chain assets — SOL itself is native and never needs deploying. Idempotent: already-registered assets are returned without error.

**Verify it worked:** poll `GET /deployed_assets` (or `GetComputerDeployedAssets`) until the `asset_id` appears with an on-Solana `address`; deployment is a group action, not instant — poll with backoff (minutes, not seconds).

## Per-language pointers

- **Go** (`bot-api-go-client/v3` v3.25.7, `computer.go`): `GetComputerInfo`, `GetComputerUser`, `GetComputerDeployedAssets`, `GetComputerSystemCall`, `GetComputerNonceAccounts(mix)`, `LockComputerNonceAccount(mix)`, `GetFeeOnXINBasedOnSOL(solAmount string)`, `RegisterComputer(ctx, su)`, `ComputerDeployExternalAsset`, plus all extra encoders. All free functions taking `ctx` first; no auth needed.
- **Node** (`@mixin.dev/mixin-node-sdk` 7.6.0): encoding helpers only — `encodeMtgExtra`, `buildComputerExtra`, `buildSystemCallExtra`, `userIdToBytes`, `checkSystemCallSize`, `MAX_SOLANA_TX_SIZE`, `OperationType`, `buildMixAddress`. **No computer HTTP client** — fetch `https://computer.mixin.one` directly with axios/fetch; build the paying Safe tx with the standard utxo/safe helpers (→ transactions.md).
- **Ruby** (`mixin_bot` 3.0.2): `MixinBot::ComputerApi` delegates to the same HTTP endpoints; MIX address via `MixinBot::MixAddress`; no dedicated encoder helpers [UNVERIFIED beyond README's delegation claim — verify gem version ≥ your target].

## Sources

- MixinNetwork/computer repo HEAD (tarball 2026-10-11): `README.md`, `config/example.toml`, `solana/http.go` (routes, handlers, state strings), `store/call.go` (state machine).
- live: computer.mixin.one `GET /` 2026-10-11 (members 7/threshold 5, payer, price 0.001 XIN, version v0.9.1-a37afa3).
- go: computer.go, mix.go, chain.go v3.25.7 (`/tmp/sdksrc/github.com/MixinNetwork/bot-api-go-client/v3@v3.25.7/`).
- node: dist/index.d.ts 7.6.0 (computer helpers, MAX_SOLANA_TX_SIZE, buildMixAddress).
- ruby: mixin_bot 3.0.2 README.
