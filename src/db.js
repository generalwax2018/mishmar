import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.MISHMAR_DATA || path.resolve('data');
fs.mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(path.join(DATA_DIR, process.env.MISHMAR_DB || 'mishmar.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;

CREATE TABLE IF NOT EXISTS congregation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'My Congregation',
  lat REAL, lon REAL,
  tzid TEXT NOT NULL DEFAULT 'America/New_York',
  il INTEGER NOT NULL DEFAULT 0,
  candle_mins INTEGER NOT NULL DEFAULT 18,
  havdalah_mins INTEGER,            -- NULL = nightfall (tzeit, 8.5 deg)
  shabbat_mode INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO congregation (id) VALUES (1);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','coordinator','guard')),
  pw_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  failed INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shifts_time ON shifts (starts_at, ends_at);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  loc BLOB,                          -- AES-GCM encrypted {lat,lon,acc,at}
  status TEXT NOT NULL DEFAULT 'active',
  outcome TEXT,
  resolved_at TEXT,
  resolved_by INTEGER
);
CREATE TABLE IF NOT EXISTS alert_recipients (
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acked_at TEXT,
  PRIMARY KEY (alert_id, user_id)
);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  post_id INTEGER REFERENCES posts(id),
  body BLOB NOT NULL,                -- AES-GCM encrypted description
  photo_file TEXT                    -- encrypted file under data/photos
);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint_hash TEXT NOT NULL UNIQUE,
  sub BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  ref TEXT
);
`);

export const now = () => new Date().toISOString();
export const audit = (userId, action, ref = null) =>
  db.prepare('INSERT INTO audit (ts, user_id, action, ref) VALUES (?,?,?,?)').run(now(), userId ?? null, action, ref == null ? null : String(ref));

// ---------- v2: layout, events, messaging ----------
db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('building','outdoor')),
  base TEXT NOT NULL CHECK (base IN ('image','osm')),
  image_file TEXT, image_w INTEGER, image_h INTEGER,
  lat REAL, lon REAL, zoom INTEGER,
  calib BLOB,                        -- encrypted 2-point GPS calibration for image maps
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS markers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  x REAL, y REAL, lat REAL, lon REAL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS site_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  marker_id INTEGER REFERENCES markers(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'photo',
  caption TEXT,
  file TEXT NOT NULL, w INTEGER, h INTEGER,
  created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  lead_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  positions TEXT NOT NULL DEFAULT 'leads' CHECK (positions IN ('leads','team','off')),
  checkin_mins INTEGER NOT NULL DEFAULT 20,
  radio TEXT,
  briefing BLOB, contacts BLOB,      -- encrypted
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_members (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acked_at TEXT, last_checkin TEXT, sharing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS positions (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loc BLOB NOT NULL,                 -- encrypted; only the latest fix is kept
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  body BLOB, post_id INTEGER, loc BLOB,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_time ON messages (created_at);
CREATE TABLE IF NOT EXISTS reminders (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
`);

function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('posts', 'site_id', 'INTEGER REFERENCES sites(id)');
addColumn('posts', 'event_id', 'INTEGER REFERENCES events(id) ON DELETE CASCADE');
addColumn('posts', 'x', 'REAL'); addColumn('posts', 'y', 'REAL');
addColumn('posts', 'lat', 'REAL'); addColumn('posts', 'lon', 'REAL');
addColumn('posts', 'radio', 'TEXT');
addColumn('posts', 'lead_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColumn('alerts', 'kind', "TEXT NOT NULL DEFAULT 'help'");
addColumn('alerts', 'post_id', 'INTEGER');
addColumn('alerts', 'event_id', 'INTEGER');
addColumn('alerts', 'escalated_at', 'TEXT');
addColumn('shifts', 'confirmed_at', 'TEXT');
addColumn('congregation', 'address', 'TEXT');
addColumn('congregation', 'emergency_script', 'TEXT');
addColumn('congregation', 'procedures', 'BLOB');
addColumn('congregation', 'emergency_contacts', 'BLOB');
addColumn('congregation', 'osm_enabled', 'INTEGER NOT NULL DEFAULT 1');
addColumn('congregation', 'main_site_id', 'INTEGER');

// Every congregation gets a main building site; existing posts move onto it.
if (!db.prepare('SELECT main_site_id FROM congregation WHERE id = 1').get().main_site_id) {
  const info = db.prepare("INSERT INTO sites (name, kind, base, created_at) VALUES ('Main building','building','image',?)").run(now());
  db.prepare('UPDATE congregation SET main_site_id = ? WHERE id = 1').run(info.lastInsertRowid);
  db.prepare('UPDATE posts SET site_id = ? WHERE site_id IS NULL AND event_id IS NULL').run(info.lastInsertRowid);
}

// ---------- v3: drills, account recovery, two-factor ----------
addColumn('alerts', 'drill', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'totp_secret', 'BLOB');      // encrypted base32 secret (enrolled)
addColumn('users', 'totp_pending', 'BLOB');     // encrypted secret awaiting confirmation
addColumn('users', 'totp_last', 'INTEGER');     // last accepted time-step (blocks code replay)
db.exec(`CREATE TABLE IF NOT EXISTS resets (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by INTEGER
);`);
