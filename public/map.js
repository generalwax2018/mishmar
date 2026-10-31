'use strict';
// Map rendering on top of Leaflet (served from our own origin). Two base types:
//  - "image": a floor plan / site map photo, in pixel coordinates (L.CRS.Simple).
//    GPS positions are placed on it via a 2-point calibration (similarity transform).
//  - "osm": a street map (OpenStreetMap tiles), only when an admin has enabled it.
// All labels and popups are built as DOM elements with textContent (never HTML strings).

const PIN = {
  post: { glyph: 'P', cls: 'pin-post', name: 'Post' },
  zone: { glyph: 'Z', cls: 'pin-post', name: 'Zone' },
  door: { glyph: 'D', cls: 'pin-door', name: 'Door / entrance' },
  exit: { glyph: 'EXIT', cls: 'pin-exit', name: 'Emergency exit' },
  aed: { glyph: 'AED', cls: 'pin-aed', name: 'AED' },
  kit: { glyph: '+', cls: 'pin-aed', name: 'First aid / bleed kit' },
  rally: { glyph: 'R', cls: 'pin-exit', name: 'Rally point' },
  fire: { glyph: 'F', cls: 'pin-fire', name: 'Fire extinguisher / alarm' },
  stairs: { glyph: 'S', cls: 'pin-door', name: 'Stairs' },
  camera: { glyph: 'C', cls: 'pin-door', name: 'Camera' },
  hazard: { glyph: '!', cls: 'pin-fire', name: 'Hazard / blind spot' },
  note: { glyph: 'i', cls: 'pin-door', name: 'Note' },
};
const PIN_TYPES = ['door', 'exit', 'aed', 'kit', 'rally', 'fire', 'stairs', 'camera', 'hazard', 'note'];

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function pinIcon(type, extra = '') {
  const p = PIN[type] || PIN.note;
  const d = el('div', `pin ${p.cls} ${extra}`.trim(), p.glyph);
  const wide = p.glyph.length > 2;
  return L.divIcon({ html: d, className: 'pin-wrap', iconSize: wide ? [40, 24] : [28, 28], iconAnchor: wide ? [20, 12] : [14, 14] });
}
function dotIcon(initials, cls) {
  return L.divIcon({ html: el('div', `dot ${cls}`, initials), className: 'pin-wrap', iconSize: [30, 30], iconAnchor: [15, 15] });
}
const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

// ---- complex helpers for the 2-point calibration ----
const C = {
  sub: (a, b) => ({ re: a.re - b.re, im: a.im - b.im }),
  add: (a, b) => ({ re: a.re + b.re, im: a.im + b.im }),
  mul: (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }),
  div: (a, b) => { const d = b.re * b.re + b.im * b.im; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }; },
};
function makeCalibration(calib) {
  if (!calib || calib.length !== 2) return null;
  const [p1, p2] = calib;
  const cos = Math.cos((p1.lat * Math.PI) / 180);
  const toW = (lat, lon) => ({ re: (lon - p1.lon) * cos * 111320, im: (lat - p1.lat) * 110540 });
  const z1 = { re: p1.x, im: -p1.y }, z2 = { re: p2.x, im: -p2.y };
  const a = C.div(C.sub(z2, z1), toW(p2.lat, p2.lon));
  return (lat, lon) => { const z = C.add(C.mul(a, toW(lat, lon)), z1); return { x: z.re, y: -z.im }; };
}

const MishMap = {
  PIN, PIN_TYPES, initials,
  // opts: { tileUrl, osmEnabled, eventId, onPinClick(kind, item, marker), onMapClick({x,y,lat,lon}), labels:true }
  render(container, site, opts = {}) {
    container.classList.add('map');
    const isImage = site.base === 'image';
    let map, toLL, fromLL;
    if (isImage) {
      const w = site.imageW || 1000, h = site.imageH || 700;
      // Size the box to the plan's shape so it fills the screen instead of floating in empty space.
      const cw = container.clientWidth || 360;
      container.style.height = `${Math.round(Math.max(260, Math.min(window.innerHeight * 0.62, cw * (h / w) + 24)))}px`;
      map = L.map(container, { crs: L.CRS.Simple, minZoom: -4, maxZoom: 3, zoomSnap: 0.25, attributionControl: false });
      const bounds = [[0, 0], [h, w]];
      toLL = (x, y) => L.latLng(h - y, x);
      fromLL = (ll) => ({ x: Math.max(0, Math.min(w, ll.lng)), y: Math.max(0, Math.min(h, h - ll.lat)) });
      if (site.hasImage) L.imageOverlay(`/api/sites/${site.id}/image`, bounds).addTo(map);
      map.fitBounds(bounds);
      map.setMaxBounds(L.latLngBounds(bounds).pad(0.6));
    } else {
      map = L.map(container, { zoomControl: true });
      map.attributionControl.setPrefix(false);
      toLL = (lat, lon) => L.latLng(lat, lon);
      fromLL = (ll) => ({ lat: ll.lat, lon: ll.lng });
      if (opts.osmEnabled) {
        L.tileLayer(opts.tileUrl, { maxZoom: 19, attribution: '© OpenStreetMap contributors', referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(map);
      }
      map.setView([site.lat ?? 39.7392, site.lon ?? -104.9903], site.zoom || 17);
    }
    const gpsToLL = isImage ? (() => { const f = makeCalibration(site.calib); return f ? (lat, lon) => { const p = f(lat, lon); return toLL(p.x, p.y); } : null; })() : (lat, lon) => L.latLng(lat, lon);
    const posOf = (item) => (isImage ? (item.x != null && item.y != null ? toLL(item.x, item.y) : null) : (item.lat != null && item.lon != null ? L.latLng(item.lat, item.lon) : null));

    const fixed = L.layerGroup().addTo(map), live = L.layerGroup().addTo(map), temp = L.layerGroup().addTo(map);
    const label = (m, text) => { if (opts.labels !== false) m.bindTooltip(el('span', '', text), { permanent: true, direction: 'top', offset: [0, -14], className: 'pin-label' }); };

    function drawFixed(s) {
      fixed.clearLayers();
      for (const mk of s.markers || []) {
        const ll = posOf(mk); if (!ll) continue;
        const m = L.marker(ll, { icon: pinIcon(mk.type), keyboard: true, title: mk.label }).addTo(fixed);
        if (['exit', 'aed', 'rally', 'kit'].includes(mk.type)) label(m, mk.label);
        m.on('click', () => opts.onPinClick?.('marker', mk, m));
      }
      for (const p of s.posts || []) {
        const ll = posOf(p); if (!ll) continue;
        const m = L.marker(ll, { icon: pinIcon(p.eventId ? 'zone' : 'post', p.onNow?.length ? 'staffed' : ''), title: p.name }).addTo(fixed);
        label(m, p.onNow?.length ? `${p.name} · ${p.onNow.join(', ')}` : p.name);
        m.on('click', () => opts.onPinClick?.('post', p, m));
      }
    }
    drawFixed(site);
    map.on('click', (e) => opts.onMapClick?.(fromLL(e.latlng), e.latlng));

    let dead = false;
    const ctl = {
      map, isImage, canPlaceGps: !!gpsToLL,
      redraw(s) { drawFixed(s); },
      // live overlays: positions [{name,lat,lon,updatedAt,self}], alerts [{loc,kind,sender}], messages [{loc,label}]
      setLive({ positions = [], alerts = [], messages = [] } = {}) {
        if (dead) return;
        live.clearLayers();
        if (!gpsToLL) return;
        const t = Date.now();
        for (const p of positions) {
          const stale = t - Date.parse(p.updatedAt) > 3 * 60000;
          const m = L.marker(gpsToLL(p.lat, p.lon), { icon: dotIcon(initials(p.name), `${p.self ? 'dot-self' : 'dot-team'}${stale ? ' stale' : ''}`), title: p.name, zIndexOffset: 500 }).addTo(live);
          m.bindTooltip(el('span', '', `${p.name}${p.zone ? ` · ${p.zone}` : ''}${stale ? ' (stale)' : ''}`), { direction: 'top', offset: [0, -14], className: 'pin-label' });
        }
        for (const m of messages) {
          if (!m.loc) continue;
          L.marker(gpsToLL(m.loc.lat, m.loc.lon), { icon: L.divIcon({ html: el('div', 'msgpin', '!'), className: 'pin-wrap', iconSize: [22, 22], iconAnchor: [11, 11] }), title: m.label }).addTo(live)
            .bindTooltip(el('span', '', `${m.label} · ${m.sender}`), { direction: 'top', className: 'pin-label' });
        }
        for (const a of alerts) {
          if (!a.loc) continue;
          L.marker(gpsToLL(a.loc.lat, a.loc.lon), { icon: L.divIcon({ html: el('div', 'alertpin', '!'), className: 'pin-wrap', iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 1000, title: 'Alert' }).addTo(live)
            .bindTooltip(el('span', '', `ALERT · ${a.sender}`), { permanent: true, direction: 'top', offset: [0, -18], className: 'pin-label alert' });
        }
      },
      showTemp(pt) { temp.clearLayers(); if (pt) L.marker(isImage ? toLL(pt.x, pt.y) : L.latLng(pt.lat, pt.lon), { icon: pinIcon('note', 'pending') }).addTo(temp); },
      focus(item) {
        if (dead) return;
        map.invalidateSize();
        container.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const ll = item.loc && gpsToLL ? gpsToLL(item.loc.lat, item.loc.lon) : posOf(item); if (ll) map.setView(ll, Math.max(map.getZoom(), isImage ? 0 : 18)); },
      fitTo(points) { const lls = points.map((p) => (gpsToLL ? gpsToLL(p.lat, p.lon) : null)).filter(Boolean); if (lls.length) map.fitBounds(L.latLngBounds(lls).pad(0.3), { maxZoom: isImage ? 1 : 18 }); },
      resize() { setTimeout(() => { if (!dead) map.invalidateSize(); }, 50); },
      destroy() { dead = true; try { map.stop?.(); map.off(); map.remove(); } catch { /* already gone */ } },
    };
    ctl.resize();
    return ctl;
  },
};
window.MishMap = MishMap;
