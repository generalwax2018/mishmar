// Service worker: caches only the static app shell (never API responses, so no
// member, schedule, location or incident data is ever written to the cache), and
// shows push notifications for alerts.
const SHELL = 'mishmar-shell-v5';
const FILES = ['/', '/style.css', '/app.js', '/pages.js', '/map.js', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/qrcode/qrcode.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // stale-while-revalidate for the shell
  e.respondWith(caches.open(SHELL).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { /* generic */ }
  const isAlert = d.type === 'alert';
  // Distinct vibration per urgency so a guard can tell what arrived without looking.
  const vibrate = isAlert ? [300, 150, 300, 150, 600, 200, 600] : d.level === 2 ? [400, 150, 400, 150, 400] : d.level === 1 ? [200, 100, 200] : [120];
  e.waitUntil(self.registration.showNotification(d.title || 'Mishmar', {
    body: d.body || 'Open the app.',
    tag: d.type === 'message' ? `msg-${d.id}` : `alert-${d.id || 'x'}`,
    renotify: true,
    requireInteraction: isAlert || d.level === 2,
    vibrate,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return self.clients.openWindow('/');
  }));
});
