import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, audit, DATA_DIR } from './db.js';
import { initKeys, enc, dec, encJSON, decJSON, hashPassword, verifyPassword, DUMMY_HASH, newToken, sha256, newInviteCode, newTotpSecret, verifyTotp } from './crypto.js';
import { shabbatState, routineOnly, getCongregation, invalidateShabbatCache } from './shabbat.js';
import { initPush, vapidPublicKey, saveSubscription, removeSubscription, addStream, notify, heartbeat, reachability } from './push.js';
import {
  RANK, SESSION_DAYS, bad, str, optStr, isoOrNull, num, int, parseCookies, auth, need, isCoord, limited,
  stripJpeg, upload, savePhoto, deletePhoto, sendJpeg, meters,
} from './http.js';
import { registerOps, currentContext, eventMembers, canSeePositions, osmEnabled, TILE_URL, TILE_ORIGIN, purgeOps, startReminders } from './ops.js';

initKeys(DATA_DIR);
initPush();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECURE_COOKIES = process.env.MISHMAR_INSECURE_COOKIES !== '1';
const ESCALATE_SECS = +process.env.MISHMAR_ESCALATE_SECS || 60;
const RETENTION = { alertDays: 90, alertLocationDays: 14, incidentDays: 365, auditDays: 400 };
export const ALERT_KINDS = ['help', 'medical', 'threat', 'suspicious', 'backup', 'fire', 'lost_child'];

export const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      // Map tiles are the only third-party request, and only while an admin has street maps enabled.
      imgSrc: ["'self'", 'blob:', 'data:', () => (osmEnabled() ? TILE_ORIGIN : "'self'")],
      connectSrc: ["'self'"], workerSrc: ["'self'"], manifestSrc: ["'self'"], objectSrc: ["'none'"],
      frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
      upgradeInsecureRequests: SECURE_COOKIES ? [] : null,
    },
  },
  strictTransportSecurity: SECURE_COOKIES,
  crossOriginEmbedderPolicy: false,
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(), payment=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '32kb' }));

function setSession(res, token) {
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIES ? '; Secure' : ''}`);
}
const clearSession = (res) => res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${SECURE_COOKIES ? '; Secure' : ''}`);
function startSession(res, userId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha256(token), userId, now(), new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
  setSession(res, token);
}

// CSRF: SameSite=Strict cookies plus a required custom header on every write.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'mishmar') return bad(res, 'csrf', 403);
  next();
});

// ---------- auth ----------
const publicUser = (u) => ({ id: u.id, login: u.login, name: u.name ?? u.display_name, role: u.role });

app.post('/api/auth/login', async (req, res) => {
  if (limited(`login:${req.ip}`, 20, 15 * 60000)) return bad(res, 'too_many_attempts', 429);
  const login = str(req.body?.login, 64), pw = str(req.body?.password, 200);
  if (!login || !pw) return bad(res, 'invalid_credentials', 401);
  const u = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
  const lockedOut = u?.locked_until && u.locked_until > now();
  const ok = await verifyPassword(pw, u?.pw_hash || DUMMY_HASH);
  if (!u || !u.active || lockedOut || !ok) {
    if (u && !ok) {
      const failed = u.failed + 1;
      db.prepare('UPDATE users SET failed = ?, locked_until = ? WHERE id = ?')
        .run(failed >= 5 ? 0 : failed, failed >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : u.locked_until, u.id);
      audit(u.id, 'login_failed');
    }
    return bad(res, 'invalid_credentials', 401);
  }
  // Second factor, only asked for after the password is right.
  if (u.totp_secret) {
    const secret = dec('field', u.totp_secret, `totp:${u.id}`).toString('utf8');
    if (!req.body?.totp) return bad(res, 'totp_required', 401);
    const step = verifyTotp(secret, String(req.body.totp).replace(/\s/g, ''), u.totp_last ?? -1);
    if (step == null) {
      const failed = u.failed + 1;
      db.prepare('UPDATE users SET failed = ?, locked_until = ? WHERE id = ?')
        .run(failed >= 5 ? 0 : failed, failed >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : u.locked_until, u.id);
      audit(u.id, 'totp_failed');
      return bad(res, 'invalid_totp', 401);
    }
    db.prepare('UPDATE users SET totp_last = ? WHERE id = ?').run(step, u.id);
  }
  db.prepare('UPDATE users SET failed = 0, locked_until = NULL WHERE id = ?').run(u.id);
  startSession(res, u.id);
  audit(u.id, 'login');
  res.json({ user: publicUser(u) });
});

// Account recovery: a coordinator/admin issues a one-time reset code; the member
// uses it with their login to set a new password. It also clears two-factor, so
// a lost phone can be recovered the same way. All other sessions are revoked.
app.post('/api/auth/reset', async (req, res) => {
  if (limited(`reset:${req.ip}`, 10, 15 * 60000)) return bad(res, 'too_many_attempts', 429);
  const code = str(req.body?.code, 32)?.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{5})(.{5})$/, '$1-$2');
  const login = str(req.body?.login, 64), pw = str(req.body?.password, 200);
  if (!code || !login || !pw) return bad(res, 'missing_fields');
  if (pw.length < 10) return bad(res, 'password_too_short');
  const r = db.prepare('SELECT r.*, u.login FROM resets r JOIN users u ON u.id = r.user_id WHERE r.code_hash = ?').get(sha256(code));
  if (!r || r.used_at || r.expires_at < now() || r.login.toLowerCase() !== login.toLowerCase()) return bad(res, 'invalid_reset', 400);
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(r.user_id);
  if (!u) return bad(res, 'invalid_reset', 400);
  db.prepare('UPDATE users SET pw_hash = ?, failed = 0, locked_until = NULL, totp_secret = NULL, totp_pending = NULL, totp_last = NULL WHERE id = ?').run(await hashPassword(pw), u.id);
  db.prepare('UPDATE resets SET used_at = ? WHERE code_hash = ?').run(now(), r.code_hash);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  audit(u.id, 'password_reset_with_code', r.created_by);
  startSession(res, u.id);
  res.json({ user: publicUser(u) });
});

app.post('/api/auth/redeem', async (req, res) => {
  if (limited(`redeem:${req.ip}`, 10, 15 * 60000)) return bad(res, 'too_many_attempts', 429);
  const code = str(req.body?.code, 32)?.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{5})(.{5})$/, '$1-$2');
  const login = str(req.body?.login, 64), name = str(req.body?.name, 60), pw = str(req.body?.password, 200);
  if (!code || !login || !name || !pw) return bad(res, 'missing_fields');
  if (!/^[a-z0-9._-]{3,64}$/i.test(login)) return bad(res, 'login_format');
  if (pw.length < 10) return bad(res, 'password_too_short');
  const inv = db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(sha256(code));
  if (!inv || inv.used_at || inv.expires_at < now()) return bad(res, 'invalid_invite', 400);
  if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) return bad(res, 'login_taken', 409);
  const info = db.prepare('INSERT INTO users (login, display_name, role, pw_hash, created_at) VALUES (?,?,?,?,?)')
    .run(login, name, inv.role, await hashPassword(pw), now());
  db.prepare('UPDATE invites SET used_at = ?, code_enc = NULL WHERE code_hash = ?').run(now(), inv.code_hash);
  audit(info.lastInsertRowid, 'redeem_invite', inv.role);
  startSession(res, info.lastInsertRowid);
  res.json({ user: { id: Number(info.lastInsertRowid), login, name, role: inv.role } });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(parseCookies(req).sid));
  clearSession(res);
  res.json({ ok: true });
});

// AGPL section 13: every user can get the source of the version they're using.
const SOURCE_URL = process.env.MISHMAR_SOURCE_URL || 'https://github.com/generalwax2018/mishmar';
app.get('/source', (req, res) => res.redirect(302, SOURCE_URL));

app.get('/api/me', auth, (req, res) => {
  const c = getCongregation();
  res.json({
    user: req.user, congregation: c.name, vapidPublicKey: vapidPublicKey(),
    totp: !!db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id).totp_secret,
    mainSiteId: c.main_site_id, osmEnabled: !!c.osm_enabled, tileUrl: TILE_URL,
  });
});

app.post('/api/me/password', auth, routineOnly, async (req, res) => {
  const cur = str(req.body?.current, 200), next = str(req.body?.next, 200);
  if (!cur || !next || next.length < 10) return bad(res, 'password_too_short');
  const u = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(cur, u.pw_hash))) return bad(res, 'invalid_credentials', 403);
  db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(await hashPassword(next), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, sha256(parseCookies(req).sid));
  audit(req.user.id, 'password_changed');
  res.json({ ok: true });
});

// ---- two-factor (authenticator app) ----
app.post('/api/me/totp/start', auth, routineOnly, (req, res) => {
  const secret = newTotpSecret();
  db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(enc('field', Buffer.from(secret), `totp-pending:${req.user.id}`), req.user.id);
  const label = encodeURIComponent(`Mishmar:${req.user.login}`);
  res.json({ secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Mishmar&algorithm=SHA1&digits=6&period=30` });
});
app.post('/api/me/totp/confirm', auth, routineOnly, (req, res) => {
  const u = db.prepare('SELECT totp_pending FROM users WHERE id = ?').get(req.user.id);
  if (!u.totp_pending) return bad(res, 'no_pending_setup');
  const secret = dec('field', u.totp_pending, `totp-pending:${req.user.id}`).toString('utf8');
  const step = verifyTotp(secret, String(req.body?.code || '').replace(/\s/g, ''));
  if (step == null) return bad(res, 'invalid_totp');
  db.prepare('UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_last = ? WHERE id = ?')
    .run(enc('field', Buffer.from(secret), `totp:${req.user.id}`), step, req.user.id);
  audit(req.user.id, 'totp_enabled');
  res.json({ ok: true });
});
app.post('/api/me/totp/disable', auth, routineOnly, async (req, res) => {
  const u = db.prepare('SELECT pw_hash, totp_secret, totp_last FROM users WHERE id = ?').get(req.user.id);
  if (!u.totp_secret) return res.json({ ok: true });
  if (!(await verifyPassword(String(req.body?.password || ''), u.pw_hash))) return bad(res, 'invalid_credentials', 403);
  const secret = dec('field', u.totp_secret, `totp:${req.user.id}`).toString('utf8');
  if (verifyTotp(secret, String(req.body?.code || '').replace(/\s/g, ''), u.totp_last ?? -1) == null) return bad(res, 'invalid_totp', 403);
  db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last = NULL WHERE id = ?').run(req.user.id);
  audit(req.user.id, 'totp_disabled');
  res.json({ ok: true });
});

// Push registration is life-safety plumbing: allowed during the observance lock.
app.post('/api/push/subscribe', auth, (req, res) => {
  const s = req.body?.subscription;
  if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth || String(s.endpoint).length > 1000) return bad(res, 'invalid_subscription');
  saveSubscription(req.user.id, { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth, (req, res) => {
  if (typeof req.body?.endpoint === 'string') removeSubscription(req.user.id, req.body.endpoint);
  res.json({ ok: true });
});

// ---------- observance lock settings ----------
app.get('/api/shabbat', auth, (req, res) => res.json(shabbatState()));

app.get('/api/congregation', auth, need('admin'), routineOnly, (req, res) => {
  const c = getCongregation();
  res.json({ name: c.name, lat: c.lat, lon: c.lon, tzid: c.tzid, il: !!c.il, candleMins: c.candle_mins, havdalahMins: c.havdalah_mins, shabbatMode: !!c.shabbat_mode, osmEnabled: !!c.osm_enabled });
});
app.put('/api/congregation', auth, need('admin'), routineOnly, (req, res) => {
  const b = req.body || {};
  const c0 = getCongregation();
  const name = str(b.name, 80);
  const lat = b.lat == null ? null : num(b.lat, -90, 90), lon = b.lon == null ? null : num(b.lon, -180, 180);
  const tzid = str(b.tzid, 64);
  const candle = num(b.candleMins, 0, 60);
  const hav = b.havdalahMins == null ? null : num(b.havdalahMins, 20, 120);
  if (!name || !tzid || candle == null || (b.lat != null && lat == null) || (b.lon != null && lon == null) || (b.havdalahMins != null && hav == null)) return bad(res, 'invalid_settings');
  try { new Intl.DateTimeFormat('en', { timeZone: tzid }); } catch { return bad(res, 'invalid_timezone'); }
  if (b.shabbatMode && (lat == null || lon == null)) return bad(res, 'location_required');
  const osm = b.osmEnabled === undefined ? c0.osm_enabled : (b.osmEnabled ? 1 : 0);
  db.prepare('UPDATE congregation SET name=?, lat=?, lon=?, tzid=?, il=?, candle_mins=?, havdalah_mins=?, shabbat_mode=?, osm_enabled=? WHERE id=1')
    .run(name, lat, lon, tzid, b.il ? 1 : 0, Math.round(candle), hav == null ? null : Math.round(hav), b.shabbatMode ? 1 : 0, osm);
  invalidateShabbatCache();
  audit(req.user.id, 'settings_updated', `${b.shabbatMode ? 'lock_on' : 'lock_off'}:osm_${osm}`);
  const state = shabbatState();
  notify(db.prepare('SELECT id FROM users WHERE active = 1').all().map((u) => u.id), 'shabbat', state);
  res.json(state);
});

// ---------- team & invites ----------
app.get('/api/team', auth, need('coordinator'), routineOnly, (req, res) => {
  res.json(db.prepare('SELECT id, login, display_name AS name, role, active FROM users ORDER BY active DESC, display_name').all());
});
app.post('/api/invites', auth, need('coordinator'), routineOnly, (req, res) => {
  const role = ['guard', 'coordinator', 'admin'].includes(req.body?.role) ? req.body.role : 'guard';
  if (role !== 'guard' && req.user.role !== 'admin') return bad(res, 'forbidden', 403);
  const label = optStr(req.body?.label, 60);
  const code = newInviteCode(), hash = sha256(code);
  const expires = new Date(Date.now() + 48 * 3600000).toISOString();
  // The code is also kept encrypted so a leader can show it again until it's used or expires.
  db.prepare('INSERT INTO invites (code_hash, role, expires_at, created_by, label, code_enc) VALUES (?,?,?,?,?,?)')
    .run(hash, role, expires, req.user.id, label, enc('field', Buffer.from(code), `invite:${hash}`));
  audit(req.user.id, 'invite_created', role);
  const id = db.prepare('SELECT rowid AS id FROM invites WHERE code_hash = ?').get(hash).id;
  res.json({ id, code, role, label, expires });
});
// Invites still waiting to be used. Coordinators see guard invites; admins see all.
app.get('/api/invites', auth, need('coordinator'), routineOnly, (req, res) => {
  const rows = db.prepare(`SELECT i.rowid AS id, i.code_hash, i.role, i.label, i.expires_at, i.code_enc, u.display_name AS by
    FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.used_at IS NULL AND i.expires_at > ? ORDER BY i.expires_at`).all(now());
  res.json(rows.filter((r) => req.user.role === 'admin' || r.role === 'guard').map((r) => {
    let code = null;
    try { code = r.code_enc ? dec('field', r.code_enc, `invite:${r.code_hash}`).toString('utf8') : null; } catch { /* ignore */ }
    return { id: r.id, role: r.role, label: r.label, expires: r.expires_at, by: r.by || 'Server', code };
  }));
});
app.delete('/api/invites/:id', auth, need('coordinator'), routineOnly, (req, res) => {
  const r = db.prepare('SELECT rowid AS id, role FROM invites WHERE rowid = ? AND used_at IS NULL').get(+req.params.id);
  if (!r || (req.user.role !== 'admin' && r.role !== 'guard')) return bad(res, 'not_found', 404);
  db.prepare('DELETE FROM invites WHERE rowid = ?').run(r.id);
  audit(req.user.id, 'invite_cancelled', r.id);
  res.json({ ok: true });
});
// Coordinators can reset guards; admins can reset anyone except themselves.
app.post('/api/team/:id/reset', auth, need('coordinator'), routineOnly, (req, res) => {
  const u = db.prepare('SELECT id, role, display_name FROM users WHERE id = ? AND active = 1').get(+req.params.id);
  if (!u) return bad(res, 'not_found', 404);
  if (u.id === req.user.id) return bad(res, 'use_change_password', 400);
  if (req.user.role !== 'admin' && u.role !== 'guard') return bad(res, 'forbidden', 403);
  const code = newInviteCode();
  const expires = new Date(Date.now() + 24 * 3600000).toISOString();
  db.prepare('DELETE FROM resets WHERE user_id = ? AND used_at IS NULL').run(u.id);   // only the newest code works
  db.prepare('INSERT INTO resets (code_hash, user_id, expires_at, created_by) VALUES (?,?,?,?)').run(sha256(code), u.id, expires, req.user.id);
  audit(req.user.id, 'reset_code_issued', u.id);
  res.json({ code, expires, name: u.display_name });
});
app.patch('/api/team/:id', auth, need('admin'), routineOnly, (req, res) => {
  const id = +req.params.id;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return bad(res, 'not_found', 404);
  const role = req.body?.role ?? u.role, active = req.body?.active === undefined ? u.active : (req.body.active ? 1 : 0);
  if (!RANK[role]) return bad(res, 'invalid_role');
  const otherAdmins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1 AND id != ?").get(id).c;
  if (u.role === 'admin' && (role !== 'admin' || !active) && otherAdmins === 0) return bad(res, 'last_admin', 409);
  db.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(role, active, id);
  if (!active) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM push_subs WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM shifts WHERE user_id = ? AND starts_at > ?').run(id, now());
    db.prepare('DELETE FROM positions WHERE user_id = ?').run(id);
  }
  audit(req.user.id, 'user_updated', `${id}:${role}:${active}`);
  res.json({ ok: true });
});

// ---------- posts (building posts and event zones) & shifts ----------
const POST_COLS = 'p.id, p.name, p.notes, p.site_id AS siteId, p.event_id AS eventId, p.x, p.y, p.lat, p.lon, p.radio, p.lead_id AS leadId, lu.display_name AS lead';
app.get('/api/posts', auth, routineOnly, (req, res) => {
  const eventId = int(req.query.eventId);
  const rows = eventId
    ? db.prepare(`SELECT ${POST_COLS} FROM posts p LEFT JOIN users lu ON lu.id = p.lead_id WHERE p.active = 1 AND p.event_id = ? ORDER BY p.name`).all(eventId)
    : db.prepare(`SELECT ${POST_COLS} FROM posts p LEFT JOIN users lu ON lu.id = p.lead_id WHERE p.active = 1 AND p.event_id IS NULL ORDER BY p.name`).all();
  res.json(rows);
});
function postFields(b, existing = {}) {
  const f = {
    name: b.name === undefined ? existing.name : str(b.name, 60),
    notes: b.notes === undefined ? existing.notes ?? null : optStr(b.notes, 300),
    radio: b.radio === undefined ? existing.radio ?? null : optStr(b.radio, 40),
    lead_id: b.leadId === undefined ? existing.lead_id ?? null : (b.leadId ? int(b.leadId) : null),
    x: b.x === undefined ? existing.x ?? null : (b.x == null ? null : num(b.x, 0, 20000)),
    y: b.y === undefined ? existing.y ?? null : (b.y == null ? null : num(b.y, 0, 20000)),
    lat: b.lat === undefined ? existing.lat ?? null : (b.lat == null ? null : num(b.lat, -90, 90)),
    lon: b.lon === undefined ? existing.lon ?? null : (b.lon == null ? null : num(b.lon, -180, 180)),
  };
  if (!f.name) return null;
  if (f.lead_id && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(f.lead_id)) return null;
  return f;
}
app.post('/api/posts', auth, need('coordinator'), routineOnly, (req, res) => {
  const f = postFields(req.body || {});
  if (!f) return bad(res, 'invalid_post');
  let siteId = getCongregation().main_site_id, eventId = null;
  if (req.body?.eventId) {
    const ev = db.prepare('SELECT * FROM events WHERE id = ? AND cancelled = 0').get(int(req.body.eventId));
    if (!ev) return bad(res, 'invalid_reference');
    eventId = ev.id; siteId = ev.site_id;
  } else if (req.body?.siteId) {
    if (!db.prepare('SELECT 1 FROM sites WHERE id = ? AND active = 1').get(int(req.body.siteId))) return bad(res, 'invalid_reference');
    siteId = int(req.body.siteId);
  }
  const info = db.prepare('INSERT INTO posts (name, notes, site_id, event_id, x, y, lat, lon, radio, lead_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(f.name, f.notes, siteId, eventId, f.x, f.y, f.lat, f.lon, f.radio, f.lead_id);
  audit(req.user.id, 'post_created', info.lastInsertRowid);
  res.json({ id: Number(info.lastInsertRowid), ...f, siteId, eventId });
});
app.patch('/api/posts/:id', auth, need('coordinator'), routineOnly, (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ? AND active = 1').get(+req.params.id);
  if (!p) return bad(res, 'not_found', 404);
  const f = postFields(req.body || {}, p);
  if (!f) return bad(res, 'invalid_post');
  db.prepare('UPDATE posts SET name=?, notes=?, x=?, y=?, lat=?, lon=?, radio=?, lead_id=? WHERE id=?').run(f.name, f.notes, f.x, f.y, f.lat, f.lon, f.radio, f.lead_id, p.id);
  res.json({ ok: true });
});
app.delete('/api/posts/:id', auth, need('coordinator'), routineOnly, (req, res) => {
  db.prepare('UPDATE posts SET active = 0 WHERE id = ?').run(+req.params.id);
  db.prepare('DELETE FROM shifts WHERE post_id = ? AND starts_at > ?').run(+req.params.id, now());
  res.json({ ok: true });
});

app.get('/api/shifts', auth, routineOnly, (req, res) => {
  const from = isoOrNull(req.query.from) || new Date(Date.now() - 86400000);
  const to = isoOrNull(req.query.to) || new Date(Date.now() + 14 * 86400000);
  if (to - from > 62 * 86400000) return bad(res, 'range_too_large');
  const rows = db.prepare(`SELECT s.id, s.post_id, p.name AS post, p.radio, s.user_id, u.display_name AS person, s.starts_at, s.ends_at, s.confirmed_at,
      p.event_id, e.name AS event
    FROM shifts s JOIN posts p ON p.id = s.post_id JOIN users u ON u.id = s.user_id LEFT JOIN events e ON e.id = p.event_id
    WHERE s.ends_at > ? AND s.starts_at < ? AND u.active = 1 AND (e.id IS NULL OR e.cancelled = 0) ORDER BY s.starts_at, p.name`).all(from.toISOString(), to.toISOString());
  res.json(rows.map((r) => ({ ...r, mine: r.user_id === req.user.id })));
});
app.post('/api/shifts', auth, need('coordinator'), routineOnly, (req, res) => {
  const b = req.body || {};
  const s = isoOrNull(b.startsAt), e = isoOrNull(b.endsAt);
  if (!s || !e || e <= s || e - s > 48 * 3600000) return bad(res, 'invalid_times');
  const post = db.prepare('SELECT id FROM posts WHERE id = ? AND active = 1').get(+b.postId);
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(+b.userId);
  if (!post || !user) return bad(res, 'invalid_reference');
  const clash = db.prepare('SELECT 1 FROM shifts WHERE user_id = ? AND starts_at < ? AND ends_at > ?').get(user.id, e.toISOString(), s.toISOString());
  if (clash) return bad(res, 'overlap', 409);
  const info = db.prepare('INSERT INTO shifts (post_id, user_id, starts_at, ends_at) VALUES (?,?,?,?)').run(post.id, user.id, s.toISOString(), e.toISOString());
  audit(req.user.id, 'shift_created', info.lastInsertRowid);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.post('/api/shifts/:id/confirm', auth, routineOnly, (req, res) => {
  const r = db.prepare('UPDATE shifts SET confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ? AND user_id = ?').run(now(), +req.params.id, req.user.id);
  if (!r.changes) return bad(res, 'not_found', 404);
  res.json({ ok: true });
});
app.delete('/api/shifts/:id', auth, need('coordinator'), routineOnly, (req, res) => {
  db.prepare('DELETE FROM shifts WHERE id = ?').run(+req.params.id);
  audit(req.user.id, 'shift_deleted', req.params.id);
  res.json({ ok: true });
});

// ---------- life-safety alerts (never locked) ----------
function recipientsFor(senderId, ctx) {
  let ids;
  if (ctx.eventId) {
    ids = eventMembers(ctx.eventId).filter((id) => id !== senderId);
  } else {
    const lo = new Date(Date.now() - 15 * 60000).toISOString(), hi = new Date(Date.now() + 15 * 60000).toISOString();
    ids = db.prepare(`SELECT DISTINCT s.user_id AS id FROM shifts s JOIN posts p ON p.id = s.post_id JOIN users u ON u.id = s.user_id
      WHERE u.active = 1 AND p.event_id IS NULL AND s.user_id != ? AND s.starts_at <= ? AND s.ends_at >= ?`).all(senderId, hi, lo).map((r) => r.id);
  }
  // Nobody scheduled (or only the sender): fall back to the whole active team.
  if (!ids.length) ids = db.prepare('SELECT id FROM users WHERE active = 1 AND id != ?').all(senderId).map((r) => r.id);
  return ids;
}
const locAad = (id) => `alert-loc:${id}`;
const ALERT_SQL = `SELECT a.*, u.display_name AS sender_name, p.name AS post_name, p.site_id AS post_site, p.x AS post_x, p.y AS post_y, p.lat AS post_lat, p.lon AS post_lon,
  e.name AS event_name FROM alerts a JOIN users u ON u.id = a.sender_id LEFT JOIN posts p ON p.id = a.post_id LEFT JOIN events e ON e.id = a.event_id`;

function alertView(a, me) {
  const rec = db.prepare('SELECT r.user_id, r.acked_at, u.display_name AS name FROM alert_recipients r JOIN users u ON u.id = r.user_id WHERE r.alert_id = ?').all(a.id);
  let loc = null;
  if (a.loc) { try { loc = decJSON('field', a.loc, locAad(a.id)); } catch { /* omit */ } }
  let nearest = null;
  if (loc && a.event_id) {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(a.event_id);
    if (ev && canSeePositions(ev, me)) {
      nearest = db.prepare('SELECT p.user_id, p.loc, u.display_name AS name FROM positions p JOIN users u ON u.id = p.user_id WHERE p.event_id = ? AND p.user_id != ?').all(a.event_id, a.sender_id)
        .map((p) => { try { const l = decJSON('field', p.loc, `pos:${a.event_id}:${p.user_id}`); return { name: p.user_id === me.id ? 'you' : p.name, m: Math.round(meters(loc, l)) }; } catch { return null; } })
        .filter(Boolean).sort((x, y) => x.m - y.m).slice(0, 3);
    }
  }
  return {
    id: a.id, kind: a.kind, sender: a.sender_name, senderId: a.sender_id, createdAt: a.created_at, status: a.status, outcome: a.outcome,
    escalated: !!a.escalated_at, loc, nearest, mine: a.sender_id === me.id,
    post: a.post_id ? { id: a.post_id, name: a.post_name, siteId: a.post_site, x: a.post_x, y: a.post_y, lat: a.post_lat, lon: a.post_lon } : null,
    event: a.event_id ? { id: a.event_id, name: a.event_name } : null,
    drill: !!a.drill,
    firstAckSecs: (() => { const t = rec.filter((r) => r.acked_at).map((r) => Date.parse(r.acked_at)).sort()[0]; return t ? Math.round((t - Date.parse(a.created_at)) / 1000) : null; })(),
    recipients: rec.length, acked: rec.filter((r) => r.acked_at).map((r) => r.name),
    iAcked: rec.some((r) => r.user_id === me.id && r.acked_at),
  };
}
function loadAlertFor(id, me) {
  const a = db.prepare(`${ALERT_SQL} WHERE a.id = ?`).get(id);
  if (!a) return null;
  const allowed = a.sender_id === me.id || isCoord(me) || db.prepare('SELECT 1 FROM alert_recipients WHERE alert_id = ? AND user_id = ?').get(id, me.id);
  return allowed ? a : null;
}
const audienceOf = (a) => [a.sender_id, ...db.prepare('SELECT user_id FROM alert_recipients WHERE alert_id = ?').all(a.id).map((r) => r.user_id)];
const KIND_LABEL = { help: 'Needs help', medical: 'Medical', threat: 'Threat / lockdown', suspicious: 'Suspicious person', backup: 'Needs backup', fire: 'Fire / evacuate', lost_child: 'Lost child' };
const pushBody = (a) => `${a.drill ? 'DRILL \u2014 ' : ''}${a.sender_name || 'A teammate'}${a.post_name ? ` @ ${a.post_name}` : ''}: ${KIND_LABEL[a.kind] || 'Needs help'}. Open the app.`;

app.post('/api/alerts', auth, (req, res) => {
  const me = req.user;
  // Drills test the whole alert path but are clearly labelled. They are a routine
  // activity: coordinators/admins only, and not during the observance lock.
  const drill = req.body?.drill ? 1 : 0;
  if (drill) {
    if (!isCoord(me)) return bad(res, 'forbidden', 403);
    const st = shabbatState();
    if (st.locked) return res.status(423).json({ error: 'shabbat_lock', until: new Date(st.current.end).toISOString() });
  }
  const recipientsOf = (id) => db.prepare('SELECT user_id FROM alert_recipients WHERE alert_id = ?').all(id).map((r) => r.user_id);
  const recent = db.prepare(`SELECT id FROM alerts WHERE sender_id = ? AND status = 'active' AND drill = ? AND created_at > ?`).get(me.id, drill, new Date(Date.now() - 120000).toISOString());
  if (recent) { const r = recipientsOf(recent.id); return res.json({ id: recent.id, notified: r.length, duplicate: true, drill: !!drill, reach: reachability(r) }); }
  const kind = ALERT_KINDS.includes(req.body?.kind) ? req.body.kind : 'help';
  const ctx = currentContext(me.id);
  const info = db.prepare('INSERT INTO alerts (sender_id, created_at, kind, post_id, event_id, drill) VALUES (?,?,?,?,?,?)').run(me.id, now(), kind, ctx.postId, ctx.eventId, drill);
  const id = Number(info.lastInsertRowid);
  const lat = num(req.body?.lat, -90, 90), lon = num(req.body?.lon, -180, 180);
  if (lat != null && lon != null) db.prepare('UPDATE alerts SET loc = ? WHERE id = ?').run(encJSON('field', { lat, lon, acc: num(req.body?.acc, 0, 1e6), at: now() }, locAad(id)), id);
  const rcpts = drill && req.body?.audience === 'all'
    ? db.prepare('SELECT id FROM users WHERE active = 1 AND id != ?').all(me.id).map((r) => r.id)
    : recipientsFor(me.id, ctx);
  const ins = db.prepare('INSERT INTO alert_recipients (alert_id, user_id) VALUES (?,?)');
  for (const r of rcpts) ins.run(id, r);
  audit(me.id, drill ? 'drill_sent' : 'alert_sent', id);
  const a = db.prepare(`${ALERT_SQL} WHERE a.id = ?`).get(id);
  // Snapshot reachability before sending so the sender knows who will actually get it.
  const reach = reachability(rcpts);
  notify(rcpts, 'alert', { id, drill: !!drill }, { type: 'alert', id, title: drill ? 'DRILL \u2014 practice alert' : 'SILENT ALERT', body: pushBody(a), drill: !!drill });
  notify([me.id], 'alert_update', { id });
  res.json({ id, notified: rcpts.length, post: ctx.postName, drill: !!drill, reach });
});

app.post('/api/alerts/:id/kind', auth, (req, res) => {
  const a = db.prepare("SELECT * FROM alerts WHERE id = ? AND sender_id = ? AND status = 'active'").get(+req.params.id, req.user.id);
  if (!a) return bad(res, 'not_found', 404);
  if (!ALERT_KINDS.includes(req.body?.kind)) return bad(res, 'invalid_kind');
  db.prepare('UPDATE alerts SET kind = ? WHERE id = ?').run(req.body.kind, a.id);
  const full = db.prepare(`${ALERT_SQL} WHERE a.id = ?`).get(a.id);
  const others = audienceOf(a).filter((u) => u !== a.sender_id);
  notify(others, 'alert_update', { id: a.id }, { type: 'alert', id: a.id, title: a.drill ? 'DRILL \u2014 practice alert' : 'SILENT ALERT', body: pushBody(full), drill: !!a.drill });
  notify([a.sender_id], 'alert_update', { id: a.id });
  res.json({ ok: true });
});

app.post('/api/alerts/:id/location', auth, (req, res) => {
  const a = db.prepare("SELECT * FROM alerts WHERE id = ? AND sender_id = ? AND status = 'active'").get(+req.params.id, req.user.id);
  if (!a) return bad(res, 'not_found', 404);
  const lat = num(req.body?.lat, -90, 90), lon = num(req.body?.lon, -180, 180);
  if (lat == null || lon == null) return bad(res, 'invalid_location');
  db.prepare('UPDATE alerts SET loc = ? WHERE id = ?').run(encJSON('field', { lat, lon, acc: num(req.body?.acc, 0, 1e6), at: now() }, locAad(a.id)), a.id);
  notify(audienceOf(a), 'alert_update', { id: a.id });
  res.json({ ok: true });
});

app.post('/api/alerts/:id/ack', auth, (req, res) => {
  const a = loadAlertFor(+req.params.id, req.user);
  if (!a || a.status !== 'active') return bad(res, 'not_found', 404);
  db.prepare(`INSERT INTO alert_recipients (alert_id, user_id, acked_at) VALUES (?,?,?)
    ON CONFLICT(alert_id, user_id) DO UPDATE SET acked_at = COALESCE(acked_at, excluded.acked_at)`).run(a.id, req.user.id, now());
  audit(req.user.id, 'alert_ack', a.id);
  notify(audienceOf(a), 'alert_update', { id: a.id });
  res.json({ ok: true });
});

app.post('/api/alerts/:id/resolve', auth, (req, res) => {
  const a = loadAlertFor(+req.params.id, req.user);
  if (!a || a.status !== 'active') return bad(res, 'not_found', 404);
  if (a.sender_id !== req.user.id && !isCoord(req.user)) return bad(res, 'forbidden', 403);
  const outcome = ['all_clear', 'false_alarm', 'resolved'].includes(req.body?.outcome) ? req.body.outcome : 'resolved';
  db.prepare("UPDATE alerts SET status = 'resolved', outcome = ?, resolved_at = ?, resolved_by = ? WHERE id = ?").run(outcome, now(), req.user.id, a.id);
  audit(req.user.id, 'alert_resolved', `${a.id}:${outcome}`);
  notify(audienceOf(a), 'alert_update', { id: a.id }, { type: 'resolved', id: a.id, title: outcome === 'false_alarm' ? 'False alarm' : 'All clear', body: `Alert from ${a.sender_name} was closed.` });
  res.json({ ok: true });
});

app.get('/api/alerts/active', auth, (req, res) => {
  const rows = db.prepare(`${ALERT_SQL} WHERE a.status = 'active' AND a.created_at > ? ORDER BY a.created_at DESC`).all(new Date(Date.now() - 12 * 3600000).toISOString());
  res.json(rows.filter((a) => loadAlertFor(a.id, req.user)).map((a) => alertView(a, req.user)));
});
app.get('/api/alerts', auth, need('coordinator'), routineOnly, (req, res) => {
  res.json(db.prepare(`${ALERT_SQL} ORDER BY a.created_at DESC LIMIT 50`).all().map((a) => alertView(a, req.user)));
});

// Escalation: nobody acknowledged within ESCALATE_SECS -> widen to the whole active team.
export function escalate() {
  const cutoff = new Date(Date.now() - ESCALATE_SECS * 1000).toISOString();
  const due = db.prepare(`SELECT a.* FROM alerts a WHERE a.status = 'active' AND a.escalated_at IS NULL AND a.created_at <= ?
    AND NOT EXISTS (SELECT 1 FROM alert_recipients r WHERE r.alert_id = a.id AND r.acked_at IS NOT NULL)`).all(cutoff);
  for (const a of due) {
    const have = new Set(audienceOf(a));
    const extra = db.prepare('SELECT id FROM users WHERE active = 1').all().map((u) => u.id).filter((id) => !have.has(id));
    const ins = db.prepare('INSERT OR IGNORE INTO alert_recipients (alert_id, user_id) VALUES (?,?)');
    for (const id of extra) ins.run(a.id, id);
    db.prepare('UPDATE alerts SET escalated_at = ? WHERE id = ?').run(now(), a.id);
    audit(null, 'alert_escalated', a.id);
    const full = db.prepare(`${ALERT_SQL} WHERE a.id = ?`).get(a.id);
    notify(extra, 'alert', { id: a.id, drill: !!a.drill }, { type: 'alert', id: a.id, title: a.drill ? 'ESCALATED DRILL \u2014 no response yet' : 'ESCALATED ALERT \u2014 no response yet', body: pushBody(full), drill: !!a.drill });
    notify([...have], 'alert_update', { id: a.id });
  }
}
setInterval(escalate, 5000).unref();

app.get('/api/stream', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  addStream(req.user.id, res);
});
setInterval(heartbeat, +process.env.MISHMAR_HEARTBEAT_MS || 25000).unref();

// ---------- incidents ----------
app.post('/api/incidents', auth, routineOnly, (req, res, next) => {
  if (limited(`inc:${req.user.id}`, 30, 3600000)) return bad(res, 'too_many_requests', 429);
  next();
}, upload('photo', 6), (req, res) => {
  const desc = str(req.body?.description, 4000);
  const occurred = isoOrNull(req.body?.occurredAt) || new Date();
  if (!desc) return bad(res, 'description_required');
  if (occurred.getTime() > Date.now() + 5 * 60000) return bad(res, 'invalid_time');
  let postId = null;
  if (req.body?.postId) {
    postId = +req.body.postId;
    if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId)) return bad(res, 'invalid_reference');
  }
  let photoFile = null;
  if (req.file) {
    const j = stripJpeg(req.file.buffer);
    if (!j) return bad(res, 'photo_must_be_jpeg');
    photoFile = savePhoto(j.buf);
  }
  const info = db.prepare('INSERT INTO incidents (reporter_id, occurred_at, created_at, post_id, body, photo_file) VALUES (?,?,?,?,?,?)')
    .run(req.user.id, occurred.toISOString(), now(), postId, enc('field', Buffer.from(desc), 'incident-body'), photoFile);
  audit(req.user.id, 'incident_created', info.lastInsertRowid);
  res.json({ id: Number(info.lastInsertRowid) });
});

const INC_SQL = `SELECT i.*, u.display_name AS reporter, p.name AS post FROM incidents i
  JOIN users u ON u.id = i.reporter_id LEFT JOIN posts p ON p.id = i.post_id`;
const incView = (i, full) => {
  const t = dec('field', i.body, 'incident-body').toString('utf8');
  return { id: i.id, reporter: i.reporter, post: i.post, occurredAt: i.occurred_at, createdAt: i.created_at, hasPhoto: !!i.photo_file, description: full ? t : t.slice(0, 140) };
};
const canSeeIncident = (i, me) => i.reporter_id === me.id || isCoord(me);

app.get('/api/incidents', auth, routineOnly, (req, res) => {
  const rows = isCoord(req.user)
    ? db.prepare(`${INC_SQL} ORDER BY i.occurred_at DESC LIMIT 100`).all()
    : db.prepare(`${INC_SQL} WHERE i.reporter_id = ? ORDER BY i.occurred_at DESC LIMIT 50`).all(req.user.id);
  res.json(rows.map((i) => incView(i, false)));
});
app.get('/api/incidents/:id', auth, routineOnly, (req, res) => {
  const i = db.prepare(`${INC_SQL} WHERE i.id = ?`).get(+req.params.id);
  if (!i || !canSeeIncident(i, req.user)) return bad(res, 'not_found', 404);
  audit(req.user.id, 'incident_viewed', i.id);
  res.json(incView(i, true));
});
app.get('/api/incidents/:id/photo', auth, routineOnly, (req, res) => {
  const i = db.prepare('SELECT * FROM incidents WHERE id = ?').get(+req.params.id);
  if (!i || !i.photo_file || !canSeeIncident(i, req.user)) return bad(res, 'not_found', 404);
  sendJpeg(res, i.photo_file);
});
app.delete('/api/incidents/:id', auth, need('admin'), routineOnly, (req, res) => {
  const i = db.prepare('SELECT * FROM incidents WHERE id = ?').get(+req.params.id);
  if (!i) return bad(res, 'not_found', 404);
  deletePhoto(i.photo_file);
  db.prepare('DELETE FROM incidents WHERE id = ?').run(i.id);
  audit(req.user.id, 'incident_deleted', i.id);
  res.json({ ok: true });
});

// ---------- layout, events, messages, emergency, readiness ----------
registerOps(app);

// ---------- health (for uptime monitors; reveals nothing but liveness) ----------
app.get('/healthz', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.set('Cache-Control', 'no-store').json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

// ---------- static + errors ----------
app.use('/api', (req, res) => bad(res, 'not_found', 404));
app.use('/vendor/qrcode', express.static(path.join(ROOT, 'node_modules', 'qrcode-generator'), { maxAge: '7d' }));
app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders: (res, p) => { if (p.endsWith('sw.js') || p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'server_error' });
});

// ---------- retention (data minimisation) ----------
export function purge() {
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  db.prepare('UPDATE alerts SET loc = NULL WHERE created_at < ? AND loc IS NOT NULL').run(ago(RETENTION.alertLocationDays));
  db.prepare('DELETE FROM alerts WHERE created_at < ?').run(ago(RETENTION.alertDays));
  for (const i of db.prepare('SELECT id, photo_file FROM incidents WHERE created_at < ?').all(ago(RETENTION.incidentDays))) {
    deletePhoto(i.photo_file);
    db.prepare('DELETE FROM incidents WHERE id = ?').run(i.id);
  }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.prepare('DELETE FROM invites WHERE expires_at < ?').run(ago(7));
  db.prepare('UPDATE invites SET code_enc = NULL WHERE expires_at < ? AND code_enc IS NOT NULL').run(now());
  db.prepare('DELETE FROM shifts WHERE ends_at < ?').run(ago(90));
  db.prepare('DELETE FROM audit WHERE ts < ?').run(ago(RETENTION.auditDays));
  purgeOps();
}
purge();
setInterval(purge, +process.env.MISHMAR_PURGE_MS || 3600000).unref();
startReminders();

// ---------- bootstrap ----------
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const code = newInviteCode();
  db.prepare('DELETE FROM invites WHERE created_by IS NULL').run();
  db.prepare('INSERT INTO invites (code_hash, role, expires_at, created_by) VALUES (?,?,?,NULL)').run(sha256(code), 'admin', new Date(Date.now() + 24 * 3600000).toISOString());
  console.log(`\n  First-run setup: open the app, choose "I have an invite code", and enter:\n\n      ${code}\n\n  (creates the first admin; valid 24h)\n`);
}

const port = +process.env.PORT || 3000;
if (process.env.MISHMAR_NO_LISTEN !== '1') {
  app.listen(port, () => console.log(`Mishmar listening on :${port}${SECURE_COOKIES ? '' : '  [INSECURE COOKIES - dev only]'}`));
}
