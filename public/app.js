'use strict';
// Mishmar front-end, part 1: core, alerts, Now screen, messages, emergency card,
// schedule, reports, position sharing. Part 2 (pages.js): map, layout survey,
// events, admin pages. No framework or third-party scripts besides self-hosted
// Leaflet. Server data is always rendered with textContent (via h()).

const root = document.getElementById('root');
const S = {
  me: null, congregation: '', vapid: null, mainSiteId: null, osmEnabled: false, tileUrl: '',
  shabbat: null, offset: 0, locked: false,
  tab: 'now', page: null, arg: null,
  alerts: [], sent: null, sending: false,
  myEvent: null, feed: [], mapCtl: null, es: null,
};

// ---------- DOM helpers ----------
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}
const $ = (sel, el = document) => el.querySelector(sel);
const clear = (el) => { while (el && el.firstChild) el.firstChild.remove(); return el; };
const store = {
  get(k) { try { return localStorage.getItem(`mishmar.${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`mishmar.${k}`, v); } catch { /* private mode */ } },
};

// ---------- API ----------
class ApiError extends Error { constructor(status, code, body) { super(code); this.status = status; this.code = code; this.body = body; } }
async function api(method, url, body, form) {
  const opts = { method, headers: { 'X-Requested-With': 'mishmar' }, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, opts); } catch { throw new ApiError(0, 'offline'); }
  let data = null;
  if ((r.headers.get('content-type') || '').includes('json')) data = await r.json();
  if (r.status === 401 && S.me) { S.me = null; showAuth(); throw new ApiError(401, 'unauthenticated'); }
  if (r.status === 423) { await refreshShabbat(); applyLock(true); throw new ApiError(423, 'shabbat_lock', data); }
  if (!r.ok) throw new ApiError(r.status, data?.error || 'error', data);
  return data;
}
const ERR = {
  invalid_credentials: 'Wrong login or password.', too_many_attempts: 'Too many attempts. Try again in a few minutes.',
  invalid_invite: 'That invite code is invalid, used, or expired. If the server was restarted, use the newest code it printed.',
  login_taken: 'That login is taken.', password_too_short: 'Password must be at least 10 characters.', login_format: 'Login: 3–64 letters, numbers, . _ -',
  overlap: 'That person already has an overlapping shift.', invalid_times: 'Check the start and end times.',
  photo_too_large: 'Photo is too large.', photo_must_be_jpeg: 'Photo could not be read.', offline: 'You appear to be offline.',
  location_required: 'Set the congregation location before turning the lock on.', last_admin: 'You cannot remove the last admin.',
  shabbat_lock: 'Locked for Shabbat / Yom Tov.', description_required: 'Please describe what happened.',
  street_maps_disabled: 'Street maps are turned off in Settings. Upload a site map instead.', points_too_close: 'Pick two spots at least ~15 m apart.',
  invalid_event: 'Check the event details (name, place, start and end).', sharing_off: 'Turn on location sharing first.', positions_disabled: 'Location sharing is off for this event.',
  text_required: 'Type a short note.', totp_required: 'Enter the 6-digit code from your authenticator app.', invalid_totp: 'That code didn\u2019t match. Wait for the next code and try again.',
  invalid_reset: 'That reset code is invalid, used, expired, or for a different login.', no_pending_setup: 'Start setup again.', use_change_password: 'Use Change password for your own account.', invalid_marker: 'Give the pin a type and a label.', invalid_post: 'Check the name.',
};
const errText = (e) => ERR[e.code] || 'Something went wrong. Please try again.';
const toast = (msg) => { const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); };

// ---------- time ----------
const serverNow = () => Date.now() + S.offset;
const tf = (d, o) => new Intl.DateTimeFormat(undefined, o).format(new Date(d));
const fmtTime = (d) => tf(d, { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => tf(d, { weekday: 'long', month: 'short', day: 'numeric' });
const fmtShort = (d) => tf(d, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const fmtLock = (ms) => new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: S.shabbat?.tzid, timeZoneName: 'short' }).format(new Date(ms));
const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const localInput = (d) => { const x = new Date(new Date(d).getTime() - new Date(d).getTimezoneOffset() * 60000); return x.toISOString().slice(0, 16); };
const isCoord = () => S.me && ['coordinator', 'admin'].includes(S.me.role);
const isAdmin = () => S.me?.role === 'admin';
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2));
}

// ---------- vibration patterns (felt, not heard) ----------
const BUZZ = { 0: [70], 1: [200, 100, 200], 2: [400, 150, 400, 150, 400], alert: [300, 150, 300, 150, 600, 200, 600] };
const buzz = (k) => { try { navigator.vibrate?.(BUZZ[k]); } catch { /* unsupported */ } };

// ---------- observance lock mirror ----------
async function refreshShabbat() {
  const s = await fetch('/api/shabbat', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!s) return;
  S.shabbat = s; S.offset = s.now - Date.now();
}
function lockInfo() {
  const s = S.shabbat; if (!s || !s.mode) return { locked: false };
  const t = serverNow();
  const win = s.windows.map((w) => ({ start: Date.parse(w.start), end: Date.parse(w.end) }));
  const cur = win.find((w) => w.start <= t && t < w.end);
  if (cur) return { locked: true, until: cur.end };
  const next = win.find((w) => w.start > t);
  return { locked: false, next: next && next.start - t < 3600000 ? next.start : null, nextAny: next?.start };
}
function applyLock(force) {
  const was = S.locked;
  S.locked = lockInfo().locked;
  if (force || was !== S.locked) {
    if (S.locked) { S.tab = 'now'; S.page = null; }
    render();
    if (!S.locked) { loadAlerts(); loadMyEvent(); }
    syncSharing();
  } else renderChrome();
}

// ---------- outdoor display mode ----------
function applyDisplay() {
  document.documentElement.classList.toggle('outdoor', store.get('outdoor') === '1');
  syncWakeLock();
}
let wakeLock = null;
async function syncWakeLock() {
  const want = store.get('outdoor') === '1' && S.myEvent?.active && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}

// ---------- auth ----------
function showAuth() {
  if (S.es) { S.es.close(); S.es = null; }
  // Forget everything the previous user could see (shared phones), and start fresh on Now.
  if (share.watch != null) { navigator.geolocation.clearWatch(share.watch); share.watch = null; }
  Object.assign(S, { me: null, tab: 'now', page: null, arg: null, alerts: [], sent: null, sending: false, myEvent: null, feed: [], mapState: null, placing: null, totp: false });
  Object.assign(share, { eventId: null, lastSent: 0, sentPos: null, last: null });
  // Invite and reset links put the code in the URL fragment, which browsers never send to the server.
  const frag = new URLSearchParams(location.hash.slice(1));
  let mode = frag.get('invite') ? 'redeem' : frag.get('reset') ? 'reset' : 'login';
  const preCode = frag.get('invite') || frag.get('reset') || '';
  if (preCode) history.replaceState(null, '', location.pathname);
  let needTotp = false, keep = {};
  const draw = () => {
    const err = h('p', { class: 'err', role: 'alert' });
    const submit = (label) => h('p', {}, h('button', { class: 'btn block', type: 'submit' }, label));
    let f;
    if (mode === 'login') {
      f = h('form', { onsubmit: async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/auth/login', { login: f.login.value, password: f.password.value, totp: needTotp ? f.totp.value : undefined }); await boot(); }
        catch (x) {
          if (x.code === 'totp_required' && !needTotp) { needTotp = true; keep = { l: f.login.value, p: f.password.value }; draw(); return; }
          err.textContent = errText(x);
        }
      } },
        h('label', { for: 'login' }, 'Login'), h('input', { id: 'login', name: 'login', autocomplete: 'username', autocapitalize: 'none', required: true, value: keep.l || '' }),
        h('label', { for: 'pw' }, 'Password'), h('input', { id: 'pw', name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
        needTotp ? [h('label', { for: 'totp' }, 'Code from your authenticator app'), h('input', { id: 'totp', name: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]{6,7}', maxlength: 7, required: true })] : null,
        err, submit('Sign in'));
      if (needTotp) setTimeout(() => { f.password.value = keep.p || ''; f.totp.focus(); });
    } else if (mode === 'redeem') {
      f = h('form', { onsubmit: async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/auth/redeem', { code: f.code.value, login: f.login.value, name: f.name.value, password: f.password.value }); await boot(); } catch (x) { err.textContent = errText(x); }
      } },
        h('label', { for: 'code' }, 'Invite code'), h('input', { id: 'code', name: 'code', autocapitalize: 'characters', autocomplete: 'off', placeholder: 'ABCDE-FGH23', required: true, value: preCode }),
        h('label', { for: 'nm' }, 'Name shown to your team'), h('input', { id: 'nm', name: 'name', maxlength: 60, autocomplete: 'name', required: true }),
        h('label', { for: 'lg' }, 'Choose a login'), h('input', { id: 'lg', name: 'login', autocomplete: 'username', autocapitalize: 'none', required: true }),
        h('label', { for: 'pw2' }, 'Password (10+ characters)'), h('input', { id: 'pw2', name: 'password', type: 'password', minlength: 10, autocomplete: 'new-password', required: true }),
        err, submit('Create account'));
    } else {
      f = h('form', { onsubmit: async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/auth/reset', { code: f.code.value, login: f.login.value, password: f.password.value }); toast('Password updated'); await boot(); } catch (x) { err.textContent = errText(x); }
      } },
        h('p', { class: 'muted small' }, 'Ask your coordinator or admin for a reset code. It works once, for 24 hours, and also turns off two-step sign-in so you can set it up again.'),
        h('label', { for: 'rc' }, 'Reset code'), h('input', { id: 'rc', name: 'code', autocapitalize: 'characters', autocomplete: 'off', placeholder: 'ABCDE-FGH23', required: true, value: preCode }),
        h('label', { for: 'rl' }, 'Your login'), h('input', { id: 'rl', name: 'login', autocomplete: 'username', autocapitalize: 'none', required: true }),
        h('label', { for: 'rp' }, 'New password (10+ characters)'), h('input', { id: 'rp', name: 'password', type: 'password', minlength: 10, autocomplete: 'new-password', required: true }),
        err, submit('Set new password'));
    }
    const link = (label, m) => h('button', { class: 'linkbtn', onclick: () => { mode = m; needTotp = false; draw(); } }, label);
    clear(root).append(h('div', { class: 'auth' },
      h('h1', {}, 'Mishmar'), h('p', { class: 'muted' }, 'Guard watch for your house of worship’s security team.'), f,
      mode === 'login' ? h('div', { class: 'row wrap' }, link('I have an invite code', 'redeem'), link('Forgot password?', 'reset')) : link('Back to sign in', 'login'),
      h('p', { class: 'muted small' }, 'Accounts are invite-only. We store your name, login and a salted password hash. No email, phone number or member directory.')));
  };
  draw();
}

// ---------- boot & live updates ----------
async function boot() {
  applyDisplay();
  try {
    const me = await api('GET', '/api/me');
    Object.assign(S, { me: me.user, congregation: me.congregation, vapid: me.vapidPublicKey, mainSiteId: me.mainSiteId, osmEnabled: me.osmEnabled, tileUrl: me.tileUrl, totp: !!me.totp });
  } catch { return showAuth(); }
  await refreshShabbat();
  S.locked = lockInfo().locked;
  await Promise.all([loadAlerts(), loadMyEvent()]);
  connectStream();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  flushOutbox();
}

let posTimer = null;
function connectStream() {
  if (S.es) S.es.close();
  const es = new EventSource('/api/stream');
  S.es = es;
  es.addEventListener('alert', () => { buzz('alert'); loadAlerts(); });
  es.addEventListener('alert_update', () => loadAlerts());
  es.addEventListener('message', (e) => {
    const d = JSON.parse(e.data);
    buzz(d.level);
    loadFeed().then(renderFeedBoxes);
    if (S.tab === 'map') refreshMapLive();
  });
  es.addEventListener('positions', () => { if (S.tab === 'map' && !posTimer) posTimer = setTimeout(() => { posTimer = null; refreshMapLive(); }, 3000); });
  es.addEventListener('roster', () => { if (S.page === 'event') document.dispatchEvent(new CustomEvent('roster')); });
  es.addEventListener('shabbat', (e) => { S.shabbat = JSON.parse(e.data); S.offset = S.shabbat.now - Date.now(); applyLock(false); });
  es.addEventListener('ping', () => setConn(true));
  es.onopen = () => { setConn(true); loadAlerts(); };
  es.onerror = () => setConn(false);
}

// ---------- connection health ----------
// The server sends a ping every 25 s. If we hear nothing for 60 s (or the phone
// goes offline) we tell the guard plainly: alerts may not be reaching them.
S.connOk = true; S.lastPing = Date.now(); S.downSince = null;
function setConn(ok) {
  if (ok) { S.lastPing = Date.now(); S.downSince = null; } else if (!S.downSince) S.downSince = Date.now();
  if (S.connOk !== ok) { S.connOk = ok; renderConn(); }
}
function renderConn() {
  const bar = $('#connbar'); if (!bar) return;
  clear(bar);
  if (S.connOk || !S.me) return;
  bar.append(h('div', { class: 'connbar', role: 'alert' },
    h('span', { class: 'grow' }, 'Not connected \u2014 alerts may not reach you. Use your radio.'),
    h('button', { class: 'btn small secondary', onclick: () => { connectStream(); loadAlerts(); } }, 'Retry')));
}
setInterval(() => {
  if (!S.me) return;
  if (!navigator.onLine || Date.now() - S.lastPing > 60000) { setConn(false); if (navigator.onLine) connectStream(); }
}, 10000);
window.addEventListener('offline', () => setConn(false));
window.addEventListener('online', () => { if (S.me) { connectStream(); loadAlerts(); flushOutbox(); } });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && S.me) { await refreshShabbat(); applyLock(false); loadAlerts(); loadMyEvent(); }
  syncWakeLock();
});

async function loadAlerts() {
  try { S.alerts = await api('GET', '/api/alerts/active'); } catch { return; }
  const mine = S.alerts.find((a) => a.mine);
  const cleared = !mine && S.sent && !S.sent.error;
  if (cleared) S.sent = null;
  if (mine && S.sent && !S.sent.kind) S.sent.kind = mine.kind;
  renderAlertBar();
  if (cleared && S.tab === 'now') renderView();
  if (S.tab === 'map') refreshMapLive();
}

// The event I'm working right now (or soon), if any.
async function loadMyEvent() {
  if (S.locked) { S.myEvent = null; return; }
  try {
    const list = await api('GET', '/api/events');
    const pick = list.find((e) => e.active && e.isMember) || null;
    S.myEvent = pick ? await api('GET', `/api/events/${pick.id}`) : null;
  } catch { S.myEvent = null; }
  syncSharing(); syncWakeLock();
}
setInterval(() => { if (S.me && !S.locked) loadMyEvent().then(() => { if (S.tab === 'now') updateEventCard(); }); }, 60000);

async function loadFeed() {
  if (S.locked) return;
  try { S.feed = await api('GET', S.myEvent ? `/api/messages?eventId=${S.myEvent.id}` : '/api/messages'); } catch { /* ignore */ }
}

// ---------- location sharing during events (foreground only) ----------
const share = { watch: null, eventId: null, lastSent: 0, sentPos: null, last: null };
function syncSharing() {
  const ev = S.myEvent;
  const want = ev && ev.active && ev.me.sharing && ev.positions !== 'off' && !S.locked && navigator.geolocation;
  if (!want || share.eventId !== ev?.id) {
    if (share.watch != null) navigator.geolocation.clearWatch(share.watch);
    share.watch = null; share.eventId = null;
  }
  if (!want || share.watch != null) return;
  share.eventId = ev.id;
  share.watch = navigator.geolocation.watchPosition((p) => {
    share.last = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
    const t = Date.now();
    const moved = share.sentPos ? distM(share.sentPos, share.last) : Infinity;
    if (t - share.lastSent > 60000 || (moved > 25 && t - share.lastSent > 15000)) {
      share.lastSent = t; share.sentPos = share.last;
      api('POST', `/api/events/${ev.id}/position`, share.last).then(() => { if (S.myEvent) S.myEvent.me.lastCheckin = new Date().toISOString(); }).catch(() => {});
    }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
}

// ---------- layout ----------
const ICON = {
  now: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z',
  map: 'M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14',
  schedule: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4',
  report: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};
function tabs() {
  if (S.locked) return [];
  return [['now', 'Now'], ['map', 'Map'], ['schedule', 'Schedule'], ['report', 'Report'], ['more', 'More']];
}
function go(tab, page = null, arg = null) {
  S.tab = tab; S.page = page; S.arg = arg;
  renderChrome(); renderView();
  window.scrollTo(0, 0);
}
function render() {
  clear(root).append(h('div', { id: 'app' },
    h('header', { id: 'hdr' }), h('div', { id: 'connbar' }), h('div', { id: 'alertbar', class: 'alertbar', 'aria-live': 'assertive' }),
    h('main', { id: 'view' }), h('nav', { id: 'nav', 'aria-label': 'Main' })));
  renderChrome(); renderConn(); renderAlertBar(); renderView();
}
function renderChrome() {
  const hdr = $('#hdr'); if (!hdr) return;
  const li = lockInfo();
  S.locked = li.locked;
  const pill = S.locked ? h('span', { class: 'pill lock' }, 'Shabbat · locked')
    : li.next ? h('span', { class: 'pill on' }, `Locks ${fmtLock(li.next)}`)
    : S.myEvent?.active ? h('span', { class: 'pill live' }, 'Event live') : null;
  clear(hdr).append(h('div', { class: 'grow' }, h('h1', {}, S.congregation || 'Mishmar'), h('small', {}, `${S.me.name} · ${S.me.role}`)), ...(pill ? [pill] : []));
  const nav = clear($('#nav'));
  const list = tabs();
  nav.hidden = !list.length;
  nav.append(h('div', { class: 'in' }, list.map(([id, label]) => h('button', {
    'aria-current': S.tab === id ? 'page' : null, onclick: () => go(id),
  }, svg(ICON[id]), label))));
}
function svg(d) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); return s;
}
function renderView() {
  if (S.mapCtl) { S.mapCtl.destroy(); S.mapCtl = null; }
  const v = clear($('#view')); if (!v) return;
  if (S.locked) return nowView(v);
  const views = { now: nowView, map: mapView, schedule: scheduleView, report: reportView, more: moreView };
  (views[S.tab] || nowView)(v);
}

// ---------- modal / bottom sheet ----------
function sheet(title, ...content) {
  const close = () => { wrap.remove(); wrap.dispatchEvent(new Event('closed')); };
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('div', { class: 'row between' }, h('h3', {}, title), h('button', { class: 'x', 'aria-label': 'Close', onclick: close }, '×')),
      ...content));
  wrap.close = close;
  document.body.append(wrap);
  return wrap;
}
function photoViewer(p) {
  const img = h('img', { src: `/api/photos/${p.id}`, alt: p.caption || 'Survey photo' });
  sheet(p.caption || (p.kind === 'panorama' ? 'Panorama' : 'Photo'),
    h('div', { class: p.kind === 'panorama' ? 'pano' : 'photo-full' }, img),
    p.kind === 'panorama' ? h('p', { class: 'muted small' }, 'Swipe sideways to look around.') : null);
}

// ---------- alerts ----------
const KIND = {
  help: 'Needs help', medical: 'Medical', threat: 'Threat / lockdown', suspicious: 'Suspicious person',
  backup: 'Needs backup', fire: 'Fire / evacuate', lost_child: 'Lost child',
};
const mapsLink = (l) => `https://www.google.com/maps?q=${l.lat},${l.lon}`;
function renderAlertBar() {
  const bar = $('#alertbar'); if (!bar) return;
  clear(bar);
  for (const a of S.alerts) {
    const canClose = a.mine || isCoord();
    const where = [a.post?.name, a.event?.name].filter(Boolean).join(' · ');
    bar.append(h('div', { class: 'card alertcard' + (a.drill ? ' drill' : ''), role: 'alert' },
      a.drill ? h('div', { class: 'drilltag' }, 'DRILL \u00b7 practice only \u2014 respond as you would for real') : null,
      h('div', { class: 'row between' },
        h('h3', {}, a.mine ? (a.drill ? 'Your drill is running' : 'Your alert is active') : `${KIND[a.kind] || 'ALERT'} \u2014 ${a.sender}`),
        a.escalated ? h('span', { class: 'pill danger' }, 'Escalated') : null),
      where ? h('p', { class: 'where' }, where) : null,
      h('p', { class: 'muted' }, `${a.mine ? KIND[a.kind] + ' \u00b7 ' : ''}Sent ${ago(a.createdAt)} \u00b7 ${a.acked.length}/${a.recipients} responding${a.acked.length ? ` (${a.acked.join(', ')})` : ''}${a.firstAckSecs != null && (a.mine || isCoord()) ? ` \u00b7 first response ${fmtSecs(a.firstAckSecs)}` : ''}`),
      a.loc ? h('p', { class: 'muted small' }, `GPS ±${Math.round(a.loc.acc || 0)} m · `, h('a', { href: mapsLink(a.loc), target: '_blank', rel: 'noopener noreferrer' }, 'open in Maps')) : null,
      a.nearest?.length ? h('p', { class: 'muted small' }, `Nearest: ${a.nearest.map((n) => `${n.name} ${n.m} m`).join(', ')}`) : null,
      h('div', { class: 'row wrap' },
        !a.mine && !a.iAcked ? h('button', { class: 'btn grow', onclick: () => alertAct(a, 'ack') }, 'I’m responding') : null,
        !a.mine && a.iAcked ? h('span', { class: 'ok grow' }, '✓ You’re responding') : null,
        !S.locked && (a.post || a.loc) ? h('button', { class: 'btn secondary', onclick: () => showAlertOnMap(a) }, 'Map') : null,
        canClose && a.drill ? h('button', { class: 'btn secondary', onclick: () => alertAct(a, 'resolve', 'resolved') }, 'End drill') : null,
        canClose && !a.drill ? h('button', { class: 'btn secondary', onclick: () => alertAct(a, 'resolve', 'all_clear') }, 'All clear') : null,
        canClose && !a.drill ? h('button', { class: 'btn secondary', onclick: () => alertAct(a, 'resolve', 'false_alarm') }, 'False alarm') : null)));
  }
}
async function alertAct(a, what, outcome) {
  try {
    if (what === 'ack') await api('POST', `/api/alerts/${a.id}/ack`);
    else await api('POST', `/api/alerts/${a.id}/resolve`, { outcome });
    await loadAlerts();
  } catch (e) { toast(errText(e)); }
}
const getPos = (o) => new Promise((res, rej) => (navigator.geolocation ? navigator.geolocation.getCurrentPosition(res, rej, o) : rej(new Error('nogeo'))));
const posBody = (p) => ({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtSecs = (n) => (n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${n % 60}s`);
// Sends immediately; on a dropped connection it keeps retrying (the server ignores
// duplicates for 2 minutes, so a retry never creates a second alert).
async function sendAlert(opts = {}) {
  if (S.sending) return;
  S.sending = true; S.sendTry = 1; S.sent = null; renderView();
  const quick = share.last ? { coords: { latitude: share.last.lat, longitude: share.last.lon, accuracy: share.last.acc } }
    : await getPos({ enableHighAccuracy: false, maximumAge: 120000, timeout: 1500 }).catch(() => null);
  const body = { ...(quick ? posBody(quick) : {}), ...(opts.drill ? { drill: true, audience: opts.audience || 'duty' } : {}) };
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    S.sendTry = attempt;
    try {
      const r = await api('POST', '/api/alerts', body);
      S.sent = r; await loadAlerts();
      if (!r.duplicate) refineLocation(r.id);
      break;
    } catch (e) {
      const transient = e.code === 'offline' || e.status >= 500;
      if (!transient) { S.sent = { error: errText(e) }; break; }
      if (Date.now() - started > 90000) { S.sent = { error: 'Could not reach the server for 90 seconds. Use your radio or call 911 now.' }; break; }
      S.sent = { error: `No connection — retrying (attempt ${attempt})… Use your radio or call 911 if you can.` };
      renderView();
      await sleep(Math.min(2000 * attempt, 8000));
    }
  }
  S.sending = false; renderView();
}
function startDrill() {
  let audience = 'duty';
  const opt = (val, label, sub) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'aud', value: val, checked: val === 'duty', onchange: () => { audience = val; } }), h('span', {}, label, h('small', { class: 'muted', style: null }, ` — ${sub}`)));
  const s = sheet('Run a practice drill',
    h('p', {}, 'Sends a clearly labelled DRILL alert through the real alert path, so you can check that phones get it and see how fast people respond.'),
    opt('duty', 'On-duty team', 'whoever is on shift now (everyone if nobody is)'),
    opt('all', 'Whole team', 'every active member'),
    h('p', { class: 'muted small' }, 'Tell the team before the first drill. Drills are not available during Shabbat / Yom Tov.'),
    h('p', {}, h('button', { class: 'btn block warnbtn', onclick: () => { s.close(); go('now'); sendAlert({ drill: true, audience }); } }, 'Send DRILL alert')));
}
function reachLine(r) {
  if (!r?.reach) return null;
  const { live, push, unreachable } = r.reach;
  const parts = [live && `${live} with the app open`, push && `${push} by notification`].filter(Boolean);
  return [
    h('p', { class: 'muted small' }, parts.length ? `Delivered: ${parts.join(', ')}.` : 'Nobody had the app open or notifications on.'),
    unreachable ? h('p', { class: 'warn small' }, `${unreachable} teammate${unreachable === 1 ? '' : 's'} couldn’t be reached (app closed and notifications off). Use your radio.`) : null,
  ];
}
async function refineLocation(id) {
  for (let i = 0; i < 2; i++) {
    try { const p = await getPos({ enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }); await api('POST', `/api/alerts/${id}/location`, posBody(p)); await loadAlerts(); return; } catch { /* retry */ }
  }
}
async function setAlertKind(kind) {
  if (!S.sent?.id) return;
  S.sent.kind = kind; renderView();
  try { await api('POST', `/api/alerts/${S.sent.id}/kind`, { kind }); await loadAlerts(); } catch (e) { toast(errText(e)); }
}

// ---------- quick messages ----------
const QUICK = [
  ['all_good', 'All good', 0], ['relief', 'Need relief', 0], ['crowd', 'Crowd building', 1], ['suspicious', 'Suspicious', 1],
  ['medical', 'Medical', 2], ['lost_child', 'Lost child', 2], ['backup', 'Need backup', 2], ['note', 'Note…', 0],
];
async function sendQuick(kind) {
  let text = null;
  if (kind === 'note') {
    const ta = h('textarea', { maxlength: 500, rows: 3, placeholder: 'Short note for the team' });
    const s = sheet('Note to the team', ta, h('p', {}, h('button', { class: 'btn block', onclick: async () => { if (!ta.value.trim()) return; s.close(); await postQuick('note', ta.value.trim()); } }, 'Send')));
    ta.focus();
    return;
  }
  await postQuick(kind, text);
}
async function postQuick(kind, text) {
  const body = { kind, text, eventId: S.myEvent?.id };
  if (S.myEvent && share.last) Object.assign(body, { lat: share.last.lat, lon: share.last.lon });
  try { await api('POST', '/api/messages', body); toast('Sent'); buzz(0); await loadFeed(); renderFeedBoxes(); if (S.myEvent) S.myEvent.me.lastCheckin = new Date().toISOString(); updateEventCard(); }
  catch (e) { toast(errText(e)); }
}
function feedList(items, max) {
  if (!items.length) return h('p', { class: 'muted small' }, 'No messages yet.');
  return h('div', { class: 'feed' }, items.slice(0, max).map((m) => h('div', { class: `msg lvl${m.level}` },
    h('div', { class: 'row between' }, h('strong', {}, m.label), h('span', { class: 'muted small' }, ago(m.createdAt))),
    h('div', { class: 'muted small' }, [m.sender, m.post].filter(Boolean).join(' · ')),
    m.text ? h('div', {}, m.text) : null)));
}
function renderFeedBoxes() { for (const box of document.querySelectorAll('[data-feed]')) clear(box).append(feedList(S.feed, +box.dataset.feed)); }

// ---------- Now ----------
function nowView(v) {
  const li = lockInfo();
  if (S.locked) {
    v.append(h('div', { class: 'card lockcard' }, h('h3', {}, 'Shabbat / Yom Tov mode'),
      h('p', { class: 'muted' }, `Routine features are locked until ${fmtLock(li.until)}. Silent alerts and the emergency card stay available.`)));
  } else {
    if (isCoord() && store.get('setupHidden') !== '1') { const sb = h('div', {}); v.append(sb); setupChecklist(sb); }
    const rb = h('div', {}); v.append(rb); readinessBanner(rb);
    v.append(h('div', { id: 'eventcard' }));
    updateEventCard();
  }
  v.append(h('div', { class: 'sos-wrap' + (S.myEvent?.active ? ' compact' : '') }, h('button', { class: 'sos', disabled: S.sending, onclick: sendAlert, 'aria-label': 'Send silent alert' },
    h('span', {}, S.sending ? (S.sendTry > 1 ? `Retrying\u2026 (${S.sendTry})` : 'Sending\u2026') : 'SILENT ALERT', h('small', {}, 'One tap \u00b7 notifies your team with your post and location')))));
  if (S.sent) {
    if (S.sent.error) v.append(h('p', { class: 'err', role: 'alert' }, S.sent.error));
    else {
      v.append(h('div', { class: 'card' + (S.sent.drill ? ' drillcard' : '') }, h('h3', {}, S.sent.drill ? '\u2713 Drill sent' : '\u2713 Alert sent'),
        h('p', { class: 'muted' }, `${S.sent.notified} teammate${S.sent.notified === 1 ? '' : 's'} notified${S.sent.post ? ` \u00b7 ${S.sent.post}` : ''}.`),
        reachLine(S.sent),
        h('p', { class: 'muted small' }, 'Add what\u2019s happening (optional):'),
        h('div', { class: 'chips' }, Object.entries(KIND).filter(([k]) => k !== 'help').map(([k, label]) =>
          h('button', { class: 'chip' + (S.sent.kind === k ? ' on' : ''), 'aria-pressed': String(S.sent.kind === k), onclick: () => setAlertKind(k) }, label)))));
    }
  }
  v.append(h('div', { class: 'row' },
    h('button', { class: 'btn danger-outline grow', onclick: showEmergency }, 'Emergency info · 911'),
    !S.locked ? h('button', { class: 'btn secondary', onclick: () => go('map') }, 'View map') : h('button', { class: 'btn secondary', onclick: () => showPlanModal() }, 'Floor plan')));
  if (S.locked) return;
  if (isCoord()) v.append(h('p', {}, h('button', { class: 'linkbtn', onclick: startDrill }, 'Run a practice drill \u203a')));
  v.append(h('h2', {}, 'Quick message'), h('div', { class: 'quick' }, QUICK.map(([k, label, lvl]) => h('button', { class: `qbtn lvl${lvl}`, onclick: () => sendQuick(k) }, label))));
  v.append(h('h2', {}, S.myEvent ? `${S.myEvent.name} — team feed` : 'Team feed'), h('div', { 'data-feed': '6' }));
  loadFeed().then(renderFeedBoxes);
}

function updateEventCard() {
  const box = $('#eventcard'); if (!box) return;
  clear(box);
  const ev = S.myEvent;
  if (ev?.active) {
    const myZone = ev.zones.find((z) => z.id === ev.me.zoneId);
    const due = ev.checkinMins && ev.me.zoneId ? (ev.me.lastCheckin ? Date.parse(ev.me.lastCheckin) : Date.now() - ev.checkinMins * 60000) + ev.checkinMins * 60000 : null;
    const late = due && Date.now() > due;
    box.append(h('div', { class: 'card nowcard' + (late ? ' late' : '') },
      h('div', { class: 'row between' }, h('h3', {}, ev.name), h('span', { class: 'muted small' }, `until ${fmtTime(ev.endsAt)}`)),
      h('div', { class: 'facts' },
        fact('Zone', myZone ? myZone.name : (ev.isLead ? 'Event lead' : '—')),
        fact('Radio', myZone?.radio || ev.radio || '—'),
        fact('Lead', myZone?.lead || ev.lead || '—')),
      !ev.me.acked ? h('button', { class: 'btn block', onclick: () => showBriefing(ev) }, 'Read the briefing') : null,
      h('div', { class: 'row wrap' },
        due ? h('button', { class: 'btn grow' + (late ? ' danger' : ' secondary'), onclick: checkIn }, late ? 'Check in now' : `Check in · due ${fmtTime(due)}`) : null,
        ev.positions !== 'off' ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: ev.me.sharing, onchange: (e) => toggleSharing(e.target.checked) }), 'Share my location') : null),
      ev.me.acked ? h('button', { class: 'linkbtn', onclick: () => showBriefing(ev) }, 'Briefing & contacts') : null));
    if (late && !updateEventCard.buzzed) { buzz(1); updateEventCard.buzzed = true; }
    if (!late) updateEventCard.buzzed = false;
    return;
  }
  // otherwise: my current or next building shift
  api('GET', '/api/shifts').then((rows) => {
    const t = Date.now();
    const cur = rows.find((r) => r.mine && Date.parse(r.starts_at) <= t && Date.parse(r.ends_at) > t);
    const next = rows.filter((r) => r.mine && Date.parse(r.starts_at) > t).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
    const s = cur || next;
    box.append(h('div', { class: 'card nowcard' }, s
      ? [h('div', { class: 'row between' }, h('h3', {}, cur ? `On duty · ${s.post}` : `Next: ${s.post}`), s.event ? h('span', { class: 'pill' }, s.event) : null),
        h('p', { class: 'muted' }, cur ? `Until ${fmtTime(s.ends_at)}${s.radio ? ` · Radio ${s.radio}` : ''}` : `${fmtDay(s.starts_at)} · ${fmtTime(s.starts_at)}–${fmtTime(s.ends_at)}`)]
      : h('p', { class: 'muted' }, 'You’re not on duty and have no upcoming shifts.')));
  }).catch(() => {});
}
setInterval(() => { if (S.tab === 'now' && S.myEvent?.active && !document.querySelector('.sheet-wrap')) updateEventCard(); }, 30000);
const fact = (k, v) => h('div', { class: 'fact' }, h('span', { class: 'muted small' }, k), h('strong', {}, v));

async function checkIn() {
  try { await api('POST', `/api/events/${S.myEvent.id}/checkin`); S.myEvent.me.lastCheckin = new Date().toISOString(); buzz(0); toast('Checked in'); updateEventCard(); } catch (e) { toast(errText(e)); }
}
async function toggleSharing(on) {
  try {
    if (on) await getPos({ timeout: 15000 }).catch(() => { throw new ApiError(0, 'location_denied'); });
    await api('POST', `/api/events/${S.myEvent.id}/sharing`, { on });
    S.myEvent.me.sharing = on; syncSharing(); toast(on ? 'Sharing your location until the event ends' : 'Location sharing off');
  } catch (e) { toast(e.code === 'location_denied' ? 'Allow location access for this app first.' : errText(e)); }
  updateEventCard();
}
function showBriefing(ev) {
  const s = sheet(`${ev.name} — briefing`,
    h('p', { class: 'muted small' }, `${fmtShort(ev.startsAt)} – ${fmtTime(ev.endsAt)} · ${ev.site}${ev.radio ? ` · Radio ${ev.radio}` : ''}`),
    h('div', { class: 'briefing' }, ev.briefing || 'No briefing text.'),
    ev.contacts.length ? [h('h2', {}, 'Contacts'), ev.contacts.map((c) => h('a', { class: 'btn secondary block callbtn', href: `tel:${c.phone.replace(/[^0-9+]/g, '')}` }, `${c.label} · ${c.phone}`))] : null,
    !ev.me.acked ? h('p', {}, h('button', { class: 'btn block', onclick: async () => {
      try { await api('POST', `/api/events/${ev.id}/ack`); ev.me.acked = true; ev.me.lastCheckin = new Date().toISOString(); s.close(); updateEventCard(); } catch (e) { toast(errText(e)); }
    } }, 'I’ve read it')) : null);
}

// ---------- setup checklist (admins & coordinators) ----------
const SETUP_STEPS = [
  ['basics', 'Congregation details', 'Name, location, time zone, Shabbat lock', () => go('more', 'settings'), true],
  ['emergency', 'Emergency card', 'Address and what to say to 911', () => go('more', 'emergency-edit'), true],
  ['posts', 'Add your posts', 'Main entrance, side door, lobby\u2026', () => go('more', 'team')],
  ['team', 'Invite your team', 'Create one-time invite codes', () => go('more', 'team')],
  ['floorplan', 'Photograph the floor plan', 'The evacuation map on your wall works', () => go('map', null, { siteId: S.mainSiteId, eventId: null, edit: false })],
  ['pins', 'Pin exits, AED & your posts', 'Map \u203a Edit layout', () => go('map', null, { siteId: S.mainSiteId, eventId: null, edit: true })],
  ['schedule', 'Schedule shifts', 'Who is at which post, and when', () => go('schedule')],
  ['push', 'Turn on alerts on this phone', 'So alerts reach you when the app is closed', () => go('more', 'notifications')],
];
async function setupChecklist(box) {
  let steps;
  try { steps = (await api('GET', '/api/setup')).steps; } catch { return; }
  const pushOn = await pushState().then((st) => st === 'on').catch(() => false);
  const done = new Set(steps.filter((x) => x.done).map((x) => x.id));
  if (pushOn) done.add('push');
  const total = SETUP_STEPS.length, n = SETUP_STEPS.filter(([id]) => done.has(id)).length;
  const hide = () => { store.set('setupHidden', '1'); box.remove(); toast('Checklist hidden \u2014 bring it back from More'); };
  if (n === total) {
    box.append(h('div', { class: 'card setupcard' }, h('div', { class: 'row between' }, h('h3', {}, '\u2713 You\u2019re all set up'), h('button', { class: 'linkbtn', onclick: hide }, 'Hide'))));
    return;
  }
  // Compact by default so the silent-alert button stays on screen; expand to see every step.
  const collapsed = store.get('setupCollapsed') !== '0';
  const next = SETUP_STEPS.find(([id, , , , adminOnly]) => !done.has(id) && (!adminOnly || isAdmin()));
  const bar = h('span', {}); bar.style.width = `${Math.round((n / total) * 100)}%`;
  const list = h('div', { class: 'steps', hidden: collapsed || null }, SETUP_STEPS.map(([id, label, hint, open, adminOnly], i) => {
    const ok = done.has(id), blocked = adminOnly && !isAdmin() && !ok;
    return h('button', { class: 'step' + (ok ? ' done' : ''), disabled: blocked || null, onclick: open },
      h('span', { class: 'tick' + (ok ? ' done' : '') }, ok ? '\u2713' : String(i + 1)),
      h('span', { class: 'grow' }, h('span', { class: 'lbl' }, label), h('small', { class: 'muted' }, blocked ? 'Ask an admin to do this' : hint)),
      ok || blocked ? null : h('span', { class: 'chev', 'aria-hidden': 'true' }, '\u203a'));
  }));
  const nextBtn = next ? h('button', { class: 'step next', hidden: !collapsed || null, onclick: next[3] },
    h('span', { class: 'tick' }, String(SETUP_STEPS.indexOf(next) + 1)),
    h('span', { class: 'grow' }, h('small', { class: 'muted' }, 'Next step'), h('span', { class: 'lbl' }, next[1])), h('span', { class: 'chev', 'aria-hidden': 'true' }, '\u203a')) : null;
  const toggle = h('button', { class: 'linkbtn', 'aria-expanded': String(!collapsed), onclick: () => {
    const now = !list.hidden; list.hidden = now; if (nextBtn) nextBtn.hidden = !now; store.set('setupCollapsed', now ? '1' : '0'); toggle.textContent = now ? 'All steps' : 'Less'; toggle.setAttribute('aria-expanded', String(!now));
  } }, collapsed ? 'All steps' : 'Less');
  box.append(h('div', { class: 'card setupcard' },
    h('div', { class: 'row between' }, h('h3', {}, `Get set up \u00b7 ${n} of ${total}`), h('div', { class: 'row' }, toggle, h('button', { class: 'linkbtn', onclick: hide }, 'Hide'))),
    h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(n) }, bar),
    nextBtn, list));
}

async function readinessBanner(box) {
  try {
    const r = await api('GET', '/api/readiness');
    if (!r.window || Date.parse(r.window.start) - serverNow() > 48 * 3600000) return;
    const unconf = r.mine.filter((s) => !s.confirmed);
    if (isCoord() && (r.gaps.length || r.unconfirmed)) {
      box.append(h('div', { class: 'card warncard' }, h('h3', {}, `Before the lock at ${fmtLock(Date.parse(r.window.start))}`),
        h('p', { class: 'muted' }, [r.gaps.length ? `Uncovered: ${r.gaps.join(', ')}.` : '', r.unconfirmed ? ` ${r.unconfirmed} shift${r.unconfirmed === 1 ? '' : 's'} not yet confirmed.` : ''].join('')),
        h('button', { class: 'btn small', onclick: () => go('schedule') }, 'Open schedule')));
    }
    for (const s of unconf) {
      box.append(h('div', { class: 'card warncard' }, h('h3', {}, 'Confirm your shift'),
        h('p', { class: 'muted' }, `${s.post} · ${fmtShort(s.startsAt)}–${fmtTime(s.endsAt)}`),
        h('button', { class: 'btn small', onclick: async (e) => { try { await api('POST', `/api/shifts/${s.id}/confirm`); e.target.closest('.card').remove(); toast('Confirmed'); } catch (x) { toast(errText(x)); } } }, 'I’ll be there')));
    }
  } catch { /* locked or none */ }
}

// ---------- emergency card (works during the lock) ----------
async function showEmergency() {
  let e;
  try { e = await api('GET', '/api/emergency'); } catch (x) { return toast(errText(x)); }
  const tel = (p) => `tel:${p.replace(/[^0-9+]/g, '')}`;
  const TYPE = { exit: 'Exit', aed: 'AED', kit: 'First aid / bleed kit', rally: 'Rally point', fire: 'Fire equipment', door: 'Door', stairs: 'Stairs' };
  sheet('Emergency',
    h('a', { class: 'btn danger block big', href: 'tel:911' }, 'Call 911'),
    e.script || e.address ? h('div', { class: 'script' }, h('div', { class: 'muted small' }, 'Read this to the dispatcher:'), h('p', {}, e.script || `This is ${e.name} at ${e.address}.`)) : h('p', { class: 'muted' }, 'Ask an admin to add your address and 911 script (More › Emergency card).'),
    e.contacts.length ? [h('h2', {}, 'Contacts'), e.contacts.map((c) => h('a', { class: 'btn secondary block callbtn', href: tel(c.phone) }, `${c.label} · ${c.phone}`))] : null,
    e.procedures ? [h('h2', {}, 'Procedures'), h('div', { class: 'briefing' }, e.procedures)] : null,
    e.pins.length ? [h('h2', {}, 'Safety equipment & exits'), h('div', { class: 'card' }, e.pins.map((p) => h('div', { class: 'shift' }, h('span', { class: 'pill' }, TYPE[p.type] || p.type), h('span', { class: 'grow' }, p.label, p.notes ? h('span', { class: 'muted small' }, ` — ${p.notes}`) : null))))] : null,
    e.hasPlan ? h('p', {}, h('button', { class: 'btn secondary block', onclick: () => showPlanModal() }, 'View floor plan')) : null);
}
async function showPlanModal(siteId = S.mainSiteId) {
  let site;
  try { site = await api('GET', `/api/sites/${siteId}`); } catch (x) { return toast(errText(x)); }
  const box = h('div', { class: 'map-box tall' });
  const s = sheet(site.name, box, h('p', { class: 'muted small' }, 'Pinch to zoom. Tap a pin for details.'));
  const ctl = MishMap.render(box, site, { tileUrl: S.tileUrl, osmEnabled: S.osmEnabled, onPinClick: (k, item) => pinDetails(site, k, item, null) });
  s.addEventListener('closed', () => ctl.destroy());
}

// ---------- schedule ----------
function scheduleView(v) {
  v.append(h('h2', {}, 'Schedule'));
  const ready = h('div', {}); v.append(ready);
  const list = h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading…'));
  Promise.all([api('GET', '/api/shifts'), isCoord() ? api('GET', '/api/posts') : [], isCoord() ? api('GET', '/api/team') : [], api('GET', '/api/readiness').catch(() => ({ window: null }))]).then(([shifts, posts, team, rd]) => {
    if (rd.window && Date.parse(rd.window.start) - serverNow() < 7 * 86400000) ready.append(readinessCard(rd, () => { clear(v); scheduleView(v); }));
    if (isCoord()) v.insertBefore(shiftForm(posts, team.filter((u) => u.active), () => { clear(v); scheduleView(v); }), list);
    clear(list);
    if (!shifts.length) return list.append(h('p', { class: 'muted' }, 'No shifts scheduled yet.'));
    let day = '';
    for (const s of shifts) {
      const d = fmtDay(s.starts_at);
      if (d !== day) { day = d; list.append(h('h3', { class: 'dayh' }, d)); }
      list.append(h('div', { class: 'shift' + (s.mine ? ' mine' : '') },
        h('div', { class: 't' }, `${fmtTime(s.starts_at)}–${fmtTime(s.ends_at)}`),
        h('div', { class: 'grow' }, h('div', {}, s.post, s.event ? h('span', { class: 'pill tiny' }, s.event) : null),
          h('div', { class: 'who muted' }, s.mine ? `${s.person} (you)` : s.person, s.confirmed_at ? ' · ✓ confirmed' : '')),
        isCoord() ? h('button', { class: 'x', 'aria-label': 'Remove shift', onclick: async () => { try { await api('DELETE', `/api/shifts/${s.id}`); clear(v); scheduleView(v); } catch (e) { toast(errText(e)); } } }, '×') : null));
    }
  }).catch((e) => { clear(list).append(h('p', { class: 'err' }, errText(e))); });
  v.append(list);
}
function readinessCard(r, redo) {
  const card = h('div', { class: 'card warncard' }, h('h3', {}, `Readiness — lock starts ${fmtLock(Date.parse(r.window.start))}`));
  if (isCoord()) {
    card.append(h('p', { class: 'muted' }, r.gaps.length ? `Uncovered posts: ${r.gaps.join(', ')}` : '✓ Every post has someone scheduled.'),
      h('p', { class: 'muted' }, r.unconfirmed ? `${r.unconfirmed} shift${r.unconfirmed === 1 ? '' : 's'} awaiting confirmation.` : '✓ All shifts confirmed.'));
  }
  for (const s of r.mine) {
    card.append(h('div', { class: 'row between shift' }, h('span', {}, `${s.post} · ${fmtShort(s.startsAt)}`),
      s.confirmed ? h('span', { class: 'ok' }, '✓ Confirmed') : h('button', { class: 'btn small', onclick: async () => { try { await api('POST', `/api/shifts/${s.id}/confirm`); redo(); } catch (e) { toast(errText(e)); } } }, 'Confirm')));
  }
  return card;
}
function shiftForm(posts, team, done, defaults = {}) {
  const err = h('p', { class: 'err' });
  const start = defaults.start ? new Date(defaults.start) : (() => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; })();
  const end = defaults.end ? new Date(defaults.end) : new Date(start.getTime() + 2 * 3600000);
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/shifts', { postId: +f.post.value, userId: +f.person.value, startsAt: new Date(f.s.value).toISOString(), endsAt: new Date(f.e.value).toISOString() }); done(); }
    catch (x) { err.textContent = errText(x); }
  } },
    h('label', {}, defaults.zoneLabel || 'Post'), h('select', { name: 'post', required: true }, posts.map((p) => h('option', { value: p.id }, p.name))),
    h('label', {}, 'Person'), h('select', { name: 'person', required: true }, team.map((u) => h('option', { value: u.id }, u.name))),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', {}, 'Starts'), h('input', { name: 's', type: 'datetime-local', value: localInput(start), required: true })),
      h('div', { class: 'grow' }, h('label', {}, 'Ends'), h('input', { name: 'e', type: 'datetime-local', value: localInput(end), required: true }))),
    err, h('p', {}, h('button', { class: 'btn block', type: 'submit', disabled: !posts.length }, posts.length ? 'Assign' : 'Add a post first (More › Team & posts)')));
  return h('details', { class: 'card', open: defaults.open || null }, h('summary', {}, defaults.title || '+ Assign a shift'), f);
}

// ---------- report ----------
async function shrinkImage(file, maxEdge = 1600, q = 0.8) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);   // re-encoding drops EXIF / GPS metadata
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
  return { blob, w: c.width, h: c.height, panorama: bmp.width / bmp.height >= 2.2 };
}
function reportView(v) {
  v.append(h('h2', {}, 'Report an incident'));
  const err = h('p', { class: 'err', role: 'alert' }), okmsg = h('p', { class: 'ok' });
  const preview = h('img', { class: 'thumb', hidden: true, alt: 'Photo preview' });
  let photo = null;
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; okmsg.textContent = '';
    const fd = new FormData();
    fd.append('description', f.description.value); fd.append('occurredAt', new Date(f.when.value).toISOString());
    if (f.post.value) fd.append('postId', f.post.value);
    if (photo) fd.append('photo', photo, 'photo.jpg');
    f.go.disabled = true;
    const done = (msg) => { f.reset(); photo = null; preview.hidden = true; f.when.value = localInput(new Date()); okmsg.textContent = msg; };
    try { await api('POST', '/api/incidents', undefined, fd); done('\u2713 Report submitted.'); loadMine(); }
    catch (x) {
      if (x.code === 'offline' || x.status >= 500) {
        try {
          await outbox.add({ description: f.description.value, occurredAt: new Date(f.when.value).toISOString(), postId: f.post.value || null, photo, queuedAt: Date.now() });
          done('Saved on this phone. It will send automatically when you\u2019re back online.'); renderOutboxNote();
        } catch { err.textContent = 'You\u2019re offline and this phone can\u2019t store the report. Write it down and submit later.'; }
      } else err.textContent = errText(x);
    }
    f.go.disabled = false;
  } },
    h('label', { for: 'desc' }, 'What happened?'), h('textarea', { id: 'desc', name: 'description', maxlength: 4000, required: true }),
    h('label', { for: 'when' }, 'When'), h('input', { id: 'when', name: 'when', type: 'datetime-local', value: localInput(new Date()), required: true }),
    h('label', { for: 'post' }, 'Post / zone (optional)'), h('select', { id: 'post', name: 'post' }, h('option', { value: '' }, '—'),
      (S.myEvent?.zones || []).map((z) => h('option', { value: z.id, selected: z.id === S.myEvent.me.zoneId || null }, `${z.name} (${S.myEvent.name})`))),
    h('label', { for: 'ph' }, 'Photo (optional)'),
    h('input', { id: 'ph', type: 'file', accept: 'image/*', capture: 'environment', onchange: async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try { photo = (await shrinkImage(file)).blob; preview.src = URL.createObjectURL(photo); preview.hidden = false; } catch { err.textContent = 'Could not read that photo.'; }
    } }),
    preview, err, okmsg, h('p', {}, h('button', { class: 'btn block', name: 'go', type: 'submit' }, 'Submit report')));
  v.append(h('div', { id: 'outboxnote' }), h('div', { class: 'card' }, f));
  renderOutboxNote();
  api('GET', '/api/posts').then((ps) => ps.forEach((p) => $('#post')?.append(h('option', { value: p.id }, p.name)))).catch(() => {});
  const mine = h('div', {});
  async function loadMine() {
    if (isCoord()) return;
    try { const rows = await api('GET', '/api/incidents'); clear(mine).append(h('h2', {}, 'My recent reports'), ...(rows.length ? rows.map(incidentCard) : [h('p', { class: 'muted' }, 'None yet.')])); } catch { /* ignore */ }
  }
  v.append(mine); loadMine();
}
// Reports written with no signal wait in IndexedDB on this phone and send on reconnect.
// They're cleared from the phone as soon as they're delivered (and on sign-out).
const outbox = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mishmar', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => { const t = d.transaction('outbox', mode); const q = fn(t.objectStore('outbox')); t.oncomplete = () => { d.close(); res(q?.result); }; t.onerror = () => rej(t.error); });
  },
  add(item) { return this.run('readwrite', (st) => st.add(item)); },
  all() { return this.run('readonly', (st) => st.getAll()).catch(() => []); },
  del(id) { return this.run('readwrite', (st) => st.delete(id)); },
  clear() { return this.run('readwrite', (st) => st.clear()).catch(() => {}); },
};
let flushing = false;
async function flushOutbox() {
  if (flushing || !S.me || S.locked || !('indexedDB' in window)) return;
  flushing = true;
  try {
    for (const item of await outbox.all()) {
      const fd = new FormData();
      fd.append('description', item.description); fd.append('occurredAt', item.occurredAt);
      if (item.postId) fd.append('postId', item.postId);
      if (item.photo) fd.append('photo', item.photo, 'photo.jpg');
      try { await api('POST', '/api/incidents', undefined, fd); await outbox.del(item.id); toast('Queued report sent'); }
      catch (e) {
        if (e.code === 'offline' || e.status >= 500 || e.status === 423) break;   // try again later
        await outbox.del(item.id); toast(`A queued report was rejected: ${errText(e)}`);
      }
    }
  } finally { flushing = false; renderOutboxNote(); }
}
setInterval(flushOutbox, 30000);
async function renderOutboxNote() {
  const box = $('#outboxnote'); if (!box) return;
  const n = (await outbox.all()).length;
  clear(box);
  if (n) box.append(h('div', { class: 'card warncard' }, h('strong', {}, `${n} report${n === 1 ? '' : 's'} waiting to send`), h('p', { class: 'muted small' }, 'Stored on this phone until you’re back online.'), h('button', { class: 'btn small secondary', onclick: flushOutbox }, 'Try now')));
}

function incidentCard(i) {
  const body = h('div', {});
  const desc = h('p', {}, i.description);
  const card = h('div', { class: 'card clickable' }, h('div', { class: 'row between' }, h('strong', {}, `${fmtDay(i.occurredAt)} ${fmtTime(i.occurredAt)}`), i.hasPhoto ? h('span', { class: 'pill' }, 'photo') : null),
    h('div', { class: 'muted' }, `${i.reporter}${i.post ? ` · ${i.post}` : ''}`), desc, body);
  let open = false;
  card.addEventListener('click', async () => {
    if (open) return; open = true;
    try {
      const full = await api('GET', `/api/incidents/${i.id}`);
      desc.textContent = full.description;
      if (full.hasPhoto) body.append(h('img', { class: 'photo', src: `/api/incidents/${i.id}/photo`, alt: 'Incident photo' }));
      body.append(h('div', { class: 'muted' }, `Logged ${fmtDay(full.createdAt)} ${fmtTime(full.createdAt)}`));
      if (isAdmin()) body.append(h('p', {}, h('button', { class: 'btn small danger', onclick: async (e) => { e.stopPropagation(); if (confirm('Delete this report permanently?')) { await api('DELETE', `/api/incidents/${i.id}`); card.remove(); } } }, 'Delete report')));
    } catch { open = false; }
  });
  return card;
}
