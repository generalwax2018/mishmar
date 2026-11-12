// npm run backup  ->  backups/mishmar-<timestamp>/
// A consistent SQLite snapshot (VACUUM INTO is safe while the server runs), the
// encrypted photo files, and the push keys. Sensitive fields and photos stay
// encrypted in the backup. The master key is deliberately NOT copied: store it
// separately (secrets manager / password manager), or the backup is unreadable.
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

const root = path.resolve(process.env.MISHMAR_BACKUP_DIR || 'backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(root, `mishmar-${stamp}`);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

db.exec(`VACUUM INTO '${path.join(dir, 'mishmar.db').replace(/'/g, "''")}'`);
fs.cpSync(path.join(DATA_DIR, 'photos'), path.join(dir, 'photos'), { recursive: true });
if (fs.existsSync(path.join(DATA_DIR, 'vapid.json'))) fs.copyFileSync(path.join(DATA_DIR, 'vapid.json'), path.join(dir, 'vapid.json'));

// Keep the newest N backups (default 14).
const keep = +process.env.MISHMAR_BACKUP_KEEP || 14;
const old = fs.readdirSync(root).filter((d) => d.startsWith('mishmar-')).sort().reverse().slice(keep);
for (const d of old) fs.rmSync(path.join(root, d), { recursive: true, force: true });

console.log(`Backup written to ${dir}${old.length ? ` (removed ${old.length} older)` : ''}`);
console.log('Reminder: the master key is not in the backup. Keep it somewhere separate and safe.');
