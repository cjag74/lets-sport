// Builds demo.mp4 for Let's Sport from scratch:
//   voiceover (edge-tts) -> seeded demo app -> Playwright recording -> subtitles -> music -> final mix.
// Run:  npm run build   (from this folder)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from './record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const BUILD = path.join(HERE, 'build');
const AUDIO = path.join(HERE, 'audio');
const PORT = Number(process.env.DEMO_PORT || 3055);
const BASE = `http://localhost:${PORT}`;
const VOICE = process.env.DEMO_VOICE || 'en-US-AriaNeural';
const FPS = 30;
const MUSIC_UNDER_VOICE_DB = 25; // music sits ~25 dB below the narration (before ducking)
const TARGET_LUFS = -16;

const scenes = JSON.parse(fs.readFileSync(path.join(HERE, 'scenes.json'), 'utf8'));
const log = (m) => console.log(`\n▶ ${m}`);

// ---------- tool lookup ----------
function findTool(name) {
  const env = process.env[name.toUpperCase()];
  if (env) return env;
  const probe = spawnSync(name, ['-version'], { stdio: 'ignore' });
  if (probe.status === 0) return name;
  const pkgs = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(pkgs)) {
    for (const d of fs.readdirSync(pkgs).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      for (const sub of fs.readdirSync(path.join(pkgs, d))) {
        const exe = path.join(pkgs, d, sub, 'bin', `${name}.exe`);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  throw new Error(`${name} not found. Install ffmpeg (e.g. "winget install Gyan.FFmpeg") or set ${name.toUpperCase()}.`);
}
const FFMPEG = findTool('ffmpeg');
const FFPROBE = findTool('ffprobe');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const PY_ARGS = process.env.PYTHON ? [] : process.platform === 'win32' ? ['-3.12'] : [];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || HERE, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} failed:\n${(r.stderr || '').split('\n').slice(-25).join('\n')}`);
  }
  return r;
}
const ffmpeg = (args, opts) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], opts);
function duration(file) {
  const r = run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(r.stdout);
}
function loudness(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const json = r.stderr.slice(r.stderr.lastIndexOf('{'), r.stderr.lastIndexOf('}') + 1);
  const d = JSON.parse(json);
  return { i: parseFloat(d.input_i), tp: parseFloat(d.input_tp) };
}

// ---------- dates for the demo data (relative to today, local time) ----------
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nextSaturdayOffset() {
  const dow = new Date().getDay(); // 0 Sun .. 6 Sat
  let n = (6 - dow + 7) % 7;
  if (n < 2) n += 7;
  return n;
}

// Demo-only accounts on a throwaway local database (never your real data).
const DEMO_PASSWORD = 'demo-pass-2026';
const DEMO_USER = { name: 'Sam Rivera', email: 'sam.rivera@example.test', password: DEMO_PASSWORD };
const HOST_GAME = {
  title: 'Saturday Smash & Brunch',
  date: dayOffset(nextSaturdayOffset()),
  time: '10:00',
  venue: 'OCBC Arena, Hall 2',
  mapUrl: 'https://www.google.com/maps/place/OCBC+Arena/@1.3024,103.8755,17z/data=!3m1!4b1!4m6!3m5!8m2!3d1.302452!4d103.876132',
};

// ---------- 1. voiceover ----------
async function voiceover() {
  log(`Generating voiceover (${VOICE})`);
  fs.rmSync(AUDIO, { recursive: true, force: true });
  run(PYTHON, [...PY_ARGS, 'tts.py', 'scenes.json', 'audio', VOICE, '+5%']);
  const words = JSON.parse(fs.readFileSync(path.join(AUDIO, 'words.json'), 'utf8'));
  // Time scenes to the end of the speech itself (clips carry ~0.8s of trailing silence).
  const durations = scenes.map((s) => {
    const clip = duration(path.join(AUDIO, `${s.id}.mp3`));
    const w = words[s.id];
    return w && w.length ? Math.min(clip, w[w.length - 1].end + 0.15) : clip;
  });
  durations.forEach((d, i) => console.log(`  ${scenes[i].id}: ${d.toFixed(2)}s of speech`));
  return { words, durations };
}

// ---------- 2. demo server + seed data ----------
async function startServer() {
  log('Starting the app on a fresh demo database');
  const dbFile = path.join(BUILD, 'demo.db');
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/me`);
      return proc;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  proc.kill();
  throw new Error(`App did not start on port ${PORT}`);
}

async function seed() {
  log('Seeding demo games');
  const sessions = {};
  async function call(who, method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(sessions[who] ? { Cookie: sessions[who] } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) sessions[who] = set.split(';')[0];
    const data = await res.json();
    if (!res.ok) throw new Error(`${url}: ${data.error}`);
    return data;
  }
  const people = ['Priya Shah', 'Marcus Lee', 'Jess Tan', 'Tom Wright', 'Aisha Rahman', 'Daniel Ong'];
  for (const name of people) {
    const email = name.toLowerCase().replace(' ', '.') + '@example.test';
    await call(name, 'POST', '/api/register', { name, email, password: DEMO_PASSWORD });
  }
  const games = [
    { host: 'Priya Shah', sport: 'badminton', title: 'Friday Night Doubles', date: dayOffset(1), time: '19:00',
      venue: 'Clementi Sports Hall, Court 2', max_players: 4, skill_level: 'Intermediate',
      notes: 'Shuttles provided, just bring your racket!', lat: 1.3138, lng: 103.7649,
      join: ['Jess Tan', 'Tom Wright'] },
    { host: 'Marcus Lee', sport: 'basketball', title: 'Sunday Morning 3-on-3', date: dayOffset(3), time: '09:00',
      venue: 'Bishan Park Basketball Court', max_players: 6, skill_level: 'All levels',
      notes: 'Friendly games, good vibes. Bring water!', lat: 1.3626, lng: 103.8463,
      join: ['Priya Shah', 'Tom Wright', 'Jess Tan'] },
    { host: 'Jess Tan', sport: 'badminton', title: "Beginners' Shuttle Club", date: dayOffset(5), time: '10:00',
      venue: 'Toa Payoh Sports Hall', max_players: 8, skill_level: 'Beginner',
      notes: "New to badminton? Perfect. We'll teach you the basics.", lat: 1.3305, lng: 103.8513,
      join: ['Priya Shah'] },
    { host: 'Tom Wright', sport: 'basketball', title: 'After-work Hoops', date: dayOffset(6), time: '18:30',
      venue: 'Jurong West Sports Centre', max_players: 6, skill_level: 'Intermediate',
      notes: 'Full court if we get enough people.', lat: 1.3383, lng: 103.6943,
      join: ['Marcus Lee', 'Aisha Rahman', 'Daniel Ong', 'Priya Shah'] },
  ];
  for (const g of games) {
    const { id } = await call(g.host, 'POST', '/api/activities', g);
    for (const p of g.join) await call(p, 'POST', `/api/activities/${id}/join`);
    console.log(`  ${g.title}: ${1 + g.join.length}/${g.max_players}`);
  }
}

// ---------- 3. video from screencast frames ----------
function buildVideo(tl) {
  log('Encoding screen recording');
  const t0 = tl.scenes[0].start;
  const end = tl.end;
  const frames = tl.frames.filter((f) => f.t < end);
  // Start on the last frame captured before scene 1, so there is no blank lead-in.
  let first = 0;
  for (let i = 0; i < frames.length; i++) if (frames[i].t <= t0) first = i;
  const used = frames.slice(first);
  const lines = [];
  used.forEach((f, i) => {
    const from = Math.max(f.t, t0);
    const to = i + 1 < used.length ? Math.max(used[i + 1].t, t0) : end;
    if (to - from <= 0) return;
    lines.push(`file '${f.file.replace(/\\/g, '/')}'`, `duration ${(to - from).toFixed(4)}`);
  });
  lines.push(`file '${used[used.length - 1].file.replace(/\\/g, '/')}'`);
  const list = path.join(BUILD, 'frames.txt');
  fs.writeFileSync(list, lines.join('\n'));
  const out = path.join(BUILD, 'screen.mp4');
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=${FPS},scale=1920:1080:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-r', String(FPS), out,
  ]);
  return { file: out, length: end - t0, t0 };
}

// ---------- 4. narration track, aligned to the recorded scenes ----------
function buildNarration(tl, t0, length) {
  log('Laying narration onto the timeline');
  const inputs = [];
  const parts = [];
  const offsets = [];
  scenes.forEach((s, i) => {
    const at = tl.scenes[i].start - t0 + tl.lead;
    offsets.push(at);
    inputs.push('-i', path.join(AUDIO, `${s.id}.mp3`));
    parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${Math.round(at * 1000)}[a${i}]`);
  });
  const mix = scenes.map((_, i) => `[a${i}]`).join('') +
    `amix=inputs=${scenes.length}:normalize=0:dropout_transition=0,apad,atrim=0:${length.toFixed(3)}[n]`;
  const raw = path.join(BUILD, 'narration_raw.wav');
  ffmpeg([...inputs, '-filter_complex', [...parts, mix].join(';'), '-map', '[n]', raw]);
  // Level the voice to the delivery target before mixing.
  const { i } = loudness(raw);
  const out = path.join(AUDIO, 'narration.wav');
  ffmpeg(['-i', raw, '-af', `volume=${(TARGET_LUFS - i).toFixed(2)}dB`, '-ar', '48000', out]);
  return { file: out, offsets };
}

// ---------- 5. music: a gentle, upbeat synthesized loop (I–vi–IV–V, 100 BPM) ----------
function buildMusic(length) {
  log('Synthesizing background music');
  const bar = 2.4; // 4 beats at 100 BPM
  // Chord tones (root, third, fifth) for C, Am, F, G.
  const chord = (a, b, c, d) => `if(eq(ld(0),0),${a},if(eq(ld(0),1),${b},if(eq(ld(0),2),${c},${d})))`;
  const r = chord(261.63, 220.0, 174.61, 196.0);
  const th = chord(329.63, 261.63, 220.0, 246.94);
  const fi = chord(392.0, 329.63, 261.63, 293.66);
  const pos = `mod(t,${bar})`;
  const padEnv = `min(1,${pos}/0.25)*min(1,(${bar}-${pos})/0.25)`;
  const pad = `0.09*${padEnv}*(sin(2*PI*${r}*t)+0.8*sin(2*PI*${th}*t)+0.7*sin(2*PI*${fi}*t))`;
  // Eighth-note arpeggio, plucked (marimba-ish) an octave up.
  const k = 'mod(floor(t/0.3),4)';
  const arpF = `if(eq(${k},0),2*${r},if(eq(${k},1),2*${th},if(eq(${k},2),2*${fi},4*${r})))`;
  const tau = 'mod(t,0.3)';
  const pluck = `0.16*(1-exp(-300*${tau}))*exp(-9*${tau})*(sin(2*PI*${arpF}*t)+0.25*sin(4*PI*${arpF}*t))`;
  // Soft bass on beats 1 and 3.
  const btau = 'mod(t,1.2)';
  const bass = `0.18*(1-exp(-200*${btau}))*exp(-3.5*${btau})*sin(PI*${r}*t)`;
  const expr = `st(0,mod(floor(t/${bar}),4));${pad}+${pluck}+${bass}`;
  const raw = path.join(BUILD, 'music_raw.wav');
  ffmpeg([
    '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=${(length + 1).toFixed(2)}`,
    '-af', 'lowpass=f=3200,aecho=0.8:0.6:280|430:0.22|0.15,pan=stereo|c0=c0|c1=c0,' +
      'extrastereo=m=1.2',
    raw,
  ]);
  return raw;
}

// ---------- 6. subtitles from word timings ----------
function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}
const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');

function splitLines(text, max = 42) {
  if (text.length <= max) return text;
  const words = text.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    if (a.length > max || b.length > max) continue;
    // Prefer balanced lines that break after punctuation.
    const score = Math.abs(a.length - b.length) - (/[,.?!…]$/.test(a) ? 12 : 0);
    if (!best || score < best.score) best = { score, text: `${a}\n${b}` };
  }
  return best ? best.text : text;
}

function buildSubtitles(words, offsets) {
  log('Writing subtitles');
  const cues = [];
  scenes.forEach((s, si) => {
    const tokens = s.text.split(/\s+/).filter(Boolean);
    const wb = words[s.id] || [];
    // Align script tokens to spoken word boundaries.
    let j = 0;
    const timed = tokens.map((tok) => {
      const n = norm(tok);
      for (let k = j; k < Math.min(wb.length, j + 4); k++) {
        if (norm(wb[k].text) === n || (n && norm(wb[k].text).startsWith(n)) || (n && n.startsWith(norm(wb[k].text)))) {
          j = k + 1;
          return { tok, start: wb[k].start, end: wb[k].end };
        }
      }
      return { tok, start: null, end: null };
    });
    // Fill any gaps by interpolation.
    timed.forEach((t, i) => {
      if (t.start === null) {
        const prev = timed.slice(0, i).reverse().find((x) => x.end !== null);
        t.start = prev ? prev.end : 0;
        t.end = t.start + 0.2;
      }
    });
    // Group into cues: break at sentence ends, and at commas once a cue is long enough.
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      cues.push({
        text: cur.map((t) => t.tok).join(' '),
        start: offsets[si] + cur[0].start,
        end: offsets[si] + cur[cur.length - 1].end,
      });
      cur = [];
    };
    timed.forEach((t, i) => {
      const next = timed[i + 1];
      const len = [...cur, t].map((x) => x.tok).join(' ').length;
      const nextLen = next ? len + 1 + next.tok.length : 0;
      cur.push(t);
      if (/[.?!…]["”]?$/.test(t.tok) && len >= 12) flush();
      else if (/[,]["”]?$/.test(t.tok) && len >= 34) flush();
      else if (next && nextLen > 74) flush();
    });
    flush();
  });
  // Tidy timing: small hold after speech, no overlaps, min 1s on screen.
  cues.forEach((c, i) => {
    const next = cues[i + 1];
    c.end = Math.max(c.end + 0.35, c.start + 1.0);
    if (next && c.end > next.start - 0.05) c.end = next.start - 0.05;
  });
  const srt = cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${splitLines(c.text)}\n`)
    .join('\n');
  fs.writeFileSync(path.join(HERE, 'demo.srt'), srt, 'utf8');
  console.log(`  ${cues.length} cues`);
}

// ---------- 7. final mix ----------
function finalMix(video, narration, musicRaw, length) {
  log('Mixing audio (ducked music) and burning subtitles');
  // Music level: MUSIC_UNDER_VOICE_DB below the narration, then ducked further by sidechain.
  const m = loudness(musicRaw);
  const musicGain = TARGET_LUFS - MUSIC_UNDER_VOICE_DB - m.i;
  const fadeOut = Math.max(0, length - 2.8);
  const premix = path.join(BUILD, 'mix_pre.wav');
  ffmpeg([
    '-i', narration, '-i', musicRaw,
    '-filter_complex',
    [
      '[0:a]asplit=2[voice][sc]',
      `[1:a]atrim=0:${length.toFixed(3)},volume=${musicGain.toFixed(2)}dB,afade=t=in:d=2,afade=t=out:st=${fadeOut.toFixed(2)}:d=2.8[mus]`,
      '[mus][sc]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=450:makeup=1[ducked]',
      '[voice]pan=stereo|c0=c0|c1=c0[v2]',
      '[v2][ducked]amix=inputs=2:normalize=0:duration=first[out]',
    ].join(';'),
    '-map', '[out]', '-ar', '48000', premix,
  ]);
  // Normalise the mix to the delivery target with a true-peak safety limiter.
  const l = loudness(premix);
  const mixed = path.join(AUDIO, 'final_mix.wav');
  ffmpeg(['-i', premix, '-af', `volume=${(TARGET_LUFS - l.i).toFixed(2)}dB,alimiter=limit=0.84:level=false`, '-ar', '48000', mixed]);

  const style = [
    'FontName=Segoe UI Semibold', 'FontSize=13', 'PrimaryColour=&H00FFFFFF', 'OutlineColour=&H70000000',
    'BackColour=&H70000000', 'BorderStyle=4', 'Outline=0', 'Shadow=0', 'MarginV=22', 'Alignment=2',
  ].join(',');
  ffmpeg([
    '-i', video, '-i', mixed,
    '-vf', `subtitles=demo.srt:force_style='${style}',fade=t=in:st=0:d=0.6,fade=t=out:st=${(length - 1.2).toFixed(2)}:d=1.2`,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', 'demo.mp4',
  ]);
}

// ---------- main ----------
async function main() {
  fs.mkdirSync(BUILD, { recursive: true });
  const { words, durations } = await voiceover();
  const server = await startServer();
  let tl;
  try {
    await seed();
    log('Recording the walkthrough (1920x1080)');
    tl = await record({ baseUrl: BASE, durations, outDir: path.join(BUILD, 'frames'), demoUser: DEMO_USER, hostGame: HOST_GAME });
  } finally {
    server.kill();
  }
  const video = buildVideo(tl);
  const narration = buildNarration(tl, video.t0, video.length);
  buildSubtitles(words, narration.offsets);
  const music = buildMusic(video.length);
  fs.copyFileSync(music, path.join(AUDIO, 'music.wav'));
  finalMix(video.file, narration.file, music, video.length);

  const final = loudness(path.join(HERE, 'demo.mp4'));
  log(`Done: demo.mp4  ${duration(path.join(HERE, 'demo.mp4')).toFixed(1)}s, ${final.i} LUFS, true peak ${final.tp} dBTP`);
}

main().catch((e) => {
  console.error('\n✖ Build failed:', e.message);
  process.exit(1);
});
