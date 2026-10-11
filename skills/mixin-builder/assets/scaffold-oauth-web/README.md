# scaffold-oauth-web — Mixin OAuth backend (client_secret) flow

Zero runtime dependencies, Node ≥ 20 (`node:http` + built-in `fetch`). This is the **backend / server-side** flow: your app holds `client_secret` and exchanges the authorization code itself.

## Run

```bash
export MIXIN_APP_ID=<your app uuid>
export MIXIN_CLIENT_SECRET=<your app secret>   # dashboard; never ship to a browser
PORT=3000 node server.mjs
```

Missing env → usage printed, exit 1. No secrets are logged.

Open `http://127.0.0.1:3000/`:

1. `GET /` → **302** to `https://mixin.one/oauth/authorize?client_id=…&scope=PROFILE:READ&response_type=code&redirect_uri=<origin>/callback&state=<random>`. State is random (`crypto.randomBytes`), stored in an in-memory map with a 10-min TTL, one-shot, and compared in constant time (`timingSafeEqual`).
2. User approves in the Mixin messenger/web wallet → redirected to `GET /callback?code=…&state=…`.
3. Server validates state, exchanges the code:

   ```
   POST https://api.mixin.one/oauth/token
   { "client_id": "...", "client_secret": "...", "code": "..." }
   → { "data": { "access_token": "...", "scope": "PROFILE:READ", ... } }
   ```

4. Server reads the profile: `GET https://api.mixin.one/me` with `Authorization: Bearer <access_token>` → renders `user_id`, `full_name`, `identity_number`, `avatar_url` (docs: `api/oauth/oauth.md`; Node SDK equivalent: `client.oauth.getToken` / `client.user.profile`, `@mixin.dev/mixin-node-sdk` 7.6.0).

## Scope

`PROFILE:READ` is required. Others: `ASSETS:READ`, `PHONE:READ`, `CONTACTS:READ`, `MESSAGES:REPRESENT`, `SNAPSHOTS:READ`, `CIRCLES:READ/WRITE`, `COLLECTIBLES:READ`, `STICKER:READ` (docs: `api/oauth/scope.md`). Request only what you use.

## PKCE alternative (mobile/SPA or no-secret backends)

Mixin supports a secretless **ed25519 PKCE** exchange: generate `{verifier, challenge}` and a key pair (`getChallenge()`, `getED25519KeyPair()` in the Node SDK 7.6.0), pass `code_challenge` in the authorize step (QR flow uses `wss://blaze.mixin.one` subprotocol `Mixin-OAuth-1`, action `REFRESH_OAUTH_CODE`), then exchange with `{client_id, code, ed25519: <publicKey>, code_verifier: <verifier>}` and build an `OAuthKeystore` from the seed. Full details: → `references/identity-and-keys.md`.

## Verify it worked

- `curl -sI http://127.0.0.1:3000/` → `302` with `Location: https://mixin.one/oauth/authorize?...`
- `curl -s "http://127.0.0.1:3000/callback?code=x&state=bogus"` → `400 invalid or expired state`
- End-to-end: approve the flow in Mixin → rendered page must show a real `user_id` (uuid) matching your account's `full_name` / `identity_number`; `scope` must equal the requested scope string.

## Notes

- States are in-memory: fine for a scaffold; use redis/DB for multi-instance deployments.
- Access tokens from this endpoint are user-scoped OAuth tokens — not your bot's JWT (`signAuthenticationToken`). Use `client.oauth.authorize/authorizations/revokeAuthorize` (Node 7.6.0) to manage grants.

## Sources

- docs: `api/oauth/oauth.md`, `api/oauth/scope.md` (developers.mixin.one HEAD 2026-10-05)
- node: `@mixin.dev/mixin-node-sdk` 7.6.0 `dist/index.d.ts` (`oauth` namespace)
- verified 2026-10-11 against mixin-builder ground truth
