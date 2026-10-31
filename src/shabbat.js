// Shabbat / Yom Tov window calculation (offline, via Hebcal) and lock state.
// A "window" runs from candle lighting to Havdalah. Consecutive days (Yom Tov
// running into Shabbat, two-day chag) have no Havdalah in between, so they merge
// into a single continuous window automatically.
import { HebrewCalendar, Location } from '@hebcal/core';
import { db } from './db.js';

const DAY = 86400000;
let cache = null; // { key, windows }
// MISHMAR_FAKE_NOW exists only so the test-suite can simulate Shabbat; never set it in production.
const nowMs = () => (process.env.MISHMAR_FAKE_NOW ? Date.parse(process.env.MISHMAR_FAKE_NOW) : Date.now());

export function getCongregation() {
  return db.prepare('SELECT * FROM congregation WHERE id = 1').get();
}

export function computeWindows(cfg, from, to) {
  if (cfg.lat == null || cfg.lon == null) return [];
  const loc = new Location(cfg.lat, cfg.lon, !!cfg.il, cfg.tzid);
  const opts = {
    start: new Date(from.getTime() - 4 * DAY),
    end: new Date(to.getTime() + 4 * DAY),
    location: loc,
    candlelighting: true,
    candleLightingMins: Math.abs(cfg.candle_mins),
    sedrot: false,
    il: !!cfg.il,
  };
  if (cfg.havdalah_mins) opts.havdalahMins = cfg.havdalah_mins;
  const events = HebrewCalendar.calendar(opts)
    .filter((e) => e.eventTime && ['Candle lighting', 'Havdalah'].includes(e.getDesc()))
    .map((e) => ({ kind: e.getDesc() === 'Havdalah' ? 'end' : 'start', t: e.eventTime.getTime() }))
    .sort((a, b) => a.t - b.t);
  const windows = [];
  let open = null;
  for (const ev of events) {
    if (ev.kind === 'start') { if (open === null) open = ev.t; }
    else if (open !== null) { windows.push({ start: open, end: ev.t }); open = null; }
  }
  return windows.filter((w) => w.end > from.getTime() && w.start < to.getTime());
}

// Windows for the next ~3 weeks, cached until settings change or 6 hours pass.
export function upcomingWindows(cfg = getCongregation(), at = nowMs()) {
  const key = JSON.stringify([cfg.lat, cfg.lon, cfg.tzid, cfg.il, cfg.candle_mins, cfg.havdalah_mins, Math.floor(at / (6 * 3600000))]);
  if (!cache || cache.key !== key) {
    cache = { key, windows: computeWindows(cfg, new Date(at - DAY), new Date(at + 21 * DAY)) };
  }
  return cache.windows;
}
export const invalidateShabbatCache = () => { cache = null; };

export function shabbatState(at = nowMs()) {
  const cfg = getCongregation();
  const windows = cfg.shabbat_mode ? upcomingWindows(cfg, at) : [];
  const current = windows.find((w) => w.start <= at && at < w.end) || null;
  return {
    mode: !!cfg.shabbat_mode,
    configured: cfg.lat != null && cfg.lon != null,
    locked: !!current,
    current,
    tzid: cfg.tzid,
    now: at,
    windows: windows.map((w) => ({ start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() })),
  };
}

// Express middleware: reject routine endpoints while locked. Life-safety routes
// simply don't use it.
export function routineOnly(req, res, next) {
  const s = shabbatState();
  if (s.locked) {
    return res.status(423).json({ error: 'shabbat_lock', until: new Date(s.current.end).toISOString() });
  }
  next();
}
