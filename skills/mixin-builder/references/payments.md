# Payments — UTXO model, transfers, multisig, withdrawals, inscriptions, storage

Everything here runs on **Mixin Safe**: kernel-compatible UTXO transactions assembled client-side, verified and indexed by the Sequencer. Prerequisite: the bot/user must be registered with the Sequencer (`POST /safe/users`, TIP PIN migrated first) — → identity-and-keys.md. Global rails (key separation, decimal-string amounts, stable trace IDs, validate-before-sign) live in SKILL.md + custody-and-ops.md; this file covers payment-specific invariants only.

**Amounts are decimal strings everywhere** (8-decimals fixed point; never floats). A **trace ID** (request UUID) identifies one intent: the network dedupes on it — reuse the same trace across retries, never rotate it mid-flight. Rotating a trace after an ambiguous failure is how double-pays happen.

Quick map:

| You want to… | Section | Shortest path |
|---|---|---|
| Show a balance | UTXO model | Go `ListAssetWithBalance` / Node `client.utxo.safeAssetBalance` |
| Get paid by users | Receiving | pay URI or direct transfer + snapshot watcher |
| Charge for an order (match payment → order, refunds) | → reconciliation.md § Order payments | per-order `trace` in the pay link, match snapshot `request_id` |
| Accept on-chain crypto | Receiving | deposit entries + pending-deposits poll |
| Send / fan out | Sending | Go `SendTransaction` / Node manual chain / Ruby `create_transfer` |
| Require approvals | Multisig | `POST /safe/multisigs` + signers |
| Cash out on-chain | Withdrawals | Go `SendWithdrawal` / Node two-tx pattern |
| Fix "insufficient outputs" | Dust | consolidation self-transfer |
| Move collectibles | Inscriptions | `transferInscription` |
| Attach >256 B payloads | Storage entries | XIN storage tx + reference |

Endpoints used in this file (JWT-authenticated; this is the money API):

| Endpoint | Purpose |
|---|---|
| `GET /safe/outputs` | UTXO set: balances, inputs, pagination by `sequence` |
| `POST /safe/keys` | ghost keys per output slot |
| `POST /safe/transaction/requests` | verify raw tx, collect per-input views |
| `POST /safe/transaction` (`/safe/transactions` in SDKs) | broadcast |
| `GET /safe/transactions/:id` | state poll (`unspent` → `signed` → `spent`) |
| `POST /safe/multisigs`, `/:id/sign`, `/:id/unlock`; `GET /safe/multisigs/:id` | multisig requests |
| `POST /safe/deposit/entries`; `GET /safe/deposits` | deposit addresses; pending deposits |
| `GET /safe/assets/:id/fees?destination=` | withdrawal fee quotes |
| `GET /safe/snapshots` | ledger of record (offset = `created_at`) |
| `GET /safe/inscriptions/{collections,items}/:hash` | inscription reads |

## UTXO model

There is no balance field anywhere. A wallet's balance is the **sum of its unspent outputs** for an asset; the Sequencer only serves the UTXO set and you aggregate client-side (docs: api/sequencer/outputs.md).

```
GET /safe/outputs?members=MEMBERS-HASH&threshold=1&asset=ASSET-UUID&offset=SEQUENCE&limit=500&state=unspent&order=ASC
```

| Param | Meaning |
|---|---|
| `members` | `hashMembers(sorted member UUIDs)` — a group hash, not a user id. 1-of-1 self = hash of `[botId]`. Go `HashMembers([]string{...})`; the Node SDK hashes `members` for you inside `client.utxo.safeOutputs` |
| `threshold` | group threshold byte |
| `offset` | **numeric** UTXO `sequence`, not a timestamp — every UTXO has an incremental sequence so pagination is deterministic (docs: outputs.md) |
| `state` | `unspent` \| `spent` \| `signed` |
| `limit` / `order` | page size (Go `ListUnspentOutputs` uses 500; the withdrawal path pins 250) / `ASC` |

Output fields that matter (docs: _resp.safe.outputs.md; go: output.go v3.25.7):

- `output_id` — unique id of this UTXO.
- `transaction_hash` + `output_index` — the pointer you cite as a tx input.
- `amount` (decimal string), `asset_id` / `kernel_asset_id`.
- `receivers`, `receivers_threshold`, `receivers_hash` — who can spend it (the group).
- `senders`, `senders_threshold`, `signers`, `signed_by` — provenance; on multisig requests these tell you who created/signed.
- `mask`, `keys` — the ghost-key locking material (you don't need to touch these to *spend* via SDKs).
- `state`, `sequence`, `created_at`; `inscription_hash` (marks inscription UTXOs); `request_id` (the trace that created it); `extra` (hex).

One output, abbreviated (docs: _resp.safe.outputs.md):

```json
{"output_id": "UUID", "transaction_hash": "KERNEL-HASH", "output_index": 0,
 "amount": "2.50000000", "asset_id": "UUID", "kernel_asset_id": "HASH",
 "receivers": ["UUID"], "receivers_threshold": 1, "receivers_hash": "MEMBERS-HASH",
 "senders": ["UUID"], "signers": [], "mask": "KEY", "keys": ["KEY"],
 "state": "unspent", "sequence": 12345, "created_at": "RFC3339NANO",
 "inscription_hash": "", "request_id": "TRACE-UUID", "extra": "HEX"}
```

Balance = Σ `amount` over `state=unspent` rows for that asset — that's the whole computation.

Output state machine:

| State | Meaning | Spendable? |
|---|---|---|
| `unspent` | live, yours to spend | yes |
| `signed` | input of a broadcast-but-unfinalized tx (your pending change) | no — retry later |
| `spent` | consumed by a finalized tx | no |

A tx either finalizes (inputs → `spent`, new outputs → `unspent`) or doesn't (inputs return to `unspent`); there is no rollback state.

Properties that bite:

- **Outputs are one-time addresses.** Each output carries a ghost-key `mask` + `keys` derived per transfer, so every output is cryptographically unique per (receivers, index, hint) even between the same sender/receiver pair — you cannot "top up" an address, only create new UTXOs.
- **Inputs are consumed entirely.** Any spend of an output consumes its full value; **change comes back as a new output to yourself** (all SDK sends append it automatically). No partial spends.
- **Change is not instantly spendable.** After broadcasting, your change outputs sit in `signed` until the kernel finalizes the tx (seconds under load, longer in storms). Spending them immediately ⇒ `'insufficient total input outputs'` (10002-family; the Node selector throws exactly this string) / Go `UtxoInsufficientError` (`"insufficient outputs %s@%d %s"` = totalInput @ utxoCount totalOutput). Retry or wait — don't widen the UTXO set mid-retry.
- **Kernel caps** (kernel `common/transaction.go`): a tx carries at most **256 inputs and 256 outputs** (`SliceCountLimit = 256`; `AddInput`/`AddOutputWithType` panic past it), **16 references** (`ReferencesCountLimit`), and **≤ 256 B extra** for normal txs (`ExtraSizeGeneralLimit`).
- **Per-asset minimums**: too-small transfers are rejected (`20120` transfer too small; `20127` withdraw too small). A dust change output below the minimum is unspendable — see Dust & consolidation.

Reading balances:

| Language | Call |
|---|---|
| Go | `ListUnspentOutputs(ctx, membersHash, threshold, assetId, su)` (= state=unspent, offset 0, limit 500); paginate with `ListOutputs(..., state, offsetSequence, limit, su)`; or `ListAssetWithBalance` / `ListAssetWithBalanceByMembers` for pre-aggregated views; `AssetBalance` for one number |
| Node | `client.utxo.safeOutputs({members?, threshold?, asset?, state?, limit?, offset?, order?})` → sum `amount`; or `client.utxo.safeAssetBalance(params)` → decimal string; `fetchSafeOutputs` (POST `/safe/outputs/fetch`) for specific ids |
| Ruby | `safe_outputs` (CLI: `mixinbot call safe_outputs -d '{"asset":"...","state":"unspent"}'`) |

Group balances: same endpoint with the group's members hash + threshold — deposits, change, and incoming transfers to the group's `MIX` address all land there.

## Receiving money

Three doors, all landing in snapshots (→ reconciliation.md for credit-once patterns and cursor management):

**(a) Direct transfer to the bot.** The payer sends to your `user_id` or your 1-of-1 `MIX` address — same thing (Go `NewUUIDMixAddress([]string{botId}, 1)`, Node `buildMixAddress({members:[botId], threshold:1})`, Ruby `MixinBot::MixAddress`). Nothing to configure. Detect via Blaze `SYSTEM_SAFE_SNAPSHOT` frames (→ blaze.md) or poll `GET /safe/snapshots` (Go `SafeSnapshots(ctx, limit, app, assetId, opponent, offset, su)` — `offset` is `created_at` ISO8601, not a sequence; Node `client.safe.fetchSafeSnapshots({app?, asset?, opponent?, offset?, limit?})` (no `order` in the TS type — paging rules → reconciliation.md § Cursor management); Ruby `safe_snapshots`). Snapshot fields (go: snapshot.go v3.25.7): `snapshot_id`, `user_id`, `opponent_id`, `amount` (**negative = you sent**), `memo`, `request_id` (= trace), `transaction_hash`, `asset_id`, `created_at`, `type`, plus `deposit`/`withdrawal` views. If the payer's wallet errors `10404`, *you* haven't registered with the Sequencer yet (docs: api/sequencer/client-integration.md).

Incoming snapshot, abbreviated:

```json
{"data": {"snapshot_id": "UUID", "user_id": "BOT-UUID", "opponent_id": "PAYER-UUID",
          "asset_id": "UUID", "amount": "0.01000000", "memo": "HEX", "type": "...",
          "request_id": "PAYER-TRACE", "transaction_hash": "KERNEL-HASH",
          "created_at": "RFC3339NANO", "deposit": null, "withdrawal": null}}
```

**(b) User-initiated taps: pay URI / MIN invoice.** Render a `mixin.one` pay URI or a multi-entry `MIN...` invoice in the user's wallet UI; they confirm, you get one snapshot per entry, whose `request_id` is the `trace` you put in the link. That is how you tie a payment to an order (full recipe with under/over-pay and refunds → reconciliation.md § Order payments). Spec, encoding and limits (per-entry memo ≤ 256 B, references ≤ 32) → schemas.md. Builders: Node `buildMixinOneSafePaymentUri(params)` (destination = uuid / XIN mainnet address / MIX address / members+threshold), `newMixinInvoice(recipient)` + `attachInvoiceEntry`; Go `NewMixinInvoice(recipientMixAddr)` + `.Encode()`, `SchemePay(assetId, traceId, recipientId, memo, amount)`; Ruby `MixinBot::Invoice`.

**(c) On-chain deposits.** Request a deposit entry once per (members, threshold, chain):

```
POST /safe/deposit/entries   {"members":["UUID-1"], "threshold":1, "chain_id":"CHAIN-UUID"}
GET  /safe/deposits?asset=&destination=&tag=&offset=RFC3339NANO&limit=500   # pending only
```

Entry response (docs: _resp.safe.entry.md):

```json
{"data": {"entry_id":"UUID", "threshold":1, "members":["UUID-1"],
          "destination":"0xabc… or bc1q…", "tag":"", "chain_id":"CHAIN-UUID",
          "signature":"FOR-VERIFICATION", "is_primary": true}}
```

- The same (asset, chain) tuple ⇒ the **same destination + tag** on repeated calls (docs: api/sequencer/deposit.md). **Show the depositor both destination and tag**; sending to a tagged chain without the tag is a recovery ticket, not a credit.
- Pending deposits expose `confirmations`, `threshold`, `state: pending|confirmed`, `transaction_hash`, `block_number` (docs: _resp.safe.deposits.md) — surface progress; **credit only on `confirmed` + snapshot**, never on the pending record (reorgs).
- Address creation and each deposit are charged (docs: deposit.md): address USD 2 (Ethereum, Bitcoin) / USD 0.5 (Polygon, BSC, Base, Litecoin, Dogecoin, Zcash, Solana, Monero, TRON, TON) / USD 0.1-per-deposit chains (EOS, MobileCoin, Ripple); per-deposit fee USD 3 / USD 0.1 / USD 0.01 respectively.

SDK: Go `CreateDepositEntry` / `FetchPendingSafeDeposits`; Node `client.safe.depositEntries({members, threshold, chain_id})` / `client.safe.pendingDeposits(params)`; Ruby `safe_deposit_entries`, `pending_safe_deposits`.

**Verify it worked (deposit):** poll `GET /safe/deposits?destination=&tag=` for that depositor until the record leaves pending (`state == "confirmed"`), then assert the matching snapshot exists (`GET /safe/snapshots`; the snapshot `deposit` view carries `deposit_hash` + `destination`). Both conditions, always — confirmed-but-no-snapshot means wait; the credit decision rides the snapshot (→ reconciliation.md).

## Sending money — protocol lifecycle (SDK-agnostic)

One canonical pipeline; every SDK wraps it (docs: api/sequencer/transactions.md):

1. **Pick unspent outputs** — `GET /safe/outputs?...&state=unspent` for (members, threshold, asset); take outputs in sequence order until Σ inputs ≥ Σ outputs; the surplus is change. Skip `inscription_hash` outputs (see Inscriptions).
2. **Build recipients** — each recipient is either a `MIX` address (user uuids, group, mainnet members) **or** an on-chain `destination` + optional `tag` (withdrawal; takes no ghost key). Batch fan-out to many recipients in one combined spend is explicitly supported (docs: client-integration.md).
3. **Fetch ghost keys** — `POST /safe/keys`:
   ```json
   [{"receivers": ["UUID-1","UUID-2"], "index": 0, "hint": "UNIQUE-UUID"}]
   → [{"mask": "KERNEL-MASK-KEY", "keys": ["K1","K2"]}]
   ```
   `receivers` are **sorted**; `index` MUST equal the recipient's output slot in the tx; `hint` is a unique UUID — Go derives it from `blake3(traceId) || index`, stable per (trace, recipient) (go: transaction.go v3.25.7). Mainnet/XIN-member ghosts are derived client-side; only UUID receivers hit this endpoint.
4. **Assemble the kernel raw tx** — version `0x05`, `inputs [{hash, index}]`, outputs `[{type:0, amount, keys, mask, script} | {type:161, amount, withdrawal:{address, tag}}]`, `references []hash`, `extra` ≤ 256 B (kernel `common/transaction.go`). Extra/memo bytes are **raw hex** — supply the exact bytes; no implicit base64/msgpack conversion (docs: client-integration.md).
5. **Verify** — `POST /safe/transaction/requests` `[{"request_id": traceId, "raw": hex}]`. Response per tx: `state`, `views`, `receivers`, `transaction_hash`. `views` holds one view-key scalar **per input**, aligned with input order (withdrawal-type outputs also surface `{destination, tag, withdrawal_hash}` rows). **Assert `len(views) == len(inputs)`** — Go hard-errors on mismatch, and a misalignment silently signs with wrong keys.
6. **Sign each input** with the **spend key** (Ed25519): per-input signing key = derived `view[i] + spendKey` scalar sum, signature over the versioned tx `PayloadHash()`; signatures land in a per-input signature map (multisig senders sign at their own key index within the output script).
7. **Broadcast** — `POST /safe/transaction` `[{"request_id","raw"}]` (docs path; both official SDKs POST `/safe/transactions` — plural — which the Sequencer also accepts). **NEVER broadcast via kernel RPC: the Sequencer won't index the tx and downstream queries break** (docs: transactions.md, explicit warning).
8. **Poll** — `GET /safe/transactions/:id` until state settles: fresh-verified = `unspent`, broadcast+signed = `signed`, kernel-finalized = `spent` with `snapshot_hash`/`snapshot_at` populated (docs: _resp.safe.request.md).

Where errors land: `20117` insufficient balance and the 10002-family (bad raw, `insufficient total input outputs`) at verify; `20120`/`20127` size floors at verify; `429` anywhere — back off, same trace.

Wire transcript of a 2-UTXO transfer to one recipient (2.5 + 1.25 in, 0.01 out, change back):

```
# 1. list
GET /safe/outputs?members=HASH&threshold=1&asset=ASSET&state=unspent&limit=500
  → [{tx_hash:H1, output_index:0, amount:"2.5"}, {tx_hash:H2, output_index:1, amount:"1.25"}]
# 3. ghost keys — one row per output slot (dest=0, change=1), receivers sorted
POST /safe/keys
  [{"receivers":["DEST"],"index":0,"hint":"U1"},{"receivers":["BOT"],"index":1,"hint":"U2"}]
  → [{"mask":"M0","keys":["K0"]},{"mask":"M1","keys":["K1"]}]
# 5. verify — raw = tx{inputs:[H1:0,H2:1], outputs:[type0 0.01→DEST, type0 3.74→BOT], extra}
POST /safe/transaction/requests   [{"request_id":"TRACE","raw":"HEX"}]
  → [{state:"unspent", views:["V0","V1"]}]        # exactly 2 views = 2 inputs
# 6-7. sign inputs 0..1 with spend key → broadcast
POST /safe/transactions           [{"request_id":"TRACE","raw":"SIGNED-HEX"}]
# 8. poll
GET /safe/transactions/TRACE      → state: unspent → signed → spent (+snapshot_hash, snapshot_at)
```

Failure points and safe retries (trace stays fixed through all of them):

| Failure at | Meaning | Safe action |
|---|---|---|
| timeout before verify | nothing persisted | rebuild, same trace |
| verify rejected (10002 family) | malformed raw / insufficient inputs | fix raw, same trace |
| broadcast timeout | unknown — request may exist | `GET /safe/transactions/:trace`; if present, poll it; if absent, resend the same signed raw |
| stuck at `signed` | kernel hasn't finalized | wait; never re-spend those inputs with a new trace |
| `UtxoInsufficientError` / `'insufficient total input outputs'` | change settling or dust | backoff retry same trace (2–5 s), or consolidate first |

### Go (v3.25.7)

| Need | Call |
|---|---|
| One recipient, auto UTXO pick + change | `SendTransferTransaction(ctx, assetId, receiver, amount, traceId, extra, su)` (`receiver` = uuid) |
| ...with pinned UTXOs | `SendTransferTransactionWithOutputs(ctx, assetId, receiver, amount, utxos, traceId, extra, su)` |
| Many recipients / references | `SendTransaction(ctx, assetId, recipients, traceId, extra, references, su)` |
| Auto-retry settling change | `SendTransactionUntilSufficient(...)` — loops every **2 s** on `UtxoInsufficientError`; bound it with `ctx` |
| Split change into sized outputs | `SendTransactionWithChangeOutputs(..., splitAmount, splitCount, ...)` — anti-dust |
| Pin UTXOs + custom change | `SendTransactionWithOutputs` / `SendTransactionWithUtxosAndChangeOutputs` |
| Low-level build/verify/send | `BuildRawTransaction` → `VerifyRawTransaction` → `SendRawTransaction` |
| Query | `GetTransactionById(ctx, requestId)` / `GetTransactionByIdWithSafeUser` |

**Go signing gap:** `signRawTransaction` is unexported — the public Go API **cannot sign a raw tx you built yourself**. Real options: use the high-level `Send*` (signing internal), use fox-one `mixin-sdk-go`, or do manual signing in Node. Also note Go send paths cap `references` at 2 (kernel allows 16).

### Node (7.6.0) — full manual chain

```js
const outputs = await client.utxo.safeOutputs({ asset: assetId, state: 'unspent' });
const recipients = [buildSafeTransactionRecipient([destUuid], 1, '0.01')];
const { utxos, change } = getUnspentOutputsForRecipients(outputs, recipients); // skips inscriptions
if (change.gt(0)) recipients.push(buildSafeTransactionRecipient([botId], 1, change.toString()));
const ghosts   = await client.utxo.ghostKey(recipients, traceId, spendPrivateKey); // index = output slot
const tx       = buildSafeTransaction(utxos, recipients, ghosts, extra, references);
const raw      = encodeSafeTransaction(tx);
const verified = await client.utxo.verifyTransaction([{ request_id: traceId, raw }]);
if (verified[0].views.length !== tx.inputs.length) throw new Error('view/input mismatch');
const signed   = signSafeTransaction(tx, verified[0].views, spendPrivateKey /*, signerIndex*/);
const sent     = await client.utxo.sendTransactions([{ request_id: traceId, raw: signed }]);
```

`getUnspentOutputsForRecipients(outputs, recipients, {includeInscriptions?})` → `{utxos, change}`, throws `'insufficient total input outputs'` — same retry semantics as Go's `UtxoInsufficientError`. `decodeSafeTransaction(raw)` inspects a raw tx; errors surface as `ResponseError{code, description, status, requestId}` (node: dist/index.d.ts 7.6.0).

### Ruby (mixin_bot 3.0.2)

`MixinBot.api.create_transfer(members:, asset_id:, amount:, memo:, trace_id:)` runs the whole Safe pipeline (UTXO select → build → verify → sign → submit); configure `spend_key` first; `members:` + `threshold:` targets a multisig group; `create_safe_transfer` is the explicit name. Lower-level, Go-parity: `build_utxos` → `build_safe_transaction` → `verify_raw_transaction` (alias `create_safe_transaction_request`) → `sign_safe_transaction` → `send_safe_transaction(requests:)`; aliases `send_transaction`, `send_transfer_transaction`, `get_transaction_by_id` → `safe_transaction` (ruby: mixin_bot 3.0.2 README). `MixinBot::MixAddress` also exposes `request_or_generate_ghost_keys`.

**Verify it worked (transfer):** poll `GET /safe/transactions/:id` (Go `GetTransactionById`, Node `client.utxo.fetchTransaction`, Ruby `safe_transaction`) until `state == "spent"` **and** `snapshot_at` is set; the counterparty sees the incoming `SYSTEM_SAFE_SNAPSHOT`. State stuck at `signed` past a finality window usually means an input was a not-yet-finalized change output — inspect, wait, resubmit with the same trace.

## Multisig

A group is just a `MIX` address — `MIX(members, threshold)`, members sorted, threshold = signatures required to spend its outputs. Sending **to** a group is an ordinary transfer (ghost keys for the group receivers). **Spending from** a group uses Safe multisig requests (docs: api/sequencer/multisigs.md):

| Step | Endpoint | Body / notes |
|---|---|---|
| Create | `POST /safe/multisigs` | `[{"request_id","raw"}]` — raw = verified kernel tx spending group UTXOs |
| Sign | `POST /safe/multisigs/:id/sign` | `{"request_id","raw"}` — each signer signs the **same raw** at **their index in the sorted senders**, posts their signed raw |
| Unlock | `POST /safe/multisigs/:id/unlock` | releases an incomplete request; only before the threshold is reached |
| Fetch | `GET /safe/multisigs/:id` | by request id **or** tx hash |

Request fields (go: safe_multisigs.go v3.25.7): `request_id`, `transaction_hash`, `asset_id`, `amount`, `senders` + `senders_threshold`, `signers` (who has signed), `state`, `raw_transaction`, `extra`, `views`, `receivers`, `revoked_by`, `inscription_hash`.

A 2-of-3 request after one signature (fields per go: safe_multisigs.go v3.25.7):

```json
{"data": {"request_id": "TRACE", "transaction_hash": "KERNEL-HASH", "asset_id": "UUID",
          "amount": "1.5", "senders": ["A","B","C"], "senders_threshold": 2,
          "signers": ["A"], "state": "...", "raw_transaction": "HEX",
          "views": ["V0"], "receivers": [{"members": ["DEST"], "members_hash": "…", "threshold": 1}]}}
```

When to reach for multisig: hot bot + cold approver on treasury moves; shared group custody (board-controlled payouts); scheduled sweeps that need two humans. Everything else stays 1-of-1 — each extra signer is another keystore to custody (→ custody-and-ops.md).

Signer workflow (2-of-3 example):

1. Initiator builds + verifies the group raw (Go `CreateMultisigRawTx`), then `POST /safe/multisigs`.
2. Each signer: `GET /safe/multisigs/:id` → decode `raw_transaction` (Node `decodeSafeTransaction`) → `signSafeTransaction(tx, views, spendPrivateKey, signerIndex)` where `signerIndex` = **your position among the sorted senders** → `POST /safe/multisigs/:id/sign` with the re-encoded raw.
3. Last needed signature finalizes and broadcasts; everyone polls `signers` and the tx state.
4. Timeout? Any signer unlocks; the UTXOs return; retry with a **new** trace (the old request stays dead).

**Hand the request to a human signer's phone** (verified ios-app@master v6.3.4, 2026-10-17): render `mixin://mixin.one/multisigs/{request_id}` — Messenger opens a multisig preview that fetches `GET /safe/multisigs/:id`. Query `action` = `sign` (default when omitted) or `revoke` / `unlock` (both open revoke; unlock-before-threshold is the abort primitive below). Constraints: `{request_id}` must be a lowercased uuid, and the opener must appear in the request's `senders` — otherwise iOS rejects the link ("invalid payment link"). The sheet reflects `pending` / `signed` (already signed) / `paid` (`signers` ≥ `senders_threshold`) / `revoked`. The `https://mixin.one/multisigs/{request_id}` universal-link form works too — prefer it outside the app (QR, email, web) → schemas.md §1b.

**There is no cancel for Safe multisigs** — not in the protocol, not in Go, not in Node (`cancelSafeMultisigs` does not exist; the `cancel` in Node's `multisig` namespace and Go's `multisigs.go` are PIN-era legacy APIs). Design approval flows to **time out and unlock**, never to cancel; treat unlock as the abort primitive.

SDK: Go `CreateSafeMultisigRequest(ctx, []*KernelTransactionRequestCreateRequest, su)` / `FetchSafeMultisigRequest(ctx, idOrHash, su)` + `CreateMultisigRawTx(...)` (builds the group raw hex); Node `client.multisig.createSafeMultisigs([{request_id, raw}])` / `fetchSafeMultisigs(id)` / `signSafeMultisigs(id, raw)` / `unlockSafeMultisigs(id)`; Ruby `create_safe_multisig_request`, `safe_multisig_request`, `create_multisig_raw_tx`.

**Verify it worked (multisig):** poll `GET /safe/multisigs/:id` until `signers` reaches the threshold and the state finalizes, then `GET /safe/transactions/:id` (by the request's tx hash) for `state == "spent"` + snapshot. After an unlock, assert the request shows released before reusing its pinned UTXOs.

## Withdrawals

Moving funds on-chain. The **destination output is built first** with **no ghost key**: `type 161` (`OutputTypeWithdrawalSubmit` = `0xa1`), `withdrawal: {address: destination, tag}`. Fees go to the cashier `674d6776-d600-4346-af46-58e77d8df185` (Go `MixinFeeUserId`, Node `MixinCashier`).

**Fee quote:** `GET /safe/assets/:assetId/fees?destination=` → (node: dist/index.d.ts 7.6.0)

```json
[{"type":"withdrawal_fee","amount":"0.00021","asset_id":"WITHDRAWN-ASSET-UUID","priority":1},
 {"type":"withdrawal_fee","amount":"0.0000089","asset_id":"CHAIN-ASSET-UUID","priority":3}]
```

Quotes come in **both** the withdrawn asset (same-asset) and the chain asset. Builders: Go `ReadAssetFee(ctx, assetId, destination, su)`, Node `client.safe.fetchFee(asset, destination)`; `ReadSafeFees(su)` for a global table. Choose deliberately: Go's `SendWithdrawal` picks the first same-asset quote when `preferAssetFeeOverChainFee=true`, otherwise the **last** quote in the response — quote explicitly if the choice matters.

**Fee branching** — the kernel rejects withdrawal txs without a matching fee (`20124` insufficient fee, `20135` fee too small):

| Branch | Condition | Transactions |
|---|---|---|
| **Same-asset fee** | fee `asset_id` == withdrawn asset | **One tx**: outputs `[destination(type 161), cashier fee, change]` |
| **Chain-asset fee** | fee paid in the chain's asset (e.g. ETH fee for a USDT withdrawal) | **Two txs**: (1) withdrawal tx `[destination(161), change]`; (2) fee tx `[cashier fee, fee change]`, trace `UniqueObjectId(traceId, "FEE")`, **references `[blake3Hash(withdrawalRaw)]`** — verify and send both **as a pair, in one request** |

Go: `SendWithdrawal(ctx, assetId, destination, tag, amount, traceId, preferAssetFeeOverChainFee, memo, su)` → `[]*SequencerTransactionRequest`; **`len(result)` tells you the branch** (1 = same-asset, 2 = chain-asset). `WithdrawalWithUtxos(ctx, traceId, feeAssetId, feeAmount, assetId, destination, tag, memo, amount, utxos, feeUtxos, su)` pins your own UTXO sets (the SDK's default fee-UTXO selection is the subject of an open 2026-08 issue — pin when fee UTXOs are settling).

```go
reqs, err := bot.SendWithdrawal(ctx, assetId, destination, tag, amount, traceId, false, memo, su)
// len(reqs) == 1 → same-asset fee; len(reqs) == 2 → chain-asset fee (reqs = withdrawal + FEE tx)
for _, r := range reqs {
    for {
        tx, err := bot.GetTransactionById(ctx, r.RequestID) // poll until state == "spent"
        if err == nil && tx.State == "spent" { break }
        time.Sleep(3 * time.Second)
    }
}
```

Node two-tx skeleton (helpers verified against dist/index.js 7.6.0; `buildSafeTransaction` emits a type-161 output for any recipient carrying `destination`):

```js
const wRecipients = [{ amount, destination, tag: tag ?? '' }];           // + change after selecting
const { utxos, change } = getUnspentOutputsForRecipients(await client.utxo.safeOutputs({asset: assetId, state:'unspent'}), wRecipients);
if (change.gt(0)) wRecipients.push(buildSafeTransactionRecipient([botId], 1, change.toString()));
const wTx = buildSafeTransaction(utxos, wRecipients, await client.utxo.ghostKey(wRecipients, traceId, spend), Buffer.from(memo,'utf8'));
const wRaw = encodeSafeTransaction(wTx);
// fee tx: cashier recipient + fee-asset change, references [blake3Hash(Buffer.from(wRaw,'hex'))]
const fRecipients = [buildSafeTransactionRecipient([MixinCashier], 1, feeAmount)]; // + fee change
const fTx  = buildSafeTransaction(fUtxos, fRecipients, await client.utxo.ghostKey(fRecipients, feeTraceId, spend), Buffer.from(memo,'utf8'), [blake3Hash(Buffer.from(wRaw,'hex')).toString('hex')]);
const verified = await client.utxo.verifyTransaction([{request_id: traceId, raw: wRaw}, {request_id: feeTraceId, raw: encodeSafeTransaction(fTx)}]);
// sign BOTH with their own views, then:
await client.utxo.sendTransactions([{request_id: traceId, raw: signedW}, {request_id: feeTraceId, raw: signedF}]);
```

**Validate the destination format yourself per chain** (address checksum, tag/memo required for XRP/EOS-style chains) **before signing** — the network only rejects the built tx (`30102` invalid address; `10104` address still generating right after creating a deposit entry). Your code, not the wallet, is the last line of defense.

**Address book** (optional whitelist; TIP-signed, distinct from deposit entries): `POST /addresses` `{asset_id, label ≤64, destination ≤128, tag?, pin_base64}` where the TIP body is `"TIP:ADDRESS:ADD:" + asset_id + destination + tag + label` (sha256-sum, base64); `GET /assets/:assetId/addresses`; delete via TIP body `"TIP:ADDRESS:REMOVE:" + addressId` (docs: api/withdrawal/address-add.md). Go `CreateAddress(ctx, *AddressInput, su)` (TIP body built for you) / `GetAddressesByAssetId` / `DeleteAddress` / `CheckAddress(ctx, asset, destination, tag)`; Node `client.address.create(pin, {asset_id, destination, tag, label})` / `fetchListOfChain(chainID)` (`fetchList(assetID)` deprecated) / `delete(pin, addressID)` with `getCreateAddressTipBody` / `getRemoveAddressTipBody`.

Floors and limits: `20127` withdraw too small, `20134` too large, `20131` memo format, `20117` insufficient balance, `20125` paid by someone else → common-errors.md.

**Verify it worked (withdrawal):** (1) `GET /safe/transactions/:id` for the withdrawal request → `views[]` contains `{destination, tag, withdrawal_hash}`; (2) the snapshot (`GET /safe/snapshots`) carries `withdrawal: {withdrawal_hash, receiver}` — `withdrawal_hash` is the **external chain tx id**, assert it non-empty; (3) two-tx branch: the **fee** request must also reach `spent`. Empty `withdrawal_hash` after finalization means the tx was a plain transfer — you forgot the type-161 output.

## Dust & consolidation

Failure mode: the many-small-outputs wallet.

Symptoms (any of):

- `20120` transfer too small — amount or change below the asset minimum.
- Builds needing more than **256 inputs** (kernel `SliceCountLimit`) — the SDK panics or verify rejects; consolidate *before* you get here.
- `'insufficient total input outputs'` / `UtxoInsufficientError` while `safeAssetBalance` shows plenty — because change UTXOs from a just-broadcast tx are still `state=signed`, or inscription outputs were excluded by the selector.

Fixes:

- **Periodic self-transfer consolidation**: `SendTransaction` to your own 1-of-1 `MIX` address sweeps N dust UTXOs into one output. The Go SDK never grew a consolidation helper (open request since 2025-07) — schedule it yourself:

```go
rec := &bot.TransactionRecipient{MixAddress: bot.NewUUIDMixAddress([]string{su.UserId}, 1), Amount: total}
_, err := bot.SendTransaction(ctx, assetId, []*bot.TransactionRecipient{rec}, traceId, nil, nil, su)
```

Node equivalent (sum amounts as decimal strings — bignumber.js, the SDK's own dependency):

```js
const outs = await client.utxo.safeOutputs({ asset: assetId, state: 'unspent' });
if (outs.length < 2) return;                       // nothing to consolidate
const total = outs.reduce((s, o) => s.plus(o.amount), new BigNumber(0));
const recipients = [buildSafeTransactionRecipient([botId], 1, total.toString())];
const { utxos } = getUnspentOutputsForRecipients(outs, recipients); // consumes them all
// → build → verify → sign → send with a fresh consolidation trace (one per run)
```

- **Split change on the way out**: Go `SendTransactionWithChangeOutputs(..., splitAmount, splitCount, ...)` emits change as `splitCount` sized outputs (even count, ≤ 256 − recipients), so payouts don't re-fragment into dust; Node: append your own change recipients.
- **Retry on settling change**: Go `SendTransactionUntilSufficient` sleeps 2 s per attempt on `UtxoInsufficientError`; Node: catch `'insufficient total input outputs'` and back off 2–5 s. Keep the trace stable across retries.
- Rule of thumb: alert when a hot wallet holds > ~100 unspent outputs per asset; consolidate nightly; never spend an inscription output as change.

## Inscriptions

Inscription (collectible) outputs are special UTXOs: the output/tx carries `inscription_hash` — that's how you distinguish them from common transfers (docs: api/inscription.md).

- **Read side**: `GET /safe/inscriptions/collections/:hash` (by deploy tx hash or kernel asset id), `GET /safe/inscriptions/items/:hash`. Go `ReadCollection` / `ReadCollectionItems` / `ReadInscription` — types `Collection`, `Inscription{Deploy, Distribute, Inscribe, Occupy}`, `Treasury` (read-side only; writing = building a Safe tx with an inscription extra). Node `client.safe.fetchInscriptionCollection(hash)` / `fetchInscriptionItem(hash)` / `fetchInscriptionItems(collectionHash, offset?)`.
- **Transfer = spend the inscription output ENTIRELY**: exactly **1 input, 1 output, no split/merge/change** (docs: inscription.md — "there can only be 1 input and 1 output for a inscription transaction"). Node: `client.safe.transferInscription({...})` (spend key defaults to keystore) or standalone `transferInscription(utxoClient, params)`; `getInscriptionOutput(utxo, inscriptionHash, {members?, threshold?, limit?})` locates the UTXO. `TransferInscriptionParams`: `inscriptionHash?` \| `utxo?`, `receivers`, `threshold`, `spendPrivateKey`, `memo?`, `signerIndex?`, `request_id?`, `members?`, `ownershipThreshold?` (node: dist/index.d.ts 7.6.0).
- **Operation extras**: `buildInscriptionOperationExtra(operation)` / `decodeInscriptionOperationExtra` — JSON-encoded op (`inscribe`+`recipient`, `distribute`+`sequence`, `occupy`+`sequence`, or `version/mode` with `InscriptionModeInstant=1` / `InscriptionModeDone=2`). Deploy/inscribe follow the kernel INSCRIPTION.md spec via ordinary Safe txs with these extras.
- **UTXO selectors skip inscriptions by default** — `getUnspentOutputsForRecipients(..., {includeInscriptions})` filters outputs with `inscription_hash` unless opted in; Go high-level sends exclude them too. Never spend an inscription output as ordinary value.
- Released an inscription carelessly? **Re-occupy** it with a new occupancy transaction (docs: inscription.md rule 3).

**Verify it worked (inscription transfer):** `GET /safe/transactions/:id` shows `inscription_hash` on the request and `state == "spent"`; the item lookup reflects the new owner's output; receivers get a `SYSTEM_SAFE_INSCRIPTION` Blaze frame (→ blaze.md).

## Large extras — storage entries

`extra` > 256 B cannot ride a normal tx (`ExtraSizeGeneralLimit = 256`). Split the payload:

1. **Send a storage tx** — a XIN-only transfer (`XINAssetID = c94ac88f-4671-3976-b60a-09064f1811e8`) whose `extra` *is* the payload (≤ `ExtraSizeStorageCapacity` = **4 MiB**), paid to the fixed storage recipient: a mainnet `MIX` address generated from seed `bytes.Repeat([]byte{1}, 64)` with threshold 64 (Go `StorageRecipient()`, Node `getRecipientForStorage(extra)`).
2. **Cost** = `ceil(len(extra)/1024) × 0.0001 XIN` (`ExtraSizeStorageStep = 1024`, `ExtraStoragePriceStep = "0.0001"`): ≤1 KiB = 0.0001 XIN · 10 KiB = 0.001 XIN · 100 KiB = 0.01 XIN · 4 MiB = 0.41 XIN (Go `EstimateStorageCost(extra)`, Node `estimateStorageCost(extra)`).
3. **Reference the storage tx's hash** from your operational tx's `references` (kernel cap 16; Go send paths cap 2) and keep the operational tx's own `extra` ≤ 256 B (a content hash + pointer is all it needs).

Go: `CreateObjectStorageTransaction(ctx, recipients, utxos, extra, traceId, references, limit, su)` — sends the storage tx and any piggyback recipients in one go; `limit` (decimal string) is the max XIN you'll pay; cost is `max(estimate, limit)`. Node: `getRecipientForStorage` + the normal build chain; invoices can carry storage entries via `attachStorageEntry(invoice, trace_id, extra)` (`isStorageEntry` to detect). Ruby: `create_object_storage_transaction`. Big-metadata deploys/inscribes use exactly this pattern (docs: api/inscription.md links kernel STORAGE.md).

```go
// 1) store the payload (XIN), then 2) reference it from the operational tx
str, err := bot.CreateObjectStorageTransaction(ctx, nil, nil, payload, storeTrace, nil, "", su)
// poll bot.GetTransactionById(ctx, str.RequestID) until spent, then:
_, err = bot.SendTransaction(ctx, opAssetId, opRecipients, opTrace, pointerExtra,
    []string{str.TransactionHash}, su)      // references = [storage tx hash]
```

**Verify it worked (storage):** the storage request reaches `state == "spent"` (its own `GET /safe/transactions/:id`) **before** you broadcast the operational tx referencing its hash — referencing an unfinalized storage tx is the classic verify rejection; then verify the operational tx as usual.

## Verify it worked — master checklist

| Flow | Confirm with | Assert |
|---|---|---|
| Transfer | `GET /safe/transactions/:id` | `state == "spent"`, `snapshot_at` set; snapshot visible in `GET /safe/snapshots` with `request_id` == trace |
| Withdrawal | tx request + snapshots | `views[].withdrawal_hash` non-empty; snapshot `withdrawal.withdrawal_hash` = external chain tx id; fee request also `spent` on the two-tx branch |
| Deposit | `GET /safe/deposits?destination=&tag=` | record confirmed out of pending **and** matching snapshot exists before crediting |
| Invoice paid | snapshots per entry | every entry's trace found as a snapshot `request_id` → reconciliation.md (credit exactly once) |
| Multisig | `GET /safe/multisigs/:id` → tx | `signers` ≥ threshold; tx `state == "spent"`; unlock shows released before reusing UTXOs |
| Inscription | tx + item lookup | `inscription_hash` present, `state == "spent"`, item shows new owner |
| Storage | storage tx → operational tx | storage `spent` first, then operational `spent` |

Payments monitoring should ride snapshots, not balance polling: → reconciliation.md. Rate limits are undocumented — global backoff honoring 202/429 → custody-and-ops.md; full error table → common-errors.md; failure stories → gotchas.md.

## Sources

- docs: api/sequencer/{transactions,outputs,multisigs,deposit,overview,client-integration}.md; api/inscription.md; api/withdrawal/address-add.md; api/_partials/_resp.safe.{outputs,requests,request,entry,deposits}.md (developers.mixin.one HEAD 2026-10-05)
- go: bot-api-go-client v3.25.7 — transaction.go, withdrawal.go, object.go, output.go, asset.go, safe_multisigs.go, address.go, invoice.go, inscription.go, tip.go, crypto.go, snapshot.go
- node: @mixin.dev/mixin-node-sdk 7.6.0 — dist/index.d.ts, dist/index.js (safe-tx helpers, endpoints, constants, inscription/storage)
- ruby: mixin_bot 3.0.2 README (2026-10-09)
- kernel: MixinNetwork/mixin common/transaction.go (master, fetched 2026-10-11) — `SliceCountLimit=256`, `ReferencesCountLimit=16`, `ExtraSizeGeneralLimit=256`, `ExtraSizeStorageStep=1024`, `ExtraSizeStorageCapacity=4 MiB`, `ExtraStoragePriceStep="0.0001"`, `OutputTypeScript=0x00`, `OutputTypeWithdrawalSubmit=0xa1`, `TxVersionHashSignature=0x05`
- github.com/MixinNetwork/bot-api-go-client issues (open as of 2026-10: consolidation helper request 2025-07, fee-UTXO assignment 2026-08)
