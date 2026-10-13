# SDK map — resolve every symbol from installed source

The protocol is canonical (REST + Blaze wire); SDKs are adapters. This map tells you **which file to open** per topic per language. Never emit a symbol that you haven't seen in the file below *in the installed version* — the REST fallback is always correct.

Verified against: Go v3.25.7 · Node 7.6.0 · Ruby 3.0.2 (2026-10-11, → compatibility.md).

## Go — `github.com/MixinNetwork/bot-api-go-client/v3`

Actively released by Mixin Network. Flat package, import alias `bot`. Process-global config (`SetBaseUri`, `SetBlazeUri`, `SetUserAgent`, `WithAPIKey` in `request.go`) — call from `main()` only.

| Topic | Open | Key exports (verified) |
|---|---|---|
| Auth / JWT | `auth.go` | `SignAuthenticationToken`, `SignAuthenticationTokenWithRequestID`, `OAuthGetAccessToken` |
| Identity / users | `user.go`, `safe.go` | `UserMe(accessToken)`, `RequestUserMe(su)`, `GetUser`, `SearchUser`, `CreateUser(Simple)`, `UpdateTipPin`; `SafeUser`, `NewSafeUser` |
| Blaze | `blaze.go` | `BlazeListener{OnMessage, OnAckReceipt, SyncAck}`, `NewBlazeClientWithSafeUser`, `BlazeClient.Loop/SendPlainText/SendAppCard/...` |
| Messages | `message.go` | `PostMessage(conv, recipient, id, category, dataBase64, su)`, `PostMessageRequest`, `PostMessages`, `PostAcknowledgements`, `Encrypt/DecryptMessageData` |
| Conversations | `conversation.go`, `utils.go` | `ConversationShow`, `CreateGroupConversation`, `CreateContactConversation`, `UpdateParticipants`, `JoinConversation`, `RotateConversation`; `UniqueConversationId` |
| Outputs (UTXOs) | `output.go` | `ListUnspentOutputs(membersHash, threshold, assetId, su)`, `ListOutputs(...offset, limit)`, `*ByToken` variants |
| Ghost keys | `safe.go`, `transaction.go` | `RequestSafeGhostKeys`, `RequestGhostRecipientsWithTraceId` |
| Send / build / verify | `transaction.go` | `SendTransferTransaction`, `SendTransaction`, `SendTransactionWithOutputs`, `SendTransactionUntilSufficient`, `BuildRawTransaction`, `VerifyRawTransaction`, `SendRawTransaction`, `GetTransactionById` |
| Withdrawals | `withdrawal.go` | `SendWithdrawal(assetId, destination, tag, amount, traceId, preferAssetFeeOverChainFee, memo, su)`, `WithdrawalWithUtxos`, `MixinFeeUserId` |
| Fees / assets | `asset.go`, `network_asset.go`, `network.go` | `ReadAssetFee(assetId, destination, su)`, `ReadSafeFees`, `FetchAssets`, `ReadAsset`, `AssetSearch`, `ReadAssetTicker`, `ReadNetworkAssetsTop` (network = no auth) |
| Snapshots | `snapshot.go` | `SafeSnapshots(limit, app, assetId, opponent, offset, su)`, `SafeSnapshotById`, `SafeNotifySnapshot`; legacy in `snapshot_legacy.go` |
| Multisig | `safe_multisigs.go`, `multisigs.go` | `CreateSafeMultisigRequest`, `FetchSafeMultisigRequest`, `CreateMultisigRawTx` (Safe); legacy `multisigs.go` |
| Addresses / deposit entries | `address.go`, `safe_deposit_entries.go`, `safe_deposits.go` | `CreateAddress`, `GetAddressesByAssetId`, `DeleteAddress`, `CheckAddress`; `CreateDepositEntry`, `FetchPendingSafeDeposits` |
| MIX/MIN addresses | `mix.go`, `invoice.go` | `NewUUIDMixAddress`, `NewMainnetMixAddress`, `NewMixAddressFromString`; `NewMixinInvoice`, `NewMixinInvoiceFromString` |
| Storage entries | `object.go` | `CreateObjectStorageTransaction`, `EstimateStorageCost`, `StorageRecipient` |
| TIP / PIN | `tip.go`, `pin.go` | `TIPBodyForSequencerRegister`, `TipBodyForWithdrawalCreate`, `TIPMigrateBody`, `EncryptEd25519PIN`, `VerifyPINTip` |
| Safe registration | `safe_user.go` | `RegisterSafe`, `RegisterSafeBareUser`, `RegisterSafeWithSetupPin` |
| Inscriptions (read) | `inscription.go` | `ReadCollection`, `ReadCollectionItems`, `ReadInscription` |
| Computer | `computer.go` | `EncodeOperationMemo`, `EncodeMtgExtra`, `BuildSystemCallExtra`, `RegisterComputer`, `GetComputerInfo/User/DeployedAssets/SystemCall`, `GetFeeOnXINBasedOnSOL`, `LockComputerNonceAccount`, `ComputerDeployExternalAsset` |
| Deep links | `url_scheme.go` | `SchemePay`, `SchemeTransfer`, `SchemeUsers`, `SchemeSend`, ... |
| Kernel RPC | `kernel.go`, `mixin/` | `CallKernelRPC` (avoid for sends — breaks sequencer indexing) |

**Known gaps (Go):** no exported per-input signing (signing happens inside `Send*` — manual sign/verify flows need Node/Ruby or fox-one `mixin-sdk-go`); no Safe-multisig cancel/unlock; no inscription *write* helpers; Blaze `Loop` does not auto-reconnect (caller loops).

## Node — `@mixin.dev/mixin-node-sdk` (≥ 7.6.0, node ≥ 20)

Types: `dist/index.d.ts` (main) + `dist/blaze/index.d.ts` (Blaze subpath). Client: `MixinApi({keystore})` → namespaces `user message conversation utxo safe multisig transfer network address payment pin oauth asset attachment circle code collection external app`. Blaze: `import { BlazeKeystoreClient } from '@mixin.dev/mixin-node-sdk/blaze'` (a factory, no `new`), **but see Known gaps: it can't connect today**. REST calls are fine (axios sends its own User-Agent).

| Topic | Namespace / export |
|---|---|
| Profile / users | `client.user.profile/search/fetch/fetchList/createBareUser/updateRelationships` |
| Messages | `client.message.sendText/sendPost/sendAppCard/sendAppButton/sendBatch(≤100, ≤128KB)/sendAcknowledges` |
| Conversations | `client.conversation.createGroup/updateParticipants/addParticipants/setAdmin/mute/...` |
| Outputs & balances | `client.utxo.safeOutputs/safeAssetBalance/fetchSafeOutputs` |
| Safe tx (full manual chain) | `getUnspentOutputsForRecipients`, `buildSafeTransactionRecipient`, `client.utxo.ghostKey`, `buildSafeTransaction`, `client.utxo.verifyTransaction`, `signSafeTransaction`, `client.utxo.sendTransactions`, `decodeSafeTransaction`, `blake3Hash` |
| Fees / withdrawal | `client.safe.fetchFee(asset, destination)`; addresses `client.address.create(pin, {...})/delete(pin, id)` |
| Snapshots | `client.safe.fetchSafeSnapshots({app, asset, opponent, offset, limit})`; `order` is not in the type but is passed through (→ reconciliation.md § Cursor management) |
| Multisig | `client.multisig.createSafeMultisigs/fetchSafeMultisigs/signSafeMultisigs/unlockSafeMultisigs` |
| Inscriptions | `client.safe.fetchInscription*`, `transferInscription`, `buildInscriptionOperationExtra` |
| Invoices / storage | `newMixinInvoice`, `attachInvoiceEntry`, `attachStorageEntry`, `getRecipientForStorage`, `estimateStorageCost` |
| Addresses enc | `buildMixAddress`, `parseMixAddress`, `uniqueConversationID`, `hashMembers` |
| OAuth / TIP | `client.oauth.getToken`, `getChallenge`, `getED25519KeyPair`; `client.pin.updateTipPin/verifyTipPin`, `tipBody` helpers, `client.safe.register` |
| Computer | `buildSystemCallExtra`, `buildComputerExtra`, `encodeMtgExtra`, `checkSystemCallSize` (MAX_SOLANA_TX_SIZE=1232), `userIdToBytes` — **no HTTP client for computer.mixin.one; call it with fetch** |
| Webview bridge | `WebViewApi()` (`getMixinContext`, `getAssets`, `getTipAddress`, `tipSign`, `reloadTheme`, `close`, `playlist`) |
| Pay links | `buildMixinOneSafePaymentUri` |
| Errors | `ResponseError{code, description, status, extra, requestId}` |

**Known gaps (Node):** no Safe-multisig cancel; `payment` namespace is the checker API, not card payment. **`BlazeKeystoreClient` (7.6.0) can't connect**: it opens the socket with no `User-Agent`, `blaze.mixin.one` rejects the handshake with HTTP 202 `10006 Update required`, and the client stays in CONNECTING forever with no error (live-checked 2026-10-13). `BlazeOptions` has no headers option. Use `assets/scaffold-bot-echo/node/blaze-client.mjs`, a ~90-line drop-in on `ws` + the SDK's `signAccessToken`/`decodeMessage`/`sendRaw` that sends a User-Agent (→ gotchas.md #19).

## Ruby — `mixin_bot` gem (≥ 3.0.2)

Repo `an-lee/mixin_bot` (parity-mapped to the Go SDK; ships `API_COVERAGE.md`). **Requires Ruby ≥ 4.0** (gemspec `required_ruby_version >= 4.0.0`). Configure via `MixinBot.configure do self.app_id = … end` (the block runs with `instance_exec`: a `|config|` param is `nil`) or per-bot `MixinBot::API.new(...)`. API modules: Me/User/Asset/NetworkAsset/Transfer/Transaction/Output/Snapshot/Multisig/Withdraw/Conversation/Message/EncryptedMessage/Blaze/Attachment/Auth/Pin/Tip/Inscription/ComputerApi. Notables: `create_transfer(members:, asset_id:, amount:, memo:, trace_id:)` (Safe pipeline), `build_utxos`, `build_safe_transaction`, `sign_safe_transaction`, `send_safe_transaction`, `safe_snapshots`, `create_safe_multisig_request`, `MixinBot::MixAddress/Invoice/UrlScheme/Transaction`, Blaze via `start_blaze_connect` (EventMachine) / `blaze_async` / Puma plugin `:mixin_blaze` with `blaze_ack_policy :on_receipt|:after_handler`. Errors: `MixinBot::APIError` subclasses with `retryable?`/`throttle?`.

**Known gaps (Ruby):** Safe-multisig cancel; some helpers expect the optional `mixin` CLI for native raw-tx encode/decode.

## Other languages (docs-listed, not verified here)

Kotlin/Java, Python, PHP, C# SDKs exist per the docs overview (`docs/app/sdk/*`) but trail the Safe API. Protocol truth in `references/*` + REST is the stable path; treat unverified community SDKs as thin wrappers to audit before use. Fox-one org (`mixin-sdk-go`, `mixin-cli`, `4swap-sdk-go`) is the de-facto Go platform alternative with exported low-level signing; Pando sunset 2026-08, Exin quiet — pointers only, not first-class.

## Resolution procedure (for agents)

1. Find the user's SDK + version (`go.mod`, `package.json`/lockfile, `Gemfile.lock`).
2. Open the file/namespace from the tables above **in the installed version** (`node_modules/.../dist/index.d.ts`, Go module cache, `gem open mixin_bot`).
3. Emit only symbols you can see there. Otherwise: REST fallback (endpoint tables in the domain reference).
4. Suspected drift? Run `scripts/check-currency.mjs` and trust its diff.

## Sources

- Go v3.25.7 source zip (proxy.golang.org), per-file export scan — 2026-10-11.
- Node 7.6.0 `dist/index.d.ts` + `dist/blaze/index.d.ts` — 2026-10-11.
- `mixin_bot` 3.0.2 README + module map (rubygems.org, repo `an-lee/mixin_bot`) — 2026-10-11.
