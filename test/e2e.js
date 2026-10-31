// End-to-end test: spawns the server twice (weekday, then Shabbat) against one data dir.
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishmar-test-'));
const PORT = 3999, base = `http://localhost:${PORT}`;
let child, code;
const start = (fakeNow) => new Promise((resolve) => {
  child = spawn('node', ['--no-warnings', 'src/server.js'], { env: { ...process.env, PORT, MISHMAR_DATA: dataDir, MISHMAR_INSECURE_COOKIES: '1', MISHMAR_FAKE_NOW: fakeNow } });
  child.stdout.on('data', (d) => { const s = d.toString(); const m = s.match(/\n\s+([A-Z2-9]{5}-[A-Z2-9]{5})\n/); if (m) code = m[1]; if (s.includes('listening')) resolve(); });
  child.stderr.on('data', (d) => process.stderr.write(d));
});
const stop = () => new Promise((r) => { child.on('exit', r); child.kill(); });

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, raw) {
    const headers = { 'x-requested-with': 'mishmar', cookie: this.cookie };
    let b = raw;
    if (body !== undefined) { headers['content-type'] = 'application/json'; b = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: b });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  }
}
let n = 0; const ok = (name) => console.log(`  ok ${++n} - ${name}`);

// tiny valid JPEG with a fake EXIF (APP1) segment containing "GPSMARKER"
const jpeg = Buffer.concat([Buffer.from([0xff,0xd8]), Buffer.from([0xff,0xe1,0x00,0x10]), Buffer.from('Exif GPSMARKER'), Buffer.from([0xff,0xda,0x00,0x02,0x01,0x02,0xff,0xd9])]);

try {
  console.log('Phase 1: weekday');
  await start('2026-10-28T18:00:00Z');
  const admin = new Client(), g1 = new Client(), g2 = new Client(), anon = new Client();

  assert.equal((await anon.req('GET', '/api/me')).status, 401); ok('unauthenticated rejected');
  assert.equal((await anon.req('POST', '/api/auth/login', { login: 'x', password: 'y' }, undefined)).status, 401); ok('bad login 401');
  const noCsrf = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403); ok('CSRF header required');

  let r = await admin.req('POST', '/api/auth/redeem', { code, login: 'rav', name: 'Admin Dan', password: 'correct horse battery' });
  assert.equal(r.status, 200); assert.equal(r.body.user.role, 'admin'); ok('bootstrap admin via invite code');
  assert.equal((await anon.req('POST', '/api/auth/redeem', { code, login: 'rav2', name: 'x', password: 'correct horse battery' })).status, 400); ok('invite is single-use');

  r = await admin.req('PUT', '/api/congregation', { name: 'Test Shul', lat: 39.7392, lon: -104.9903, tzid: 'America/Denver', il: false, candleMins: 18, havdalahMins: null, shabbatMode: true });
  assert.equal(r.status, 200); assert.equal(r.body.mode, true); assert.equal(r.body.locked, false); assert.ok(r.body.windows.length >= 2); ok('shabbat mode configured, unlocked midweek');

  r = await admin.req('POST', '/api/invites', { role: 'guard' }); const c1 = r.body.code;
  r = await admin.req('POST', '/api/invites', { role: 'guard' }); const c2 = r.body.code;
  assert.equal((await g1.req('POST', '/api/auth/redeem', { code: c1, login: 'avi', name: 'Avi', password: 'short' })).status, 400); ok('weak password rejected');
  assert.equal((await g1.req('POST', '/api/auth/redeem', { code: c1, login: 'avi', name: 'Avi', password: 'guard-password-1' })).status, 200);
  assert.equal((await g2.req('POST', '/api/auth/redeem', { code: c2, login: 'ben', name: 'Ben', password: 'guard-password-2' })).status, 200); ok('guards onboarded');

  // RBAC
  assert.equal((await g1.req('GET', '/api/team')).status, 403);
  assert.equal((await g1.req('PUT', '/api/congregation', {})).status, 403);
  assert.equal((await g1.req('POST', '/api/shifts', {})).status, 403);
  assert.equal((await g1.req('POST', '/api/invites', { role: 'admin' })).status, 403); ok('guards cannot list members, edit settings, schedule, or invite');

  // schedule
  const post = (await admin.req('POST', '/api/posts', { name: 'Main Entrance' })).body;
  const team = (await admin.req('GET', '/api/team')).body; const avi = team.find((u) => u.login === 'avi'), ben = team.find((u) => u.login === 'ben');
  const start1 = new Date(Date.now() - 3600000).toISOString(), end1 = new Date(Date.now() + 3600000).toISOString();
  assert.equal((await admin.req('POST', '/api/shifts', { postId: post.id, userId: avi.id, startsAt: start1, endsAt: end1 })).status, 200);
  assert.equal((await admin.req('POST', '/api/shifts', { postId: post.id, userId: avi.id, startsAt: start1, endsAt: end1 })).status, 409); ok('shift created; overlap blocked');
  r = await g2.req('GET', '/api/shifts'); assert.equal(r.body.length, 1); assert.equal(r.body[0].person, 'Avi'); ok('guard sees roster (display names only)');
  assert.ok(!JSON.stringify(r.body).includes('"login"')); ok('no login handles leaked in schedule');

  // alert: Ben (not on duty) sends; Avi (on duty) is the recipient
  const sse = await fetch(base + '/api/stream', { headers: { cookie: g1.cookie } });
  const reader = sse.body.getReader(); let sseText = ''; (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; sseText += Buffer.from(value).toString(); } })().catch(() => {});
  r = await g2.req('POST', '/api/alerts', { lat: 39.74, lon: -104.99, acc: 12 });
  assert.equal(r.status, 200); assert.equal(r.body.notified, 1); const alertId = r.body.id; ok('silent alert sent to on-duty team only');
  await new Promise((s) => setTimeout(s, 300)); assert.ok(sseText.includes('event: alert')); ok('recipient got realtime event');
  assert.equal((await g2.req('POST', '/api/alerts', {})).body.duplicate, true); ok('duplicate taps are idempotent');
  r = await g1.req('GET', '/api/alerts/active'); assert.equal(r.body[0].loc.lat, 39.74); ok('recipient sees decrypted location');
  assert.equal((await g1.req('POST', `/api/alerts/${alertId}/ack`)).status, 200);
  r = await g2.req('GET', '/api/alerts/active'); assert.deepEqual(r.body[0].acked, ['Avi']); ok('sender sees acknowledgement');

  // incident with photo
  const fd = new FormData(); fd.append('description', 'Unfamiliar vehicle idling near the side door'); fd.append('occurredAt', new Date().toISOString());
  fd.append('postId', String(post.id)); fd.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'p.jpg');
  r = await g1.req('POST', '/api/incidents', undefined, fd); assert.equal(r.status, 200); const incId = r.body.id; ok('incident with photo created');
  assert.equal((await g2.req('GET', `/api/incidents/${incId}`)).status, 404); ok("other guard can't read someone else's incident");
  assert.equal((await admin.req('GET', `/api/incidents/${incId}`)).body.description, 'Unfamiliar vehicle idling near the side door'); ok('admin can read it');
  r = await admin.req('GET', `/api/incidents/${incId}/photo`); assert.ok(!r.body.includes('GPSMARKER') && r.body[0] === 0xff); ok('EXIF/APP1 stripped from stored photo');
  const bad = new FormData(); bad.append('description', 'x'); bad.append('photo', new Blob([Buffer.from('<html>')]), 'a.jpg');
  assert.equal((await g1.req('POST', '/api/incidents', undefined, bad)).status, 400); ok('non-JPEG upload rejected');

  // encryption at rest
  const dbBytes = fs.readFileSync(path.join(dataDir, 'mishmar.db')); const wal = fs.existsSync(path.join(dataDir, 'mishmar.db-wal')) ? fs.readFileSync(path.join(dataDir, 'mishmar.db-wal')) : Buffer.alloc(0);
  const all = Buffer.concat([dbBytes, wal]);
  assert.ok(!all.includes('Unfamiliar vehicle')); assert.ok(!all.includes('39.74')); ok('incident text & alert location are ciphertext in the database');
  const photoFile = fs.readdirSync(path.join(dataDir, 'photos'))[0]; assert.ok(fs.readFileSync(path.join(dataDir, 'photos', photoFile))[0] === 1); ok('photo file is encrypted on disk');
  assert.ok(!all.includes('guard-password-1')); ok('passwords never stored in plaintext');

  assert.equal((await g1.req('POST', `/api/alerts/${alertId}/resolve`, { outcome: 'all_clear' })).status, 403); ok('a recipient cannot close the sender\'s alert');
  await stop();

  console.log('Phase 2: Shabbat (Sat 2026-10-31 noon Denver)');
  await start('2026-10-31T18:00:00Z');
  r = await admin.req('GET', '/api/shabbat'); assert.equal(r.body.locked, true); assert.ok(new Date(r.body.current.end) > new Date('2026-10-31T18:00:00Z')); ok('server reports locked until Havdalah');
  const lockedCalls = [
    ['GET', '/api/shifts'], ['GET', '/api/posts'], ['GET', '/api/incidents'], ['GET', '/api/team'],
    ['POST', '/api/shifts', { postId: post.id, userId: avi.id, startsAt: start1, endsAt: end1 }],
    ['PUT', '/api/congregation', { name: 'x', tzid: 'America/Denver', candleMins: 18, shabbatMode: false }],
    ['POST', '/api/invites', { role: 'guard' }],
  ];
  for (const [m, u, b] of lockedCalls) { const x = await admin.req(m, u, b); assert.equal(x.status, 423, `${m} ${u} should be 423, got ${x.status}`); }
  ok('every routine endpoint returns 423 - even for admin; Shabbat mode cannot be switched off while locked');
  const fd2 = new FormData(); fd2.append('description', 'x'); assert.equal((await g1.req('POST', '/api/incidents', undefined, fd2)).status, 423); ok('incident reporting locked');

  assert.equal((await g1.req('GET', '/api/me')).status, 200);
  assert.equal((await new Client().req('POST', '/api/auth/login', { login: 'ben', password: 'guard-password-2' })).status, 200); ok('sign-in and session still work');
  r = await g1.req('GET', '/api/alerts/active'); assert.equal(r.status, 200); ok('life-safety: active alerts readable');
  assert.equal((await g2.req('POST', `/api/alerts/${alertId}/resolve`, { outcome: 'false_alarm' })).status, 200);
  r = await g2.req('POST', '/api/alerts', { lat: 39.74, lon: -104.99 }); assert.equal(r.status, 200); assert.ok(r.body.id !== alertId); ok('life-safety: silent alert sends during Shabbat lock');
  assert.equal((await g1.req('POST', `/api/alerts/${r.body.id}/ack`)).status, 200); ok('life-safety: acknowledge works during lock');
  await stop();

  console.log('Phase 3: Yom Tov and unlock');
  await start('2026-09-13T18:00:00Z'); // Rosh Hashana day 2 (a Sunday)
  r = await admin.req('GET', '/api/shabbat'); assert.equal(r.body.locked, true); ok('Rosh Hashana day 2 (Sunday) is locked: Yom Tov merged with the preceding window');
  await stop();
  await start('2026-11-01T12:00:00Z'); // Sunday after Havdalah
  r = await admin.req('GET', '/api/shabbat'); assert.equal(r.body.locked, false);
  assert.equal((await admin.req('GET', '/api/shifts')).status, 200); ok('routine features return after Havdalah');
  await stop();
  console.log(`\nAll ${n} checks passed.`);
} catch (e) { console.error('FAIL', e); await stop().catch(() => {}); process.exit(1); }
