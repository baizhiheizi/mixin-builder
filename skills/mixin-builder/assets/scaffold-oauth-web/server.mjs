// Mixin OAuth — backend client_secret flow (zero deps, Node >= 20).
// Protocol: https://mixin.one/oauth/authorize?client_id&scope&response_type=code&redirect_uri
// Exchange: POST https://api.mixin.one/oauth/token {client_id, client_secret, code, code_verifier?}
// Profile:  GET  https://api.mixin.one/me  Authorization: Bearer <access_token>
// Verified against mixin-builder gt.md 2026-10-11 (docs: api/oauth/oauth.md; node: dist/index.d.ts 7.6.0 — client.oauth.getToken uses this same endpoint).

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const USAGE = `Usage:
  MIXIN_APP_ID=<app uuid> MIXIN_CLIENT_SECRET=<secret> PORT=3000 node server.mjs

Env:
  MIXIN_APP_ID          bot/app client_id (dashboard)
  MIXIN_CLIENT_SECRET   app secret (dashboard; keep server-side only)
  PORT                  optional, default 3000
`;

const APP_ID = process.env.MIXIN_APP_ID;
const CLIENT_SECRET = process.env.MIXIN_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 3000);

if (!APP_ID || !CLIENT_SECRET) {
  console.error(USAGE);
  process.exit(1);
}

const AUTHORIZE_URL = 'https://mixin.one/oauth/authorize';
const TOKEN_URL = 'https://api.mixin.one/oauth/token';
const ME_URL = 'https://api.mixin.one/me';
const SCOPE = 'PROFILE:READ'; // required scope; more: ASSETS:READ, SNAPSHOTS:READ, ... (docs: api/oauth/scope.md)
const STATE_TTL_MS = 10 * 60 * 1000;

// state -> expiry (in-memory; fine for a single-process scaffold)
const states = new Map();

function newOAuthState() {
  const state = randomBytes(24).toString('base64url');
  states.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeState(state) {
  const exp = states.get(state);
  states.delete(state); // one-shot even on failure
  if (typeof state !== 'string' || state.length === 0 || typeof exp !== 'number') return false;
  if (Date.now() > exp) return false;
  return true;
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const origin = `${url.protocol}//${url.host}`;

  if (req.method !== 'GET') {
    return send(res, 405, { 'content-type': 'text/plain' }, 'method not allowed\n');
  }

  if (url.pathname === '/') {
    const state = newOAuthState();
    const redirectUri = `${origin}/callback`;
    const q = new URLSearchParams({
      client_id: APP_ID,
      scope: SCOPE,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
    });
    return send(res, 302, { location: `${AUTHORIZE_URL}?${q}` });
  }

  if (url.pathname === '/callback') {
    const state = url.searchParams.get('state') || '';
    // validate state first; one-shot + constant-time compare
    const expected = [...states.keys()].find((k) => constantTimeEqual(k, state));
    if (!expected || !consumeState(expected)) {
      return send(res, 400, { 'content-type': 'text/plain' }, 'invalid or expired state\n');
    }
    const code = url.searchParams.get('code');
    if (!code) {
      return send(res, 400, { 'content-type': 'text/plain' }, 'missing code\n');
    }

    try {
      // token exchange (client_secret backend flow; code_verifier only for PKCE — see README)
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: APP_ID,
          client_secret: CLIENT_SECRET,
          code,
        }),
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok || tokenJson.error) {
        const d = tokenJson.error || {};
        return send(res, 502, { 'content-type': 'text/plain' },
          `token exchange failed: ${d.code ?? tokenRes.status} ${d.description ?? ''}\n`);
      }
      const accessToken = tokenJson.data?.access_token;
      const scope = tokenJson.data?.scope;

      // profile read
      const meRes = await fetch(ME_URL, { headers: { authorization: `Bearer ${accessToken}` } });
      const meJson = await meRes.json();
      if (!meRes.ok || meJson.error) {
        const d = meJson.error || {};
        return send(res, 502, { 'content-type': 'text/plain' },
          `/me failed: ${d.code ?? meRes.status} ${d.description ?? ''}\n`);
      }
      const u = meJson.data || {};
      const html = `<!doctype html><meta charset="utf-8"><title>Mixin OAuth</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
<h1>Logged in</h1>
<dl>
<dt>scope</dt><dd>${String(scope).replace(/[<>&]/g, '')}</dd>
<dt>user_id</dt><dd>${String(u.user_id ?? '').replace(/[<>&]/g, '')}</dd>
<dt>full_name</dt><dd>${String(u.full_name ?? '').replace(/[<>&]/g, '')}</dd>
<dt>identity_number</dt><dd>${String(u.identity_number ?? '').replace(/[<>&]/g, '')}</dd>
<dt>avatar</dt><dd><img src="${String(u.avatar_url ?? '').replace(/"/g, '')}" width="96" alt="avatar"></dd>
</dl></body>`;
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, html);
    } catch (err) {
      return send(res, 502, { 'content-type': 'text/plain' }, `oauth flow error: ${err.message}\n`);
    }
  }

  send(res, 404, { 'content-type': 'text/plain' }, 'not found\n');
});

server.listen(PORT, () => {
  console.log(`scaffold-oauth-web listening on http://127.0.0.1:${PORT}`);
  console.log(`open http://127.0.0.1:${PORT}/ to start the Mixin OAuth flow`);
});
