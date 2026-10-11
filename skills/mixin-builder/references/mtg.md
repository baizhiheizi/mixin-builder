# MTG — Mixin Trusted Group

An MTG is a **consensus group of Mixin bots** that jointly controls one on-chain balance and computes one deterministic action log. This is the Go-only domain: the reference library is `github.com/MixinNetwork/safe` **v0.28.2** (module proxy `@latest`, 2026-10-11) package `mtg`, and the canonical production deployment is `github.com/MixinNetwork/computer` (HEAD fetched 2026-10-11), which drives Mixin Computer over Solana. Node/Ruby SDKs have no MTG runtime — they only *send into* a group (below).

> ⚠️ MTG documentation was **deleted** from developers.mixin.one (commit `48398f1`, ~2025-09-30). This file plus the two source repos are the only reference; everything here was read out of the fetched trees at `/tmp/sdksrc/github.com/MixinNetwork/safe@v0.28.2` and `/tmp/sdksrc/computer/computer-HEAD`.

## What an MTG is

A group is the fixed tuple **(members, threshold, epoch)**:

- **Group MIX address** = `MIX(members, threshold)` — members sorted before encoding. All funds users send land here as UTXOs. (go: safe@v0.28.2 mtg/utils.go `NewMixAddress`; go: bot-api-go-client v3.25.7 mix.go)
- **extra** on each output dispatches the output to the owning application: `extra = base64rawurl(uuid16(appId) || memo)`, hex-encoded on chain. (mtg/utils.go `EncodeMixinExtraBase64` / `DecodeMixinExtraHEX`)
- **Messenger group conversation** carries the MPC traffic between nodes (encrypted messages, see MPC section). (safe@v0.28.2 messenger/)
- **Genesis identity** = `sha256(sort(members) joined || ":" || threshold || ":" || epoch)`; every node derives it independently and the store refuses a mismatched genesis on boot. (mtg/group.go `generateGenesisId`, `BuildGroup`)

## Node roles

Even when compiled into one binary (`computer boot`), the roles are separate code paths — keep them separate in any reimplementation (go: computer solana/node.go `Node.Boot` starts observer + signer + balance loops; cmd/computer.go wires group+worker):

| Role | Duty | Where |
|---|---|---|
| **observer** | Watches the external world and **commits facts as Mixin transactions** to the group (price info, session proposals, confirmed Solana calls…). Exactly one node: `observer-id` in config. | solana/observer.go `bootObserver` (returns immediately if `node.id != conf.ObserverId`) |
| **signer** | Runs MPC rounds (keygen / threshold signatures) triggered by observer-proposed transactions, messages flowing over the messenger group. Every node runs this. | solana/signer.go `bootSigner` |
| **worker** | Deterministically processes the ordered input stream and emits group transactions. Implemented per app; attached via `group.AttachWorker(appId, wkr)`. | safe@v0.28.2 mtg/group.go `Worker` interface |

Bootstrap order in `cmd/computer.go`: read TOML → `mtg.OpenSQLite3Store(store-dir + "/mtg.sqlite3")` → `mtg.BuildGroup` → `group.EnableDebug()` (turns on replay checks) → `messenger.NewMixinMessenger(ctx, conf, genesisMembers)` → `computer.NewNode(...)` → `node.Boot` → attach worker → `group.Run(ctx)` (blocking).

## The input stream

The ONLY consensus input is the group's own UTXO set, read from the Sequencer:

```
GET /safe/outputs?members=<HashMembers(sorted members)>&threshold=<t>&order=ASC&offset=<last sequence>&limit=<batch>
```

- `offset` is the numeric **UTXO sequence**, not a timestamp; poll ascending. (mtg/drain.go `readSafeOutputsAsUnspent`; same endpoint shape as go output.go `ListOutputs`)
- The `members` param is `HashMembers(sorted members)` — the hash of the sorted member list (`mixinnet.HashMembers` in safe@v0.28.2); sort before hashing or you query a different group.
- The drain loop persists a checkpoint property (`outputs-draining-checkpoint`) and re-reads on error; outputs are processed in chunks of ≤64. (mtg/drain.go `drainOutputsFromNetwork`)
- **Epoch filter**: any output with `sequence < epoch` is ignored — this is how a migrated group ignores pre-migration history. (drain.go `processSafeOutputs`)
- **Snapshots (`GET /safe/snapshots`) are NOT consensus input** — they are user-facing history/notifications only. Do not drive worker logic off snapshots.
- Local state machine (mtg/output.go, action.go, transaction.go): outputs `unreceived → unspent → assigned → signed → spent`; actions `Initial(10) → Done(11)` (+ `Restorable(12)`); transactions `Initial(10) → Signed(12) → Snapshot(13)`.

The whole engine is one loop (mtg/group.go `Group.Run`, 500 ms cadence):

```
drainOutputsFromNetwork  → poll /safe/outputs, persist outputs+actions (idempotent)
handleActionsQueue       → up to 16 Initial actions/round through workers
signTransactions         → build raw tx, create+sign SAFE multisig per asset
publishTransactions      → wait request state == spent, mark Snapshot
confirmWithdrawalTransactions → verify withdrawal hash on chain
```

## Determinism rules

The worker contract (mtg/group.go `Worker`):

```go
ProcessOutput(ctx, *Action) (txs []*Transaction, compactionAsset string)
```

1. **Pure function of (output, committed store state)** — no `time.Now()`, no randomness, no external HTTP/RPC inside `ProcessOutput`. If the action needs an external fact, the **observer commits that fact as a Mixin tx first** and the worker consumes it from the stream.
2. **Replay check**: with `EnableDebug()` (computer enables it in production), the group calls `ProcessOutput` **twice** on a fresh action and compares `SerializeTransactions` byte-for-byte; mismatch panics the node. (mtg/action.go `replayCheck`)
3. **Balance checks via store**, not network: `Action.CheckAssetBalanceAt(ctx, assetId)` sums unspent outputs ≤ action sequence; returning transactions without checking balance gets them silently dropped for insufficient funds. (group.go; comment on `Worker`)
4. **Idempotent stores**: `writeOutputAndAction` returns nil if output+action already exist (mtg/store.go); MPC round messages persist via `WriteSessionWorkIfNotExist` (computer store/work.go). Every write is keyed — re-running an action must produce the same trace IDs, never new ones.
5. **Dust compaction**: worker returns `compactionAsset` with no txs when it wants change consolidation; group batches ≥ `OutputsBatchSize` (36) outputs into one tx. (mtg/transaction.go `buildCompactionTransaction`)
6. **Deposit routing**: outputs with deposit data route by registered `(destination, tag)` entry, not by extra. (group.go `RegisterDepositEntry`, action.go `checkCompactionTransaction`)

## Thresholds and membership

Validated at boot, panic on violation (computer solana/node.go `NewNode`):

- `mtgThreshold ≥ mpcThreshold` — the group must be able to outvote the MPC set ("the mtg threshold must not be smaller than the mpc threshold", config/example.toml).
- `mtgThreshold ≥ len(members)*2/3+1`.
- MPC threshold recommended = 2/3 of member count (example.toml comment); computer signs with `threshold + 1` prepared members. (signer.go `loopPreparedSessions`)
- `BuildGroup` also rejects `len(members) < threshold`, `threshold < 1`, and a keystore app that is not a member. (mtg/group.go)

**Membership/threshold changes are a migration, not an in-place edit.** The `Iteration` mechanism (add=11/remove=12, mtg/iteration.go) is explicitly `TODO not implemented yet`. To change members or threshold: deploy a **new group** (new sorted-member tuple ⇒ new genesis id ⇒ new MIX address, new epoch above the old one so old outputs stay filtered), sweep the old group's balance to the new address, and run fresh FROST keygen for the new signer set [migration procedure inferred — the library only ships the pieces]. Sort members before deriving anything — `Group.GetMembers()` panics on unsorted input under debug.

## Configuration

Computer node TOML (computer config/example.toml; TOML keys verbatim, nested under `[computer]`; embedded mtg config under `[computer.mtg.genesis]` / `[computer.mtg.app]`):

```toml
[computer]
app-id = "<group worker app id>"        # actions/outputs owner
store-dir = "/tmp/safe/computer"        # private sqlite dir (mtg/wallet/computer .sqlite3)
messenger-conversation-id = ""          # group chat carrying MPC traffic
monitor-conversation-id = ""            # alert channel (optional)
threshold = 2                           # MPC threshold (2/3 of members recommended)
observer-id = "<member uuid>"           # which node runs the observer role
observer-spend-public-key = "<hex>"
mixin-messenger-api = "https://api.mixin.one"
mixin-rpc = "https://kernel.mixin.dev"
# + solana-rpc, solana-key, solana-deposit-entry, operation-price-*, mpc-key-number, timestamp

[computer.mtg.genesis]                  # MUST be byte-identical on all nodes
members = ["...", "...", "..."]
threshold = 3                           # mtg threshold ≥ mpc threshold
epoch = 15903300                        # ignore outputs with sequence < epoch

[computer.mtg.app]                      # THIS node's keystore only
app-id = "<member uuid>"
session-id / session-private-key / server-public-key / spend-private-key = "..."

[dev]
profile-port = 12345                    # pprof
log-level = 3
```

Bare library usage (safe@v0.28.2 mtg/example.toml): top-level `store-dir`, `project`; `[app]` keystore; `[genesis]` members/threshold/epoch. Messenger section keys (`MixinConfiguration` toml tags): `user`, `session`, `key`, `conversation`, `send-buffer`, `receive-buffer` (safe messenger/mixin.go). Genesis fields must be identical across nodes; only `[app]` differs.

## Sending to an MTG from client code

1. Compute the recipient: `MIX(members, threshold)` with members sorted — Go `bot.NewUUIDMixAddress(members, threshold)`, Node `buildMixAddress({members, threshold})`. Do not hand-assemble.
2. Build the extra: Go `bot.EncodeMtgExtra(appId, memo)` / Node `encodeMtgExtra(app_id, extra)` → `base64rawurl(uuid16(appId) || memo)` (go: computer.go v3.25.7; node: 7.6.0). The appId is the **worker** the output is dispatched to.
3. Send a normal Safe transfer to the MIX address carrying that extra (Go `SendTransferTransaction` / Node `sendTransactions`; → payments.md). Amount must clear dust minimums (error 20120 transfer too small).
4. Memo payload > 256 B cannot ride the tx — use the storage-entry pattern (XIN storage tx referenced from the operational tx; → payments.md).

Receiving side: `DecodeMixinExtraHEX(extra)` yields `(appId, memo)`; unknown appId falls back to the group's own id; outputs addressed to an app with no attached worker are marked Done without side effects (mtg/action.go `handleActionsQueue`).

## Group transaction signing (spend path)

Group-emitted transactions do **not** use FROST; they use SAFE multisigs signed by each node's spend key (mtg/transaction.go `signTransaction`):

1. `createMultisigUntilSufficient(requestID, hex(raw))` → `POST /safe/multisigs`.
2. **Never sign a raw you didn't build**: the multisig request id is public and deterministic, so anyone can pre-create the request with a different raw — `CheckMultisigRequestRawTransaction(req, ver)` must pass before signing (source comment, transaction.go).
3. Each node signs via `signMultisigUntilSufficient` until `len(Signers) ≥ SendersThreshold`.
4. `publishTransactions` polls the request until `state == spent` before marking Snapshot — request state via `GET /safe/transactions/:id` family (`readTransactionUntilSufficient`).

## MPC / FROST notes

Verified against `github.com/MixinNetwork/multi-party-sig` **v0.7.0** (`protocols/frost/frost.go`, `protocols/frost/keygen`, `protocols/frost/sign`):

- `frost.Keygen(group curve.Curve, selfID party.ID, participants party.IDSlice, threshold int) protocol.StartFunc`
- `frost.Sign(config *Config, signers []party.ID, messageHash []byte, variant int)` — computer passes `sign.ProtocolEd25519SHA512`.
- `frost.EmptyConfig(group)` + `Config.UnmarshalBinary(share)` restores persisted shares; derived keys via `deriveEd25519Child(conf *keygen.Config, pub, path)` after `mixin.CheckEd25519ChildPath(path)`.
- Result of keygen is `*frost.Config` (`PublicPoint()`); result of sign is `*frost.Signature` — **always verify `signature.VerifyEd25519(P, m)` before accepting** (computer frost.go does; returns error on failure).
- Round timeouts: keygen and sign both 5 min (`frostKeygenRoundTimeout`, `frostSignRoundTimeout`); session expiry `SessionTimeout = 1h` → `store.FailSession`.
- Shares persist as `KeygenResult{Public, Share, SSID}` in sqlite — **never log or expose `Share`**; only the aggregate public point is public.

Session lifecycle (computer signer.go): the observer proposes a session by sending the group a transaction (trace `SESSION:<id>:SIGNER:<id>:PREPARE`, extra `uuid(sessionId) || "PREPARE"`); when `threshold+1` nodes have committed PREPARE, every node queues the operation and enters `loopMultiPartySession`; each protocol message is checked `h.CanAccept`/`h.Accept` before `WriteSessionWorkIfNotExist` persists it; messages from non-members are dropped; SSID mismatch aborts the session. Transport: `PostEncryptedMessages` (session-key encrypted, ENCRYPTED_* category) inside the configured group conversation, payload cap ~1 MiB (safe messenger/mixin.go) — not Blaze broadcast.

## Verify it worked

- **Exactly-once across restarts**: restart a node mid-stream and diff `SELECT output_id, action_state FROM actions` before/after — every output appears once, `Initial`→`Done` monotonic; the drain checkpoint + `writeOutputAndAction` idempotency guarantee no double-processing. Then confirm spend-through: `GET /safe/outputs?members=<hash>&threshold=<t>&state=spent` contains the group's emitted transactions with `sequence > epoch`.
- **Deterministic agreement**: run two nodes with identical `[genesis]` against the same stream and diff their emitted transaction lists (`SELECT trace_id, hash FROM transactions WHERE state=13`) — must be identical.
- **Threshold-sign failures alert**: sessions stuck past `SessionTimeout` log `store.FailSession` and vanish from `ListPreparedSessions`; point `monitor-conversation-id` at an admin chat (cmd/computer.go `MonitorComputer`) and assert an alert arrives. For a computer-style deployment also poll the node HTTP index (`GET /` → `height`, `members`, `observer`, `params`, `payer`, `version`) and `GET /system_calls/:id` for call states (go: computer solana/http.go; live: computer.mixin.one 2026-10-11).

## Sources

- go: `github.com/MixinNetwork/safe` v0.28.2 — `mtg/{group,action,output,drain,iteration,transaction,utils,store,config}.go`, `messenger/mixin.go` (module zip from proxy.golang.org, fetched 2026-10-11)
- go: `github.com/MixinNetwork/computer` HEAD — `cmd/computer.go`, `config/example.toml`, `solana/{node,observer,signer,frost,http,request}.go`, `store/work.go` (codeload via RefComputer, 2026-10-11)
- go: `github.com/MixinNetwork/multi-party-sig` v0.7.0 — `protocols/frost/{frost.go,keygen,sign}` (module zip, 2026-10-11)
- go: bot-api-go-client v3.25.7 — computer.go `EncodeMtgExtra`, mix.go, output.go, safe_multisigs.go
- live: computer.mixin.one 2026-10-11
- docs: none — MTG pages deleted from developers.mixin.one (commit 48398f1)
