// Operational features: site layouts (floor plans, survey photos, pins), events
// (outdoor or indoor) with zones, check-ins and opt-in live positions, quick
// messages, the emergency card, and pre-Shabbat readiness.
import { db, now, audit } from './db.js';
import { encJSON, decJSON, enc, dec } from './crypto.js';
import { routineOnly, shabbatState, getCongregation } from './shabbat.js';
import { notify, pushToUsers } from './push.js';
import {
  bad, str, optStr, isoOrNull, num, int, auth, need, isCoord, stripJpeg, upload, savePhoto, deletePhoto, sendJpeg, meters,
} from './http.js';

export const TILE_URL = process.env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ORIGIN = new URL(TILE_URL.replace(/\{[a-z]\}/g, 'a')).origin;
export const osmEnabled = () => !!getCongregation().osm_enabled;

const MARKER_TYPES = ['door', 'exit', 'aed', 'kit', 'rally', 'fire', 'stairs', 'camera', 'hazard', 'note'];
const SAFETY_TYPES = ['exit', 'aed', 'kit', 'rally', 'fire', 'door', 'stairs'];
export const MSG_LEVEL = { all_good: 0, relief: 0, note: 0, crowd: 1, suspicious: 1, medical: 2, lost_child: 2, backup: 2 };
const MSG_LABEL = { all_good: 'All good', relief: 'Need relief', note: 'Note', crowd: 'Crowd building', suspicious: 'Suspicious person', medical: 'Medical', lost_child: 'Lost child', backup: 'Need backup' };
const GRACE = 15 * 60000;
const iso = (ms) => new Date(ms).toISOString();

// ---------- membership & context ----------
export function eventActive(ev, at = Date.now()) {
  return !!ev && !ev.cancelled && Date.parse(ev.starts_at) - 3600000 <= at && at <= Date.parse(ev.ends_at) + 3600000;
}
export function eventMembers(eventId) {
  return db.prepare(`SELECT DISTINCT s.user_id AS id FROM shifts s JOIN posts p ON p.id = s.post_id JOIN users u ON u.id = s.user_id WHERE p.event_id = ? AND p.active = 1 AND u.active = 1
    UNION SELECT lead_id FROM events WHERE id = ? AND lead_id IS NOT NULL
    UNION SELECT lead_id FROM posts WHERE event_id = ? AND lead_id IS NOT NULL AND active = 1`).all(eventId, eventId, eventId).map((r) => r.id);
}
const isMember = (ev, u) => eventMembers(ev.id).includes(u.id);
export function isEventLead(ev, u) {
  return isCoord(u) || ev.lead_id === u.id || !!db.prepare('SELECT 1 FROM posts WHERE event_id = ? AND lead_id = ? AND active = 1').get(ev.id, u.id);
}
export function canSeePositions(ev, u) {
  if (ev.positions === 'off') return false;
  return isEventLead(ev, u) || (ev.positions === 'team' && isMember(ev, u));
}

// Where is this person working right now? Used to stamp alerts and messages.
export function currentContext(userId) {
  const t = Date.now();
  const s = db.prepare(`SELECT p.id, p.name, p.event_id FROM shifts s JOIN posts p ON p.id = s.post_id LEFT JOIN events e ON e.id = p.event_id
    WHERE s.user_id = ? AND s.starts_at <= ? AND s.ends_at >= ? AND (e.id IS NULL OR e.cancelled = 0)
    ORDER BY (s.starts_at <= ? AND s.ends_at >= ?) DESC, s.starts_at DESC LIMIT 1`).get(userId, iso(t + GRACE), iso(t - GRACE), iso(t), iso(t));
  if (s) return { postId: s.id, postName: s.name, eventId: s.event_id };
  const led = db.prepare('SELECT * FROM events WHERE lead_id = ? AND cancelled = 0 AND starts_at <= ? AND ends_at >= ? ORDER BY starts_at DESC LIMIT 1').get(userId, iso(t + 3600000), iso(t - 3600000));
  return { postId: null, postName: null, eventId: led ? led.id : null };
}

const onNow = (postId) => db.prepare('SELECT u.display_name AS name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.post_id = ? AND s.starts_at <= ? AND s.ends_at >= ? AND u.active = 1')
  .all(postId, now(), now()).map((r) => r.name);
const touch = (eventId, userId, col = 'last_checkin') => db.prepare(`INSERT INTO event_members (event_id, user_id, ${col}) VALUES (?,?,?)
  ON CONFLICT(event_id, user_id) DO UPDATE SET ${col} = excluded.${col}`).run(eventId, userId, now());

export function registerOps(app) {
  // ======================= SITES (layout) =======================
  // Read access is NOT locked during Shabbat/Yom Tov: the layout is safety reference material.
  const siteRow = (id) => db.prepare('SELECT * FROM sites WHERE id = ? AND active = 1').get(id);
  function siteView(s, eventId) {
    let calib = null;
    if (s.calib) { try { calib = decJSON('field', s.calib, `calib:${s.id}`); } catch { /* ignore */ } }
    const posts = db.prepare(`SELECT p.id, p.name, p.notes, p.x, p.y, p.lat, p.lon, p.radio, p.event_id AS eventId, p.lead_id AS leadId, lu.display_name AS lead
      FROM posts p LEFT JOIN users lu ON lu.id = p.lead_id WHERE p.site_id = ? AND p.active = 1 AND (p.event_id IS NULL OR p.event_id = ?) ORDER BY p.name`).all(s.id, eventId || -1)
      .map((p) => ({ ...p, onNow: onNow(p.id) }));
    return {
      id: s.id, name: s.name, kind: s.kind, base: s.base, hasImage: !!s.image_file, imageW: s.image_w, imageH: s.image_h,
      lat: s.lat, lon: s.lon, zoom: s.zoom, calib,
      markers: db.prepare('SELECT id, type, label, x, y, lat, lon, notes FROM markers WHERE site_id = ? ORDER BY type, label').all(s.id),
      posts,
      photos: db.prepare('SELECT id, kind, caption, marker_id AS markerId, post_id AS postId, w, h FROM site_photos WHERE site_id = ? ORDER BY id').all(s.id),
    };
  }
  app.get('/api/sites', auth, (req, res) => {
    res.json(db.prepare('SELECT id, name, kind, base, lat, lon, zoom, image_file IS NOT NULL AS hasImage FROM sites WHERE active = 1 ORDER BY kind, name').all()
      .map((s) => ({ ...s, hasImage: !!s.hasImage, main: s.id === getCongregation().main_site_id })));
  });
  app.get('/api/sites/:id', auth, (req, res) => {
    const s = siteRow(+req.params.id);
    if (!s) return bad(res, 'not_found', 404);
    res.json(siteView(s, int(req.query.eventId)));
  });
  app.get('/api/sites/:id/image', auth, (req, res) => {
    const s = siteRow(+req.params.id);
    if (!s?.image_file) return bad(res, 'not_found', 404);
    sendJpeg(res, s.image_file);
  });
  function siteFields(b, existing = {}) {
    const f = {
      name: b.name === undefined ? existing.name : str(b.name, 80),
      kind: b.kind === undefined ? existing.kind : (['building', 'outdoor'].includes(b.kind) ? b.kind : null),
      base: b.base === undefined ? existing.base : (['image', 'osm'].includes(b.base) ? b.base : null),
      lat: b.lat === undefined ? existing.lat ?? null : (b.lat == null ? null : num(b.lat, -90, 90)),
      lon: b.lon === undefined ? existing.lon ?? null : (b.lon == null ? null : num(b.lon, -180, 180)),
      zoom: b.zoom === undefined ? existing.zoom ?? null : (b.zoom == null ? null : num(b.zoom, 1, 20)),
    };
    if (!f.name || !f.kind || !f.base) return null;
    return f;
  }
  app.post('/api/sites', auth, need('coordinator'), routineOnly, (req, res) => {
    const f = siteFields(req.body || {});
    if (!f) return bad(res, 'invalid_site');
    if (f.base === 'osm' && !osmEnabled()) return bad(res, 'street_maps_disabled');
    const info = db.prepare('INSERT INTO sites (name, kind, base, lat, lon, zoom, created_at) VALUES (?,?,?,?,?,?,?)').run(f.name, f.kind, f.base, f.lat, f.lon, f.zoom, now());
    audit(req.user.id, 'site_created', info.lastInsertRowid);
    res.json(siteView(siteRow(Number(info.lastInsertRowid))));
  });
  app.patch('/api/sites/:id', auth, need('coordinator'), routineOnly, (req, res) => {
    const s = siteRow(+req.params.id);
    if (!s) return bad(res, 'not_found', 404);
    const f = siteFields(req.body || {}, s);
    if (!f) return bad(res, 'invalid_site');
    if (f.base === 'osm' && s.base !== 'osm' && !osmEnabled()) return bad(res, 'street_maps_disabled');
    db.prepare('UPDATE sites SET name=?, kind=?, base=?, lat=?, lon=?, zoom=? WHERE id=?').run(f.name, f.kind, f.base, f.lat, f.lon, f.zoom, s.id);
    res.json(siteView(siteRow(s.id)));
  });
  app.delete('/api/sites/:id', auth, need('coordinator'), routineOnly, (req, res) => {
    if (+req.params.id === getCongregation().main_site_id) return bad(res, 'cannot_delete_main_site', 409);
    db.prepare('UPDATE sites SET active = 0 WHERE id = ?').run(+req.params.id);
    res.json({ ok: true });
  });
  // Floor plan / site map image (e.g. a photo of the posted evacuation map).
  app.post('/api/sites/:id/image', auth, need('coordinator'), routineOnly, upload('image', 10), (req, res) => {
    const s = siteRow(+req.params.id);
    if (!s) return bad(res, 'not_found', 404);
    const j = req.file && stripJpeg(req.file.buffer);
    if (!j || !j.w || !j.h) return bad(res, 'photo_must_be_jpeg');
    deletePhoto(s.image_file);
    db.prepare('UPDATE sites SET image_file = ?, image_w = ?, image_h = ?, calib = NULL WHERE id = ?').run(savePhoto(j.buf), j.w, j.h, s.id);
    audit(req.user.id, 'site_image', s.id);
    res.json(siteView(siteRow(s.id)));
  });
  // Two reference points (image pixel <-> GPS) let us place live GPS positions on an uploaded map.
  app.put('/api/sites/:id/calibration', auth, need('coordinator'), routineOnly, (req, res) => {
    const s = siteRow(+req.params.id);
    if (!s?.image_file) return bad(res, 'not_found', 404);
    const pts = Array.isArray(req.body?.points) ? req.body.points.slice(0, 2).map((p) => ({
      x: num(p?.x, 0, s.image_w), y: num(p?.y, 0, s.image_h), lat: num(p?.lat, -90, 90), lon: num(p?.lon, -180, 180),
    })) : [];
    if (pts.length !== 2 || pts.some((p) => Object.values(p).some((v) => v == null))) return bad(res, 'invalid_calibration');
    if (meters(pts[0], pts[1]) < 15 || Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) < 30) return bad(res, 'points_too_close');
    db.prepare('UPDATE sites SET calib = ? WHERE id = ?').run(encJSON('field', pts, `calib:${s.id}`), s.id);
    res.json(siteView(siteRow(s.id)));
  });

  // ---- pins ----
  function markerFields(b, existing = {}) {
    const f = {
      type: b.type === undefined ? existing.type : (MARKER_TYPES.includes(b.type) ? b.type : null),
      label: b.label === undefined ? existing.label : str(b.label, 60),
      notes: b.notes === undefined ? existing.notes ?? null : optStr(b.notes, 300),
      x: b.x === undefined ? existing.x ?? null : (b.x == null ? null : num(b.x, 0, 20000)),
      y: b.y === undefined ? existing.y ?? null : (b.y == null ? null : num(b.y, 0, 20000)),
      lat: b.lat === undefined ? existing.lat ?? null : (b.lat == null ? null : num(b.lat, -90, 90)),
      lon: b.lon === undefined ? existing.lon ?? null : (b.lon == null ? null : num(b.lon, -180, 180)),
    };
    if (!f.type || !f.label || ((f.x == null || f.y == null) && (f.lat == null || f.lon == null))) return null;
    return f;
  }
  app.post('/api/sites/:id/markers', auth, need('coordinator'), routineOnly, (req, res) => {
    const s = siteRow(+req.params.id);
    if (!s) return bad(res, 'not_found', 404);
    const f = markerFields(req.body || {});
    if (!f) return bad(res, 'invalid_marker');
    const info = db.prepare('INSERT INTO markers (site_id, type, label, notes, x, y, lat, lon) VALUES (?,?,?,?,?,?,?,?)').run(s.id, f.type, f.label, f.notes, f.x, f.y, f.lat, f.lon);
    res.json({ id: Number(info.lastInsertRowid), ...f });
  });
  app.patch('/api/markers/:id', auth, need('coordinator'), routineOnly, (req, res) => {
    const m = db.prepare('SELECT * FROM markers WHERE id = ?').get(+req.params.id);
    if (!m) return bad(res, 'not_found', 404);
    const f = markerFields(req.body || {}, m);
    if (!f) return bad(res, 'invalid_marker');
    db.prepare('UPDATE markers SET type=?, label=?, notes=?, x=?, y=?, lat=?, lon=? WHERE id=?').run(f.type, f.label, f.notes, f.x, f.y, f.lat, f.lon, m.id);
    res.json({ ok: true });
  });
  app.delete('/api/markers/:id', auth, need('coordinator'), routineOnly, (req, res) => {
    for (const p of db.prepare('SELECT file FROM site_photos WHERE marker_id = ?').all(+req.params.id)) deletePhoto(p.file);
    db.prepare('DELETE FROM markers WHERE id = ?').run(+req.params.id);
    res.json({ ok: true });
  });

  // ---- survey photos & panoramas ----
  app.post('/api/sites/:id/photos', auth, need('coordinator'), routineOnly, upload('photo', 10), (req, res) => {
    const s = siteRow(+req.params.id);
    if (!s) return bad(res, 'not_found', 404);
    const j = req.file && stripJpeg(req.file.buffer);
    if (!j) return bad(res, 'photo_must_be_jpeg');
    const markerId = req.body?.markerId ? int(req.body.markerId) : null, postId = req.body?.postId ? int(req.body.postId) : null;
    if (markerId && !db.prepare('SELECT 1 FROM markers WHERE id = ? AND site_id = ?').get(markerId, s.id)) return bad(res, 'invalid_reference');
    if (postId && !db.prepare('SELECT 1 FROM posts WHERE id = ? AND site_id = ?').get(postId, s.id)) return bad(res, 'invalid_reference');
    const kind = req.body?.kind === 'panorama' ? 'panorama' : 'photo';
    const info = db.prepare('INSERT INTO site_photos (site_id, marker_id, post_id, kind, caption, file, w, h, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(s.id, markerId, postId, kind, optStr(req.body?.caption, 120), savePhoto(j.buf), j.w, j.h, req.user.id, now());
    audit(req.user.id, 'site_photo_added', info.lastInsertRowid);
    res.json({ id: Number(info.lastInsertRowid), kind, w: j.w, h: j.h });
  });
  app.get('/api/photos/:id', auth, (req, res) => {
    const p = db.prepare('SELECT ph.file FROM site_photos ph JOIN sites s ON s.id = ph.site_id WHERE ph.id = ? AND s.active = 1').get(+req.params.id);
    if (!p) return bad(res, 'not_found', 404);
    sendJpeg(res, p.file);
  });
  app.delete('/api/photos/:id', auth, need('coordinator'), routineOnly, (req, res) => {
    const p = db.prepare('SELECT * FROM site_photos WHERE id = ?').get(+req.params.id);
    if (!p) return bad(res, 'not_found', 404);
    deletePhoto(p.file);
    db.prepare('DELETE FROM site_photos WHERE id = ?').run(p.id);
    res.json({ ok: true });
  });

  // ======================= EVENTS =======================
  const evRow = (id) => db.prepare('SELECT e.*, s.name AS site_name, lu.display_name AS lead_name FROM events e JOIN sites s ON s.id = e.site_id LEFT JOIN users lu ON lu.id = e.lead_id WHERE e.id = ?').get(id);
  function eventSummary(ev, me) {
    const members = eventMembers(ev.id);
    return {
      id: ev.id, name: ev.name, siteId: ev.site_id, site: ev.site_name, startsAt: ev.starts_at, endsAt: ev.ends_at,
      lead: ev.lead_name, leadId: ev.lead_id, positions: ev.positions, checkinMins: ev.checkin_mins, radio: ev.radio,
      cancelled: !!ev.cancelled, active: eventActive(ev), isMember: members.includes(me.id), isLead: isEventLead(ev, me), memberCount: members.length,
    };
  }
  function contactsFrom(v) {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 12).map((c) => ({ label: str(c?.label, 40), phone: str(c?.phone, 25) }))
      .filter((c) => c.label && c.phone && /^[0-9+()\-.\s]{3,25}$/.test(c.phone));
  }
  function eventFields(b, existing = {}) {
    const f = {
      name: b.name === undefined ? existing.name : str(b.name, 80),
      site_id: b.siteId === undefined ? existing.site_id : int(b.siteId),
      starts_at: b.startsAt === undefined ? existing.starts_at : isoOrNull(b.startsAt)?.toISOString(),
      ends_at: b.endsAt === undefined ? existing.ends_at : isoOrNull(b.endsAt)?.toISOString(),
      lead_id: b.leadId === undefined ? existing.lead_id ?? null : (b.leadId ? int(b.leadId) : null),
      positions: b.positions === undefined ? existing.positions ?? 'leads' : (['leads', 'team', 'off'].includes(b.positions) ? b.positions : null),
      checkin_mins: b.checkinMins === undefined ? existing.checkin_mins ?? 20 : num(b.checkinMins, 0, 240),
      radio: b.radio === undefined ? existing.radio ?? null : optStr(b.radio, 60),
    };
    if (!f.name || !f.site_id || !f.starts_at || !f.ends_at || !f.positions || f.checkin_mins == null) return null;
    if (f.ends_at <= f.starts_at || Date.parse(f.ends_at) - Date.parse(f.starts_at) > 4 * 86400000) return null;
    if (!db.prepare('SELECT 1 FROM sites WHERE id = ? AND active = 1').get(f.site_id)) return null;
    if (f.lead_id && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(f.lead_id)) return null;
    return f;
  }
  app.get('/api/events', auth, routineOnly, (req, res) => {
    const rows = db.prepare('SELECT e.*, s.name AS site_name, lu.display_name AS lead_name FROM events e JOIN sites s ON s.id = e.site_id LEFT JOIN users lu ON lu.id = e.lead_id WHERE e.cancelled = 0 AND e.ends_at > ? ORDER BY e.starts_at')
      .all(new Date(Date.now() - 86400000).toISOString());
    res.json(rows.map((ev) => eventSummary(ev, req.user)).filter((e) => isCoord(req.user) || e.isMember));
  });
  app.post('/api/events', auth, need('coordinator'), routineOnly, (req, res) => {
    const f = eventFields(req.body || {});
    if (!f) return bad(res, 'invalid_event');
    const info = db.prepare('INSERT INTO events (name, site_id, starts_at, ends_at, lead_id, positions, checkin_mins, radio, briefing, contacts, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(f.name, f.site_id, f.starts_at, f.ends_at, f.lead_id, f.positions, f.checkin_mins, f.radio, null, null, req.user.id, now());
    const id = Number(info.lastInsertRowid);
    db.prepare('UPDATE events SET briefing = ?, contacts = ? WHERE id = ?')
      .run(enc('field', Buffer.from(optStr(req.body?.briefing, 4000) || ''), `brief:${id}`), encJSON('field', contactsFrom(req.body?.contacts), `contacts:${id}`), id);
    audit(req.user.id, 'event_created', id);
    res.json(eventSummary(evRow(id), req.user));
  });
  app.put('/api/events/:id', auth, need('coordinator'), routineOnly, (req, res) => {
    const ev = evRow(+req.params.id);
    if (!ev) return bad(res, 'not_found', 404);
    const f = eventFields(req.body || {}, ev);
    if (!f) return bad(res, 'invalid_event');
    db.prepare('UPDATE events SET name=?, site_id=?, starts_at=?, ends_at=?, lead_id=?, positions=?, checkin_mins=?, radio=? WHERE id=?')
      .run(f.name, f.site_id, f.starts_at, f.ends_at, f.lead_id, f.positions, f.checkin_mins, f.radio, ev.id);
    if (req.body?.briefing !== undefined) db.prepare('UPDATE events SET briefing = ? WHERE id = ?').run(enc('field', Buffer.from(optStr(req.body.briefing, 4000) || ''), `brief:${ev.id}`), ev.id);
    if (req.body?.contacts !== undefined) db.prepare('UPDATE events SET contacts = ? WHERE id = ?').run(encJSON('field', contactsFrom(req.body.contacts), `contacts:${ev.id}`), ev.id);
    if (f.positions === 'off') db.prepare('DELETE FROM positions WHERE event_id = ?').run(ev.id);
    res.json(eventSummary(evRow(ev.id), req.user));
  });
  app.delete('/api/events/:id', auth, need('coordinator'), routineOnly, (req, res) => {
    db.prepare('UPDATE events SET cancelled = 1 WHERE id = ?').run(+req.params.id);
    db.prepare('DELETE FROM positions WHERE event_id = ?').run(+req.params.id);
    audit(req.user.id, 'event_cancelled', req.params.id);
    res.json({ ok: true });
  });
  const memberOrCoord = (req, res) => {
    const ev = evRow(+req.params.id);
    if (!ev || ev.cancelled || !(isCoord(req.user) || isMember(ev, req.user))) { bad(res, 'not_found', 404); return null; }
    return ev;
  };
  app.get('/api/events/:id', auth, routineOnly, (req, res) => {
    const ev = memberOrCoord(req, res); if (!ev) return;
    const me = db.prepare('SELECT acked_at, last_checkin, sharing FROM event_members WHERE event_id = ? AND user_id = ?').get(ev.id, req.user.id) || {};
    const zones = db.prepare(`SELECT p.id, p.name, p.notes, p.x, p.y, p.lat, p.lon, p.radio, p.lead_id AS leadId, lu.display_name AS lead FROM posts p LEFT JOIN users lu ON lu.id = p.lead_id
      WHERE p.event_id = ? AND p.active = 1 ORDER BY p.name`).all(ev.id).map((z) => ({
      ...z, assigned: db.prepare('SELECT s.id, s.user_id AS userId, u.display_name AS name, s.starts_at AS startsAt, s.ends_at AS endsAt FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.post_id = ? AND u.active = 1 ORDER BY s.starts_at').all(z.id),
    }));
    let briefing = '', contacts = [];
    try { briefing = ev.briefing ? dec('field', ev.briefing, `brief:${ev.id}`).toString('utf8') : ''; } catch { /* ignore */ }
    try { contacts = ev.contacts ? decJSON('field', ev.contacts, `contacts:${ev.id}`) : []; } catch { /* ignore */ }
    const ctx = currentContext(req.user.id);
    res.json({
      ...eventSummary(ev, req.user), briefing, contacts, zones,
      me: { acked: !!me.acked_at, lastCheckin: me.last_checkin || null, sharing: !!me.sharing, zoneId: ctx.eventId === ev.id ? ctx.postId : null },
      canSeePositions: canSeePositions(ev, req.user),
    });
  });
  app.post('/api/events/:id/ack', auth, routineOnly, (req, res) => {
    const ev = memberOrCoord(req, res); if (!ev) return;
    touch(ev.id, req.user.id, 'acked_at'); touch(ev.id, req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/events/:id/checkin', auth, routineOnly, (req, res) => {
    const ev = memberOrCoord(req, res); if (!ev) return;
    touch(ev.id, req.user.id);
    notify(eventLeads(ev), 'roster', { eventId: ev.id });
    res.json({ ok: true, at: now() });
  });
  app.post('/api/events/:id/sharing', auth, routineOnly, (req, res) => {
    const ev = memberOrCoord(req, res); if (!ev) return;
    if (ev.positions === 'off' && req.body?.on) return bad(res, 'positions_disabled', 409);
    db.prepare(`INSERT INTO event_members (event_id, user_id, sharing) VALUES (?,?,?) ON CONFLICT(event_id, user_id) DO UPDATE SET sharing = excluded.sharing`)
      .run(ev.id, req.user.id, req.body?.on ? 1 : 0);
    if (!req.body?.on) db.prepare('DELETE FROM positions WHERE event_id = ? AND user_id = ?').run(ev.id, req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/events/:id/position', auth, routineOnly, (req, res) => {
    const ev = memberOrCoord(req, res); if (!ev) return;
    if (ev.positions === 'off' || !eventActive(ev)) return bad(res, 'not_active', 409);
    const m = db.prepare('SELECT sharing FROM event_members WHERE event_id = ? AND user_id = ?').get(ev.id, req.user.id);
    if (!m?.sharing) return bad(res, 'sharing_off', 409);
    const lat = num(req.body?.lat, -90, 90), lon = num(req.body?.lon, -180, 180);
    if (lat == null || lon == null) return bad(res, 'invalid_location');
    const loc = { lat, lon, acc: num(req.body?.acc, 0, 1e5) };
    db.prepare(`INSERT INTO positions (event_id, user_id, loc, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(event_id, user_id) DO UPDATE SET loc = excluded.loc, updated_at = excluded.updated_at`).run(ev.id, req.user.id, encJSON('field', loc, `pos:${ev.id}:${req.user.id}`), now());
    touch(ev.id, req.user.id);
    const viewers = eventMembers(ev.id).concat(coordIds()).filter((uid) => uid !== req.user.id);
    notify([...new Set(viewers)], 'positions', { eventId: ev.id });
    res.json({ ok: true });
  });
  app.get('/api/events/:id/positions', auth, routineOnly, (req, res) => {
    const ev = memberOrCoord(req, res); if (!ev) return;
    const all = canSeePositions(ev, req.user);
    const rows = db.prepare(`SELECT p.user_id, p.loc, p.updated_at, u.display_name AS name FROM positions p JOIN users u ON u.id = p.user_id WHERE p.event_id = ?${all ? '' : ' AND p.user_id = ?'}`)
      .all(...(all ? [ev.id] : [ev.id, req.user.id]));
    res.json(rows.map((r) => {
      try {
        const ctx = currentContext(r.user_id);
        return { userId: r.user_id, name: r.name, ...decJSON('field', r.loc, `pos:${ev.id}:${r.user_id}`), updatedAt: r.updated_at, zone: ctx.eventId === ev.id ? ctx.postName : null };
      } catch { return null; }
    }).filter(Boolean));
  });
  app.get('/api/events/:id/roster', auth, routineOnly, (req, res) => {
    const ev = memberOrCoord(req, res); if (!ev) return;
    if (!isEventLead(ev, req.user)) return bad(res, 'forbidden', 403);
    const t = Date.now();
    res.json(eventMembers(ev.id).map((uid) => {
      const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid);
      const m = db.prepare('SELECT acked_at, last_checkin, sharing FROM event_members WHERE event_id = ? AND user_id = ?').get(ev.id, uid) || {};
      const pos = db.prepare('SELECT updated_at FROM positions WHERE event_id = ? AND user_id = ?').get(ev.id, uid);
      const last = [m.last_checkin, pos?.updated_at].filter(Boolean).sort().pop() || null;
      const ctx = currentContext(uid);
      const onDuty = ctx.eventId === ev.id;
      const overdue = eventActive(ev) && onDuty && ev.checkin_mins > 0 && (!last || t - Date.parse(last) > ev.checkin_mins * 60000);
      return { userId: uid, name: u?.display_name, zone: onDuty ? ctx.postName : null, onDuty, acked: !!m.acked_at, lastSeen: last, sharing: !!m.sharing, overdue, isLead: ev.lead_id === uid };
    }));
  });

  // ======================= QUICK MESSAGES =======================
  function msgView(m) {
    let text = null, loc = null;
    try { text = m.body ? dec('field', m.body, `msg:${m.id}`).toString('utf8') : null; } catch { /* ignore */ }
    try { loc = m.loc ? decJSON('field', m.loc, `msgloc:${m.id}`) : null; } catch { /* ignore */ }
    return { id: m.id, kind: m.kind, label: MSG_LABEL[m.kind], level: MSG_LEVEL[m.kind], text, loc, sender: m.sender, senderId: m.sender_id, post: m.post, eventId: m.event_id, createdAt: m.created_at };
  }
  const MSG_SQL = 'SELECT m.*, u.display_name AS sender, p.name AS post FROM messages m JOIN users u ON u.id = m.sender_id LEFT JOIN posts p ON p.id = m.post_id';
  app.post('/api/messages', auth, routineOnly, (req, res) => {
    const kind = req.body?.kind;
    if (!(kind in MSG_LEVEL)) return bad(res, 'invalid_kind');
    const text = optStr(req.body?.text, 500);
    if (kind === 'note' && !text) return bad(res, 'text_required');
    const ctx = currentContext(req.user.id);
    let eventId = req.body?.eventId ? int(req.body.eventId) : (ctx.eventId || null);
    let ev = null;
    if (eventId) {
      ev = evRow(eventId);
      if (!ev || ev.cancelled || !(isCoord(req.user) || isMember(ev, req.user))) return bad(res, 'not_found', 404);
    }
    const info = db.prepare('INSERT INTO messages (event_id, sender_id, kind, post_id, created_at) VALUES (?,?,?,?,?)')
      .run(eventId, req.user.id, kind, ctx.eventId === eventId ? ctx.postId : null, now());
    const id = Number(info.lastInsertRowid);
    if (text) db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(enc('field', Buffer.from(text), `msg:${id}`), id);
    const lat = num(req.body?.lat, -90, 90), lon = num(req.body?.lon, -180, 180);
    if (lat != null && lon != null) db.prepare('UPDATE messages SET loc = ? WHERE id = ?').run(encJSON('field', { lat, lon }, `msgloc:${id}`), id);
    if (ev) touch(ev.id, req.user.id);
    const m = msgView(db.prepare(`${MSG_SQL} WHERE m.id = ?`).get(id));
    // Audience: event team (+ coordinators), or the whole active team for building messages.
    const audience = [...new Set(ev ? eventMembers(ev.id).concat(coordIds()) : db.prepare('SELECT id FROM users WHERE active = 1').all().map((u) => u.id))];
    notify(audience, 'message', { id, kind, level: m.level, eventId });
    if (m.level >= 1) {
      // Push only for attention/urgent messages, and only to people actually working.
      const pushTo = (ev ? eventMembers(ev.id) : onDutyBuilding()).concat(coordIds()).filter((u) => u !== req.user.id);
      pushToUsers([...new Set(pushTo)], { type: 'message', id, title: `${m.label}${m.post ? ` — ${m.post}` : ''}`, body: `${req.user.name}${text ? `: ${text}` : ''}`, level: m.level }).catch(() => {});
    }
    res.json(m);
  });
  app.get('/api/messages', auth, routineOnly, (req, res) => {
    const eventId = int(req.query.eventId);
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    if (eventId) {
      const ev = evRow(eventId);
      if (!ev || !(isCoord(req.user) || isMember(ev, req.user))) return bad(res, 'not_found', 404);
      return res.json(db.prepare(`${MSG_SQL} WHERE m.event_id = ? ORDER BY m.id DESC LIMIT 80`).all(eventId).map(msgView));
    }
    res.json(db.prepare(`${MSG_SQL} WHERE m.event_id IS NULL AND m.created_at > ? ORDER BY m.id DESC LIMIT 60`).all(since).map(msgView));
  });

  // ======================= EMERGENCY CARD (available during the lock) =======================
  app.get('/api/emergency', auth, (req, res) => {
    const c = getCongregation();
    let procedures = '', contacts = [];
    try { procedures = c.procedures ? dec('field', c.procedures, 'procedures').toString('utf8') : ''; } catch { /* ignore */ }
    try { contacts = c.emergency_contacts ? decJSON('field', c.emergency_contacts, 'em-contacts') : []; } catch { /* ignore */ }
    const site = siteRow(c.main_site_id);
    res.json({
      name: c.name, address: c.address || '', script: c.emergency_script || '', procedures, contacts,
      mainSiteId: c.main_site_id, hasPlan: !!site?.image_file,
      pins: db.prepare(`SELECT id, type, label, notes FROM markers WHERE site_id = ? AND type IN (${SAFETY_TYPES.map(() => '?').join(',')}) ORDER BY type, label`).all(c.main_site_id, ...SAFETY_TYPES),
    });
  });
  app.put('/api/emergency', auth, need('admin'), routineOnly, (req, res) => {
    const b = req.body || {};
    db.prepare('UPDATE congregation SET address = ?, emergency_script = ?, procedures = ?, emergency_contacts = ? WHERE id = 1').run(
      optStr(b.address, 200), optStr(b.script, 600),
      enc('field', Buffer.from(optStr(b.procedures, 6000) || ''), 'procedures'),
      encJSON('field', contactsFrom(b.contacts), 'em-contacts'));
    audit(req.user.id, 'emergency_card_updated');
    res.json({ ok: true });
  });

  // ======================= PRE-SHABBAT READINESS =======================
  app.get('/api/readiness', auth, routineOnly, (req, res) => res.json(readiness(req.user)));
}

function coordIds() { return db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('coordinator','admin')").all().map((r) => r.id); }
function eventLeads(ev) {
  return [...new Set([ev.lead_id, ...db.prepare('SELECT lead_id FROM posts WHERE event_id = ? AND lead_id IS NOT NULL').all(ev.id).map((r) => r.lead_id), ...coordIds()].filter(Boolean))];
}
function onDutyBuilding() {
  const t = Date.now();
  return db.prepare(`SELECT DISTINCT s.user_id AS id FROM shifts s JOIN posts p ON p.id = s.post_id WHERE p.event_id IS NULL AND s.starts_at <= ? AND s.ends_at >= ?`).all(iso(t + GRACE), iso(t - GRACE)).map((r) => r.id);
}

function nextWindow() {
  const s = shabbatState();
  if (!s.mode) return null;
  const t = s.now;
  const w = s.windows.map((x) => ({ start: Date.parse(x.start), end: Date.parse(x.end), now: t })).find((x) => x.start > t);
  return w || null;
}
function readiness(user) {
  const w = nextWindow();
  if (!w) return { window: null };
  const shifts = db.prepare(`SELECT s.id, s.post_id, s.user_id, u.display_name AS person, s.starts_at, s.ends_at, s.confirmed_at FROM shifts s JOIN posts p ON p.id = s.post_id JOIN users u ON u.id = s.user_id
    WHERE p.event_id IS NULL AND p.active = 1 AND u.active = 1 AND s.starts_at < ? AND s.ends_at > ? ORDER BY s.starts_at`).all(iso(w.end), iso(w.start));
  const posts = db.prepare('SELECT id, name FROM posts WHERE active = 1 AND event_id IS NULL ORDER BY name').all().map((p) => ({
    ...p, shifts: shifts.filter((s) => s.post_id === p.id).map((s) => ({ id: s.id, person: s.person, startsAt: s.starts_at, endsAt: s.ends_at, confirmed: !!s.confirmed_at, mine: s.user_id === user.id })),
  }));
  const mine = shifts.filter((s) => s.user_id === user.id).map((s) => ({ id: s.id, post: posts.find((p) => p.id === s.post_id)?.name, startsAt: s.starts_at, endsAt: s.ends_at, confirmed: !!s.confirmed_at }));
  const base = { window: { start: iso(w.start), end: iso(w.end) }, mine };
  if (!isCoord(user)) return base;
  return { ...base, posts, gaps: posts.filter((p) => !p.shifts.length).map((p) => p.name), unconfirmed: shifts.filter((s) => !s.confirmed_at).length };
}

// Reminder ~1 day before each lock: guards confirm their shifts; coordinators hear about gaps.
export function sendReadinessReminders() {
  const w = nextWindow();
  if (!w) return;
  const lead = w.start - w.now;
  if (lead <= 0 || lead > 30 * 3600000) return;
  const key = `ready:${w.start}`;
  if (db.prepare('SELECT 1 FROM reminders WHERE key = ?').get(key)) return;
  db.prepare('INSERT INTO reminders (key, sent_at) VALUES (?,?)').run(key, now());
  const shifts = db.prepare(`SELECT DISTINCT s.user_id FROM shifts s JOIN posts p ON p.id = s.post_id WHERE p.event_id IS NULL AND p.active = 1 AND s.confirmed_at IS NULL AND s.starts_at < ? AND s.ends_at > ?`).all(iso(w.end), iso(w.start));
  pushToUsers(shifts.map((s) => s.user_id), { type: 'readiness', title: 'Please confirm your shift', body: 'Open Mishmar to confirm your upcoming Shabbat/Yom Tov shift.' }).catch(() => {});
  const gaps = db.prepare(`SELECT COUNT(*) c FROM posts p WHERE p.active = 1 AND p.event_id IS NULL AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.post_id = p.id AND s.starts_at < ? AND s.ends_at > ?)`).get(iso(w.end), iso(w.start)).c;
  if (gaps) pushToUsers(coordIds(), { type: 'readiness', title: `${gaps} post${gaps === 1 ? '' : 's'} uncovered`, body: 'The schedule locks soon. Open Mishmar to fill the gaps.' }).catch(() => {});
  audit(null, 'readiness_reminder', key);
}
export function startReminders() {
  sendReadinessReminders();
  setInterval(sendReadinessReminders, +process.env.MISHMAR_REMINDER_MS || 30 * 60000).unref();
}

export function purgeOps() {
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  // Live positions disappear as soon as the event ends (or is cancelled).
  db.prepare('DELETE FROM positions WHERE event_id IN (SELECT id FROM events WHERE cancelled = 1 OR ends_at < ?)').run(new Date(Date.now() - 3600000).toISOString());
  db.prepare('UPDATE event_members SET sharing = 0 WHERE sharing = 1 AND event_id IN (SELECT id FROM events WHERE cancelled = 1 OR ends_at < ?)').run(new Date(Date.now() - 3600000).toISOString());
  db.prepare('DELETE FROM messages WHERE event_id IS NULL AND created_at < ?').run(ago(7));
  db.prepare('DELETE FROM messages WHERE event_id IN (SELECT id FROM events WHERE ends_at < ?)').run(ago(7));
  db.prepare('DELETE FROM event_members WHERE event_id IN (SELECT id FROM events WHERE ends_at < ?)').run(ago(30));
}
