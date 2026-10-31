// Web Push + in-app SSE fan-out. Push payloads never contain locations or
// incident content: just "open the app" prompts. Details are fetched over the
// authenticated API after the user opens the app.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { db, DATA_DIR } from './db.js';
import { decJSON, sha256, encJSON } from './crypto.js';

let vapid;
export function initPush() {
  const p = path.join(DATA_DIR, 'vapid.json');
  if (fs.existsSync(p)) vapid = JSON.parse(fs.readFileSync(p, 'utf8'));
  else {
    vapid = webpush.generateVAPIDKeys();
    fs.writeFileSync(p, JSON.stringify(vapid), { mode: 0o600 });
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:security@example.org', vapid.publicKey, vapid.privateKey);
}
export const vapidPublicKey = () => vapid.publicKey;

export function saveSubscription(userId, sub) {
  const hash = sha256(sub.endpoint);
  db.prepare('DELETE FROM push_subs WHERE endpoint_hash = ?').run(hash);
  db.prepare('INSERT INTO push_subs (user_id, endpoint_hash, sub) VALUES (?,?,?)')
    .run(userId, hash, encJSON('push', sub, `push:${hash}`));
}
export function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint_hash = ?').run(userId, sha256(endpoint));
}

// ---- SSE hub ----
const streams = new Map(); // userId -> Set<res>
export function addStream(userId, res) {
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
  res.on('close', () => { streams.get(userId)?.delete(res); });
}
export function sendEvent(userId, event, data) {
  for (const res of streams.get(userId) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
export function heartbeat() {
  for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
}

export async function pushToUsers(userIds, payload) {
  const body = JSON.stringify(payload);
  for (const uid of userIds) {
    const rows = db.prepare('SELECT id, endpoint_hash, sub FROM push_subs WHERE user_id = ?').all(uid);
    await Promise.allSettled(rows.map(async (r) => {
      try {
        const sub = decJSON('push', r.sub, `push:${r.endpoint_hash}`);
        await webpush.sendNotification(sub, body, { TTL: 300, urgency: 'high' });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(r.id);
      }
    }));
  }
}

export function notify(userIds, event, data, pushPayload) {
  for (const uid of userIds) sendEvent(uid, event, data);
  if (pushPayload) pushToUsers(userIds, pushPayload).catch(() => {});
}
