const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 14;
const COOKIE = 'ls_session';
const SPORTS = ['badminton', 'basketball'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`
  );
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, name: row.name, email: row.email };
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in first.' });
  req.user = user;
  next();
}

// ---------- Google Maps links ----------
function toCoord(v, limit) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? Math.round(n * 1e6) / 1e6 : null;
}

function isGoogleMapsUrl(u) {
  const host = u.hostname.toLowerCase();
  if (host === 'maps.app.goo.gl') return true;
  if (host === 'goo.gl') return u.pathname.startsWith('/maps');
  if (/^maps\.google\.[a-z.]+$/.test(host)) return true;
  if (/^(www\.)?google\.[a-z.]+$/.test(host)) return u.pathname.startsWith('/maps');
  return false;
}

// Pull coordinates and a place name out of a full Google Maps URL.
function extractFromMapUrl(href) {
  const out = { lat: null, lng: null, place: '' };
  const pin = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/); // exact pin of a place
  const at = href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/); // map centre
  const q = href.match(/[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i);
  const m = pin || q || at;
  if (m) {
    out.lat = toCoord(m[1], 90);
    out.lng = toCoord(m[2], 180);
    if (out.lat === null || out.lng === null) out.lat = out.lng = null;
  }
  const place = href.match(/\/maps\/place\/([^/@?]+)/);
  if (place) {
    try { out.place = decodeURIComponent(place[1].replace(/\+/g, ' ')).slice(0, 120); } catch {}
  }
  return out;
}

// Validates a Google Maps link; short links (maps.app.goo.gl) are followed to the full URL.
async function resolveMapLink(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!isGoogleMapsUrl(u)) return null;

  let full = u.href;
  if (u.hostname === 'maps.app.goo.gl' || u.hostname === 'goo.gl') {
    try {
      // Follow up to 3 redirects, but only while they stay on Google domains.
      let next = u;
      for (let i = 0; i < 3 && (next.hostname.endsWith('goo.gl')); i++) {
        const r = await fetch(next.href, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const loc = r.headers.get('location');
        if (!loc) break;
        next = new URL(loc, next);
        if (!isGoogleMapsUrl(next) && !next.hostname.endsWith('google.com')) break;
        full = next.href;
      }
    } catch {
      // Couldn't reach Google — keep the short link, just without coordinates.
    }
  }
  return { url: u.href, ...extractFromMapUrl(full) };
}

function clean(s, max = 200) {
  return String(s ?? '').trim().slice(0, max);
}

function activityWithPlayers(a, userId) {
  const players = db
    .prepare(
      `SELECT u.id, u.name FROM interests i JOIN users u ON u.id = i.user_id
       WHERE i.activity_id = ? ORDER BY i.created_at`
    )
    .all(a.id);
  return {
    ...a,
    players,
    is_host: a.host_id === userId,
    is_joined: players.some((p) => p.id === userId),
  };
}

// ---------- auth ----------
app.post('/api/register', (req, res) => {
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That email looks a bit off.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, hashPassword(password));
  const id = Number(info.lastInsertRowid);
  startSession(res, id);
  res.json({ user: { id, name, email } });
});

app.post('/api/login', (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  startSession(res, user.id);
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: currentUser(req) });
});

// ---------- activities ----------
app.get('/api/activities', requireAuth, (req, res) => {
  const { sport, view } = req.query;
  const today = localToday();
  const where = [];
  const params = [];

  if (view === 'past') {
    where.push('a.date < ?');
  } else {
    where.push('a.date >= ?');
  }
  params.push(today);

  if (SPORTS.includes(sport)) {
    where.push('a.sport = ?');
    params.push(sport);
  }
  if (view === 'mine') {
    where.push('(a.host_id = ? OR EXISTS (SELECT 1 FROM interests i WHERE i.activity_id = a.id AND i.user_id = ?))');
    params.push(req.user.id, req.user.id);
  }

  const order = view === 'past' ? 'DESC' : 'ASC';
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS host_name FROM activities a
       JOIN users u ON u.id = a.host_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.date ${order}, a.time ${order}`
    )
    .all(...params);

  res.json({ activities: rows.map((a) => activityWithPlayers(a, req.user.id)) });
});

// Lets the "Host a game" form preview a pasted Google Maps link before posting.
app.post('/api/resolve-map', requireAuth, async (req, res) => {
  const parsed = await resolveMapLink(clean(req.body.url, 2000));
  if (!parsed) return res.status(400).json({ error: "That doesn't look like a Google Maps link." });
  res.json(parsed);
});

app.post('/api/activities', requireAuth, async (req, res) => {
  const sport = clean(req.body.sport, 20);
  const title = clean(req.body.title, 80);
  const date = clean(req.body.date, 10);
  const time = clean(req.body.time, 5);
  const venue = clean(req.body.venue, 120);
  const notes = clean(req.body.notes, 500);
  const skill = clean(req.body.skill_level, 30) || 'All levels';
  const max = Math.max(2, Math.min(50, parseInt(req.body.max_players, 10) || 4));

  // Optional map location: a Google Maps link and/or coordinates.
  let mapUrl = null;
  let lat = toCoord(req.body.lat, 90);
  let lng = toCoord(req.body.lng, 180);
  if (lat === null || lng === null) lat = lng = null;
  const rawMap = clean(req.body.map_url, 2000);
  if (rawMap) {
    const parsed = await resolveMapLink(rawMap);
    if (!parsed) return res.status(400).json({ error: "That doesn't look like a Google Maps link." });
    mapUrl = parsed.url;
    if (lat === null && parsed.lat !== null) ({ lat, lng } = parsed);
  }

  if (!SPORTS.includes(sport)) return res.status(400).json({ error: 'Pick badminton or basketball.' });
  if (!title || !venue) return res.status(400).json({ error: 'Give your game a title and a venue.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ error: 'Please choose a date and time.' });
  }
  if (date < localToday()) {
    return res.status(400).json({ error: "That date has already passed — let's play in the future!" });
  }

  const info = db
    .prepare(
      `INSERT INTO activities (host_id, sport, title, date, time, venue, max_players, skill_level, notes, map_url, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, sport, title, date, time, venue, max, skill, notes, mapUrl, lat, lng);
  const id = Number(info.lastInsertRowid);
  // The host is automatically counted as a player.
  db.prepare('INSERT INTO interests (activity_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  res.json({ id });
});

app.delete('/api/activities/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT host_id FROM activities WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Activity not found.' });
  if (a.host_id !== req.user.id) return res.status(403).json({ error: 'Only the host can cancel this.' });
  db.prepare('DELETE FROM activities WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/activities/:id/join', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Activity not found.' });
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM interests WHERE activity_id = ?').get(a.id);
  const already = db
    .prepare('SELECT 1 FROM interests WHERE activity_id = ? AND user_id = ?')
    .get(a.id, req.user.id);
  if (already) return res.json({ ok: true });
  if (n >= a.max_players) return res.status(409).json({ error: 'Sorry, this game is full!' });
  db.prepare('INSERT INTO interests (activity_id, user_id) VALUES (?, ?)').run(a.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/activities/:id/join', requireAuth, (req, res) => {
  const a = db.prepare('SELECT host_id FROM activities WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Activity not found.' });
  if (a.host_id === req.user.id) {
    return res.status(400).json({ error: "You're the host — cancel the game instead." });
  }
  db.prepare('DELETE FROM interests WHERE activity_id = ? AND user_id = ?').run(a.id, req.user.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🏸🏀 Let's Sport is running at http://localhost:${PORT}`);
});
