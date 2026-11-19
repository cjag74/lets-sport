// Scripted, screen-recorded walkthrough of Let's Sport.
// Captures frames through the Chrome DevTools screencast (sharper than Playwright's
// built-in VP8 recorder) and returns frame + scene timestamps for syncing.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const VIEW = { width: 1536, height: 864 }; // x1.25 device scale = 1920x1080 frames
const LEAD = 0.3; // seconds of silence before each scene's narration
const GAP = 0.6;  // pause after each scene's narration
const TAIL = 2.8; // hold on the end card for the music fade-out

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// A visible cursor (headless browsers draw none) with a click ripple, and no scrollbars.
const CURSOR_SCRIPT = `
  if (window.top === window) window.addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = \`
      html { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }
      /* keep app toasts clear of the burned-in subtitles, and fully hidden when dismissed */
      .toast { bottom: 150px !important; transition: transform .35s cubic-bezier(.2,.9,.3,1.3), opacity .3s !important; }
      .toast:not(.show) { opacity: 0 !important; }
      #__cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
        width: 30px; height: 30px; transform: translate(-100px,-100px);
        filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); transition: opacity .3s; }
      .__ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 44px; height: 44px;
        margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid rgba(255,93,143,.9);
        animation: __rip .5s ease-out forwards; }
      @keyframes __rip { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }\`;
    document.head.appendChild(st);
    const c = document.createElement('div');
    c.id = '__cursor';
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 30 30"><path d="M4 2 L4 24 L9.5 18.6 L13.4 27.2 L17.3 25.5 L13.5 17 L21.5 17 Z" fill="#fff" stroke="#2b2140" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    document.addEventListener('mousemove', (e) => {
      c.style.transform = 'translate(' + (e.clientX - 4) + 'px,' + (e.clientY - 2) + 'px)';
    }, true);
    document.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = '__ripple';
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }, true);
  });
`;

export async function record({ baseUrl, durations, outDir, demoUser, hostGame }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1.25,
    locale: 'en-US',
    timezoneId: 'Asia/Singapore',
    reducedMotion: 'no-preference',
  });
  await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();

  // ---------- mouse helpers ----------
  let mx = VIEW.width * 0.62, my = VIEW.height * 0.7;
  async function moveTo(x, y, ms) {
    const dist = Math.hypot(x - mx, y - my);
    ms = ms ?? Math.min(750, Math.max(300, dist * 0.8));
    const sx = mx, sy = my;
    const t0 = Date.now();
    // Clock-driven, so a move always takes `ms` however slow each mouse event is.
    for (;;) {
      const p = Math.min(1, (Date.now() - t0) / ms);
      const k = ease(p);
      await page.mouse.move(sx + (x - sx) * k, sy + (y - sy) * k);
      if (p >= 1) break;
      await sleep(10);
    }
    mx = x; my = y;
  }
  async function ensureVisible(loc) {
    const b = await loc.boundingBox();
    if (!b || b.y < 70 || b.y + b.height > VIEW.height - 20) {
      await loc.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await sleep(750);
    }
  }
  async function hover(loc, ms) {
    await ensureVisible(loc);
    const b = await loc.boundingBox();
    await moveTo(b.x + b.width / 2, b.y + b.height / 2, ms);
  }
  async function click(loc, pause = 220) {
    await hover(loc);
    await sleep(pause);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    await sleep(150);
  }
  async function type(loc, text, delay = 45) {
    await click(loc, 120);
    await page.keyboard.type(text, { delay });
    await sleep(150);
  }
  const card = (title) => page.locator('.activity', { hasText: title });

  // ---------- load the app before recording starts ----------
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(mx, my);
  await sleep(1500);

  // ---------- screencast ----------
  const frames = [];
  const cdp = await context.newCDPSession(page);
  let n = 0;
  const writes = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = path.join(outDir, `f${String(n++).padStart(6, '0')}.jpg`);
    frames.push({ t: metadata.timestamp, file });
    writes.push(fs.promises.writeFile(file, Buffer.from(data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080 });
  // Nudge the page so a first frame arrives right away.
  await page.mouse.move(mx + 1, my);
  await sleep(400);

  // ---------- scenes (same order as scenes.json) ----------
  const actions = [
    // 1. Hook — a gentle drift over the landing page.
    async () => {
      await moveTo(VIEW.width * 0.3, VIEW.height * 0.42, 1600);
      await sleep(800);
      await moveTo(VIEW.width * 0.24, VIEW.height * 0.62, 1400);
      await sleep(900);
      await hover(page.locator('.auth-tab[data-mode=register]'), 1500);
    },
    // 2. Sign up.
    async () => {
      await click(page.locator('.auth-tab[data-mode=register]'));
      await sleep(250);
      await type(page.locator('#auth-form [name=name]'), demoUser.name, 55);
      await type(page.locator('#auth-form [name=email]'), demoUser.email, 35);
      await type(page.locator('#auth-form [name=password]'), demoUser.password, 40);
      await click(page.locator('#auth-submit'));
      await page.waitForSelector('#app-screen:not(.hidden) .activity');
      await moveTo(VIEW.width * 0.55, VIEW.height * 0.35, 900);
    },
    // 3. Browse + filter.
    async () => {
      await sleep(400);
      await hover(card('Friday Night Doubles').locator('h3'), 800);
      await sleep(1300);
      await hover(card('Sunday Morning 3-on-3').locator('h3'), 700);
      await sleep(1100);
      await hover(card('Sunday Morning 3-on-3').locator('.spots'), 500);
      await sleep(1200);
      await click(page.locator('#sport-filter .pill[data-sport=basketball]'));
      await sleep(1700);
      await click(page.locator('#sport-filter .pill[data-sport=""]'));
    },
    // 4. Host a game.
    async () => {
      await click(page.locator('#new-btn'), 150);
      await sleep(250);
      await click(page.locator('.sport-option.badminton'), 120);
      const f = page.locator('#activity-form');
      await type(f.locator('[name=title]'), hostGame.title, 28);
      await click(f.locator('[name=date]'), 60);
      await f.locator('[name=date]').fill(hostGame.date);
      await f.locator('[name=time]').fill(hostGame.time);
      await type(f.locator('[name=venue]'), hostGame.venue, 25);
      await click(f.locator('[name=map_url]'), 60);
      await f.locator('[name=map_url]').fill(hostGame.mapUrl); // like a paste
      await f.locator('[name=map_url]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('#map-status')?.textContent.includes('Pinned'));
      await ensureVisible(page.locator('#map-preview'));
      await hover(page.locator('#map-preview iframe'), 600);
    },
    // 5. Post it.
    async () => {
      const f = page.locator('#activity-form');
      await f.locator('[name=max_players]').fill('4');
      await click(f.locator('button[type=submit]'));
      await page.waitForSelector('#modal.hidden', { state: 'attached' });
      await card(hostGame.title).waitFor();
      await sleep(300);
      await hover(card(hostGame.title).locator('h3'), 700);
    },
    // 6. Join Priya's game.
    async () => {
      await sleep(300);
      const c = card('Friday Night Doubles');
      await hover(c.locator('.spots'), 800);
      await sleep(900);
      await click(c.locator('button[data-action=join]'));
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.activity')].some(
          (a) => a.textContent.includes('Friday Night Doubles') && a.textContent.includes('Full house')
        )
      );
      await sleep(600);
      await hover(card('Friday Night Doubles').locator('.spots'), 700);
      await sleep(1200);
      await hover(card('Friday Night Doubles').locator('button[data-action=leave]'), 700);
    },
    // 7. Map + directions.
    async () => {
      const c = card('Sunday Morning 3-on-3');
      await click(c.locator('[data-map-toggle]'));
      await c.locator('.card-map iframe').waitFor();
      await sleep(600);
      await ensureVisible(c.locator('.card-map'));
      await hover(c.locator('.map-links a', { hasText: 'Directions' }), 700);
    },
    // 8. My games, then the end card.
    async () => {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await sleep(700);
      await click(page.locator('#view-filter .pill[data-view=mine]'));
      await sleep(2600);
      await moveTo(VIEW.width * 0.5, VIEW.height * 0.55, 700);
      await page.evaluate(() => {
        document.getElementById('__cursor').style.opacity = '0';
        const o = document.createElement('div');
        o.innerHTML = `<div class="logo big">Let's <span>Sport!</span></div>
          <p class="tagline">Find your crew. Book the court. Play together!</p>
          <div class="hero-sports"><div class="sport-chip badminton">🏸 Badminton</div>
          <div class="sport-chip basketball">🏀 Basketball</div></div>`;
        Object.assign(o.style, {
          position: 'fixed', inset: '0', zIndex: '2147483000', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', textAlign: 'center', opacity: '0',
          background: 'linear-gradient(135deg, #fff3d6 0%, #ffe0ef 50%, #dff5ff 100%)',
          transition: 'opacity .9s ease',
        });
        document.body.appendChild(o);
        requestAnimationFrame(() => requestAnimationFrame(() => (o.style.opacity = '1')));
      });
    },
  ];

  const scenes = [];
  for (let i = 0; i < actions.length; i++) {
    const start = now();
    await actions[i]();
    const used = now() - start;
    const target = LEAD + durations[i] + GAP + (i === actions.length - 1 ? TAIL : 0);
    if (used > LEAD + durations[i]) {
      console.warn(`  ! scene ${i + 1} actions took ${used.toFixed(2)}s, narration is ${durations[i].toFixed(2)}s`);
    }
    if (target > used) await sleep((target - used) * 1000);
    scenes.push({ start, end: now() });
    console.log(`  recorded scene ${i + 1} (${(now() - start).toFixed(2)}s)`);
  }

  await cdp.send('Page.stopScreencast');
  await Promise.all(writes);
  const end = now();
  await browser.close();

  const result = { frames, scenes, end, lead: LEAD };
  fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(result, null, 1));
  return result;
}
