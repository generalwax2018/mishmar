// Server-side admin commands. Anyone who can run these already controls the
// server, so they are the safe way to bootstrap or recover access.
//
//   npm run invite                 -> one-time ADMIN invite code (48 h)
//   npm run invite -- guard        -> one-time invite for a role (guard|coordinator|admin)
//   npm run reset-login -- <login> -> one-time password reset code for that login (24 h)
//
// Works while the server is running.
import { db, now, audit, DATA_DIR } from './db.js';
import { initKeys, enc, newInviteCode, sha256 } from './crypto.js';

initKeys(DATA_DIR);

const [cmd, arg] = process.argv.slice(2);
const box = (lines) => console.log(`\n  ${lines.join('\n  ')}\n`);

if (cmd === 'invite') {
  const role = arg || 'admin';
  if (!['admin', 'coordinator', 'guard'].includes(role)) { console.error('Role must be admin, coordinator or guard.'); process.exit(1); }
  const code = newInviteCode();
  // created_by = 0 marks a server-command invite (startup only clears its own first-run codes, which are NULL)
  const hash = sha256(code);
  db.prepare('INSERT INTO invites (code_hash, role, expires_at, created_by, label, code_enc) VALUES (?,?,?,0,?,?)')
    .run(hash, role, new Date(Date.now() + 48 * 3600000).toISOString(), 'From server command', enc('field', Buffer.from(code), `invite:${hash}`));
  audit(null, 'invite_created_cli', role);
  box([`One-time ${role} invite code (valid 48 hours):`, '', `    ${code}`, '', 'Open the app, tap "I have an invite code", and enter it.']);
} else if (cmd === 'reset') {
  if (!arg) { console.error('Usage: npm run reset-login -- <login>'); process.exit(1); }
  const u = db.prepare('SELECT id, login, display_name, role, active FROM users WHERE login = ?').get(arg);
  if (!u) {
    const logins = db.prepare('SELECT login, role FROM users WHERE active = 1 ORDER BY role, login').all();
    console.error(`No user with login "${arg}". Active logins: ${logins.map((l) => `${l.login} (${l.role})`).join(', ') || 'none'}`);
    process.exit(1);
  }
  if (!u.active) db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(u.id);
  const code = newInviteCode();
  db.prepare('DELETE FROM resets WHERE user_id = ? AND used_at IS NULL').run(u.id);
  db.prepare('INSERT INTO resets (code_hash, user_id, expires_at, created_by) VALUES (?,?,?,NULL)').run(sha256(code), u.id, new Date(Date.now() + 24 * 3600000).toISOString());
  db.prepare('UPDATE users SET failed = 0, locked_until = NULL WHERE id = ?').run(u.id);
  audit(null, 'reset_code_issued_cli', u.id);
  box([`Password reset code for "${u.login}" (${u.role}), valid 24 hours:`, '', `    ${code}`, '',
    'Open the app, tap "Forgot password?", and enter the code, the login and a new password.', 'This also turns off two-step sign-in for that account.']);
} else {
  console.log('Commands:\n  npm run invite [-- guard|coordinator|admin]\n  npm run reset-login -- <login>');
}
