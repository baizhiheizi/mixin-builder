# Eval: Mixin login for a web app

## Prompt

> Add "Sign in with Mixin" to my Next.js app. I have app_id and client_secret. Show me the login flow, what to store, and how to read the user's profile. Also: can I do it without handling any secret server-side?

## Passes when

- Presents both flows with a correct chooser: backend `client_secret` exchange vs frontend PKCE (secretless, Ed25519 keypair + code_challenge), citing `identity-and-keys.md`.
- Backend: authorize URL (`https://mixin.one/oauth/authorize` with client_id/scope/response_type=code/redirect_uri) → code → token exchange → `GET /me` with Bearer; state/CSRF handled; secret from env, never client bundle.
- PKCE: WS `wss://blaze.mixin.one` subprotocol `Mixin-OAuth-1`, `REFRESH_OAUTH_CODE`, QR `mixin://codes/{code_id}`, `authorization_id` reuse for re-auth; seed kept client-side secret; warns seed = private key.
- Scopes: `PROFILE:READ` required + minimal extras; doesn't request ASSETS:READ for a login-only app.
- Storage: user_id as identity, scope + authorization_id; does NOT store raw tokens longer than needed; notes OAuth tokens are per-scope, not spend authority.
- Points at `assets/scaffold-oauth-web/` as the runnable start, and a verify step (profile fetch succeeds with the obtained credential).

## Fails when

- Sends client_secret to the browser, skips state validation, or claims PKCE needs the secret.
- Requests FULL scope or treats an OAuth token as money authority.
- Invents SDK methods (real: `client.oauth.getToken`, `getChallenge`, `getED25519KeyPair`; Go `OAuthGetAccessToken`).
