import { chromium } from 'patchright';
import { resolve, jsonDb, datetime, filenamify, notify, html_game_list, handleSIGINT, closeContextSafely, awaitUserCaptchaSolve, log } from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';

const SITE_ID = 'alienware-arena';
const SITE_NAME = 'Alienware Arena';
const AWA_URL = 'https://eu.alienwarearena.com/control-center';

const screenshot = (...a) => resolve(cfg.dir.screenshots, SITE_ID, ...a);
const db = await jsonDb('alienware-arena.json', { days: {} });

log.section(`${SITE_NAME} (v${siteVersion(SITE_ID)})`);
log.status('AWA presence', `${cfg.awa_presence_minutes}m`);
log.status('Daily target', `${cfg.awa_daily_target_minutes}m`);

const context = await chromium.launchPersistentContext(cfg.dir.browser + '-alienware-arena', {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US',
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined,
  recordHar: cfg.record ? { path: `data/record/alienware-arena-${filenamify(datetime())}.har` } : undefined,
  handleSIGINT: false,
  args: [
    '--hide-crash-restore-bubble',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ],
});

handleSIGINT(context);
if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage();
await page.setViewportSize({ width: cfg.width, height: cfg.height });

const notifyItems = [];
const today = datetime().slice(0, 10);
db.data.days[today] ||= { totalMinutes: 0, sessions: [] };

let user = 'member';
let twitchToken = null;
let twitchTokenExpiresAt = 0;

const streamers = cfg.awa_twitch_streamers
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(s => /^[a-z0-9_]{3,25}$/i.test(s));

function jitterMs(minSec = 60, maxSec = 180) {
  const min = Math.max(1, minSec) * 1000;
  const max = Math.max(minSec, maxSec) * 1000;
  return Math.round(min + Math.random() * (max - min));
}

function logSession(platform, details, minutes) {
  const entry = {
    time: datetime(),
    platform,
    details,
    minutes,
  };
  db.data.days[today].sessions.push(entry);
  db.data.days[today].totalMinutes = Number((db.data.days[today].totalMinutes + minutes).toFixed(2));
  return entry;
}

function todayTotal() {
  return db.data.days[today]?.totalMinutes || 0;
}

async function captchaVisible() {
  return await page.locator([
    'iframe[src*="captcha"]',
    'iframe[title*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
  ].join(', ')).first().isVisible().catch(() => false);
}

async function readAwaLogin() {
  await page.goto(AWA_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const result = await page.evaluate(() => {
    const loggedIn = !!document.querySelector([
      'a.dropdown-item[href="/quests"][data-is-logged-in="true"]',
      '[data-is-logged-in="true"]',
      'a[href="/quests"]',
    ].join(', '));
    const user = document.querySelector('.media-body, .username, [class*="username"]')?.textContent?.trim() || null;
    return { loggedIn, user, title: document.title };
  });

  if (result.user) user = result.user;
  return result.loggedIn;
}

async function ensureAwaLogin() {
  if (await readAwaLogin()) {
    log.status('AWA user', user);
    return true;
  }

  log.warn('Not signed in to Alienware Arena');
  await notify('alienware-arena: not signed in. Open the Sessions tab/noVNC and sign in manually.');

  if (cfg.nowait || cfg.headless) {
    log.info('Run `SHOW=1 node alienware-arena` once to sign in with the persistent browser profile');
    return false;
  }

  if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
  await page.goto(AWA_URL, { waitUntil: 'domcontentloaded' });
  await awaitUserCaptchaSolve(page, {
    service: SITE_ID,
    label: 'Login captcha',
    captchaCheck: captchaVisible,
  });
  await page.waitForSelector('[data-is-logged-in="true"], a[href="/quests"]', { timeout: cfg.login_timeout });
  if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

  return await readAwaLogin();
}

async function keepPageAlive(minutes, label, activity = 'scroll') {
  const end = Date.now() + minutes * 60 * 1000;
  while (Date.now() < end) {
    if (activity === 'twitch') {
      await page.evaluate(() => {
        const mute = document.querySelector('[data-a-target="player-mute-unmute-button"]');
        if (mute && mute.getAttribute('data-muted') !== 'true') mute.click();
        const chat = document.querySelector('.chat-room, [data-a-target="chat-messages"]');
        if (chat) chat.style.display = 'none';
        window.scrollBy(0, Math.round(Math.random() * 300 - 150));
      }).catch(() => {});
    } else {
      await page.mouse.move(
        Math.round(100 + Math.random() * Math.max(200, cfg.width - 200)),
        Math.round(100 + Math.random() * Math.max(200, cfg.height - 200)),
      ).catch(() => {});
      await page.evaluate(() => window.scrollBy(0, Math.round(Math.random() * 500 - 250))).catch(() => {});
    }

    const remaining = end - Date.now();
    if (remaining <= 0) break;
    const sleep = Math.min(jitterMs(60, 180), remaining);
    log.progressStart(`${label}: ${Math.max(0, Math.ceil(remaining / 60000))}m remaining`);
    log.progressEnd();
    await page.waitForTimeout(sleep);
  }
}

async function runAwaPresence() {
  if (cfg.awa_presence_minutes <= 0) return true;
  await page.goto(AWA_URL, { waitUntil: 'domcontentloaded' });
  const solved = await awaitUserCaptchaSolve(page, {
    service: SITE_ID,
    label: 'AWA presence captcha',
    captchaCheck: captchaVisible,
  });
  if (!solved) return false;

  log.info(`Maintaining AWA presence for ${cfg.awa_presence_minutes} minutes`);
  await keepPageAlive(cfg.awa_presence_minutes, 'AWA presence');
  logSession('AWA', 'control-center presence', cfg.awa_presence_minutes);
  log.ok('AWA presence complete');
  return true;
}

async function getTwitchToken() {
  if (twitchToken && Date.now() < twitchTokenExpiresAt) return twitchToken;
  if (!cfg.awa_twitch_client_id || !cfg.awa_twitch_client_secret) return null;

  const body = new URLSearchParams({
    client_id: cfg.awa_twitch_client_id,
    client_secret: cfg.awa_twitch_client_secret,
    grant_type: 'client_credentials',
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body,
  });
  if (!res.ok) throw new Error(`Twitch OAuth failed: HTTP ${res.status}`);
  const data = await res.json();
  twitchToken = data.access_token;
  twitchTokenExpiresAt = Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000;
  return twitchToken;
}

async function isStreamerLive(streamer) {
  const token = await getTwitchToken().catch(e => {
    log.warn(e.message);
    return null;
  });
  if (!token) {
    log.warn('Missing Twitch API credentials; assuming streamer is live');
    return true;
  }

  const url = `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(streamer)}`;
  const res = await fetch(url, {
    headers: {
      'Client-ID': cfg.awa_twitch_client_id,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    log.warn(`Twitch live check failed for ${streamer}: HTTP ${res.status}; assuming live`);
    return true;
  }
  const data = await res.json();
  const stream = data.data?.[0];
  if (stream) {
    log.info(`${streamer} is live (${stream.game_name || 'unknown'}, ${stream.viewer_count || 0} viewers)`);
    return true;
  }
  log.info(`${streamer} is offline`);
  return false;
}

async function watchStreamer(streamer, minutes) {
  const url = `https://www.twitch.tv/${streamer}`;
  log.info(`Watching ${streamer} for ${minutes} minutes`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await keepPageAlive(minutes, `Twitch ${streamer}`, 'twitch');
  logSession('Twitch', `Watched ${streamer}`, minutes);
  notifyItems.push({ title: `Twitch: ${streamer}`, url, status: 'claimed', details: `${minutes} minutes watched` });
  return true;
}

async function runTwitchSessions() {
  if (!streamers.length) {
    log.warn('No Twitch streamers configured');
    return false;
  }

  let watched = 0;
  let offline = 0;
  let errors = 0;

  while (todayTotal() < cfg.awa_daily_target_minutes) {
    let liveFound = false;

    for (const streamer of streamers) {
      if (todayTotal() >= cfg.awa_daily_target_minutes) break;
      try {
        if (!await isStreamerLive(streamer)) {
          offline++;
          await page.waitForTimeout(jitterMs(10, 20));
          continue;
        }

        liveFound = true;
        const remaining = cfg.awa_daily_target_minutes - todayTotal();
        const minutes = Math.max(1, Math.min(cfg.awa_watch_chunk_minutes, Math.ceil(remaining)));
        await watchStreamer(streamer, minutes);
        watched++;
        break;
      } catch (e) {
        errors++;
        log.warn(`${streamer} failed: ${e.message}`);
        await page.screenshot({ path: screenshot('failed', `${streamer}_${filenamify(datetime())}.png`), fullPage: true }).catch(() => {});
      }

      await page.waitForTimeout(jitterMs(10, 20));
    }

    if (todayTotal() >= cfg.awa_daily_target_minutes) break;
    if (!liveFound) {
      log.warn('No configured streamers are live; stopping this run');
      break;
    }
  }

  return { watched, offline, errors };
}

try {
  if (!await ensureAwaLogin()) {
    process.exitCode = 1;
  } else if (todayTotal() >= cfg.awa_daily_target_minutes) {
    log.info(`Daily target already met: ${todayTotal()}/${cfg.awa_daily_target_minutes} minutes`);
  } else {
    const awaOk = await runAwaPresence();
    if (!awaOk) throw new Error('AWA presence failed');

    const twitch = await runTwitchSessions();
    log.summary({
      siteId: SITE_ID,
      claimed: twitch.watched,
      skipped: twitch.offline,
      display: 'tracked',
      tracked: Math.round(todayTotal()),
      failed: twitch.errors,
    });
  }
} catch (error) {
  process.exitCode ||= 1;
  log.fail(`Exception: ${error.message || error}`);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode !== 130) await notify(`alienware-arena failed: ${error.message.split('\n')[0]}`, { attachLatestScreenshot: true });
} finally {
  await db.write();
  if (notifyItems.length || process.exitCode) {
    const status = `${Math.round(todayTotal())}/${cfg.awa_daily_target_minutes} minutes today`;
    const body = notifyItems.length ? html_game_list(notifyItems) : status;
    await notify(`alienware-arena (${user}):<br>${status}<br>${body}`, { kind: process.exitCode ? 'action' : 'summary' });
  }
}

if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await closeContextSafely(context);
