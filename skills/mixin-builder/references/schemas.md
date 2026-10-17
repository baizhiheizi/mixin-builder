# User-facing encodings and URL families

Everything a human taps in Messenger: deep links, web pay URIs, MIX addresses, MIN invoices, QR codes. Byte-level formats are canonical here because mis-encoding loses money.

## Family chooser

| Need | Use |
|---|---|
| Open a profile / conversation / snapshot in Messenger | `mixin://` deep link (users, conversations, snapshots) |
| User pays your bot from Messenger chat | `mixin://pay` **or** `https://mixin.one/pay/{address}` (web, QR-friendly) |
| One payment, multiple entries (multi-asset, memo per entry, storage extras) | MIN invoice |
| Address a multisig group or a user canonically | MIX address |
| A signer opens a multisig request on their phone | `mixin://mixin.one/multisigs/{request_id}?action=sign` → payments.md |
| QR login (OAuth) | `mixin://codes/{code_id}` → identity-and-keys.md |
| Share content into a chat | `mixin://send` |

## 1. `mixin://` deep links

Verified Go helpers (go: url_scheme.go v3.25.7; all build query-encoded URLs — never string-concatenate):

| Link | Go helper | Shape |
|---|---|---|
| `mixin://users/{uuid}` | `SchemeUsers(userId)` | user profile popup |
| `mixin://transfer/{uuid}` | `SchemeTransfer(userId)` | pre-filled transfer dialog to user |
| `mixin://pay?asset=&trace=&recipient=&memo=&amount=` | `SchemePay(assetId, traceId, recipientId, memo, amount)` | payment page; query params: `asset` (asset uuid), `recipient` (user uuid), `amount` (decimal string), `trace` (optional UUID dedupe), `memo` |
| `mixin://send?category=&data=&conversation=` | `SchemeSend(category, data, conversationID)` | share sheet; categories: `text, image, contact, app_card, live, post` (iOS also `sticker`, plus a `?text=…` raw-text shortcut and `user=` as destination); `data` = base64 (StdEncoding) of payload, itself query-escaped before encoding |
| `mixin://apps/{appID}?action=open&k=v…` | `SchemeApps(appID, action, params)` | bot homepage with arbitrary params (invite codes etc.); with no/other `action` iOS opens the bot **profile** instead |
| `mixin://codes/{code_id}` | `SchemeCodes(codeId)` | code info popup (also QR login → identity-and-keys.md) |
| `mixin://conversations/{id}?user=` | `SchemeConversations(conversationID, userID)` | open conversation; creates it if absent |
| `mixin://snapshots/{snapshotId}` (+ `trace=`) | `SchemeSnapshots(snapshotId, traceId)` | snapshot detail |

Node/Ruby: no per-link builders in the Node SDK's helper set (only `buildMixinOneSafePaymentUri`); Ruby has `MixinBot::UrlScheme`. Use the query table above.

Host-style extras iOS accepts beyond the Go helpers above (no SDK builders — construct and percent-encode yourself, §6): `mixin://address` (address book), `mixin://buy` (buy-crypto entry), `mixin://wc?uri={WalletConnectURI}` (WalletConnect pairing), `mixin://device/auth?id=&pub_key=` (desktop login; missing `id` → desktop-upgrade alert), `mixin://device-transfer?data={base64url JSON}` (device migration). Any other external `mixin://…` is not rejected — iOS shows a generic fallback sheet (`UnknownURLWindow`). `mixin-internal://identity/{number}` and `mixin-internal://phone/{phone}` fire on in-chat taps only; Info.plist registers just `mixin` for third parties.

## 1b. `mixin://mixin.one/…` path-form links (iOS `SafeURL`)

A second, newer family: scheme `mixin` **or** `https` with host exactly `mixin.one` — every link below doubles as a universal link (`https://mixin.one/…`, better for QR/email/browser). Dispatch order in iOS `UrlWindow.checkUrl`: `SafeURL` → host-style `MixinURL` (§1) → `mixin-internal://`. Verified from ios-app@master 2026-10-17 (v6.3.4): `SafeURL.swift` + sub-parsers (`SafePaymentURL`, `MultisigURL`, `TIPURL`, `TradeURL`, `CodeURL`, `ExternalSharingContext`). No SDK builders exist — build with a URL-components API and percent-encode (§6).

| Link | Shape |
|---|---|
| `mixin://mixin.one/pay/{address}?asset=&amount=&trace=&memo=&return_to=&reference=&inscription=&inscription_collection=` | same parser as §2 web pay; `{address}` = user uuid / XIN mainnet / MIX / **MIN invoice string**; `amount` ≤ 8 fractional digits and > 0; `trace` defaults to a fresh uuid client-side |
| `mixin://mixin.one/multisigs/{request_id}?action=` | multisig sign/revoke sheet → payments.md; `action` = `sign` (default when omitted) \| `revoke` or `unlock` (both revoke); `request_id` must be a lowercased uuid; opener must be one of the request's `senders` |
| `mixin://mixin.one/schemes/{scheme_id}` | code popup (lowercased uuid) — path twin of `mixin://codes/{id}` |
| `mixin://mixin.one/tip/sign?chain=&action=&raw=&request_id=` | TIP sign request; `chain` must be `solana`, `action` must be `signRawTransaction`, `raw` required, `request_id` optional uuid |
| `mixin://mixin.one/swap` or `/trade?type=&input=&output=&referral=` | trade UI; `type` = `swap` \| `limit` \| `perps` (absent → default trading mode); perps: `market` required, then `action=open` (+ `side`, `leverage`, `margin`, `leader_position`) \| `action=add_margin` (+ `margin`) \| no action → market detail |
| `mixin://mixin.one/send?…` | share sheet — same params as `mixin://send` |
| `mixin://mixin.one/referrals` (+ `/{code}`) | referral-code entry sheet |
| `mixin://mixin.one/membership` | membership plans |
| `mixin://mixin.one/inscriptions/{hash}` | inscription detail (hash-validated) |
| `mixin://mixin.one/markets/{id}` | market detail |
| `mixin://mixin.one/codes/{code_id}` · `/users/{uuid}` · `/transfer/{uuid}` · `/conversations/{id}?user=` · `/apps/{id}` · `/address` · `/wc?uri=` · `/buy` | path-forms of §1 links, same behavior |

iOS quirk: `mixin://mixin.one/snapshots/{snapshotId}` parses but the handler reads the wrong path component, so the **id is ignored** — only `?trace=` works there. Use the §1 host-style `mixin://snapshots/{snapshotId}` (id works) or a `trace=` query on either form.

## 2. Web pay URIs — `https://mixin.one/pay/{address}`

Node SDK `buildMixinOneSafePaymentUri(params)` (node: dist/index.js 7.6.0). Destination precedence — first match wins:

1. `uuid` — valid user/bot uuid
2. `mainnetAddress` — XIN-prefixed kernel address
3. `mixAddress` — MIX… address
4. `threshold` + (`uuidMembers` XOR `xinMembers`) → builds a MIX address on the fly

Throws `'fail to get payment destination address'` if none resolve.

Query params appended (only truthy ones; `trace` defaults to a fresh `uuid.v4()`):

```
https://mixin.one/pay/{address}?asset={assetId}&amount={decimal}&memo={memo}
  &trace={uuid}&inscription={hash}&inscription_collection={hash}&return_to={encoded}
```

- `inscription` / `inscriptionCollection` — pay a specific NFT / pick from a collection (node PaymentParams docs).
- `returnTo` — the builder encodes it (`encodeURIComponent`); everything else is joined raw by the SDK, so **you** must pre-encode user-supplied `memo`/label values (see §6).

| mixin://pay | mixin.one/pay | |
|---|---|---|
| Recipient = user uuid only | Recipient = uuid, XIN, MIX, or members+threshold | Use web URI when you need multisig destination or QR |
| In-app tap | Works anywhere (browser, QR) | Prefer web URI for printed/embedded QR |

## 3. MIX address

Encoding of a multisig group (or canonical user address) (go: mix.go v3.25.7):

```
"MIX" + base58( payload || checksum[0:4] )
payload  = version(1B = 2) || threshold(1B) || count(1B ≤ 64)
           || members…
members  = count × uuid-bytes(16B)            # uuid members, sorted before encode
         | count × (spendKey(32B) || viewKey(32B))  # XIN mainnet members
checksum = sha256("MIX" || payload)[0:4]
```

- 1-of-1 UUID mix address = the canonical address of that user.
- `NewUUIDMixAddress(members, threshold)` sorts members internally; `Members()` returns sorted uuids (mainnet members as strings). Node: `buildMixAddress({version?, xinMembers?, uuidMembers?, members?, threshold})` / `parseMixAddress`.
- Validation rejects: wrong prefix, bad checksum, version ≠ 2, threshold 0, count > 64 (go: `NewMixAddressFromString`).
- XIN mainnet addresses (`XIN…`) address kernel-level keys, not uuids — needed for MTG-style groups mixing both member kinds → mtg.md.

When to choose: an address string that survives outside your system (emails, invoices, other chains' users); use `members_hash`+`threshold` API params when staying inside sequencer calls.

## 4. MIN invoice

Multi-entry payment request, prefix `MIN` (go: invoice.go v3.25.7):

```
"MIN" + base64url-raw( payload || checksum[0:4] )
payload = version(1B = 0)
        || uint16BE(len(recipientBytes) ≤ 1024) || recipientBytes   # MixAddress payload (§3, no checksum)
        || entryCount(1B ≤ 128)
        || entry…                    # repeated:
entry   = traceId(16B uuid) || assetId(16B uuid)
        || amountLen(1B) || ascii(amount decimal string)            # len ≤ 128
        || int32(len(extra)) || extra                               # extra < 4 MiB
        || refsCount(1B ≤ 16) || ref…
ref     = 0x01 || index(1B)          # index reference
        | 0x00 || hash(32B)          # hash reference
checksum = sha256("MIN" || payload)[0:4]
```

Limits enforced by `AddEntry`: per-entry `extra` < 256 B (general limit) unless it's a storage entry (`AddStorageEntry(traceId, extra)` — larger extras ride a XIN storage tx → payments.md); index+hash references ≤ `ReferencesCountLimit`. Node: `newMixinInvoice(recipient)`, `attachInvoiceEntry`, `attachStorageEntry`, `parseMixinInvoice`, `getInvoiceString` (same MIN prefix).

When to choose MIN over a pay URI: multiple assets in one payment, per-entry memos, storage entries, or referencing prior tx hashes.

## 5. Codes — QR login and resolution

- OAuth QR flow renders `mixin://codes/{code_id}` from the Blaze OAuth WS (`REFRESH_OAUTH_CODE` → `data.code_id`); user scans/confirms → `data.authorization_code` → PKCE exchange. Full flow → identity-and-keys.md.
- A code can also front other objects (conversations, multisig requests, payment requests, users): `CodeResponse` is a union (node: dist/index.d.ts 7.6.0).
- Resolution server-side: `GET /codes/{codeID}` (Node `code.fetch`, Go `ReadCode`/`ReadMultisigByCode`).
- On iOS a code also opens via the path form `mixin://mixin.one/schemes/{scheme_id}` (≠ `mixin://codes/{id}`, both valid — see §1b).
- Reverse — turn a `mixin://`-style target into a scheme id: `POST /schemes` `{target}` → `{type:'scheme', scheme_id, target}` (Node `code.schemes(target)`).

## 6. Percent-encoding rule (injection guard)

Always URL-encode user-supplied values before putting them into any `mixin://` or `mixin.one/pay` URL. Never concatenate raw input:

- `memo`, labels, group names can contain `&`, `=`, `#`, `%` — a crafted memo like `x&recipient=<attacker>` rewrites payment parameters (parameter injection) or breaks the fragment.
- The Node pay-URI builder joins `asset/amount/memo/…` **without** encoding (only `returnTo` is encoded) — pre-encode anything user-controlled you pass in.
- Go `SchemePay`/`SchemeSend` use `url.Values.Encode()` (safe), and `SchemeSend` additionally query-escapes the base64 payload for the historical wire format.

Domain rule: treat every deep link you *emit* as a serializer (encode) and every deep link you *consume* as untrusted input (validate uuid formats, amounts as decimal strings, categories against the known set → messaging.md).

## Verify it worked

- MIX address: round-trip — `NewUUIDMixAddress(members, threshold).String()` → `NewMixAddressFromString(s)`; assert `Members()` and `Threshold()` equal the inputs (Go). Node: `parseMixAddress(buildMixAddress({uuidMembers, threshold}))` round-trip.
- MIN invoice: `NewMixinInvoiceFromString(invoice.String())` (Go) / `parseMixinInvoice(getInvoiceString(inv))` (Node); assert entry count, trace ids, amounts parse back.
- Deep links / pay URIs: no decode helper exists — open the link in Messenger (or paste `https://mixin.one/pay/...` in a browser) and confirm the prefilled asset/recipient/amount. For a `trace`-tagged payment, confirm settlement by polling `GET /safe/snapshots?opponent=<recipient>` for that trace / a `SYSTEM_SAFE_SNAPSHOT` on Blaze → payments.md.

## Sources

- go: url_scheme.go, mix.go, invoice.go v3.25.7
- node: dist/index.d.ts + dist/index.js 7.6.0 (`buildMixinOneSafePaymentUri`, PaymentParams, CodeClient.schemes `/schemes`, invoice helpers)
- iOS client: MixinNetwork/ios-app master @ 2026-10-17 (v6.3.4, build 843) — `Mixin/Constants/MixinURL.swift`, `Mixin/UserInterface/Controllers/Wallet/Payment/{SafeURL,SafePaymentURL,MultisigURL,TIPURL,TradeURL,CodeURL}.swift`, `Mixin/Service/Message/ExternalSharingContext.swift`, dispatch in `Mixin/UserInterface/Windows/UrlWindow.swift`, Info.plist (registers only `mixin`)
- docs: schema deep-link sections referenced by Go doc comments (developers.mixin.one/docs/schema)
- SDK parts verified 2026-10-11; deep-link surface re-verified against the iOS client 2026-10-17 (→ compatibility.md)
