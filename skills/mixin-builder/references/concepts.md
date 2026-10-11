# Mixin Network: the mental model

## What Mixin is

Mixin is not a smart-contract chain. It is a UTXO payment network with a messenger bolted on as the wallet UI (docs: api/sequencer/overview.md):

- **Mixin Kernel** — the layer that *stores and validates* transactions. Final authority; consensus over signed UTXO transactions. You never talk to it directly for Safe flows (broadcasting must go through the sequencer or indexing breaks → payments.md).
- **Mixin Sequencer** — an *indexer* on top of the Kernel: keeps user data, orders transactions, and exposes the `/safe/*` API surface (`/safe/me`, `/safe/outputs`, `/safe/transactions`, `/safe/snapshots`, `/safe/multisigs`, …). Every operation ultimately proxies to the Kernel JSON-RPC (docs: api/sequencer/overview.md).
- **Mixin Safe** — the money layer built on UTXOs ("Safe" = the current account/tx stack; the pre-Safe Messenger APIs are legacy).
- **Blaze** — the push channel: one WebSocket (`wss://blaze.mixin.one`, subprotocol `Mixin-Blaze-1`) delivering messages, transfer snapshots, and conversation events → blaze.md.
- **Messenger** — the mobile/web app normal users see. For a builder it is just the wallet UI and the browser for `mixin://` deep links → schemas.md.
- **A bot IS a user.** An app bot's `app_id` is a user uuid: it can hold balances, be a multisig member, receive transfers, appear in chats. There is no separate "bot account" type. Sending money to a bot = sending money to that uuid.

**The custody insight**: for a bot/app you hold the *spend private key* (keystore field `spend_private_key`). The Kernel executes whatever valid signature arrives — Mixin support cannot reverse a transaction, freeze your UTXOs, or recover a leaked key. Mistakes are permanent. Key handling rules live in custody-and-ops.md and identity-and-keys.md.

## Actors

| Actor | What it is | How you address it |
|---|---|---|
| User | Any Mixin account (human or bot) | uuid (`user_id`) or 6–7 digit identity number |
| Bot / app | A user created via the developer dashboard; `app_id == user_id` | uuid; authenticates with EdDSA JWT per request (identity-and-keys.md) |
| Multisig group | N members + threshold M; the unit of UTXO ownership on Safe | MIX address (members sorted + threshold) or `members_hash` + `threshold` in API params |
| MTG worker | A server that is a member of a multisig group, co-signing group transactions | Its own user uuid inside the group → mtg.md |
| Cashier | Mixin's fee/withdrawal service, uuid `674d6776-d600-4346-af46-58ee77d8df185` (Go `MixinFeeUserId`; Node `MixinCashier`) | Appears as fee recipient in withdrawal outputs |
| Sequencer | Indexer + `/safe/*` API host | `api.mixin.one` (Go `SetBaseUri`) |
| Kernel | Validation layer behind everything | JSON-RPC only (`CallKernelRPC`); do not broadcast through it |

## Asset model

- `asset_id` — uuid of the asset (e.g. XIN = `c94ac88f-4671-3976-b60a-09064f1811e8`). Stable, canonical identifier for payments.
- `chain_id` — uuid of the hosting external chain (e.g. Bitcoin, Ethereum). An asset lives on one chain; many assets share a chain.
- **Precision is always 8** decimal places. Amounts are decimal **strings** (`"1.5"`), never floats — float math corrupts the last digits, which are money.
- `KernelAssetID` vs `AssetID` in snapshot views: same coin, kernel-native id vs sequencer id; carry both when reconciling → reconciliation.md.

### Naming trap: XIN vs "MixinAssetID"

| Constant | Value | Actually is |
|---|---|---|
| XIN asset id | `c94ac88f-4671-3976-b60a-09064f1811e8` | XIN, Mixin's native token (used for storage/Computer fees) |
| Node `MixinAssetID` | `43d61dcd-e413-450d-80b8-101d5e903357` | **Ethereum** (the ETH asset) — misleading name; never use it as "XIN" |

(go: constants via gt.md verification of withdrawal.go / node dist/index.d.ts 7.6.0)

### Balances are derived, not stored

There is no balance endpoint of record. The sequencer is a thin proxy over the Kernel; balance = sum of your unspent outputs (docs: api/sequencer/outputs.md):

1. `GET /safe/outputs?members=HASH&threshold=N&state=unspent` — paginate with the numeric `offset` (each UTXO has an incremental sequence number; deterministic pagination).
2. Sum output values per `asset_id` client-side.

Helpers: Go `ListUnspentOutputs(ctx, membersHash, threshold, assetId, su)`; Node `client.utxo.safeOutputs(...)` / `safeAssetBalance`; Ruby `MixinBot::Output#safe_outputs`. Change-UTXO churn means the unspent set changes after every send → payments.md.

## Coming-from translations

### From EVM (Solidity) development

| You expect (EVM) | Mixin reality |
|---|---|
| Deploy a contract | No contracts on Mixin itself; business logic lives in *your server* (bot), or in Mixin Computer (Solana execution) → computer.md |
| Pay gas per call | No gas on Mixin transfers. Fees only on **withdrawals** to external chains (quoted via `/safe/assets/:id/fees`) and XIN-priced extras (storage 0.0001 XIN / 1024 B). Messenger messages are free. |
| Account model, `mapping(address => uint)` | UTXO model: balance = unspent outputs; each spend consumes whole outputs and mints change. Track by `trace_id`, not by "account". |
| Nonce ordering | No sequential nonce. Idempotency key is the **trace id** (UUID you generate, stable per intent); replay protection per-input via ghost-key `hint`/index → payments.md |
| Client sends pre-signed tx to RPC | Same shape! Tx is built and signed **client-side** (ghost keys → raw → verify → sign → broadcast) — the SDK does this in-process; nothing trusted server-side holds your funds |
| `msg.sender` | The opponent/opponent_id on a snapshot, or the multisig members of the input UTXO |
| L2/execution chain | Mixin Computer = Solana program execution reachable through Safe transactions → computer.md |

### From Telegram bot development

| You expect (Telegram) | Mixin reality |
|---|---|
| Bot token + `api.telegram.org` polling | No bot token server. The bot is a **full user with money**: keystore (session key signs JWTs) + optional spend key |
| `getUpdates` long-poll / webhook | **Blaze WebSocket** (`wss://blaze.mixin.one`, subprotocol `Mixin-Blaze-1`, gzip binary frames); must ACK every processed frame or the gateway retransmits 10–30× → blaze.md |
| Text message JSON | Messages are `category` strings + **base64-encoded** payloads (`data_base64`); e.g. `PLAIN_TEXT`, `APP_CARD` (your UI), `SYSTEM_SAFE_SNAPSHOT` (money arrived) → messaging.md |
| Bot can't hold money | Bot *is* the wallet; users pay it via pay links/QR → schemas.md, payments.md |
| Deep links `t.me/...` | `mixin://` scheme + `https://mixin.one/pay/...` → schemas.md |

### From custodial fintech

| You expect (custodial fintech) | Mixin reality |
|---|---|
| "The provider is the custodian" | **You are the custodian.** The spend private key in your keystore is the root of custody; whoever holds it holds the money |
| Ledger rows in your DB, provider moves funds | Snapshots (`GET /safe/snapshots`) are the authoritative ledger; your DB is a cache → reconciliation.md |
| Chargebacks / support reversal | None. Confirmed Safe transactions are final; design for it (validate destinations, confirm-before-send) |
| Reconciliation via provider reports | Derive balances from `/safe/outputs`; reconcile credits against snapshots keyed on `trace_id` (credit exactly once) |
| Cold/warm wallet split | Achieved with multisig groups (M-of-N MIX addresses) and key separation → custody-and-ops.md, mtg.md |

## Topology

```
                 ┌──────────────────────── your server ───────────────────────┐
                 │  bot / MTG worker (keystore: session key, spend key, TIP)  │
                 └───────┬──────────────────────────────┬────────────────────┘
     REST + EdDSA JWT    │                              │  WSS (Mixin-Blaze-1,
     (Authorization:     │                              │  gzip frames, ACK)
      Bearer, X-Request-Id)                              │
                 ┌───────▼──────────┐          ┌─────────▼─────────┐
                 │ api.mixin.one    │          │ blaze.mixin.one   │
                 │ (Sequencer       │          │ (Blaze gateway)   │
                 │  /safe/*, users, │          │  messages,        │
                 │  oauth, network) │          │  SYSTEM_SAFE_     │
                 └───────┬──────────┘          │  SNAPSHOT push    │
                         │ JSON-RPC proxy      └───────────────────┘
                 ┌───────▼──────────┐
                 │  Mixin Kernel    │  stores & validates UTXO transactions
                 └───────┬──────────┘
                         │ withdrawals (output type 161, destination + tag,
                         │  fee to Cashier 674d6776-…df185)
                 ┌───────▼──────────┐
                 │ external chains  │  BTC / ETH / … via cashier processing
                 └──────────────────┘
```

Reading money: same REST surface (`/safe/outputs`, `/safe/snapshots`) works for both pushes (Blaze notifies) and pulls (poll snapshots). Messenger users interact with the same network through `mixin://` links and `https://mixin.one/pay/...` pages → schemas.md.

## Sources

- docs: api/sequencer/overview.md, api/sequencer/outputs.md (repo snapshot 2026-10-05 at /tmp/sdksrc/developers.mixin.one-HEAD)
- go: mix.go, withdrawal.go, output.go, snapshot.go v3.25.7
- node: dist/index.d.ts + dist/index.js 7.6.0 (MixinCashier/XINAssetID/MixinAssetID constants)
- gt.md verified baseline 2026-10-11
