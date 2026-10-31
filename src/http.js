// Shared request helpers: validation, auth/RBAC middleware, rate limiting,
// and encrypted photo storage. Used by server.js and ops.js.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db, now, DATA_DIR } from './db.js';
import { enc, dec, sha256 } from './crypto.js';

export const RANK = { guard: 1, coordinator: 2, admin: 3 };
export const SESSION_DAYS = 14;

export const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
export const str = (v, max) => (typeof v === 'string' && v.trim().length && v.length <= max ? v.trim() : null);
export const optStr = (v, max) => (v == null || v === '' ? null : str(v, max));
export const isoOrNull = (v) => { const d = new Date(v); return typeof v === 'string' && !isNaN(d) ? d : null; };
export const num = (v, lo, hi) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) && n >= lo && n <= hi ? n : null;
};
export const int = (v) => (Number.isInteger(+v) && +v > 0 ? +v : null);

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function auth(req, res, next) {
  const tok = parseCookies(req).sid;
  if (!tok) return bad(res, 'unauthenticated', 401);
  const row = db.prepare(`SELECT s.token_hash, s.expires_at, u.id, u.login, u.display_name, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(tok));
  if (!row || !row.active || row.expires_at < now()) return bad(res, 'unauthenticated', 401);
  if (new Date(row.expires_at).getTime() - Date.now() < (SESSION_DAYS - 1) * 86400000) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(), row.token_hash);
  }
  req.user = { id: row.id, login: row.login, name: row.display_name, role: row.role };
  next();
}
export const need = (role) => (req, res, next) => (RANK[req.user.role] >= RANK[role] ? next() : bad(res, 'forbidden', 403));
export const isCoord = (u) => RANK[u.role] >= RANK.coordinator;

// In-memory limiter. For multi-instance deployments use a shared store.
const hits = new Map();
export function limited(key, max, windowMs) {
  const t = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < t) { hits.set(key, { n: 1, reset: t + windowMs }); return false; }
  return ++h.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, 60000).unref();

// ---------- images ----------
// Validates a JPEG, removes EXIF/GPS/comment segments (APP1-APP15, COM) and
// reads its pixel dimensions. Returns null if it isn't a well-formed JPEG.
export function stripJpeg(buf) {
  if (!buf || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  const out = [buf.subarray(0, 2)];
  let i = 2, w = 0, h = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xda) { out.push(buf.subarray(i)); return { buf: Buffer.concat(out), w, h }; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && len >= 7) {
      h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7);
    }
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

export const upload = (field, maxMb = 8) => {
  const m = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 10 } }).single(field);
  return (req, res, next) => m(req, res, (err) => (err ? bad(res, err.code === 'LIMIT_FILE_SIZE' ? 'photo_too_large' : 'upload_error') : next()));
};

const photoPath = (f) => path.join(DATA_DIR, 'photos', path.basename(f));
export function savePhoto(buf) {
  const file = crypto.randomBytes(16).toString('hex') + '.bin';
  fs.writeFileSync(photoPath(file), enc('photo', buf, file), { mode: 0o600 });
  return file;
}
export const readPhoto = (file) => dec('photo', fs.readFileSync(photoPath(file)), file);
export const deletePhoto = (file) => { if (file) fs.rmSync(photoPath(file), { force: true }); };
export function sendJpeg(res, file) {
  try {
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(readPhoto(file));
  } catch { bad(res, 'not_found', 404); }
}

// ---------- geo ----------
export function meters(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
