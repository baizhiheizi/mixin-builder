# Compatibility — verified-against matrix

Last full verification: **2026-10-11** (method below). This file is the skill's truth anchor: every SDK symbol used in the references was read from these exact versions. Re-verify before extending content, and after any SDK release.

## Matrix

| Layer | Pinned / verified | Where checked | Notes |
|---|---|---|---|
| Go SDK `github.com/MixinNetwork/bot-api-go-client/v3` | **v3.25.7** (tag hash `95adbb4e`, released 2026-09-15) | module zip from `https://proxy.golang.org/github.com/!mixin!network/bot-api-go-client/v3/@v/v3.25.7.zip` | ⚠️ GitHub `releases/latest` says v3.24.7 — the releases API is stale; tags are ahead. **Always use the Go module proxy**, not the releases API. |
| Mixin Computer | **v0.9.1-a37afa3**, height 455620165, 7 members / threshold 5, operation price **0.001 XIN** | live `GET https://computer.mixin.one/` on 2026-10-11 | Ephemeral values (height, price, members) — always re-probe; `scripts/probe.mjs computer` does it. |
| MTG libraries | `github.com/MixinNetwork/safe` **v0.28.2** (mtg package) · `github.com/MixinNetwork/multi-party-sig` **v0.7.0** (frost) | module-proxy zips, exports listed for `mtg.md` | `github.com/MixinNetwork/computer` HEAD (config/example.toml, solana/{node,observer,signer}.go, store/) read for `mtg.md` + `computer.md`. |
| Official docs `developers.mixin.one` | docs content last changed **2026-08-02** (`48398f1`; default branch, `developers-docs/docs`) | `codeload.github.com/MixinNetwork/developers.mixin.one/tar.gz/HEAD` | MTG section deleted (commit `48398f1`); App-Security dashboard tab (commit `bd4dc94`, 2026-09-02) still undocumented. |
| Endpoints | `api.mixin.one` REST, `wss://blaze.mixin.one` (subprotocols `Mixin-Blaze-1`, `Mixin-OAuth-1`) | SDK source + docs | Stable since 2026; blaze subprotocol confirmed in Go SDK `blaze.go` + `oauthws_test.go`. |
| Mixin Messenger iOS `MixinNetwork/ios-app` | **master @ 2026-10-17** (v6.3.4, build 843) | shallow clone; read `MixinURL.swift`, `SafeURL.swift` + sub-parsers, `UrlWindow.checkUrl`, Info.plist | Source of truth for the deep-link surface in `schemas.md` §1/§1b and the multisig mobile sheet in `payments.md`. Info.plist registers only the `mixin` scheme. |
| Mixin Messenger Android `MixinNetwork/android-app` | **master @ 2026-10-17** | shallow clone; read `UrlInterpreterActivity.kt`, `LinkBottomSheetDialogFragment.kt`, `Constants.kt` Scheme, `WebFragment.kt`, `TipSign.kt`, `BlazeMessageParam.kt` | Deep-link divergences (`/scheme/` singular, `mixin://tip/{public\|sign}` TIPNode protocol, no membership path form) and the working TIP webview bridges. URL scheme manifest + blaze params match iOS. |
| Mixin Messenger Desktop `MixinNetwork/flutter-app` | **main @ 2026-10-16** (v6.3.1+597, macOS/Windows/Linux) | shallow clone; read `uri_utils.dart`, `constants.dart` (`MixinSchemeHost`, `kMaxGroupParticipants`), `action_card_data.dart`, `web_view_desktop.dart`, `blaze_message_param.dart` | Desktop router: money/trading links → unknown-link dialog; `conversations?start=` auto-send; trace-only snapshots; app card `shareable` defaults true; webview injects `MixinContext.getContext()` only. Uses official `mixin_bot_sdk_dart` (field `capabilites` — the typo is the wire format). |

## What was verified, and how

1. **Export surfaces** — every exported Go func/type grepped per file from the v3.25.7 zip; Node surface read from `dist/index.d.ts` + `dist/blaze/index.d.ts`; Ruby surface from the 3.0.2 README/API map. Symbols in `references/*` come only from these lists (plus `github.com/MixinNetwork/safe`'s `mtg` package for `mtg.md`, fetched the same way).
2. **Prior-art correction** — the previous skill generation contained fabricated symbols (`PostMessage2`, `SafeSnapshotsRead`, `GhostKeyForRecipients`, `BuildSafeTransaction` as a Go name, `GetMe`, …). `gotchas.md` #12 lists the recurring ones. If you find a symbol in the wild that is not in `sdk-map.md`'s file map, assume it is invented until proven from source.
3. **Live probes** — Computer info, npm registry, Go proxy, Rubygems (all 2026-10-11).
4. **Live run with real bot keystores (2026-10-13)** — two unregistered test bots (`has_safe: false`, no spend key, so no money moved):
   - `probe.mjs me/outputs/snapshots` work.
   - All three echo scaffolds (Node, Go, Ruby on Ruby 4.0.7) passed a round trip: bot A sends a nonce, the scaffold on bot B replies `echo: <nonce>`. The Ruby run also answered a message sent while it was down, so `LIST_PENDING_MESSAGES` redelivery works.
   - The payment watcher starts and its Blaze trigger connects.
   - Found along the way:
     - Node SDK 7.6.0 `BlazeKeystoreClient` can't connect: no `User-Agent`, so the handshake gets `10006` (→ gotchas.md #19).
     - The Node SDK's REST client works (axios sends its own UA).
     - `/safe/me` returns `has_safe: false` for unregistered bots rather than failing.
     - `mixin_bot` 3.x needs Ruby ≥ 4.0, and its `configure` block uses `instance_exec`.
   - Not verified: whether `/safe/snapshots` honours `order=ASC`. Both ledgers were empty, and the server accepts any `order` value without error (`BOGUS` included), so re-run `probe.mjs snapshots` on a bot with ≥ 2 snapshots.
5. **Mobile client deep links (2026-10-17)** — `MixinNetwork/ios-app` master (v6.3.4, build 843) shallow-cloned; every `mixin://` form in `schemas.md` §1/§1b traced to a parser (`MixinURL.swift`, `SafeURL.swift`, `MultisigURL`, `SafePaymentURL`, `TIPURL`, `TradeURL`, `CodeURL`, `ExternalSharingContext`) and to dispatch in `UrlWindow.checkUrl`. Found along the way: the multisig sign sheet `mixin://mixin.one/multisigs/{id}?action=sign|unlock|revoke` (default `sign`; opener must be in `senders`), the `sticker` share category + `?text=` send shortcut, the `/schemes/{uuid}` code path form, and the `mixin.one/snapshots/{id}` wrong-component quirk (id ignored — trace only).
6. **Mobile client product-surface audit (2026-10-17)** — same clone, wider sweep: message categories (`Message.swift`), app-card V0/V1 models (`AppCardData.swift` — v1 `cover` rich object w/ blurhash, required `shareable`), input-action handling (`ConversationViewController.openInputAction` — `input:share` does not exist), app capabilities (`capabilites` misspelling; `ENCRYPTED`/`GROUP`/`IMMERSIVE` semantics in `SendMessageService+Sending.swift`, `AppDAO`, `MixinWebContext`), Blaze send params (`BlazeMessageParam.swift`: `mentions`, `silent`, `expire_in`; `@700xxxx ` group addressing in `SendMessageService.swift`), REST fallbacks (`MessageAPI.swift`: `/acknowledgements`, `/messages/status/:offset`), webview bridge (`WebViewMessageHandler` — TIP calls rejected on iOS; `getAssets` gating; `openInBrowser`; `_mw_`; `signBotSignature`), OAuth (`AuthorizeAPI` — `POST /oauth/authorize` w/ TIP-encrypted pin, `/oauth/cancel`, `/authorizations`), snapshot model (`SafeSnapshot.swift`), and the Route API family (`RouteAPI.swift` — MR-ACCESS-SIGN ECDH+HMAC scheme, api.route/reward/cash/earn.mixin.one). Findings folded into messaging.md, blaze.md, webview.md, payments.md, gotchas.md #20–#21.
7. **Android + Desktop cross-client audit (2026-10-17)** — `MixinNetwork/android-app` master and `MixinNetwork/flutter-app` main (v6.3.1+597) shallow-cloned. Verified: multisig link semantics identical on Android (default sign, unlock→revoke); `/scheme/` is **singular** on Android vs iOS `/schemes/`; Android-only host-style TIPNode protocol `mixin://tip/{public|sign}?id=&alg=&crv=&data=&notify=` (`TipSign.kt`: ecdsa/secp256k1 + eddsa/ed25519, result → notify endpoint); TIP webview bridges work on Android (`WebFragment.kt`), absent on Desktop (`web_view_desktop.dart` injects context only); Desktop routes pay/multisigs/swap/markets/membership links to an unknown-link dialog; `conversations?start=` auto-send on Android+Desktop (iOS ignores); snapshots trace-only on Desktop; Android `getAssets` returns the full token list for an empty id array; `capabilites` typo confirmed as the wire key via official `mixin_bot_sdk_dart` `App.capabilites` (Android's own VO expects `capabilities` — parse both); Blaze params `mentions`/`silent`/`expire_in` present in all three clients; group cap 1024 (flutter `kMaxGroupParticipants`). Folded into schemas.md §1b divergence matrix, messaging.md, webview.md.

## Re-verify instructions (quarterly, or on demand)

```bash
node scripts/check-currency.mjs            # versions + export diffs + scaffold typecheck; exit≠0 = drift
node scripts/check-currency.mjs --update   # rewrite the expected-surface baseline after review
node scripts/probe.mjs computer            # live computer params
```

Manual pass (each quarter):

1. Diff the docs repo (`git log` since last check) — watch `api/sequencer/`, `api/messages/`, dashboard features.
2. Download new SDK versions, diff exported symbols against the baseline (`check-currency.mjs` automates).
3. Ecosystem pulse: fox-one org, `an-lee/mixin_bot`, Pando/Exin status.
4. Update this matrix + the SKILL.md currency block in the same commit; bump `references/` claims that moved.

## Known drift risks (checked next cycle)

- Node SDK `collectible`/inscription surface is moving fast (2026-09 additions: inscriptions, multisig `receivers`).
- Blaze hardening landed 2026-08 in both SDKs; ack semantics stable but options may grow.
- App-Security `POST /apps/:appId/security` payload shape still dashboard-only `[UNVERIFIED]`.

## Sources

- Module proxy: proxy.golang.org · npm registry · rubygems.org API · codeload.github.com — all fetched 2026-10-11.
- Audit origin: LixvYang/mixin-skills#2 (fabricated-symbol findings that motivated this file).
