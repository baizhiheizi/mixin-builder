# Identity, Keystores, and Keys

Everything a Mixin bot *is*: one keystore, three key roles (session / spend / TIP), the JWT that authenticates every HTTP call, OAuth for acting on behalf of Messenger users, and sequencer registration that turns a fresh app into a money-moving Safe user.

## Keystore anatomy

A bot keystore is five fields (plus derived state). `app_id` **is** the bot's `user_id` — same UUID, two names (JSON key on the wire is `app_id`).

| Field | Used for | Rotates with | Can change |
|---|---|---|---|
| `app_id` | Bot identity everywhere (conversations, payments, MixAddress members) | — | Never (delete app instead) |
| `session_id` | Identifies the current session in JWT `sid` claim | — | Yes — owner can create a new session |
| `session_private_key` (hex, Ed25519) | Signs every request JWT; ECDH half for PIN encryption | `session_id` | Yes — rotate by creating a new session |
| `server_public_key` (hex) | Verifies server response signatures; ECDh peer of session key | `session_id` | Yes — arrives with each new session |
| `spend_private_key` (hex) | Kernel money: signs Safe transactions, derives ghost-key views | — | **NEVER** (go: safe.go v3.25.7: "spend private key can never change") |

Sources: (go: safe.go SafeUser comments v3.25.7), (node: dist/index.d.ts 7.6.0 `AppKeystore`).

Serialization per SDK: Node `AppKeystore{app_id, session_id, server_public_key, session_private_key, spend_private_key?}` — spend key is *optional* in the type for a reason. Ruby configures via `MixinBot.configure` (`spend_key` is its own knob). Go `bot.SafeUser` / `NewSafeUser(userId, sessionId, sessionPrivateKey)` builds one without the spend key (go: safe.go).

## Key hierarchy & separation

Three roles, deliberately independent:

1. **Session key (Ed25519)** — pure auth. Rotatable: create a new session, get new `session_id` + `session_private_key` + `server_public_key`. Compromise = attacker can call the API *as the bot* (messaging, read balance) but cannot move Safe funds by raw signing; they can, however, trigger PIN-protected ops, so rotate on suspicion anyway.
2. **Spend key** — kernel money. Signs Safe transaction inputs and is required for **every** Safe send (`SendTransferTransaction(…, su)` in Go; `signSafeTransaction(…, privateKey, …)` in Node; `MixinBot` `sign_safe_transaction`). Never changes; if you started the app before the Safe era it's whatever the dashboard gave you. Treat its exposure as total fund loss.
3. **TIP key** — an Ed25519 keypair whose private half signs TIP bodies (see below). After Safe registration the *TIP key is the sequencer gate*: `TIP:VERIFY:`, `SEQUENCER:REGISTER:`, withdrawal create, address add all require a TIP signature. Docs recommend a **dedicated keypair per user**, separate from the session key (docs: api/sequencer/registration.md).

**Rule: narrow clients.** Messaging code must never see the spend key.

- Go: construct `bot.NewSafeUser(appId, sessionId, sessionPriv)` for message/conversation paths — that struct has no spend field set; only money code receives the full keystore.
- Node: partial keystores are first-class — `{app_id, session_id, session_private_key}` (no spend) is valid for `MixinApi()` messaging; `OAuthKeystore` (below) has no spend field at all. Build the full keystore only inside the payments module.
- Ruby: `MixinBot::API.new(...)` per bot and per concern — instantiate a spend-less API for webhooks/messaging, a full one (with `spend_key`) only in the payment process (ruby: mixin_bot 3.0.2 README).

### Keystore formats — which one do you have?

Two shapes exist in the wild, and the official "Create a App" page still shows the legacy one (docs: app/getting-started/create-app.md):

| Legacy (`Ed25519 session` button, pre-Safe docs) | Safe-era (what SDKs and this skill expect) | Notes |
|---|---|---|
| `client_id` | `app_id` | same uuid |
| `session_id` | `session_id` | same |
| `private_key` (base64url, 64-byte Ed25519) | `session_private_key` (**hex**) | Node decodes `session_private_key` with `Buffer.from(…, 'hex')` and signs with noble `ed25519.sign`, which needs the **32-byte seed**. Convert with `Buffer.from(private_key, 'base64url').subarray(0, 32).toString('hex')` |
| `pin_token` (base64) | `server_public_key` (hex) | |
| `pin` (6 digits) | — | legacy PIN; you need it once as `old_pin` for TIP migration (→ § TIP PIN) |
| — | `spend_private_key` (hex) | absent from legacy keystores: the app can read and message, but can't move Safe funds until TIP + registration are done |

Ruby's `MixinBot.configure` accepts both name sets (`client_id`→`app_id`, `private_key`→`session_private_key`, `pin_token`→`server_public_key`; mixin_bot 3.0.2 `configuration.rb`), and so does `scripts/probe.mjs`. **First check on any new keystore:** `node scripts/probe.mjs me --keystore ks.json` shows whether the key authenticates and whether the app is Safe-registered (`has_safe`).

Passing the whole keystore through one global config is the classic leak; structure imports so a messaging crash dump can't contain the spend hex.

## Request auth (JWT)

Every authenticated REST call carries `Authorization: Bearer <JWT>` signed with the session Ed25519 key (docs: app/guide/generate-jwt-token.md; go: auth.go).

Header: `{"alg":"EdDSA","typ":"JWT"}`. Claims:

| Claim | Value |
|---|---|
| `uid` | app_id |
| `sid` | session_id |
| `iat` / `exp` | unix seconds; short-lived, per request |
| `jti` | random UUID |
| `sig` | **hex**(sha256(method + URI-with-query + body)) |
| `scp` | `FULL` for bots |

Gotchas:

- The signed URI must match the request URI **exactly, including the query string** — sign `/safe/outputs?limit=500&state=unspent`, not `/safe/outputs`. A mismatched query = 401.
- Mint a fresh token per request (`SignAuthenticationToken(method, uri, body, su)`); don't cache.
- Send an `X-Request-Id` UUID header; quote it in bug reports — server logs key off it. Go: `SignAuthenticationTokenWithRequestID`.
- Body is the exact bytes sent (empty string, not `"null"`).

SDK entries: go `bot.SignAuthenticationToken` (auth.go); node `signAuthenticationToken(method, uri, params, requestID, keystore)`; ruby `MixinBot::API` signs internally.

## TIP PIN

Why: the sequencer requires a TIP PIN before registration, and TIP-signed bodies gate withdrawals and withdrawal-address creation. A TIP "PIN" is not a 6-digit number — it's an Ed25519 **keypair + counter** (docs: api/pin/tip.md).

Migration flow (legacy PIN → TIP):

1. Generate an ed25519 keypair; keep `priv` safe forever — **it cannot be replaced once set**.
2. Build the update body: public key bytes || counter `1` as **uint64 big-endian** → hex. Go ships this: `bot.TIPMigrateBody(pub)` = `pub || uint64BE(1)` hex (go: tip.go).
3. Encrypt with `bot.EncryptEd25519PIN(body, pinToken, sessionKey, iterator)` and POST the pin-update endpoint with `old_pin` (blank if none, encrypted legacy pin if one exists) — node: `client.pin.updateTipPin(firstPin, secondPin, counter)`.
4. From then on, sign TIP bodies with `priv`:

| Body | Prefix / helper |
|---|---|
| PIN verify | `TIP:VERIFY:` + `%032d` timestamp (go `TipBody`; node `getVerifyPinTipBody(timestamp)`) |
| Sequencer register | `SEQUENCER:REGISTER:` + userUuid + pubHex (go `TIPBodyForSequencerRegister`) |
| Withdrawal create | go `TipBodyForWithdrawalCreate(addressId, amount, fee, traceId, memo)`; node `getCreateAddressTipBody` for address add |

The signature is ed25519 over the body, then the *signature* is encrypted like a PIN (`pin_base64`).

**Counter discipline:** the counter increments with each TIP use. Persist the incremented counter **before** sending the request that consumes it — a crash between send and persist means a stuck counter and rejected signatures.

**Verify it worked** — after migration, POST `/pin/verify` with `{pin_base64, timestamp}`; a successful response returns user info (node: `client.pin.verifyTipPin(pin)`). If verify passes, TIP is live.

## Sequencer registration

Before the sequencer indexes a bot's Safe activity it must be registered: this binds the TIP public key and PIN (docs: api/sequencer/registration.md).

1. Check first: `GET /safe/me` — node `client.safe.checkRegisteration()`; go `bot.RequestUserMe(ctx, su)` (hits `/safe/me`). Read the **`has_safe`** boolean (go `User.HasSafe`; the Go SDK's `cli/register.go` gates on it). An unregistered bot still gets a full user object back, with `has_safe: false`, so "the call succeeded" or "`user_id` is present" does not mean registered (live-checked 2026-10-13). Don't blind-register.
2. Register: `POST /safe/users` with:

```json
{
  "public_key": "ED25519-PUBLIC-KEY-HEX",
  "signature":  "ed25519-sig over sha256('SEQUENCER:REGISTER:' + USER-UUID + PUB-KEY-HEX)",
  "pin_base64": "TIP-encrypted SEQUENCER:REGISTER body"
}
```

The signature is signed with the **session** private key over the sha256 digest; the `pin_base64` carries the TIP signature. SDK entries wrap all of it: node `client.safe.register(user_id, tipPin, priv)` (TIP PIN must exist first); ruby `MixinBot.api.safe_register`; go `bot.RegisterSafe` / `bot.RegisterSafeWithSetupPin` (safe_user.go).

**Verify it worked** — poll `GET /safe/me`; assert `has_safe == true`. Then confirm end-to-end with a dust transfer or `GET /safe/outputs` for the bot's 1-of-1 members set. → payments.md for the send flow.

## OAuth (acting for Messenger users)

Authorize URL: `https://mixin.one/oauth/authorize?client_id=&scope=&response_type=code&redirect_uri=` (docs: api/oauth/oauth.md).

Scopes (docs: api/oauth/scope.md) — `PROFILE:READ` is **required**, rest optional:

| Scope | Grants |
|---|---|
| `PROFILE:READ` | user id, Mixin ID, name, avatar (always request) |
| `ASSETS:READ` | asset list & balances |
| `PHONE:READ` | phone number |
| `CONTACTS:READ` | contacts & block list |
| `MESSAGES:REPRESENT` | bot sends messages on behalf of the user |
| `SNAPSHOTS:READ` | transfer/deposit records |
| `CIRCLES:READ` / `CIRCLES:WRITE` | read/write circles |
| `COLLECTIBLES:READ` | collectibles list & balance |
| `STICKER:READ` | user stickers |

Request the minimum; users see and can revoke the list (revocation also expires tokens after a year — handle re-auth).

### Flow A — frontend, PKCE, no client_secret

For web/mobile frontends where the app secret must stay server-side-hidden or absent entirely.

1. `const {verifier, challenge} = client.oauth.getChallenge()` (node); generate an ed25519 keypair (`getED25519KeyPair()` → `{privateKey, publicKey, seed}`) — the **seed** becomes the user-scoped session key, keep it secret.
2. Open a WS to `wss://blaze.mixin.one` with subprotocol **`Mixin-OAuth-1`** and send action `REFRESH_OAUTH_CODE {client_id, scope, code_challenge, authorization_id}` (first time: omit/null `authorization_id`).
3. Response `data.code_id` → render QR as `mixin://codes/{code_id}` (node `SchemeCodes`). User scans in Messenger.
4. Server pushes `data.authorization_code` on the same WS.
5. Exchange secretless: `client.oauth.getToken({client_id, code, code_verifier, ed25519: publicKey})` → `{scope, authorization_id}`. (No client_secret needed — ed25519 + verifier suffice; go equivalent `bot.OAuthGetAccessToken(ctx, clientID, "", code, codeVerifier, ed25519)`.)
6. Build `OAuthKeystore {app_id, scope, authorization_id, session_private_key: seed hex}` and construct a scoped `MixinApi(keystore)`. `authorization_id` is stable — reuse it in step 2's `REFRESH_OAUTH_CODE` to re-auth the same user without re-prompting.

**Verify it worked** — call `client.user.profile()` on the OAuth-scoped client; it must return the *authorizing user's* profile (not the bot's) with fields matching the granted scope.

### Flow B — backend, client_secret

For server-to-server where the code arrives at your `redirect_uri`:

```go
accessToken, scope, authID, err := bot.OAuthGetAccessToken(
    ctx, clientID, clientSecret, code, "", "") // no verifier, no ed25519
me, err := bot.UserMe(ctx, accessToken) // token carries scp claim
```

The returned access token is a JWT with an `scp` claim; pass it as the access token to user-scoped reads (`UserMe`, `GetUser`, `SearchUser`, `ListUnspentOutputsByToken`). Choose Flow A when you control only a frontend or want per-device keys with no secret on the wire; Flow B when a trusted backend receives the redirect and you accept secret handling (store it like the spend key — see custody rails in custody-and-ops.md).

## Sub-accounts / bare users

Bots can create users programmatically (docs: app/guide/create-network-user.md):

1. Node: `userKeystore = client.user.createBareUser(fullName, sessionSecretB64)` → `NetworkUserKeystore {app_id, session_id, session_private_key, pin_token_base64}` (go: `bot.CreateUser` / `CreateUserSimple`). No spend key yet, no PIN yet.
2. **Persist the keystore now, before continuing** — if you lose these keys the account is unrecoverable; there is no reset path.
3. Set up TIP (migrate flow above — bare users have no old pin, `old_pin` = blank).
4. `safe.register(user_id, tipPin, priv)` to gain sequencer/spend capability.

**Verify it worked** — with the new keystore: `GET /safe/me` (node `safe.checkRegisteration()`) returns `has_safe: true`, and a test `client.safe.assets()`/outputs read returns the account's (empty) state without error.

## Dashboard app-security tab

The developer dashboard (2026-09-02) exposes per-app **IP allowlist** and **resource-pattern whitelist**, max **64 entries each**, applied via `POST /apps/:appId/security` — dashboard-only, no public docs page; payload shape `[UNVERIFIED]` — inspect the dashboard network tab before scripting it (docs: app/overview.md mentions App Security).

Recommendation regardless: enable both for any bot whose backend has a public IP. A locked-down allowlist turns a leaked session key from "full API access" into "requests from the wrong IP get dropped." This complements — never replaces — the custody rails in custody-and-ops.md.

## Sources

- docs: app/guide/generate-jwt-token.md, app/guide/create-network-user.md
- docs: api/pin/tip.md, api/sequencer/registration.md, api/oauth/oauth.md, api/oauth/scope.md, app/overview.md
- go: safe.go, auth.go, tip.go, safe_user.go, user.go (bot-api-go-client v3.25.7)
- node: dist/index.d.ts 7.6.0 (AppKeystore, OAuthKeystore, NetworkUserKeystore, pin.updateTipPin, oauth, safe.register, user.createBareUser)
- ruby: mixin_bot 3.0.2 README (MixinBot.configure, MixinBot::API.new, safe_register, create_user)
