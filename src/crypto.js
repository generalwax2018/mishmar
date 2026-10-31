// Cryptographic helpers: master key handling, AES-256-GCM field/file encryption,
// scrypt password hashing, and opaque token hashing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const keys = {};

export function initKeys(dataDir) {
  let master;
  const env = process.env.MISHMAR_MASTER_KEY;
  if (env) {
    master = Buffer.from(env, 'base64');
    if (master.length !== 32) throw new Error('MISHMAR_MASTER_KEY must be 32 bytes, base64-encoded');
  } else {
    const p = path.join(dataDir, 'master.key');
    if (fs.existsSync(p)) {
      master = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'base64');
    } else {
      master = crypto.randomBytes(32);
      fs.writeFileSync(p, master.toString('base64'), { mode: 0o600 });
      console.warn('[security] Generated data/master.key. In production set MISHMAR_MASTER_KEY from a secrets manager instead.');
    }
  }
  // Separate subkeys per purpose so a bug in one context can't decrypt another.
  for (const purpose of ['field', 'photo', 'push']) {
    keys[purpose] = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `mishmar:${purpose}`, 32));
  }
}

// Layout: [1 version][12 iv][16 tag][ciphertext]. `aad` binds ciphertext to its context.
export function enc(purpose, data, aad = '') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys[purpose], iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
}

export function dec(purpose, blob, aad = '') {
  const b = Buffer.from(blob);
  if (b[0] !== 1) throw new Error('bad ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', keys[purpose], b.subarray(1, 13));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(13, 29));
  return Buffer.concat([d.update(b.subarray(29)), d.final()]);
}

export const encJSON = (purpose, obj, aad) => enc(purpose, Buffer.from(JSON.stringify(obj)), aad);
export const decJSON = (purpose, blob, aad) => JSON.parse(dec(purpose, blob, aad).toString('utf8'));

// ---- passwords ----
const N = 32768, R = 8, P = 1;
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64, { N, r: R, p: P, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [, n, r, p, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const h = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: 128 * 1024 * 1024 });
  return crypto.timingSafeEqual(h, expected);
}
// Used so unknown logins cost the same time as known ones.
export const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

// ---- tokens ----
export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newInviteCode = () => {
  // 10 chars, unambiguous alphabet, shown once.
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), (b) => a[b % a.length]).join('').replace(/(.{5})(.{5})/, '$1-$2');
};
