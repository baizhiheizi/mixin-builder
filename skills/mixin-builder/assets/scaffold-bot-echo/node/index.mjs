// Minimal Mixin echo bot over Blaze (@mixin.dev/mixin-node-sdk).
//
// Reads a keystore JSON file (path from --keystore or $KEYSTORE), echoes
// every inbound PLAIN_TEXT back to the sender as "echo: <text>" with a
// reply message_id derived deterministically from the inbound message_id,
// so redeliveries never produce duplicate replies.
//
// Messaging-only keystores work: app_id + session_id + session_private_key
// are enough; spend_private_key is optional and never required here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MixinApi } from '@mixin.dev/mixin-node-sdk';
import { BlazeKeystoreClient } from '@mixin.dev/mixin-node-sdk/blaze';

const USAGE = `usage: node index.mjs [--keystore path]   (or set $KEYSTORE)

The keystore is a JSON file with at least:
  {"app_id": "...", "session_id": "...", "session_private_key": "..."}
Spend key / server public key are not required for messaging.`;
function loadKeystore() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--keystore');
  const path = (i !== -1 ? args[i + 1] : undefined) ?? process.env.KEYSTORE;
  if (!path) {
    console.error(USAGE);
    process.exit(1); // no network before a keystore exists
  }
  let keystore;
  try {
    keystore = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`cannot read/parse keystore at ${path}: ${err.message}`);
    process.exit(1);
  }
  // NOTE: never log the keystore object — it holds secrets.
  if (!keystore.app_id || !keystore.session_id || !keystore.session_private_key) {
    console.error('keystore is missing app_id/session_id/session_private_key');
    process.exit(1);
  }
  return keystore;
}

// Same inbound id → same reply id → the network dedupes re-sent replies.
function deterministicReplyId(inboundId) {
  const h = createHash('sha256').update(`echo:${inboundId}`).digest('hex');
  return [
    h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32),
  ].join('-');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const keystore = loadKeystore();
const client = MixinApi({ keystore });
const blaze = BlazeKeystoreClient(keystore, { parse: true, syncAck: true });

const handler = {
  async onMessage(msg) {
    // Ignore non-text categories and our own messages.
    if (msg.category !== 'PLAIN_TEXT' || msg.user_id === keystore.app_id) return;
    const text = Buffer.from(msg.data_base64, 'base64').toString('utf8');
    console.log(`echo -> conversation ${msg.conversation_id} user ${msg.user_id}`);
    await client.message.sendOne({
      conversation_id: msg.conversation_id,
      recipient_id: msg.user_id,
      message_id: deterministicReplyId(msg.message_id),
      category: 'PLAIN_TEXT',
      data_base64: Buffer.from(`echo: ${text}`, 'utf8').toString('base64'),
    });
    // syncAck: true → the SDK sends ACKNOWLEDGE_MESSAGE_RECEIPT itself
    // after this handler resolves; do not ack manually.
  },
  onAckReceipt(_msg) {}, // receipts for our outgoing messages
};

// BlazeKeystoreClient.loop auto-reconnects internally; this outer loop only
// handles fatal errors (bad keystore, unrecoverable socket) with backoff
// 1s..60s cap (x2, jitter), reset after a healthy 60s run.
let backoff = 1000;
for (;;) {
  const started = Date.now();
  try {
    await new Promise((_resolve, reject) => {
      blaze.loop({ ...handler, onMessage: (m) => Promise.resolve(handler.onMessage(m)).catch(reject) });
      // loop() returns immediately; keep the promise pending while connected.
    });
  } catch (err) {
    if (Date.now() - started > 60_000) backoff = 1000;
    const wait = backoff / 2 + Math.random() * backoff;
    console.error(`blaze fatal: ${err?.message ?? err}; retrying in ${Math.round(wait)}ms`);
    await sleep(wait);
    backoff = Math.min(backoff * 2, 60_000);
    try { blaze.stopLoop(); } catch { /* not looping */ }
  }
}
