// v3 tests: health check, reset codes, two-factor sign-in, drills, delivery
// receipts, heartbeat events, backups.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { hotp } from '../src/crypto.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishmar-v3-'));
const PORT = 3997, base = `http://localhost:${PORT}`;
let child, code;
const start = (fakeNow) => new Promise((resolve) => {
  child = spawn('node', ['--no-warnings', 'src/server.js'], { env: { ...process.env, PORT, MISHMAR_DATA: dataDir, MISHMAR_INSECURE_COOKIES: '1', MISHMAR_FAKE_NOW: fakeNow, MISHMAR_HEARTBEAT_MS: '500' } });
  child.stdout.on('data', (d) => { const s = d.toString(); const m = s.match(/\n\s+([A-Z2-9]{5}-[A-Z2-9]{5})\n/); if (m) code = m[1]; if (s.includes('listening')) resolve(); });
  child.stderr.on('data', (d) => process.stderr.write(d));
});
const stop = () => new Promise((r) => { child.on('exit', r); child.kill(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const headers = { 'x-requested-with': 'mishmar', cookie: this.cookie };
    let b; if (body !== undefined) { headers['content-type'] = 'application/json'; b = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: b });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  }
}
const stream = (cookie) => { let text = ''; const ctl = new AbortController();
  fetch(base + '/api/stream', { headers: { cookie }, signal: ctl.signal }).then(async (r) => { const rd = r.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; text += Buffer.from(value).toString(); } }).catch(() => {});
  return { get text() { return text; }, close: () => ctl.abort() }; };
let n = 0; const ok = (name) => console.log(`  ok ${++n} - ${name}`);
const step = () => Math.floor(Date.now() / 30000);

try {
  console.log('Phase 1: weekday');
  await start('2026-11-11T18:00:00Z');
  const anon = new Client(), admin = new Client(), coord = new Client(), avi = new Client(), ben = new Client();
  let r = await anon.req('GET', '/healthz'); assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true }); ok('health check answers without signing in and reveals nothing else');

  await admin.req('POST', '/api/auth/redeem', { code, login: 'rav', name: 'Admin', password: 'correct horse battery' });
  const inv = async (role) => (await admin.req('POST', '/api/invites', { role })).body.code;
  await coord.req('POST', '/api/auth/redeem', { code: await inv('coordinator'), login: 'cora', name: 'Cora', password: 'coord-password-1' });
  await avi.req('POST', '/api/auth/redeem', { code: await inv('guard'), login: 'avi', name: 'Avi', password: 'avi-password-01' });
  await ben.req('POST', '/api/auth/redeem', { code: await inv('guard'), login: 'ben', name: 'Ben', password: 'ben-password-01' });
  const team = (await admin.req('GET', '/api/team')).body; const id = (l) => team.find((u) => u.login === l).id;

  // ---------- reset codes ----------
  assert.equal((await avi.req('POST', `/api/team/${id('ben')}/reset`)).status, 403);
  assert.equal((await coord.req('POST', `/api/team/${id('rav')}/reset`)).status, 403);
  assert.equal((await coord.req('POST', `/api/team/${id('cora')}/reset`)).status, 400); ok('guards cannot issue reset codes; coordinators only for guards, never themselves');
  const first = (await coord.req('POST', `/api/team/${id('avi')}/reset`)).body.code;
  const second = (await coord.req('POST', `/api/team/${id('avi')}/reset`)).body.code;
  const fresh = new Client();
  assert.equal((await fresh.req('POST', '/api/auth/reset', { code: first, login: 'avi', password: 'new-password-123' })).body.error, 'invalid_reset'); ok('issuing a new reset code cancels the previous one');
  assert.equal((await fresh.req('POST', '/api/auth/reset', { code: second, login: 'ben', password: 'new-password-123' })).body.error, 'invalid_reset'); ok('a reset code only works with the right login');
  assert.equal((await fresh.req('POST', '/api/auth/reset', { code: second.replace('-', '').toLowerCase(), login: 'AVI', password: 'new-password-123' })).status, 200); ok('reset code accepted (hyphen and case don\'t matter); new password set and signed in');
  assert.equal((await avi.req('GET', '/api/me')).status, 401); ok('all of the member\'s other sessions are signed out');
  assert.equal((await new Client().req('POST', '/api/auth/reset', { code: second, login: 'avi', password: 'another-password-1' })).body.error, 'invalid_reset'); ok('reset codes work once');
  assert.equal((await new Client().req('POST', '/api/auth/login', { login: 'avi', password: 'new-password-123' })).status, 200);
  Object.assign(avi, fresh);

  // ---------- two-factor ----------
  r = await avi.req('POST', '/api/me/totp/start'); const secret = r.body.secret;
  assert.match(r.body.uri, /^otpauth:\/\/totp\/Mishmar%3Aavi\?secret=[A-Z2-7]+&issuer=Mishmar/); ok('setup returns an authenticator QR link');
  assert.equal((await avi.req('POST', '/api/me/totp/confirm', { code: '000000' })).body.error, 'invalid_totp');
  assert.equal((await avi.req('POST', '/api/me/totp/confirm', { code: hotp(secret, step()) })).status, 200);
  assert.equal((await avi.req('GET', '/api/me')).body.totp, true); ok('two-step sign-in turns on only after a correct code');
  { const d = new DatabaseSync(path.join(dataDir, 'mishmar.db'), { readOnly: true }); const raw = Buffer.from(d.prepare("SELECT totp_secret FROM users WHERE login='avi'").get().totp_secret); d.close(); assert.ok(!raw.includes(secret)); } ok('authenticator secret is encrypted at rest');
  const t = new Client();
  assert.equal((await t.req('POST', '/api/auth/login', { login: 'avi', password: 'wrong-password-x' })).body.error, 'invalid_credentials'); ok('wrong password still says only "invalid credentials" (no hint that 2FA exists)');
  assert.equal((await t.req('POST', '/api/auth/login', { login: 'avi', password: 'new-password-123' })).body.error, 'totp_required');
  assert.equal((await t.req('POST', '/api/auth/login', { login: 'avi', password: 'new-password-123', totp: '123456' })).body.error, 'invalid_totp');
  // the confirm step already used the current time-step, so wait for the next one
  let s0 = step(); while (step() === s0) await wait(500);
  const good = hotp(secret, step());
  assert.equal((await t.req('POST', '/api/auth/login', { login: 'avi', password: 'new-password-123', totp: good })).status, 200); ok('sign-in needs password + current code');
  assert.equal((await new Client().req('POST', '/api/auth/login', { login: 'avi', password: 'new-password-123', totp: good })).body.error, 'invalid_totp'); ok('a code cannot be replayed');
  assert.equal((await avi.req('POST', '/api/me/totp/disable', { password: 'new-password-123', code: '111111' })).status, 403); ok('turning 2FA off needs a valid code');
  // lost phone: coordinator reset clears 2FA
  const rc = (await coord.req('POST', `/api/team/${id('avi')}/reset`)).body.code;
  assert.equal((await new Client().req('POST', '/api/auth/reset', { code: rc, login: 'avi', password: 'recovered-pass-1' })).status, 200);
  assert.equal((await new Client().req('POST', '/api/auth/login', { login: 'avi', password: 'recovered-pass-1' })).status, 200); ok('lost phone: a reset code also clears two-step sign-in');
  await avi.req('POST', '/api/auth/login', { login: 'avi', password: 'recovered-pass-1' });

  // ---------- drills & delivery receipts ----------
  assert.equal((await avi.req('POST', '/api/alerts', { drill: true })).status, 403); ok('guards cannot start drills');
  const sBen = stream(ben.cookie); await wait(300);
  r = await coord.req('POST', '/api/alerts', { drill: true, audience: 'all' });
  assert.equal(r.status, 200); assert.equal(r.body.drill, true); assert.equal(r.body.notified, 3);
  assert.equal(r.body.reach.live, 1); assert.equal(r.body.reach.unreachable, 2); ok('drill to whole team; receipt shows 1 with the app open, 2 unreachable');
  await wait(300); assert.ok(sBen.text.includes('event: alert') && sBen.text.includes('"drill":true')); ok('recipients are told it is a drill');
  const drillId = r.body.id;
  await wait(1200); assert.ok(sBen.text.includes('event: ping')); ok('server sends heartbeat events so the app can detect a dead connection');
  await ben.req('POST', `/api/alerts/${drillId}/ack`);
  r = await coord.req('GET', '/api/alerts/active'); const d = r.body.find((a) => a.id === drillId);
  assert.equal(d.drill, true); assert.equal(typeof d.firstAckSecs, 'number'); ok('drill records time to first response');
  r = await avi.req('POST', '/api/alerts', {}); assert.equal(r.body.drill, false); assert.notEqual(r.body.id, drillId); ok('a real alert is separate from a running drill');
  await avi.req('POST', `/api/alerts/${r.body.id}/resolve`, { outcome: 'false_alarm' });
  await coord.req('POST', `/api/alerts/${drillId}/resolve`, { outcome: 'resolved' });
  r = await admin.req('GET', '/api/alerts'); assert.ok(r.body.some((a) => a.drill && a.firstAckSecs != null)); ok('alert history marks drills with response time');
  sBen.close();

  // ---------- friendly invites ----------
  r = await coord.req('POST', '/api/invites', { role: 'guard', label: 'Sarah K.' });
  assert.equal(r.body.label, 'Sarah K.'); const sarah = r.body; ok('invite can carry the name of who it is for');
  assert.equal((await coord.req('POST', '/api/invites', { role: 'admin' })).status, 403); ok('coordinators can only invite guards');
  const adminInv = (await admin.req('POST', '/api/invites', { role: 'coordinator', label: 'Dan' })).body;
  r = await coord.req('GET', '/api/invites'); const mine = r.body.find((i) => i.id === sarah.id);
  assert.equal(mine.code, sarah.code); assert.equal(mine.by, 'Cora'); assert.ok(!r.body.some((i) => i.id === adminInv.id)); ok('leaders can see waiting invites and show the code again; coordinators see guard invites only');
  assert.equal((await avi.req('GET', '/api/invites')).status, 403); ok('guards cannot list invites');
  { const db = new DatabaseSync(path.join(dataDir, 'mishmar.db'), { readOnly: true }); const row = db.prepare('SELECT code_enc FROM invites WHERE rowid = ?').get(sarah.id); assert.ok(!Buffer.from(row.code_enc).toString('latin1').includes(sarah.code.replace('-', '').slice(0, 5))); db.close(); } ok('stored invite code is encrypted');
  assert.notEqual((await coord.req('DELETE', `/api/invites/${adminInv.id}`)).status, 200);
  assert.equal((await admin.req('DELETE', `/api/invites/${adminInv.id}`)).status, 200);
  assert.equal((await new Client().req('POST', '/api/auth/redeem', { code: adminInv.code, login: 'dan', name: 'Dan', password: 'dan-password-01' })).status, 400); ok('a cancelled invite stops working');
  assert.equal((await new Client().req('POST', '/api/auth/redeem', { code: sarah.code, login: 'sarah', name: 'Sarah', password: 'sarah-password-1' })).status, 200);
  assert.ok(!(await coord.req('GET', '/api/invites')).body.some((i) => i.id === sarah.id));
  { const db = new DatabaseSync(path.join(dataDir, 'mishmar.db'), { readOnly: true }); assert.equal(db.prepare('SELECT code_enc FROM invites WHERE rowid = ?').get(sarah.id).code_enc, null); db.close(); } ok('a used invite leaves the list and its code is wiped');
  await stop();

  console.log('Phase 2: during Shabbat');
  // configure the lock on a weekday, then check behaviour on Shabbat
  await start('2026-11-11T18:00:00Z');
  await admin.req('PUT', '/api/congregation', { name: 'T', lat: 39.7392, lon: -104.9903, tzid: 'America/Denver', candleMins: 18, havdalahMins: null, shabbatMode: true });
  await stop();
  await start('2026-11-14T18:00:00Z');
  assert.equal((await coord.req('POST', '/api/alerts', { drill: true })).status, 423); ok('no drills during Shabbat / Yom Tov');
  assert.equal((await coord.req('POST', '/api/alerts', {})).status, 200); ok('real alerts still work during the lock');
  assert.equal((await coord.req('POST', `/api/team/${id('ben')}/reset`)).status, 423); ok('account admin is locked during Shabbat like other routine actions');
  await stop();

  console.log('Phase 3: backup');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mishmar-bk-'));
  execFileSync('node', ['--no-warnings', 'src/backup.js'], { env: { ...process.env, MISHMAR_DATA: dataDir, MISHMAR_BACKUP_DIR: out } });
  const snap = fs.readdirSync(out)[0]; const files = fs.readdirSync(path.join(out, snap));
  assert.ok(files.includes('mishmar.db') && files.includes('photos') && !files.includes('master.key')); ok('backup has the database and photos but never the master key');
  { const db = new DatabaseSync(path.join(out, snap, 'mishmar.db'), { readOnly: true }); assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 5); db.close(); } ok('backup database is complete and readable');
  console.log(`\nAll ${n} v3 checks passed.`);
} catch (e) { console.error('FAIL', e); await stop().catch(() => {}); process.exit(1); }
