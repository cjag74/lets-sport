// ===== Let's Sport — frontend =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = { user: null, sport: '', view: 'upcoming', authMode: 'login' };

const SPORT_EMOJI = { badminton: '🏸', basketball: '🏀' };
const AVATAR_COLORS = ['#ff5d8f', '#ff8a3d', '#8b5cf6', '#2ec4b6', '#4d7cfe', '#3ddc97', '#f59e0b'];
const JOIN_CHEERS = [
  "You're in! Game on! 🎉",
  'Woohoo! See you on the court! 🙌',
  "Let's gooo! 🔥",
  'Squad assembled! 💪',
];

// ---------- API helper ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) showAuth();
    throw new Error(data.error || 'Something went wrong.');
  }
  return data;
}

// ---------- utils ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}
function colorFor(id) {
  return AVATAR_COLORS[id % AVATAR_COLORS.length];
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function friendlyDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 86400000);
  const label = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (diff === 0) return { main: 'Today! 🔥', sub: label };
  if (diff === 1) return { main: 'Tomorrow', sub: label };
  if (diff > 1 && diff < 7) return { main: date.toLocaleDateString(undefined, { weekday: 'long' }), sub: label };
  return { main: label, sub: diff < 0 ? 'Played' : `in ${diff} days` };
}
function friendlyTime(t) {
  const [h, m] = t.split(':').map(Number);
  const d = new Date(); d.setHours(h, m);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- screens ----------
function showAuth() {
  state.user = null;
  $('#app-screen').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
}
function showApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  $('#user-name').textContent = state.user.name;
  loadActivities();
}

// ---------- auth ----------
function setAuthMode(mode) {
  state.authMode = mode;
  $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('.register-only').classList.toggle('hidden', mode !== 'register');
  $('#auth-form [name=name]').required = mode === 'register';
  $('#auth-form [name=password]').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = mode === 'register' ? 'Create my account 🎉' : "Let's go! 🚀";
  $('#auth-error').textContent = '';
}

$$('.auth-tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const btn = $('#auth-submit');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const { user } = await api(state.authMode === 'register' ? '/api/register' : '/api/login', {
      method: 'POST',
      body: fd,
    });
    state.user = user;
    e.target.reset();
    showApp();
    if (state.authMode === 'register') {
      confetti();
      toast(`Welcome to the team, ${user.name}! 🥳`);
    } else {
      toast(`Welcome back, ${user.name}! 👋`);
    }
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showAuth();
  setAuthMode('login');
  toast('See you next game! 👋');
});

// ---------- filters ----------
$$('#sport-filter .pill').forEach((p) =>
  p.addEventListener('click', () => {
    state.sport = p.dataset.sport;
    $$('#sport-filter .pill').forEach((x) => x.classList.toggle('active', x === p));
    loadActivities();
  })
);
$$('#view-filter .pill').forEach((p) =>
  p.addEventListener('click', () => {
    state.view = p.dataset.view;
    $$('#view-filter .pill').forEach((x) => x.classList.toggle('active', x === p));
    loadActivities();
  })
);

// ---------- activities ----------
async function loadActivities() {
  const q = new URLSearchParams({ sport: state.sport, view: state.view });
  try {
    const { activities } = await api(`/api/activities?${q}`);
    renderActivities(activities);
  } catch (err) {
    toast(err.message);
  }
}

function renderActivities(list) {
  const wrap = $('#activity-list');
  wrap.classList.toggle('past', state.view === 'past');
  $('#empty').classList.toggle('hidden', list.length > 0);
  if (!list.length) {
    const emptyText = {
      upcoming: ['The court is empty!', 'Be the hero — host the first game and get people moving.'],
      mine: ['No games yet 💛', "Join a game or host one — it'll show up here."],
      past: ['No past games yet', 'Once you play, your history will show up here.'],
    }[state.view];
    $('#empty h3').textContent = emptyText[0];
    $('#empty p').textContent = emptyText[1];
  }
  wrap.innerHTML = list.map(cardHTML).join('');
  wrap.querySelectorAll('.activity').forEach((el, i) => (el.style.animationDelay = `${i * 50}ms`));
}

function cardHTML(a) {
  const count = a.players.length;
  const left = a.max_players - count;
  const pct = Math.min(100, Math.round((count / a.max_players) * 100));
  const when = friendlyDate(a.date);
  const isPast = state.view === 'past';
  const avatars = a.players
    .slice(0, 8)
    .map((p) => `<div class="avatar" style="background:${colorFor(p.id)}" title="${esc(p.name)}">${esc(initials(p.name))}</div>`)
    .join('');
  const names = a.players.map((p) => (p.id === state.user.id ? 'You' : p.name.split(' ')[0]));
  const namesText = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3} more` : names.join(', ');

  let actions = '';
  if (!isPast) {
    if (a.is_host) {
      actions = `<button class="btn btn-danger btn-sm" data-action="cancel" data-id="${a.id}">Cancel game</button>`;
    } else if (a.is_joined) {
      actions = `<button class="btn btn-leave btn-sm" data-action="leave" data-id="${a.id}">Can't make it 😢</button>`;
    } else if (left <= 0) {
      actions = `<button class="btn btn-leave btn-sm" disabled>Game full 🙈</button>`;
    } else {
      actions = `<button class="btn btn-join" data-action="join" data-id="${a.id}">I'm in! 🙋</button>`;
    }
  }

  return `
  <article class="card activity ${a.sport}">
    <div class="activity-head">
      <span class="activity-emoji">${SPORT_EMOJI[a.sport]}</span>
      <span class="badge ${a.sport}">${a.sport === 'badminton' ? 'Badminton' : 'Basketball'}</span>
      <span class="badge level">${esc(a.skill_level)}</span>
      ${a.is_host ? '<span class="badge host">⭐ Hosting</span>' : ''}
      <h3>${esc(a.title)}</h3>
    </div>
    <div class="activity-body">
      <div class="meta"><i>📅</i><div>${esc(when.main)} · ${esc(friendlyTime(a.time))}<small>${esc(when.sub)}</small></div></div>
      <div class="meta"><i>📍</i><div>${esc(a.venue)}${a.lat !== null || a.map_url ? '<span class="pinned">📌 pinned</span>' : ''}<small>Hosted by ${a.is_host ? 'you' : esc(a.host_name)}</small>
        <div class="map-links">
          <button type="button" class="link-btn" data-map-toggle="${a.id}">🗺️ Show map</button>
          <a href="${esc(openMapUrl(a))}" target="_blank" rel="noopener noreferrer">Open in Google Maps ↗</a>
          <a href="${esc(directionsUrl(a))}" target="_blank" rel="noopener noreferrer">🚗 Directions</a>
        </div>
      </div></div>
      <div class="card-map hidden" id="card-map-${a.id}" data-q="${esc(mapQuery(a.lat, a.lng, a.venue))}"></div>
      ${a.notes ? `<div class="notes">💬 ${esc(a.notes)}</div>` : ''}
      <div class="spots">
        <div class="spots-label">
          <span>${count} / ${a.max_players} players</span>
          ${left > 0 ? `<span class="left">${left} spot${left === 1 ? '' : 's'} left!</span>` : '<span class="full">Full house! 🎉</span>'}
        </div>
        <div class="bar"><div style="width:${pct}%"></div></div>
      </div>
      <div class="players">${avatars}<span class="players-names">${esc(namesText)}</span></div>
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </div>
  </article>`;
}

function openMapUrl(a) {
  if (a.map_url) return a.map_url;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery(a.lat, a.lng, a.venue))}`;
}
function directionsUrl(a) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapQuery(a.lat, a.lng, a.venue))}`;
}

$('#activity-list').addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-map-toggle]');
  if (toggle) {
    const box = $(`#card-map-${toggle.dataset.mapToggle}`);
    if (!box.firstChild) {
      box.innerHTML = `<iframe title="Venue map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${esc(embedUrl(box.dataset.q))}"></iframe>`;
    }
    const opening = box.classList.contains('hidden');
    box.classList.toggle('hidden', !opening);
    toggle.textContent = opening ? '🙈 Hide map' : '🗺️ Show map';
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  btn.disabled = true;
  try {
    if (action === 'join') {
      await api(`/api/activities/${id}/join`, { method: 'POST' });
      const r = btn.getBoundingClientRect();
      confetti(r.left + r.width / 2, r.top);
      toast(JOIN_CHEERS[Math.floor(Math.random() * JOIN_CHEERS.length)]);
    } else if (action === 'leave') {
      await api(`/api/activities/${id}/join`, { method: 'DELETE' });
      toast("No worries — maybe next time! 💛");
    } else if (action === 'cancel') {
      if (!confirm('Cancel this game for everyone?')) { btn.disabled = false; return; }
      await api(`/api/activities/${id}`, { method: 'DELETE' });
      toast('Game cancelled.');
    }
    loadActivities();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

// ---------- new activity modal ----------
function openModal() {
  const form = $('#activity-form');
  form.reset();
  form.elements.date.min = todayStr();
  form.elements.date.value = todayStr();
  clearMapPin();
  $('#activity-error').textContent = '';
  $('#modal').classList.remove('hidden');
  setTimeout(() => form.elements.title.focus(), 50);
}
function closeModal() {
  $('#modal').classList.add('hidden');
}
$('#new-btn').addEventListener('click', openModal);
$('#empty-new-btn').addEventListener('click', openModal);
$$('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());

// ---------- map location in the form ----------
const mapForm = $('#activity-form').elements;
let venueTimer;

function mapQuery(lat, lng, text) {
  return lat !== '' && lat !== null && lat !== undefined && lng !== '' && lng !== null && lng !== undefined
    ? `${lat},${lng}`
    : text;
}
function embedUrl(q) {
  return `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=16&output=embed`;
}
function showMapPreview(q, status, isError = false) {
  const box = $('#map-preview');
  if (!q) { box.classList.add('hidden'); return; }
  const frame = box.querySelector('iframe');
  const src = embedUrl(q);
  if (frame.src !== src) frame.src = src;
  $('#map-status').textContent = status;
  box.querySelector('.map-preview-bar').classList.toggle('error', isError);
  $('#map-clear').classList.toggle('hidden', !mapForm.lat.value && !mapForm.map_url.value);
  box.classList.remove('hidden');
}
function refreshPreviewFromVenue() {
  if (mapForm.lat.value || mapForm.map_url.value) return; // a pin already wins
  const v = mapForm.venue.value.trim();
  if (v.length >= 4) showMapPreview(v, "🔎 Best guess from the venue name — paste a link to pin it exactly");
  else $('#map-preview').classList.add('hidden');
}
function clearMapPin() {
  mapForm.lat.value = '';
  mapForm.lng.value = '';
  mapForm.map_url.value = '';
  $('#map-preview').classList.add('hidden');
  $('#map-preview iframe').removeAttribute('src');
  refreshPreviewFromVenue();
}

mapForm.venue.addEventListener('input', () => {
  clearTimeout(venueTimer);
  venueTimer = setTimeout(refreshPreviewFromVenue, 700);
});

async function handleMapLink() {
  const url = mapForm.map_url.value.trim();
  mapForm.lat.value = mapForm.lng.value = '';
  if (!url) { refreshPreviewFromVenue(); return; }
  $('#map-status').textContent = '⏳ Finding that spot…';
  try {
    const r = await api('/api/resolve-map', { method: 'POST', body: { url } });
    if (r.lat !== null) { mapForm.lat.value = r.lat; mapForm.lng.value = r.lng; }
    if (r.place && !mapForm.venue.value.trim()) mapForm.venue.value = r.place;
    const q = mapQuery(r.lat, r.lng, r.place || mapForm.venue.value.trim());
    showMapPreview(q, r.lat !== null ? '📌 Pinned from your Google Maps link!' : '🔗 Link saved — players can open it in Google Maps');
  } catch (err) {
    showMapPreview(mapForm.venue.value.trim(), `⚠️ ${err.message}`, true);
  }
}
mapForm.map_url.addEventListener('change', handleMapLink);
mapForm.map_url.addEventListener('paste', () => setTimeout(handleMapLink, 0));

$('#map-clear').addEventListener('click', clearMapPin);

$('#use-location').addEventListener('click', () => {
  if (!navigator.geolocation) return toast("Your browser can't share location 😕");
  const btn = $('#use-location');
  btn.disabled = true;
  btn.textContent = '⏳ Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      mapForm.lat.value = pos.coords.latitude.toFixed(6);
      mapForm.lng.value = pos.coords.longitude.toFixed(6);
      mapForm.map_url.value = '';
      showMapPreview(`${mapForm.lat.value},${mapForm.lng.value}`, "📌 Pinned to where you are right now!");
      btn.disabled = false;
      btn.textContent = '📍 Use my location';
    },
    () => {
      toast("Couldn't get your location — try pasting a Maps link instead.");
      btn.disabled = false;
      btn.textContent = '📍 Use my location';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

$('#activity-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  $('#activity-error').textContent = '';
  try {
    await api('/api/activities', { method: 'POST', body });
    closeModal();
    confetti();
    toast(`${SPORT_EMOJI[body.sport]} Your game is live! Let the players roll in.`);
    if (state.view === 'past') $('#view-filter .pill[data-view=upcoming]').click();
    else loadActivities();
  } catch (err) {
    $('#activity-error').textContent = err.message;
  }
});

// ---------- confetti ----------
function confetti(x = innerWidth / 2, y = innerHeight / 3) {
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const colors = ['#ff5d8f', '#ff8a3d', '#ffd23f', '#3ddc97', '#2ec4b6', '#4d7cfe', '#8b5cf6'];
  const parts = Array.from({ length: 120 }, () => ({
    x, y,
    vx: (Math.random() - 0.5) * 14,
    vy: Math.random() * -14 - 4,
    size: Math.random() * 8 + 4,
    rot: Math.random() * 360,
    vr: (Math.random() - 0.5) * 20,
    color: colors[Math.floor(Math.random() * colors.length)],
    life: 0,
  }));
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts.forEach((p) => {
      p.vy += 0.4; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - frame / 110);
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    });
    if (++frame < 110) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}

// ---------- boot ----------
(async function init() {
  try {
    const { user } = await api('/api/me');
    if (user) { state.user = user; showApp(); }
    else showAuth();
  } catch {
    showAuth();
  }
})();
