// v2 end-to-end tests: layout & survey photos, emergency card, outdoor events,
// positions privacy, check-ins, quick messages, alerts v2 + escalation,
// readiness, observance-lock behaviour and retention.
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishmar-v2-'));
const PORT = 3998, base = `http://localhost:${PORT}`;
let child, code;
const start = (fakeNow, extra = {}) => new Promise((resolve) => {
  child = spawn('node', ['--no-warnings', 'src/server.js'], { env: { ...process.env, PORT, MISHMAR_DATA: dataDir, MISHMAR_INSECURE_COOKIES: '1', MISHMAR_FAKE_NOW: fakeNow, MISHMAR_ESCALATE_SECS: '2', MISHMAR_PURGE_MS: '700', ...extra } });
  child.stdout.on('data', (d) => { const s = d.toString(); const m = s.match(/\n\s+([A-Z2-9]{5}-[A-Z2-9]{5})\n/); if (m) code = m[1]; if (s.includes('listening')) resolve(); });
  child.stderr.on('data', (d) => process.stderr.write(d));
});
const stop = () => new Promise((r) => { child.on('exit', r); child.kill(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, raw) {
    const headers = { 'x-requested-with': 'mishmar', cookie: this.cookie };
    let b = raw;
    if (body !== undefined) { headers['content-type'] = 'application/json'; b = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: b });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  }
}
let n = 0; const ok = (name) => console.log(`  ok ${++n} - ${name}`);
const H = (ms) => new Date(Date.now() + ms).toISOString();

// Minimal JPEG with an EXIF segment and a SOF0 header declaring 1200x800.
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif GPSMARKER'),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x04, 0xb0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0xff, 0xd9]),
]);
const form = (fields, file, name = 'photo') => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, String(v)); if (file) f.append(name, new Blob([file], { type: 'image/jpeg' }), 'x.jpg'); return f; };

try {
  console.log('Phase 1: weekday (Wed)');
  await start('2026-10-28T18:00:00Z');
  const admin = new Client(), avi = new Client(), ben = new Client(), cara = new Client(), dan = new Client();
  await admin.req('POST', '/api/auth/redeem', { code: code.replace('-', '').toLowerCase(), login: 'rav', name: 'Admin', password: 'correct horse battery' }).then((r) => assert.equal(r.status, 200));
  ok('invite code accepted without the hyphen, in lower case');
  for (const [c, login, name] of [[avi, 'avi', 'Avi'], [ben, 'ben', 'Ben'], [cara, 'cara', 'Cara'], [dan, 'dan', 'Dan']]) {
    const inv = (await admin.req('POST', '/api/invites', { role: 'guard' })).body.code;
    assert.equal((await c.req('POST', '/api/auth/redeem', { code: inv, login, name, password: `${login}-password-1` })).status, 200);
  }
  const team = (await admin.req('GET', '/api/team')).body; const id = (l) => team.find((u) => u.login === l).id;
  await admin.req('PUT', '/api/congregation', { name: 'Test Shul', lat: 39.7392, lon: -104.9903, tzid: 'America/Denver', candleMins: 18, havdalahMins: null, shabbatMode: true, osmEnabled: true });

  // ---------- layout ----------
  const me = (await admin.req('GET', '/api/me')).body; const mainId = me.mainSiteId;
  assert.ok(mainId); assert.equal(me.osmEnabled, true); ok('main building site exists by default');
  let r = await admin.req('POST', `/api/sites/${mainId}/image`, undefined, form({}, jpeg, 'image'));
  assert.equal(r.status, 200); assert.equal(r.body.imageW, 1200); assert.equal(r.body.imageH, 800); ok('floor plan uploaded; dimensions read from JPEG');
  r = await admin.req('GET', `/api/sites/${mainId}/image`); assert.ok(!r.body.includes('GPSMARKER')); ok('floor plan EXIF stripped');
  assert.ok(!fs.readdirSync(path.join(dataDir, 'photos')).some((f) => fs.readFileSync(path.join(dataDir, 'photos', f)).includes('JFIF'))); ok('floor plan encrypted on disk');
  const exit = (await admin.req('POST', `/api/sites/${mainId}/markers`, { type: 'exit', label: 'East exit', x: 1100, y: 400 })).body;
  await admin.req('POST', `/api/sites/${mainId}/markers`, { type: 'aed', label: 'AED by office', x: 300, y: 200, notes: 'Wall cabinet' });
  assert.equal((await admin.req('POST', `/api/sites/${mainId}/markers`, { type: 'bogus', label: 'x', x: 1, y: 1 })).status, 400); ok('pins: exit + AED placed; invalid type rejected');
  const front = (await admin.req('POST', '/api/posts', { name: 'Front door', x: 600, y: 780, radio: 'Ch 2' })).body;
  const side = (await admin.req('POST', '/api/posts', { name: 'Side door', x: 50, y: 400 })).body;
  r = await admin.req('POST', `/api/sites/${mainId}/photos`, undefined, form({ kind: 'panorama', caption: 'Lobby 360', postId: front.id }, jpeg));
  assert.equal(r.status, 200); const panoId = r.body.id; ok('panorama attached to a post');
  assert.equal((await avi.req('POST', `/api/sites/${mainId}/markers`, { type: 'exit', label: 'x', x: 1, y: 1 })).status, 403);
  assert.equal((await avi.req('POST', `/api/sites/${mainId}/photos`, undefined, form({}, jpeg))).status, 403); ok('guards cannot edit the layout');
  r = await avi.req('GET', `/api/sites/${mainId}`);
  assert.equal(r.body.markers.length, 2); assert.equal(r.body.posts.length, 2); assert.equal(r.body.photos[0].kind, 'panorama');
  assert.equal((await avi.req('GET', `/api/photos/${panoId}`)).status, 200); ok('guards can view the layout, pins and survey photos');
  assert.equal((await admin.req('PUT', `/api/sites/${mainId}/calibration`, { points: [{ x: 10, y: 10, lat: 39.7392, lon: -104.9903 }, { x: 15, y: 12, lat: 39.73921, lon: -104.99031 }] })).status, 400);
  assert.equal((await admin.req('PUT', `/api/sites/${mainId}/calibration`, { points: [{ x: 100, y: 700, lat: 39.7390, lon: -104.9910 }, { x: 1100, y: 100, lat: 39.7396, lon: -104.9898 }] })).status, 200);
  ok('2-point GPS calibration (rejects points too close together)');

  // ---------- emergency card ----------
  await admin.req('PUT', '/api/emergency', { address: '123 Main St, Denver', script: 'This is Test Shul at 123 Main St, side entrance on 2nd Ave.', procedures: 'Lockdown: lock doors, lights off.', contacts: [{ label: 'Police non-emergency', phone: '720-913-2000' }, { label: 'bad', phone: 'javascript:alert(1)' }] });
  r = await avi.req('GET', '/api/emergency');
  assert.equal(r.body.address, '123 Main St, Denver'); assert.equal(r.body.contacts.length, 1); assert.ok(r.body.pins.some((p) => p.type === 'exit')); ok('emergency card readable by guards; unsafe phone value dropped');
  assert.equal((await avi.req('PUT', '/api/emergency', {})).status, 403); ok('only admins edit the emergency card');

  // ---------- street maps toggle / CSP ----------
  let csp = (await admin.req('GET', '/')).headers.get('content-security-policy');
  assert.ok(csp.includes('tile.openstreetmap.org')); ok('CSP allows map tiles only while street maps are on');
  const park = (await admin.req('POST', '/api/sites', { name: 'Civic Center Park', kind: 'outdoor', base: 'osm', lat: 39.7393, lon: -104.9874, zoom: 18 })).body;
  assert.ok(park.id);
  await admin.req('PUT', '/api/congregation', { name: 'Test Shul', lat: 39.7392, lon: -104.9903, tzid: 'America/Denver', candleMins: 18, havdalahMins: null, shabbatMode: true, osmEnabled: false });
  csp = (await admin.req('GET', '/')).headers.get('content-security-policy');
  assert.ok(!csp.includes('openstreetmap')); assert.equal((await admin.req('POST', '/api/sites', { name: 'X', kind: 'outdoor', base: 'osm' })).body.error, 'street_maps_disabled');
  ok('admin can switch street maps off: tiles blocked by CSP, OSM sites refused');
  await admin.req('PUT', '/api/congregation', { name: 'Test Shul', lat: 39.7392, lon: -104.9903, tzid: 'America/Denver', candleMins: 18, havdalahMins: null, shabbatMode: true, osmEnabled: true });

  // ---------- outdoor event ----------
  r = await admin.req('POST', '/api/events', { name: 'Chanukah lighting', siteId: park.id, startsAt: H(-30 * 60000), endsAt: H(3 * 3600000), leadId: id('rav'), positions: 'leads', checkinMins: 20, radio: 'Ch 5', briefing: 'Rally point: fountain. Code word BLUE = evacuate.', contacts: [{ label: 'Police detail Sgt. K', phone: '303-555-0100' }] });
  assert.equal(r.status, 200); const ev = r.body; ok('event created with lead, briefing, contacts');
  const z1 = (await admin.req('POST', '/api/posts', { name: 'Stage', eventId: ev.id, lat: 39.7394, lon: -104.9875, leadId: id('avi'), radio: 'Ch 5' })).body;
  const z2 = (await admin.req('POST', '/api/posts', { name: 'North barricade', eventId: ev.id, lat: 39.7398, lon: -104.9874 })).body;
  for (const [zone, who] of [[z1, 'avi'], [z2, 'ben']]) assert.equal((await admin.req('POST', '/api/shifts', { postId: zone.id, userId: id(who), startsAt: ev.startsAt, endsAt: ev.endsAt })).status, 200);
  ok('zones placed on map and staffed');
  assert.equal((await cara.req('GET', '/api/events')).body.length, 0); assert.equal((await cara.req('GET', `/api/events/${ev.id}`)).status, 404); ok('non-members cannot see the event');
  r = await ben.req('GET', `/api/events/${ev.id}`);
  assert.equal(r.body.briefing.includes('BLUE'), true); assert.equal(r.body.me.zoneId, z2.id); assert.equal(r.body.zones.length, 2); ok('member sees briefing, zones and their own zone');
  assert.equal((await ben.req('POST', `/api/events/${ev.id}/position`, { lat: 39.7398, lon: -104.9874 })).body.error, 'sharing_off'); ok('positions refused until the guard opts in');
  await ben.req('POST', `/api/events/${ev.id}/ack`);
  await ben.req('POST', `/api/events/${ev.id}/sharing`, { on: true });
  await avi.req('POST', `/api/events/${ev.id}/sharing`, { on: true });
  assert.equal((await ben.req('POST', `/api/events/${ev.id}/position`, { lat: 39.7398, lon: -104.9874, acc: 8 })).status, 200);
  assert.equal((await avi.req('POST', `/api/events/${ev.id}/position`, { lat: 39.7394, lon: -104.9875, acc: 5 })).status, 200);
  r = await ben.req('GET', `/api/events/${ev.id}/positions`); assert.equal(r.body.length, 1); assert.equal(r.body[0].name, 'Ben'); ok('leads-only mode: a guard sees only themselves');
  r = await avi.req('GET', `/api/events/${ev.id}/positions`); assert.equal(r.body.length, 2); ok('zone lead sees the team');
  r = await admin.req('GET', `/api/events/${ev.id}/positions`); assert.equal(r.body.length, 2); assert.equal(r.body.find((p) => p.name === 'Ben').zone, 'North barricade'); ok('event lead sees positions labelled by zone');
  await admin.req('PUT', `/api/events/${ev.id}`, { positions: 'team' });
  assert.equal((await ben.req('GET', `/api/events/${ev.id}/positions`)).body.length, 2); ok('whole-team mode: guards see teammates');
  const db = () => new DatabaseSync(path.join(dataDir, 'mishmar.db'), { readOnly: true });
  { const d = db(); const raw = Buffer.concat(d.prepare('SELECT loc FROM positions').all().map((x) => Buffer.from(x.loc))); d.close(); assert.ok(!raw.includes('39.7398')); } ok('positions encrypted at rest');

  // roster & check-ins
  assert.equal((await ben.req('GET', `/api/events/${ev.id}/roster`)).status, 403);
  r = await admin.req('GET', `/api/events/${ev.id}/roster`);
  const rb = r.body.find((x) => x.name === 'Ben'); assert.equal(rb.acked, true); assert.equal(rb.overdue, false); assert.equal(rb.zone, 'North barricade');
  ok('lead roster: briefing acks, last seen, zone; guards cannot open it');

  // quick messages
  const sse = await fetch(base + '/api/stream', { headers: { cookie: avi.cookie } });
  const reader = sse.body.getReader(); let sseText = ''; (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; sseText += Buffer.from(value).toString(); } })().catch(() => {});
  r = await ben.req('POST', '/api/messages', { kind: 'crowd', text: 'Crowd pushing at barricade' });
  assert.equal(r.status, 200); assert.equal(r.body.post, 'North barricade'); assert.equal(r.body.eventId, ev.id); ok('quick message auto-stamped with zone and event');
  await wait(300); assert.ok(sseText.includes('event: message')); ok('teammates get it in real time');
  assert.equal((await cara.req('GET', `/api/messages?eventId=${ev.id}`)).status, 404); ok('non-members cannot read event messages');
  assert.equal((await ben.req('POST', '/api/messages', { kind: 'note' })).status, 400); ok('free-text note requires text');
  { const d = db(); const raw = Buffer.concat(d.prepare('SELECT body FROM messages WHERE body IS NOT NULL').all().map((x) => Buffer.from(x.body))); d.close(); assert.ok(!raw.includes('Crowd pushing')); } ok('message text encrypted at rest');

  // alerts v2
  r = await ben.req('POST', '/api/alerts', { kind: 'medical', lat: 39.73975, lon: -104.98742, acc: 6 });
  assert.equal(r.status, 200); assert.equal(r.body.post, 'North barricade');
  const evAlert = r.body.id;
  r = await admin.req('GET', '/api/alerts/active'); const av = r.body.find((a) => a.id === evAlert);
  assert.equal(av.kind, 'medical'); assert.equal(av.post.name, 'North barricade'); assert.equal(av.event.name, 'Chanukah lighting');
  assert.equal(av.nearest[0].name, 'Avi'); assert.ok(av.nearest[0].m > 20 && av.nearest[0].m < 100);
  ok('event alert carries type, zone, event and nearest responders with distance');
  assert.equal(av.recipients, 2); ok('event alert goes to the event team (not the building team)');
  await ben.req('POST', `/api/alerts/${evAlert}/kind`, { kind: 'backup' });
  assert.equal((await avi.req('GET', '/api/alerts/active')).body[0].kind, 'backup'); ok('sender can change the alert type after sending');
  await avi.req('POST', `/api/alerts/${evAlert}/ack`); await ben.req('POST', `/api/alerts/${evAlert}/resolve`, { outcome: 'all_clear' });

  // escalation (building): Dan is on duty, Cara sends; nobody acks within 2s -> whole team
  const tmpShifts = [
    (await admin.req('POST', '/api/shifts', { postId: front.id, userId: id('dan'), startsAt: H(-3600000), endsAt: H(3600000) })).body.id,
    (await admin.req('POST', '/api/shifts', { postId: side.id, userId: id('cara'), startsAt: H(-3600000), endsAt: H(3600000) })).body.id,
  ];
  r = await cara.req('POST', '/api/alerts', {});
  assert.equal(r.body.notified, 1); assert.equal(r.body.post, 'Side door'); const bAlert = r.body.id; ok('building alert: only on-duty building guards, stamped "Side door"');
  await wait(8000);
  r = await admin.req('GET', '/api/alerts/active'); const esc = r.body.find((a) => a.id === bAlert);
  assert.equal(esc.escalated, true); assert.equal(esc.recipients, 4); ok('no acknowledgement in time: escalated to the whole active team');
  await cara.req('POST', `/api/alerts/${bAlert}/resolve`, { outcome: 'false_alarm' });
  for (const sid of tmpShifts) await admin.req('DELETE', `/api/shifts/${sid}`);

  // retention: positions vanish when the event ends
  await admin.req('PUT', `/api/events/${ev.id}`, { startsAt: H(-5 * 3600000), endsAt: H(-2 * 3600000) });
  await wait(1500);
  { const d = db(); const c = d.prepare('SELECT COUNT(*) c FROM positions').get().c; d.close(); assert.equal(c, 0); } ok('live positions deleted automatically after the event ends');
  await stop();

  console.log('Phase 2: readiness (Thu, ~29h before candle lighting)');
  // Shifts for the Fri 10/30 - Sat 10/31 window
  await start('2026-10-29T18:00:00Z');
  assert.equal((await admin.req('POST', '/api/shifts', { postId: front.id, userId: id('dan'), startsAt: '2026-10-30T23:00:00Z', endsAt: '2026-10-31T03:00:00Z' })).status, 200);
  r = await admin.req('GET', '/api/readiness');
  assert.equal(r.body.window.start, '2026-10-30T23:42:00.000Z'); assert.deepEqual(r.body.gaps, ['Side door']); assert.equal(r.body.unconfirmed, 1); ok('readiness shows the next lock, uncovered posts and unconfirmed shifts');
  const shiftId = (await dan.req('GET', '/api/readiness')).body.mine[0].id;
  assert.equal((await dan.req('GET', '/api/readiness')).body.posts, undefined); ok('guards see only their own shifts in readiness');
  assert.equal((await cara.req('POST', `/api/shifts/${shiftId}/confirm`)).status, 404);
  assert.equal((await dan.req('POST', `/api/shifts/${shiftId}/confirm`)).status, 200);
  assert.equal((await admin.req('GET', '/api/readiness')).body.unconfirmed, 0); ok('a guard can confirm only their own shift');
  await stop();
  { const d = db(); const rem = d.prepare("SELECT key FROM reminders").all(); d.close(); assert.equal(rem.length, 1); } ok('readiness reminder sent once, ~a day before the lock');

  console.log('Phase 3: during Shabbat');
  await start('2026-10-31T18:00:00Z');
  assert.equal((await avi.req('GET', '/api/emergency')).status, 200);
  assert.equal((await avi.req('GET', `/api/sites/${mainId}`)).status, 200);
  assert.equal((await avi.req('GET', `/api/sites/${mainId}/image`)).status, 200); ok('emergency card and building layout stay readable during the lock');
  for (const [m, u, b] of [['POST', '/api/messages', { kind: 'all_good' }], ['GET', '/api/events'], ['POST', `/api/sites/${mainId}/markers`, { type: 'exit', label: 'x', x: 1, y: 1 }], ['GET', '/api/readiness'], ['PUT', '/api/emergency', {}]]) {
    assert.equal((await admin.req(m, u, b)).status, 423, `${m} ${u}`);
  }
  ok('messages, events, layout edits and readiness are locked');
  r = await cara.req('POST', '/api/alerts', { kind: 'threat' }); assert.equal(r.status, 200); ok('typed silent alert still works during the lock');
  await stop();
  console.log(`\nAll ${n} v2 checks passed.`);
} catch (e) { console.error('FAIL', e); await stop().catch(() => {}); process.exit(1); }
