// blaze-client.mjs — minimal Blaze loop on top of @mixin.dev/mixin-node-sdk 7.6.0.
//
// Why not the SDK's BlazeKeystoreClient: it opens the socket without a User-Agent header.
// blaze.mixin.one answers that handshake with HTTP 202 {"code":10006,"description":"Update required."}
// and the SDK then sits in CONNECTING forever without raising an error, so the bot never
// receives anything (live-checked 2026-10-13; → references/blaze.md, references/gotchas.md #19).
//
// Same protocol otherwise, using the SDK's own helpers: JWT from signAccessToken('GET', '/'),
// gzip frames via decodeMessage/sendRaw, LIST_PENDING_MESSAGES on open, and
// ACKNOWLEDGE_MESSAGE_RECEIPT only after the handler resolves. A handler that throws leaves
// the message un-acked, so the gateway redelivers it: handlers must be idempotent.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { signAccessToken } from '@mixin.dev/mixin-node-sdk';
import { decodeMessage, sendRaw } from '@mixin.dev/mixin-node-sdk/blaze';

const BLAZE_URL = 'wss://blaze.mixin.one';

export function startBlaze(keystore, { onMessage, onOpen, onError = console.error, userAgent = 'mixin-bot/1.0', parse = true }) {
  let ws;
  let stopped = false;
  let pingTimer;
  let backoff = 1000;

  const heartbeat = () => {
    // The gateway pings regularly; 30s of silence means a dead socket.
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => ws?.terminate(), 30_000);
  };

  const connect = () => {
    const token = signAccessToken('GET', '/', '', randomUUID(), keystore);
    if (!token) throw new Error('cannot sign Blaze token: keystore needs app_id + hex 32-byte session_private_key');
    // Handlers below use `sock`, not `ws`, so a late event from an old socket never touches its replacement.
    const sock = new WebSocket(BLAZE_URL, 'Mixin-Blaze-1', {
      // A "name/version" User-Agent is required; none, "node" or "x" get 10006.
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent },
      handshakeTimeout: 10_000,
    });
    ws = sock;
    let rejected = false; // handshake refused: already reported, skip the follow-up "closed before established" error
    sock.on('open', () => {
      backoff = 1000;
      heartbeat();
      sendRaw(sock, { id: randomUUID(), action: 'LIST_PENDING_MESSAGES' });
      onOpen?.();
    });
    sock.on('ping', heartbeat);
    sock.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        rejected = true;
        onError(new Error(`blaze handshake HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        sock.terminate();
      });
    });
    sock.on('message', async (data) => {
      let msg;
      try {
        msg = decodeMessage(data, { parse });
      } catch (err) {
        onError(new Error(`blaze decode: ${err.message}`));
        return;
      }
      if (!msg?.message_id) return;
      try {
        await onMessage(msg);
      } catch (err) {
        onError(new Error(`handler failed for ${msg.message_id}, leaving it un-acked for redelivery: ${err.message}`));
        return;
      }
      await sendRaw(sock, {
        id: randomUUID(),
        action: 'ACKNOWLEDGE_MESSAGE_RECEIPT',
        params: { message_id: msg.message_id, status: 'READ' },
      });
    });
    sock.on('error', (err) => { if (!rejected) onError(new Error(`blaze socket: ${err.message}`)); });
    sock.on('close', () => {
      clearTimeout(pingTimer);
      if (stopped) return;
      // 1s..60s, doubling, with 0.5–1.5× jitter; reset on the next successful open.
      const wait = backoff / 2 + Math.random() * backoff;
      backoff = Math.min(backoff * 2, 60_000);
      setTimeout(connect, wait);
    });
  };

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(pingTimer);
      ws?.close();
    },
  };
}
