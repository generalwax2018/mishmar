'use strict';
// Mishmar front-end, part 2: map & layout survey, events, More pages.

// ======================= MAP =======================
S.mapState = null;   // { siteId, eventId, mode: 'map'|'list', edit }
S.placing = null;    // pending tap-to-place action in the map editor
let mapSite = null, mapEvent = null;

function defaultMapCtx() {
  return S.myEvent?.active ? { siteId: S.myEvent.siteId, eventId: S.myEvent.id } : { siteId: S.mainSiteId, eventId: null };
}
function showAlertOnMap(a) {
  const ctx = a.event ? { siteId: S.myEvent?.id === a.event.id ? S.myEvent.siteId : a.post?.siteId, eventId: a.event.id } : { siteId: a.post?.siteId || S.mainSiteId, eventId: null };
  S.mapState = { ...ctx, mode: 'map', edit: false, focus: a };
  go('map');
}

async function mapView(v) {
  if (S.arg?.siteId) { S.mapState = { mode: 'map', edit: false, ...S.arg }; S.arg = null; }
  if (!S.mapState) S.mapState = { ...defaultMapCtx(), mode: 'map', edit: false };
  const st = S.mapState;
  const head = h('div', { class: 'maphead' }); v.append(head);
  const body = h('div', {}); v.append(body);

  // context chips: building, my event, and (coordinators) every place/event
  const chips = [{ label: 'Building', siteId: S.mainSiteId, eventId: null }];
  try {
    const [sites, events] = await Promise.all([api('GET', '/api/sites'), api('GET', '/api/events')]);
    for (const e of events) chips.push({ label: e.name + (e.active ? ' ●' : ''), siteId: e.siteId, eventId: e.id });
    if (isCoord()) for (const s of sites) if (s.id !== S.mainSiteId && !events.some((e) => e.siteId === s.id)) chips.push({ label: s.name, siteId: s.id, eventId: null });
  } catch { /* locked/offline */ }
  head.append(h('div', { class: 'chips scroll' }, chips.map((c) => h('button', {
    class: 'chip' + (c.siteId === st.siteId && (c.eventId || null) === (st.eventId || null) ? ' on' : ''),
    onclick: () => { S.mapState = { siteId: c.siteId, eventId: c.eventId, mode: st.mode, edit: false }; S.placing = null; go('map'); },
  }, c.label))));
  head.append(h('div', { class: 'row' },
    h('div', { class: 'seg grow', role: 'group' }, ['map', 'list'].map((m) => h('button', { 'aria-pressed': String(st.mode === m), onclick: () => { st.mode = m; go('map'); } }, m === 'map' ? 'Map' : 'List'))),
    isCoord() ? h('button', { class: 'btn small ' + (st.edit ? '' : 'secondary'), onclick: () => { st.edit = !st.edit; S.placing = null; go('map'); } }, st.edit ? 'Done' : 'Edit layout') : null));

  try {
    mapSite = await api('GET', `/api/sites/${st.siteId}${st.eventId ? `?eventId=${st.eventId}` : ''}`);
    mapEvent = st.eventId ? (S.myEvent?.id === st.eventId ? S.myEvent : await api('GET', `/api/events/${st.eventId}`)) : null;
  } catch (e) { return body.append(h('p', { class: 'err' }, errText(e))); }
  if (!v.isConnected || S.tab !== 'map') return;   // user navigated away while loading

  if (st.edit) body.append(editToolbar(mapSite));
  body.append(h('div', { id: 'placebar' }));
  const needsPlan = mapSite.base === 'image' && !mapSite.hasImage;
  if (needsPlan) body.append(setupCard(mapSite));
  if (st.mode === 'map' && !needsPlan) {
    const box = h('div', { class: 'map-box' }); body.append(box);
    if (mapSite.base === 'osm' && !S.osmEnabled) body.append(h('p', { class: 'muted small' }, 'Street maps are turned off by your admin; showing pins only.'));
    S.mapCtl = MishMap.render(box, mapSite, {
      tileUrl: S.tileUrl, osmEnabled: S.osmEnabled,
      // While placing something, tapping an existing pin places at that pin's spot.
      onPinClick: (k, item) => (S.placing ? onMapTap(mapSite.base === 'image' ? { x: item.x, y: item.y } : { lat: item.lat, lon: item.lon }) : pinDetails(mapSite, k, item)),
      onMapClick: (pt) => onMapTap(pt),
    });
    if (mapSite.base === 'image' && !mapSite.calib && mapEvent) body.append(h('p', { class: 'muted small' }, 'Team positions appear on this map after a coordinator calibrates it (Edit layout › Calibrate GPS).'));
    refreshMapLive().then(() => { if (st.focus) { S.mapCtl?.focus(st.focus.loc ? st.focus : st.focus.post || {}); st.focus = null; } });
    body.append(legend());
  }
  if (st.mode === 'list' || needsPlan) body.append(await mapList(mapSite, mapEvent));
  renderPlacebar();
}
function legend() {
  const items = [['post', 'Post / zone'], ['exit', 'Exit'], ['aed', 'AED / kit'], ['rally', 'Rally'], ['fire', 'Fire'], ['door', 'Door']];
  return h('div', { class: 'legend' }, items.map(([t, l]) => h('span', {}, h('span', { class: `pin mini ${MishMap.PIN[t].cls}` }, MishMap.PIN[t].glyph.slice(0, 1)), l)),
    h('span', {}, h('span', { class: 'dot mini dot-team' }, ''), 'Teammate'));
}
async function livePositions() {
  if (!mapEvent || mapEvent.positions === 'off') return [];
  try { return (await api('GET', `/api/events/${mapEvent.id}/positions`)).map((p) => ({ ...p, self: p.userId === S.me.id })); } catch { return []; }
}
async function refreshMapLive() {
  if (!S.mapCtl || !mapSite) return;
  const positions = await livePositions();
  const alerts = S.alerts.filter((a) => a.loc && (mapEvent ? a.event?.id === mapEvent.id : !a.event));
  const msgs = mapEvent ? S.feed.filter((m) => m.eventId === mapEvent.id && m.loc && Date.now() - Date.parse(m.createdAt) < 30 * 60000) : [];
  S.mapCtl?.setLive({ positions, alerts, messages: msgs });
}

async function mapList(site, ev) {
  const box = h('div', {});
  const SAFE = ['exit', 'aed', 'kit', 'rally', 'fire'];
  const safety = site.markers.filter((m) => SAFE.includes(m.type));
  const posts = site.posts.filter((p) => (ev ? p.eventId === ev.id : !p.eventId));
  box.append(h('h2', {}, ev ? 'Zones' : 'Posts'), h('div', { class: 'card' }, posts.length ? posts.map((p) => h('div', { class: 'shift clickable', onclick: () => pinDetails(site, 'post', p) },
    h('div', { class: 'grow' }, h('strong', {}, p.name), h('div', { class: 'muted small' }, p.onNow.length ? `On now: ${p.onNow.join(', ')}` : 'Nobody on now', p.radio ? ` · Radio ${p.radio}` : '', p.lead ? ` · Lead ${p.lead}` : '')),
    p.x == null && p.lat == null ? h('span', { class: 'pill tiny' }, 'not placed') : null)) : h('p', { class: 'muted' }, 'None yet.')));
  const pos = await livePositions();
  if (pos.length) {
    const mine = share.last;
    box.append(h('h2', {}, 'Team positions'), h('div', { class: 'card' }, pos.sort((a, b) => (mine ? distM(mine, a) - distM(mine, b) : 0)).map((p) => h('div', { class: 'shift' },
      h('div', { class: 'grow' }, h('strong', {}, p.self ? `${p.name} (you)` : p.name), h('div', { class: 'muted small' }, [p.zone, `updated ${ago(p.updatedAt)}`].filter(Boolean).join(' · '))),
      mine && !p.self ? h('span', { class: 'pill' }, `${Math.round(distM(mine, p))} m`) : null))));
  }
  box.append(h('h2', {}, 'Safety equipment & exits'), h('div', { class: 'card' }, safety.length ? safety.map((m) => h('div', { class: 'shift clickable', onclick: () => pinDetails(site, 'marker', m) },
    h('span', { class: `pin mini ${MishMap.PIN[m.type].cls}` }, MishMap.PIN[m.type].glyph.slice(0, 3)), h('span', { class: 'grow' }, m.label, m.notes ? h('span', { class: 'muted small' }, ` — ${m.notes}`) : null))) : h('p', { class: 'muted' }, 'None pinned yet.')));
  const others = site.markers.filter((m) => !SAFE.includes(m.type));
  if (others.length) box.append(h('h2', {}, 'Other pins'), h('div', { class: 'card' }, others.map((m) => h('div', { class: 'shift clickable', onclick: () => pinDetails(site, 'marker', m) }, h('span', { class: 'pill tiny' }, MishMap.PIN[m.type]?.name || m.type), h('span', { class: 'grow' }, m.label)))));
  return box;
}

function setupCard(site) {
  if (!isCoord()) return h('div', { class: 'card' }, h('h3', {}, 'No floor plan yet'), h('p', { class: 'muted' }, 'A coordinator can add one by photographing the posted evacuation map.'));
  return h('div', { class: 'card setup' },
    h('h3', {}, site.kind === 'building' ? 'Set up your building layout' : 'Set up this site map'),
    h('ol', {},
      h('li', {}, site.kind === 'building' ? 'Photograph the evacuation map posted in your building (or upload a floor plan). It becomes your base map.' : 'Upload the organizer’s site map or take a photo of it.'),
      h('li', {}, 'Walk the space. At each entrance, exit, AED, first-aid kit and camera, take a photo or panorama and tap where you are on the map.'),
      h('li', {}, 'Place your posts so alerts show exactly where someone is.')),
    imagePickers(site, 'Floor plan'));
}
function imagePickers(site, what) {
  const upload = async (file) => {
    if (!file) return;
    try {
      const { blob } = await shrinkImage(file, 2400, 0.85);
      const fd = new FormData(); fd.append('image', blob, 'plan.jpg');
      await api('POST', `/api/sites/${site.id}/image`, undefined, fd);
      if (site.base !== 'image') await api('PATCH', `/api/sites/${site.id}`, { base: 'image' });
      toast(`${what} saved`); S.mapState.mode = 'map'; go('map');
    } catch (e) { toast(errText(e)); }
  };
  return h('div', { class: 'row wrap' },
    h('label', { class: 'btn' }, `\u{1F4F7} Photograph ${what.toLowerCase()}`, h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'sr', onchange: (e) => upload(e.target.files[0]) })),
    h('label', { class: 'btn secondary' }, 'Upload a file', h('input', { type: 'file', accept: 'image/*', class: 'sr', onchange: (e) => upload(e.target.files[0]) })));
}

// ---- layout editor ----
function editToolbar(site) {
  const pickPhoto = (pano) => h('label', { class: 'btn small secondary' }, pano ? 'Panorama' : '\u{1F4F7} Spot + photo',
    h('input', { type: 'file', accept: 'image/*', capture: pano ? null : 'environment', class: 'sr', onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const img = await shrinkImage(f, pano ? 6000 : 1600, 0.8);
        S.placing = { kind: 'marker', photo: img, pano: pano || img.panorama };
        renderPlacebar();
      } catch { toast('Could not read that photo.'); }
    } }));
  return h('div', { class: 'card toolbar' },
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn small', onclick: () => { S.placing = { kind: 'marker' }; renderPlacebar(); } }, '+ Pin'),
      pickPhoto(false), pickPhoto(true),
      h('button', { class: 'btn small secondary', onclick: () => placePostSheet(site) }, mapEvent ? 'Place a zone' : 'Place a post'),
      site.base === 'image' && site.hasImage ? h('button', { class: 'btn small secondary', onclick: () => { S.placing = { kind: 'calib', pts: [] }; renderPlacebar(); } }, site.calib ? 'Re-calibrate GPS' : 'Calibrate GPS') : null),
    h('details', {}, h('summary', { class: 'small' }, 'Base map'),
      imagePickers(site, site.kind === 'building' ? 'Floor plan' : 'Site map'),
      site.kind === 'outdoor' && S.osmEnabled ? h('p', {}, h('button', { class: 'btn small secondary', onclick: async () => {
        try {
          const p = await getPos({ timeout: 10000 }).catch(() => null);
          await api('PATCH', `/api/sites/${site.id}`, { base: 'osm', lat: site.lat ?? p?.coords.latitude ?? null, lon: site.lon ?? p?.coords.longitude ?? null, zoom: site.zoom || 17 });
          go('map');
        } catch (e) { toast(errText(e)); }
      } }, 'Use the street map instead')) : null),
    h('p', { class: 'muted small' }, 'Tip: for a panorama, use your camera’s Pano mode, then pick it here.'));
}
function renderPlacebar() {
  const bar = $('#placebar'); if (!bar) return;
  clear(bar);
  const p = S.placing; if (!p) return;
  const text = p.kind === 'calib'
    ? `Calibrate ${p.pts.length + 1} of 2: stand at a spot you can find on the map (a corner, a door, a lamp post), then tap that spot.`
    : p.kind === 'post' ? `Tap where "${p.post.name}" is.` : p.kind === 'move' ? `Tap the new spot for "${p.item.label || p.item.name}".`
    : p.photo ? 'Photo ready. Now tap where you took it.' : 'Tap the map where the pin goes.';
  bar.append(h('div', { class: 'placebar' }, h('span', { class: 'grow' }, text), h('button', { class: 'btn small secondary', onclick: () => { S.placing = null; S.mapCtl?.showTemp(null); renderPlacebar(); } }, 'Cancel')));
  if (S.mapState.mode !== 'map') { S.mapState.mode = 'map'; go('map'); return; }
  // Bring the map on screen: the toolbar can push it below the fold on phones.
  const box = document.querySelector('.map-box');
  if (box) { const r = box.getBoundingClientRect(); if (r.bottom > innerHeight - 70 || r.top < 0) window.scrollTo({ top: scrollY + r.top - 70, behavior: 'smooth' }); }
}
async function onMapTap(pt) {
  const p = S.placing; if (!p) return;
  S.mapCtl.showTemp(pt);
  const coords = mapSite.base === 'image' ? { x: Math.round(pt.x), y: Math.round(pt.y) } : { lat: +pt.lat.toFixed(6), lon: +pt.lon.toFixed(6) };
  try {
    if (p.kind === 'marker') return newPinSheet(coords, p);
    if (p.kind === 'post') { await api('PATCH', `/api/posts/${p.post.id}`, coords); toast('Placed'); }
    if (p.kind === 'move') { await api('PATCH', `/api/${p.what}/${p.item.id}`, coords); toast('Moved'); }
    if (p.kind === 'calib') {
      toast('Getting a GPS fix…');
      const g = await getPos({ enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
      if (g.coords.accuracy > 30) toast(`GPS is rough (±${Math.round(g.coords.accuracy)} m). Try again in the open if positions look off.`);
      p.pts.push({ ...coords, lat: g.coords.latitude, lon: g.coords.longitude });
      if (p.pts.length < 2) return renderPlacebar();
      await api('PUT', `/api/sites/${mapSite.id}/calibration`, { points: p.pts });
      toast('Calibrated — live positions will now appear on this map');
    }
    S.placing = null; go('map');
  } catch (e) { toast(e.code ? errText(e) : 'Could not get your location.'); if (p.kind === 'calib') { S.placing = null; renderPlacebar(); } }
}
function newPinSheet(coords, p) {
  const posts = mapSite.posts.filter((x) => (mapEvent ? x.eventId === mapEvent.id : !x.eventId));
  const type = h('select', {}, MishMap.PIN_TYPES.map((t) => h('option', { value: t }, MishMap.PIN[t].name)),
    p.photo && posts.length ? h('optgroup', { label: 'Attach photo to a post' }, posts.map((x) => h('option', { value: `post:${x.id}` }, x.name))) : null);
  const label = h('input', { maxlength: 60, placeholder: 'e.g. East exit, AED by office' });
  const notes = h('input', { maxlength: 300, placeholder: 'Notes (optional)' });
  const caption = h('input', { maxlength: 120, placeholder: 'Photo caption (optional)' });
  const err = h('p', { class: 'err' });
  const s = sheet(p.photo ? 'Save this spot' : 'New pin',
    p.photo ? h('img', { class: 'thumb', src: URL.createObjectURL(p.photo.blob), alt: '' }) : null,
    h('label', {}, 'What is here?'), type, h('label', {}, 'Label'), label, h('label', {}, 'Notes'), notes,
    p.photo ? [h('label', {}, 'Caption'), caption] : null, err,
    h('p', {}, h('button', { class: 'btn block', onclick: async () => {
      try {
        let markerId = null, postId = null;
        if (type.value.startsWith('post:')) {
          postId = +type.value.slice(5);
          const post = posts.find((x) => x.id === postId);
          if (post && post.x == null && post.lat == null) await api('PATCH', `/api/posts/${postId}`, coords);
        } else {
          if (!label.value.trim()) { err.textContent = 'Give it a label.'; return; }
          markerId = (await api('POST', `/api/sites/${mapSite.id}/markers`, { type: type.value, label: label.value, notes: notes.value || null, ...coords })).id;
        }
        if (p.photo) {
          const fd = new FormData();
          fd.append('photo', p.photo.blob, 'spot.jpg'); fd.append('kind', p.pano ? 'panorama' : 'photo'); if (caption.value) fd.append('caption', caption.value);
          if (markerId) fd.append('markerId', markerId); if (postId) fd.append('postId', postId);
          await api('POST', `/api/sites/${mapSite.id}/photos`, undefined, fd);
        }
        s.close(); S.placing = null; toast('Saved'); go('map');
      } catch (e) { err.textContent = errText(e); }
    } }, 'Save')));
  s.addEventListener('closed', () => S.mapCtl?.showTemp(null));
  label.focus();
}
function placePostSheet(site) {
  const posts = site.posts.filter((x) => (mapEvent ? x.eventId === mapEvent.id : !x.eventId));
  const name = h('input', { maxlength: 60, placeholder: mapEvent ? 'New zone name, e.g. Stage' : 'New post name, e.g. Main entrance' });
  const s = sheet(mapEvent ? 'Place a zone' : 'Place a post',
    posts.length ? h('div', { class: 'card' }, posts.map((p) => h('div', { class: 'row between shift' }, h('span', {}, p.name, p.x == null && p.lat == null ? h('span', { class: 'pill tiny' }, 'not placed') : null),
      h('button', { class: 'btn small secondary', onclick: () => { s.close(); S.placing = { kind: 'post', post: p }; renderPlacebar(); } }, 'Place')))) : null,
    h('label', {}, 'Or add a new one'), h('div', { class: 'row' }, h('div', { class: 'grow' }, name), h('button', { class: 'btn', onclick: async () => {
      if (!name.value.trim()) return;
      try { const p = await api('POST', '/api/posts', { name: name.value, ...(mapEvent ? { eventId: mapEvent.id } : { siteId: site.id }) }); s.close(); S.placing = { kind: 'post', post: p }; renderPlacebar(); } catch (e) { toast(errText(e)); }
    } }, 'Add')));
}
function pinDetails(site, kind, item) {
  const photos = site.photos.filter((p) => (kind === 'post' ? p.postId === item.id : p.markerId === item.id));
  const edit = isCoord() && S.mapState?.edit;
  const s = sheet(kind === 'post' ? item.name : item.label,
    h('p', { class: 'muted' }, kind === 'post' ? (item.eventId ? 'Zone' : 'Post') : MishMap.PIN[item.type]?.name),
    kind === 'post' ? h('div', { class: 'facts' }, fact('On now', item.onNow?.join(', ') || 'Nobody'), fact('Radio', item.radio || '—'), fact('Lead', item.lead || '—')) : null,
    item.notes ? h('p', {}, item.notes) : null,
    photos.length ? h('div', { class: 'thumbs' }, photos.map((p) => h('button', { class: 'thumbbtn', onclick: () => photoViewer(p) },
      h('img', { src: `/api/photos/${p.id}`, alt: p.caption || '' }), p.kind === 'panorama' ? h('span', { class: 'pill tiny' }, '360') : null))) : null,
    edit ? h('div', { class: 'row wrap' },
      h('button', { class: 'btn small secondary', onclick: () => { s.close(); S.placing = { kind: 'move', what: kind === 'post' ? 'posts' : 'markers', item }; renderPlacebar(); } }, 'Move'),
      h('label', { class: 'btn small secondary' }, 'Add photo', h('input', { type: 'file', accept: 'image/*', class: 'sr', onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const img = await shrinkImage(f, 6000, 0.8);
          const small = img.panorama ? img : await shrinkImage(f, 1600, 0.8);
          const fd = new FormData(); fd.append('photo', small.blob, 'p.jpg'); fd.append('kind', img.panorama ? 'panorama' : 'photo'); fd.append(kind === 'post' ? 'postId' : 'markerId', item.id);
          await api('POST', `/api/sites/${site.id}/photos`, undefined, fd); s.close(); toast('Photo added'); go('map');
        } catch (x) { toast(errText(x)); }
      } })),
      kind === 'marker' ? h('button', { class: 'btn small danger', onclick: async () => { if (!confirm('Delete this pin and its photos?')) return; await api('DELETE', `/api/markers/${item.id}`); s.close(); go('map'); } }, 'Delete') : null,
      photos.length ? h('button', { class: 'btn small secondary', onclick: async () => { if (!confirm('Delete all photos on this pin?')) return; for (const p of photos) await api('DELETE', `/api/photos/${p.id}`); s.close(); go('map'); } }, 'Remove photos') : null) : null);
}

// ======================= MORE =======================
function moreView(v) {
  const pages = { events: eventsPage, event: eventPage, 'event-edit': eventEditPage, layout: layoutPage, incidents: incidentsPage, alerts: alertsPage, team: teamPage, settings: settingsPage, 'emergency-edit': emergencyEditPage, notifications: notificationsPage, display: displayPage, account: accountPage, privacy: privacyPage };
  if (S.page && pages[S.page]) {
    v.append(h('button', { class: 'linkbtn back', onclick: () => go('more', S.page === 'event' || S.page === 'event-edit' ? 'events' : null) }, '‹ Back'));
    return pages[S.page](v, S.arg);
  }
  const item = (page, label, sub) => h('button', { class: 'menuitem', onclick: () => go('more', page) }, h('span', {}, label), sub ? h('small', { class: 'muted' }, sub) : null);
  v.append(h('h2', {}, 'Operations'), h('div', { class: 'menu' },
    item('events', isCoord() ? 'Events' : 'My events', 'Outdoor & special events, zones, briefings'),
    isCoord() ? item('layout', 'Layout & survey', 'Floor plans, photos, panoramas, pins') : null,
    isCoord() ? item('incidents', 'Incident reports') : null,
    isCoord() ? item('alerts', 'Alert history') : null,
    isCoord() ? item('team', 'Team & posts', 'Invites, roles, posts') : null,
    h('button', { class: 'menuitem', onclick: showEmergency }, h('span', {}, 'Emergency info'), h('small', { class: 'muted' }, '911 script, contacts, exits')),
    isCoord() ? h('button', { class: 'menuitem', onclick: () => { store.set('setupHidden', '0'); store.set('setupCollapsed', '0'); go('now'); } }, h('span', {}, 'Setup checklist'), h('small', { class: 'muted' }, 'Show it on the Now screen')) : null));
  if (isAdmin()) v.append(h('h2', {}, 'Admin'), h('div', { class: 'menu' }, item('settings', 'Shabbat / Yom Tov lock & maps'), item('emergency-edit', 'Emergency card')));
  v.append(h('h2', {}, 'You'), h('div', { class: 'menu' }, item('notifications', 'Notifications'), item('display', 'Display', store.get('outdoor') === '1' ? 'Outdoor mode on' : 'Outdoor mode off'), item('account', 'Password & sign out'), item('privacy', 'Your data')));
}

// ---------- events ----------
async function eventsPage(v) {
  v.append(h('h2', {}, isCoord() ? 'Events' : 'My events'));
  if (isCoord()) v.append(h('p', {}, h('button', { class: 'btn', onclick: () => go('more', 'event-edit') }, '+ New event')));
  try {
    const list = await api('GET', '/api/events');
    if (!list.length) v.append(h('p', { class: 'muted' }, isCoord() ? 'No upcoming events. Create one for a Chanukah lighting, parade, festival or any special service.' : 'You’re not assigned to any upcoming events.'));
    for (const e of list) v.append(h('div', { class: 'card clickable', onclick: () => go('more', 'event', e.id) },
      h('div', { class: 'row between' }, h('h3', {}, e.name), e.active ? h('span', { class: 'pill live' }, 'Live') : null),
      h('p', { class: 'muted' }, `${fmtShort(e.startsAt)} – ${fmtTime(e.endsAt)} · ${e.site}`),
      h('p', { class: 'muted small' }, `${e.memberCount} on team${e.lead ? ` · Lead ${e.lead}` : ''}${e.isLead ? ' · you lead' : ''}`)));
  } catch (e) { v.append(h('p', { class: 'err' }, errText(e))); }
}

async function eventEditPage(v, id) {
  let ev = null;
  try { if (id) ev = await api('GET', `/api/events/${id}`); } catch (e) { return v.append(h('p', { class: 'err' }, errText(e))); }
  const [sites, team] = await Promise.all([api('GET', '/api/sites'), api('GET', '/api/team')]);
  v.append(h('h2', {}, ev ? 'Edit event' : 'New event'));
  const start = ev ? new Date(ev.startsAt) : (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(17, 0, 0, 0); return d; })();
  const end = ev ? new Date(ev.endsAt) : new Date(start.getTime() + 2 * 3600000);
  const contacts = h('div', {});
  const addContact = (c = {}) => contacts.append(h('div', { class: 'row contactrow' }, h('input', { placeholder: 'Who (e.g. Police detail)', value: c.label || '', maxlength: 40 }), h('input', { placeholder: 'Phone', type: 'tel', value: c.phone || '', maxlength: 25 }),
    h('button', { class: 'x', type: 'button', 'aria-label': 'Remove', onclick: (e) => e.target.closest('.contactrow').remove() }, '×')));
  (ev?.contacts?.length ? ev.contacts : [{}]).forEach(addContact);
  const err = h('p', { class: 'err', role: 'alert' });
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      let siteId = f.site.value;
      if (siteId === 'new') {
        const p = await getPos({ timeout: 10000 }).catch(() => null);
        const s = await api('POST', '/api/sites', { name: f.newsite.value || f.name.value, kind: 'outdoor', base: S.osmEnabled ? 'osm' : 'image', lat: p?.coords.latitude ?? null, lon: p?.coords.longitude ?? null, zoom: 18 });
        siteId = s.id;
      }
      const body = {
        name: f.name.value, siteId: +siteId, startsAt: new Date(f.s.value).toISOString(), endsAt: new Date(f.e.value).toISOString(),
        leadId: f.lead.value ? +f.lead.value : null, positions: f.positions.value, checkinMins: +f.checkin.value, radio: f.radio.value || null, briefing: f.briefing.value,
        contacts: [...contacts.querySelectorAll('.contactrow')].map((r) => { const [a, b] = r.querySelectorAll('input'); return { label: a.value, phone: b.value }; }).filter((c) => c.label && c.phone),
      };
      const saved = ev ? await api('PUT', `/api/events/${ev.id}`, body) : await api('POST', '/api/events', body);
      toast('Saved'); loadMyEvent(); go('more', 'event', saved.id);
    } catch (x) { err.textContent = errText(x); }
  } },
    h('label', {}, 'Event name'), h('input', { name: 'name', required: true, maxlength: 80, value: ev?.name || '', placeholder: 'e.g. Public Chanukah lighting' }),
    h('label', {}, 'Place'), h('select', { name: 'site', onchange: (e) => { f.newsite.parentElement.hidden = e.target.value !== 'new'; } },
      sites.map((s) => h('option', { value: s.id, selected: ev?.siteId === s.id || null }, `${s.name}${s.kind === 'building' ? ' (building)' : ''}`)),
      h('option', { value: 'new', selected: !ev || null }, '+ New outdoor place (uses my location)')),
    h('div', { hidden: !!ev || null }, h('label', {}, 'New place name'), h('input', { name: 'newsite', maxlength: 80, placeholder: 'e.g. Civic Center Park' })),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', {}, 'Starts'), h('input', { name: 's', type: 'datetime-local', value: localInput(start), required: true })),
      h('div', { class: 'grow' }, h('label', {}, 'Ends'), h('input', { name: 'e', type: 'datetime-local', value: localInput(end), required: true }))),
    h('label', {}, 'Event lead'), h('select', { name: 'lead' }, h('option', { value: '' }, '—'), team.filter((u) => u.active).map((u) => h('option', { value: u.id, selected: ev?.leadId === u.id || null }, u.name))),
    h('label', {}, 'Who sees live team positions?'),
    h('select', { name: 'positions' }, [['leads', 'Leads only (event lead, zone leads, coordinators)'], ['team', 'Whole event team'], ['off', 'Nobody — location sharing off']].map(([val, l]) => h('option', { value: val, selected: (ev?.positions || 'leads') === val || null }, l))),
    h('p', { class: 'muted small' }, 'Sharing is opt-in for each guard, works while the app is open, and every position is deleted when the event ends.'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', {}, 'Check-in every (min, 0 = off)'), h('input', { name: 'checkin', type: 'number', min: 0, max: 240, value: ev?.checkinMins ?? 20 })),
      h('div', { class: 'grow' }, h('label', {}, 'Radio channel'), h('input', { name: 'radio', maxlength: 60, value: ev?.radio || '', placeholder: 'e.g. Ch 5' }))),
    h('label', {}, 'Briefing (rally points, code words, who to watch for)'), h('textarea', { name: 'briefing', maxlength: 4000, rows: 5 }, ev?.briefing || ''),
    h('label', {}, 'Contacts (police detail, EMS, organizer)'), contacts,
    h('button', { class: 'linkbtn', type: 'button', onclick: () => addContact() }, '+ Add contact'),
    err, h('p', {}, h('button', { class: 'btn block', type: 'submit' }, ev ? 'Save changes' : 'Create event')));
  v.append(h('div', { class: 'card' }, f));
}

async function eventPage(v, id) {
  let ev;
  try { ev = await api('GET', `/api/events/${id}`); } catch (e) { return v.append(h('p', { class: 'err' }, errText(e))); }
  const redo = () => go('more', 'event', id);
  v.append(h('div', { class: 'row between' }, h('h2', {}, ev.name), ev.active ? h('span', { class: 'pill live' }, 'Live') : null),
    h('p', { class: 'muted' }, `${fmtShort(ev.startsAt)} – ${fmtTime(ev.endsAt)} · ${ev.site}`),
    h('div', { class: 'facts' }, fact('Lead', ev.lead || '—'), fact('Radio', ev.radio || '—'), fact('Positions', { leads: 'Leads only', team: 'Whole team', off: 'Off' }[ev.positions]), fact('Check-in', ev.checkinMins ? `${ev.checkinMins} min` : 'Off')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onclick: () => go('map', null, { siteId: ev.siteId, eventId: ev.id }) }, 'Open map'),
      h('button', { class: 'btn secondary', onclick: () => showBriefing(ev) }, ev.me.acked || !ev.isMember ? 'Briefing' : 'Read briefing'),
      isCoord() ? h('button', { class: 'btn secondary', onclick: () => go('more', 'event-edit', ev.id) }, 'Edit') : null));

  // zones & assignments
  v.append(h('h2', {}, 'Zones'));
  const zc = h('div', { class: 'card' }); v.append(zc);
  if (!ev.zones.length) zc.append(h('p', { class: 'muted' }, 'No zones yet. Split the area into zones (Stage, North barricade, Parking…) or route segments for a parade.'));
  for (const z of ev.zones) {
    zc.append(h('div', { class: 'zone' },
      h('div', { class: 'row between' }, h('strong', {}, z.name), h('span', { class: 'muted small' }, [z.radio && `Radio ${z.radio}`, z.lead && `Lead ${z.lead}`].filter(Boolean).join(' · '))),
      z.x == null && z.lat == null ? h('span', { class: 'pill tiny' }, 'not on map yet') : null,
      z.assigned.length ? z.assigned.map((a) => h('div', { class: 'row between small' }, h('span', {}, `${a.name} · ${fmtTime(a.startsAt)}–${fmtTime(a.endsAt)}`),
        isCoord() ? h('button', { class: 'x', 'aria-label': 'Unassign', onclick: async () => { await api('DELETE', `/api/shifts/${a.id}`); redo(); } }, '×') : null)) : h('div', { class: 'muted small' }, 'Nobody assigned')));
  }
  if (isCoord()) {
    const team = (await api('GET', '/api/team')).filter((u) => u.active);
    const zn = h('input', { maxlength: 60, placeholder: 'Zone name' }), zr = h('input', { maxlength: 40, placeholder: 'Radio (optional)' });
    const zl = h('select', {}, h('option', { value: '' }, 'Zone lead (optional)'), team.map((u) => h('option', { value: u.id }, u.name)));
    v.append(h('details', { class: 'card' }, h('summary', {}, '+ Add a zone'), zn, h('div', { class: 'row mt8' }, h('div', { class: 'grow' }, zr), h('div', { class: 'grow' }, zl)),
      h('p', {}, h('button', { class: 'btn block', onclick: async () => {
        if (!zn.value.trim()) return;
        try { await api('POST', '/api/posts', { name: zn.value, eventId: ev.id, radio: zr.value || null, leadId: zl.value ? +zl.value : null }); toast('Zone added — place it from the map’s Edit layout'); redo(); } catch (e) { toast(errText(e)); }
      } }, 'Add zone'))));
    if (ev.zones.length) v.append(shiftForm(ev.zones, team, redo, { start: ev.startsAt, end: ev.endsAt, title: '+ Assign someone to a zone', zoneLabel: 'Zone' }));
  }

  // live roster for leads
  if (ev.isLead) {
    v.append(h('h2', {}, 'Team status'));
    const rc = h('div', { class: 'card' }); v.append(rc);
    const draw = async () => {
      try {
        const rows = await api('GET', `/api/events/${ev.id}/roster`);
        clear(rc).append(...(rows.length ? rows.map((r) => h('div', { class: 'shift' + (r.overdue ? ' overdue' : '') },
          h('div', { class: 'grow' }, h('strong', {}, r.name, r.isLead ? ' (lead)' : ''), h('div', { class: 'muted small' }, [r.zone || 'not on duty now', r.lastSeen ? `seen ${ago(r.lastSeen)}` : 'not seen yet'].join(' · '))),
          h('div', { class: 'badges' }, r.overdue ? h('span', { class: 'pill danger' }, 'Check-in late') : null, r.acked ? h('span', { class: 'pill' }, 'Briefed') : h('span', { class: 'pill warn' }, 'Not briefed'), r.sharing ? h('span', { class: 'pill' }, 'GPS') : null))) : [h('p', { class: 'muted' }, 'Nobody assigned yet.')]));
      } catch { /* ignore */ }
    };
    draw();
    const t = setInterval(() => { if (S.page !== 'event') return clearInterval(t); draw(); }, 30000);
    document.addEventListener('roster', draw);
  }
  if (isCoord()) v.append(h('p', {}, h('button', { class: 'btn small danger', onclick: async () => { if (!confirm('Cancel this event? Live positions are deleted.')) return; await api('DELETE', `/api/events/${ev.id}`); loadMyEvent(); go('more', 'events'); } }, 'Cancel event')));
}

// ---------- layout overview ----------
async function layoutPage(v) {
  v.append(h('h2', {}, 'Layout & survey'),
    h('div', { class: 'card' }, h('p', {}, 'Teach the app your space so alerts show exactly where help is needed:'),
      h('ol', {}, h('li', {}, 'Photograph the posted evacuation map (it becomes the base map).'), h('li', {}, 'Walk the building: photograph or pano each entrance, exit, AED, kit and camera, and tap where you are.'), h('li', {}, 'Place your posts.'), h('li', {}, 'Optional: calibrate GPS so outdoor positions line up.')),
      h('p', { class: 'muted small' }, 'Photos are encrypted, stripped of location data, and visible only to your team. Layout details are sensitive — don’t share screenshots outside the team.')));
  try {
    const sites = await api('GET', '/api/sites');
    for (const s of sites) v.append(h('div', { class: 'card clickable', onclick: () => go('map', null, { siteId: s.id, eventId: null, edit: true }) },
      h('div', { class: 'row between' }, h('h3', {}, s.name), h('span', { class: 'pill' }, s.kind === 'building' ? 'Building' : 'Outdoor')),
      h('p', { class: 'muted small' }, s.base === 'osm' ? 'Street map' : s.hasImage ? 'Floor plan / site map uploaded' : 'No base map yet', ' · tap to edit')));
    const name = h('input', { maxlength: 80, placeholder: 'e.g. Social hall annex, Parking lot' });
    const kind = h('select', {}, h('option', { value: 'building' }, 'Building'), h('option', { value: 'outdoor' }, 'Outdoor place'));
    v.append(h('details', { class: 'card' }, h('summary', {}, '+ Add another place'), name, h('div', { class: 'mt8' }, kind),
      h('p', {}, h('button', { class: 'btn block', onclick: async () => {
        if (!name.value.trim()) return;
        try {
          const outdoorOsm = kind.value === 'outdoor' && S.osmEnabled;
          const p = outdoorOsm ? await getPos({ timeout: 10000 }).catch(() => null) : null;
          const s = await api('POST', '/api/sites', { name: name.value, kind: kind.value, base: outdoorOsm ? 'osm' : 'image', lat: p?.coords.latitude ?? null, lon: p?.coords.longitude ?? null, zoom: 18 });
          go('map', null, { siteId: s.id, eventId: null, edit: true });
        } catch (e) { toast(errText(e)); }
      } }, 'Create'))));
  } catch (e) { v.append(h('p', { class: 'err' }, errText(e))); }
}

// ---------- coordinator pages ----------
async function incidentsPage(v) {
  v.append(h('h2', {}, 'Incident reports'));
  try { const rows = await api('GET', '/api/incidents'); v.append(...(rows.length ? rows.map(incidentCard) : [h('p', { class: 'muted' }, 'No incidents reported.')])); }
  catch (e) { v.append(h('p', { class: 'err' }, errText(e))); }
}
async function alertsPage(v) {
  v.append(h('h2', {}, 'Alert history'));
  try {
    const rows = await api('GET', '/api/alerts');
    v.append(...(rows.length ? rows.map((a) => h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('strong', {}, `${KIND[a.kind] || 'Alert'} — ${a.sender}`), h('span', { class: 'pill' }, a.status === 'active' ? 'active' : (a.outcome || 'closed').replace('_', ' '))),
      h('div', { class: 'muted' }, [a.post?.name, a.event?.name].filter(Boolean).join(' · ')),
      h('div', { class: 'muted small' }, `${fmtDay(a.createdAt)} ${fmtTime(a.createdAt)} · ${a.acked.length}/${a.recipients} responded${a.escalated ? ' · escalated' : ''}`))) : [h('p', { class: 'muted' }, 'No alerts yet.')]));
  } catch (e) { v.append(h('p', { class: 'err' }, errText(e))); }
}
async function teamPage(v) {
  const redraw = () => go('more', 'team');
  try {
    const [team, posts] = await Promise.all([api('GET', '/api/team'), api('GET', '/api/posts')]);
    const inviteOut = h('div', {});
    const roleSel = h('select', {}, h('option', { value: 'guard' }, 'Guard'), isAdmin() ? [h('option', { value: 'coordinator' }, 'Coordinator'), h('option', { value: 'admin' }, 'Admin')] : null);
    v.append(h('h2', {}, 'Invite someone'), h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, roleSel),
      h('button', { class: 'btn', onclick: async () => {
        try { const r = await api('POST', '/api/invites', { role: roleSel.value }); clear(inviteOut).append(h('p', {}, 'Share this one-time code in person or over a secure channel:'), h('p', { class: 'code' }, r.code), h('p', { class: 'muted' }, `Role: ${r.role}. Expires in 48 hours.`)); }
        catch (e) { toast(errText(e)); }
      } }, 'Create code')), inviteOut));
    v.append(h('h2', {}, 'Building posts'));
    const pc = h('div', { class: 'card' }); v.append(pc);
    posts.forEach((p) => pc.append(h('div', { class: 'row between shift' }, h('span', {}, p.name, p.radio ? h('span', { class: 'muted small' }, ` · ${p.radio}`) : null, p.x == null ? h('span', { class: 'pill tiny' }, 'not on map') : null),
      h('button', { class: 'x', 'aria-label': `Remove ${p.name}`, onclick: async () => { if (confirm(`Remove post "${p.name}" and its future shifts?`)) { await api('DELETE', `/api/posts/${p.id}`); redraw(); } } }, '×'))));
    const pn = h('input', { placeholder: 'e.g. Main entrance', maxlength: 60 }), pr = h('input', { placeholder: 'Radio', maxlength: 40 });
    pc.append(h('div', { class: 'row mt8' }, h('div', { class: 'grow' }, pn), h('div', { class: 'narrow' }, pr), h('button', { class: 'btn', onclick: async () => { if (!pn.value.trim()) return; try { await api('POST', '/api/posts', { name: pn.value, radio: pr.value || null }); redraw(); } catch (e) { toast(errText(e)); } } }, 'Add')));
    v.append(h('h2', {}, 'Team'));
    const tc = h('div', { class: 'card' }); v.append(tc);
    for (const u of team) {
      tc.append(h('div', { class: 'shift' }, h('div', { class: 'grow' }, h('div', {}, u.name, u.id === S.me.id ? ' (you)' : ''), h('div', { class: 'muted small' }, `${u.login} · ${u.role}${u.active ? '' : ' · deactivated'}`)),
        isAdmin() && u.id !== S.me.id ? h('button', { class: 'btn small secondary', onclick: async () => {
          try {
            if (u.active) { if (confirm(`Deactivate ${u.name}? They are signed out, removed from future shifts, and their positions deleted.`)) await api('PATCH', `/api/team/${u.id}`, { active: false }); }
            else await api('PATCH', `/api/team/${u.id}`, { active: true });
            redraw();
          } catch (e) { toast(errText(e)); }
        } }, u.active ? 'Deactivate' : 'Reactivate') : null));
    }
  } catch (e) { v.append(h('p', { class: 'err' }, errText(e))); }
}
async function settingsPage(v) {
  let c;
  try { c = await api('GET', '/api/congregation'); } catch (e) { return v.append(h('p', { class: 'err' }, errText(e))); }
  const err = h('p', { class: 'err', role: 'alert' }), okm = h('p', { class: 'ok' }), preview = h('div', { class: 'muted' });
  const showWindows = (s) => { clear(preview); if (!s.mode) return; preview.append(h('strong', {}, 'Upcoming locks'), ...s.windows.slice(0, 4).map((w) => h('div', {}, `${fmtLock(Date.parse(w.start))} → ${fmtLock(Date.parse(w.end))}`))); };
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; okm.textContent = '';
    try {
      const s = await api('PUT', '/api/congregation', { name: f.name.value, lat: f.lat.value === '' ? null : +f.lat.value, lon: f.lon.value === '' ? null : +f.lon.value, tzid: f.tz.value, il: f.il.checked, candleMins: +f.candle.value, havdalahMins: f.hav.value === '' ? null : +f.hav.value, shabbatMode: f.mode.checked, osmEnabled: f.osm.checked });
      S.shabbat = s; S.offset = s.now - Date.now(); S.congregation = f.name.value; S.osmEnabled = f.osm.checked; okm.textContent = '✓ Saved'; showWindows(s); applyLock(false);
    } catch (x) { err.textContent = errText(x); }
  } },
    h('label', {}, 'Name'), h('input', { name: 'name', value: c.name, maxlength: 80, required: true }),
    h('h2', {}, 'Observance lock'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'mode', checked: c.shabbatMode }), 'Lock routine features from candle lighting to Havdalah, and on Yom Tov'),
    h('p', { class: 'muted small' }, 'Leave this off if your community doesn’t need it (for example a church or mosque using Mishmar).'),
    h('label', {}, 'Location (used only to calculate zmanim, on this server)'),
    h('div', { class: 'row' }, h('input', { name: 'lat', type: 'number', step: 'any', placeholder: 'Latitude', value: c.lat ?? '' }), h('input', { name: 'lon', type: 'number', step: 'any', placeholder: 'Longitude', value: c.lon ?? '' })),
    h('p', {}, h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { try { const p = await getPos({ timeout: 10000 }); f.lat.value = p.coords.latitude.toFixed(4); f.lon.value = p.coords.longitude.toFixed(4); } catch { err.textContent = 'Could not get your location.'; } } }, 'Use my current location')),
    h('label', {}, 'Time zone (IANA)'), h('input', { name: 'tz', value: c.tzid || Intl.DateTimeFormat().resolvedOptions().timeZone, required: true }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'il', checked: c.il }), 'Israel (one-day Yom Tov)'),
    h('label', {}, 'Candle lighting: minutes before sunset'), h('input', { name: 'candle', type: 'number', min: 0, max: 60, value: c.candleMins, required: true }),
    h('label', {}, 'Havdalah'),
    h('select', { name: 'hav' }, [['', 'Nightfall (3 stars, 8.5°)'], ['42', '42 min after sunset'], ['50', '50 min after sunset'], ['72', '72 min after sunset (Rabbeinu Tam)']].map(([val, l]) => h('option', { value: val, selected: String(c.havdalahMins ?? '') === val || null }, l))),
    h('p', { class: 'muted small' }, 'Please have your rabbi confirm the zmanim and which functions stay available. During the lock the server itself refuses everything except alerts, the emergency card and the read-only floor plan.'),
    h('h2', {}, 'Maps'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'osm', checked: c.osmEnabled }), 'Allow street maps (OpenStreetMap) for outdoor events'),
    h('p', { class: 'muted small' }, 'Street map tiles are downloaded from OpenStreetMap, which reveals the general area being viewed. Turn this off to use only uploaded site maps; no third-party requests are made then.'),
    err, okm, preview, h('p', {}, h('button', { class: 'btn block', type: 'submit' }, 'Save')));
  v.append(h('div', { class: 'card' }, f));
  fetch('/api/shabbat', { credentials: 'same-origin' }).then((r) => r.json()).then(showWindows).catch(() => {});
}
async function emergencyEditPage(v) {
  let e;
  try { e = await api('GET', '/api/emergency'); } catch (x) { return v.append(h('p', { class: 'err' }, errText(x))); }
  const contacts = h('div', {});
  const addContact = (c = {}) => contacts.append(h('div', { class: 'row contactrow' }, h('input', { placeholder: 'Who', value: c.label || '', maxlength: 40 }), h('input', { placeholder: 'Phone', type: 'tel', value: c.phone || '', maxlength: 25 }),
    h('button', { class: 'x', type: 'button', 'aria-label': 'Remove', onclick: (ev) => ev.target.closest('.contactrow').remove() }, '×')));
  (e.contacts.length ? e.contacts : [{}]).forEach(addContact);
  const okm = h('p', { class: 'ok' }), err = h('p', { class: 'err' });
  const f = h('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    try {
      await api('PUT', '/api/emergency', { address: f.address.value, script: f.script.value, procedures: f.procedures.value,
        contacts: [...contacts.querySelectorAll('.contactrow')].map((r) => { const [a, b] = r.querySelectorAll('input'); return { label: a.value, phone: b.value }; }).filter((c) => c.label && c.phone) });
      okm.textContent = '✓ Saved';
    } catch (x) { err.textContent = errText(x); }
  } },
    h('label', {}, 'Street address'), h('input', { name: 'address', maxlength: 200, value: e.address }),
    h('label', {}, 'What to say to 911 (read aloud under stress — keep it short)'), h('textarea', { name: 'script', maxlength: 600, rows: 3, placeholder: 'This is Beth Shalom at 123 Main St. Enter from 2nd Avenue, side door.' }, e.script),
    h('label', {}, 'Procedures (lockdown, evacuation, medical)'), h('textarea', { name: 'procedures', maxlength: 6000, rows: 8 }, e.procedures),
    h('label', {}, 'Contacts'), contacts, h('button', { class: 'linkbtn', type: 'button', onclick: () => addContact() }, '+ Add contact'),
    h('p', { class: 'muted small' }, 'Exits, AEDs, kits and rally points come from the pins on your building map (Layout & survey). This card stays available during the Shabbat / Yom Tov lock.'),
    err, okm, h('p', {}, h('button', { class: 'btn block', type: 'submit' }, 'Save')));
  v.append(h('h2', {}, 'Emergency card'), h('div', { class: 'card' }, f));
}

// ---------- personal pages ----------
function b64u8(s) { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); }
async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}
function notificationsPage(v) {
  v.append(h('h2', {}, 'Notifications'));
  const box = h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Checking…'));
  const draw = async () => {
    const st = await pushState().catch(() => 'unsupported');
    clear(box);
    if (st === 'unsupported') box.append(h('p', { class: 'muted' }, 'Push alerts need a browser that supports them. On iPhone, add this app to your Home Screen first (Share › Add to Home Screen).'));
    else if (st === 'denied') box.append(h('p', { class: 'muted' }, 'Notifications are blocked. Enable them in your device settings for this app.'));
    else if (st === 'on') box.append(h('p', { class: 'ok' }, '✓ Alerts are enabled on this device.'), h('button', { class: 'btn secondary small', onclick: async () => { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); } draw(); } }, 'Turn off'));
    else box.append(h('p', { class: 'muted' }, 'Get alerts and urgent team messages on this device, even when the app is closed.'), h('button', { class: 'btn', onclick: async () => {
      try {
        if ((await Notification.requestPermission()) !== 'granted') return draw();
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u8(S.vapid) });
        await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      } catch { /* state shows */ }
      draw();
    } }, 'Enable alerts'));
  };
  draw(); v.append(box,
    h('div', { class: 'card' }, h('h3', {}, 'Vibration patterns'), h('p', { class: 'muted small' }, 'So you can tell what arrived without looking:'),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn small secondary', onclick: () => buzz(0) }, 'Routine'), h('button', { class: 'btn small secondary', onclick: () => buzz(1) }, 'Attention'), h('button', { class: 'btn small secondary', onclick: () => buzz(2) }, 'Urgent'), h('button', { class: 'btn small danger', onclick: () => buzz('alert') }, 'Silent alert'))));
}
function displayPage(v) {
  v.append(h('h2', {}, 'Display'), h('div', { class: 'card' },
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: store.get('outdoor') === '1', onchange: (e) => { store.set('outdoor', e.target.checked ? '1' : '0'); applyDisplay(); } }), 'Outdoor mode'),
    h('p', { class: 'muted small' }, 'High contrast for bright sun, bigger buttons for gloves, and the screen stays on during a live event (where supported).')));
}
function accountPage(v) {
  v.append(h('h2', {}, 'Change password'));
  const err = h('p', { class: 'err' }), okm = h('p', { class: 'ok' });
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; okm.textContent = '';
    try { await api('POST', '/api/me/password', { current: f.cur.value, next: f.next.value }); f.reset(); okm.textContent = '✓ Updated. Other devices were signed out.'; } catch (x) { err.textContent = errText(x); }
  } },
    h('label', {}, 'Current password'), h('input', { name: 'cur', type: 'password', autocomplete: 'current-password', required: true }),
    h('label', {}, 'New password (10+ characters)'), h('input', { name: 'next', type: 'password', minlength: 10, autocomplete: 'new-password', required: true }),
    err, okm, h('p', {}, h('button', { class: 'btn secondary', type: 'submit' }, 'Update password')));
  v.append(h('div', { class: 'card' }, f), h('p', {}, h('button', { class: 'btn secondary block', onclick: async () => { try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ } S.me = null; showAuth(); } }, 'Sign out')));
}
function privacyPage(v) {
  v.append(h('h2', {}, 'Your data'), h('div', { class: 'card' },
    h('p', {}, 'Mishmar keeps your name, login and a password hash. No email, phone number or member directory: guards only see names on the schedule and their own event.'),
    h('p', {}, 'Alert locations are deleted after 14 days. Live event positions are opt-in, only kept as your latest point, and deleted when the event ends. Team messages are deleted after 7 days. Incident reports are kept for a year.'),
    h('p', { class: 'muted small' }, 'Incident text, locations, messages, briefings and every photo are encrypted on the server. Photos are stripped of GPS/EXIF metadata.')));
}

boot();
