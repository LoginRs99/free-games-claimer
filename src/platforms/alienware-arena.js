import { launchContext, gotoWithRetry } from '#src/browser.js';
import { resolve, jsonDb, datetime, filenamify, notify, html_game_list, awaitUserCaptchaSolve, closeContextSafely, log } from '#src/util.js';
import { cfg } from '#src/config.js';
import { siteVersion } from '#src/sites.js';

const SITE_ID = 'alienware-arena';
const SITE_NAME = 'Alienware Arena';
const AWA_URL = 'https://eu.alienwarearena.com/control-center';
const RUN_MODES = new Set(['full', 'presence', 'twitch']);
const RUN_MODE = RUN_MODES.has(process.env.AWA_RUN_MODE) ? process.env.AWA_RUN_MODE : 'full';

const screenshot = (...a) => resolve(cfg.dir.screenshots, SITE_ID, ...a);
const db = await jsonDb('alienware-arena.json', { days: {} });

log.section(`${SITE_NAME} (v${siteVersion(SITE_ID) || '0.1'})`);
log.status('Run mode', RUN_MODE === 'presence' ? 'AWA presence only' : RUN_MODE === 'twitch' ? 'Twitch only' : 'AWA presence + Twitch');
log.status('AWA presence', `${cfg.awa_presence_minutes}m`);
log.status('Twitch target', `${cfg.awa_daily_target_minutes}m`);
log.status('Live recheck', `${cfg.awa_twitch_recheck_minutes}m`);
if (cfg.awa_arp_target > 0) log.status('ARP target', cfg.awa_arp_target);

// Launch persistent browser context using standard upstream launchContext factory
const { context, page } = await launchContext(SITE_ID, {
  profileDir: cfg.dir.browser + '-alienware-arena',
  extraArgs: [
    '--hide-crash-restore-bubble',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ],
});

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const notifyItems = [];
const today = datetime().slice(0, 10);
db.data.days[today] ||= { totalMinutes: 0, sessions: [] };

let user = 'member';
let arpBalance = null;
let twitchToken = null;
let twitchTokenExpiresAt = 0;

const streamers = (cfg.awa_twitch_streamers || '')
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

function todayTwitchTotal() {
  return (db.data.days[today]?.sessions || [])
    .filter(s => s.platform === 'Twitch')
    .reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
}

async function captchaVisible() {
  return await page.locator([
    'iframe[src*="captcha"]',
    'iframe[title*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
  ].join(', ')).first().isVisible().catch(() => false);
}

/**
 * Reads Alienware Arena login status and ARP points balance.
 *
 * DOM Selector breakdown (matching extracted Alienware Arena snapshots):
 * - Logged-in indicators:
 *     - [data-is-logged-in="true"]: Set on member navigation/quest links when authenticated
 *     - a.dropdown-item[href="/quests"]: Quest link available in authenticated user profile menu
 *     - a[href*="/member/"], .user-avatar, .nav-user: Profile avatar and user menu containers
 * - Username extraction:
 *     - .media-body, .username, [class*="username"], .user-name: User handle containers
 * - ARP Points extraction:
 *     - Regexp matches "ARP" or "Arena Rewards Points" followed by point values
 */
let awaControlCenterState = {
  timeOnSiteArp: null,
  timeOnSiteCap: null,
  dailyArp: null,
  twitchStatus: null,
  twitchArp: null,
  twitchUnderCap: true,
  live2xStreamers: [],
};

async function readAwaLogin() {
  await gotoWithRetry(page, AWA_URL, {
    attempts: 2,
    backoffMs: 3000,
    gotoOpts: { waitUntil: 'domcontentloaded' },
    siteId: SITE_ID,
  });
  await page.waitForTimeout(2500);

  const result = await page.evaluate(() => {
    // Selectors referenced from Alienware Arena DOM snapshot:
    const loggedInNode = document.querySelector([
      'a.dropdown-item[href="/quests"][data-is-logged-in="true"]',
      '[data-is-logged-in="true"]',
      'a[href="/quests"]',
      'a[href*="/member/"]',
      '.user-avatar',
      '.nav-user',
    ].join(', '));
    const loggedIn = !!loggedInNode;

    const userNode = document.querySelector('.media-body, .username, [class*="username"], .user-name, [data-user-name]');
    const user = userNode?.textContent?.trim() || null;

    const text = document.body?.innerText || '';
    const arpMatch = text.match(/(?:ARP|Arena Rewards Points)[^\d]{0,20}([\d,]+)/i)
      || text.match(/([\d,]+)\s*ARP/i);
    const arp = arpMatch ? Number(arpMatch[1].replace(/,/g, '')) : null;

    // Extract dailyArpData and DOM-rendered ARP stats from Control Center
    let tosArp = null;
    let tosCap = null;
    let dailyArp = null;
    let twitchStatus = null;
    let twitchArp = null;
    let twitchUnderCap = true;

    // 1. Try reading from DOM elements
    const tosArpEl = document.getElementById('control-center__tos-arp');
    const tosCapEl = document.getElementById('control-center__tos-max-arp');
    const totalArpEl = document.getElementById('control-center__total-arp');
    const twitchStatusEl = document.getElementById('control-center__twitch-arp-status');
    const twitchArpEl = document.getElementById('control-center__twitch-arp');
    const twitchMaxReachedEl = document.getElementById('control-center__twitch-max-reached');

    if (tosArpEl && tosArpEl.textContent) tosArp = Number(tosArpEl.textContent.trim());
    if (tosCapEl && tosCapEl.textContent) tosCap = Number(tosCapEl.textContent.trim());
    if (totalArpEl && totalArpEl.textContent) dailyArp = Number(totalArpEl.textContent.trim());
    if (twitchStatusEl && twitchStatusEl.textContent) twitchStatus = twitchStatusEl.textContent.trim();
    if (twitchArpEl && twitchArpEl.textContent) twitchArp = Number(twitchArpEl.textContent.trim());

    if (twitchStatus) {
      if (twitchStatus.toLowerCase() === 'complete' || (twitchMaxReachedEl && window.getComputedStyle(twitchMaxReachedEl).display !== 'none')) {
        twitchUnderCap = false;
      }
    }

    // 2. Try reading raw script variable dailyArpData if available in page source
    try {
      const scripts = Array.from(document.querySelectorAll('script')).map(s => s.textContent || '');
      for (const s of scripts) {
        const m = s.match(/let\s+dailyArpData\s*=\s*(\{.+?\});/s);
        if (m) {
          const parsed = JSON.parse(m[1]);
          if (parsed) {
            if (Number.isFinite(parsed.timeOnSiteArp)) tosArp = parsed.timeOnSiteArp;
            if (Number.isFinite(parsed.timeOnSiteCap)) tosCap = parsed.timeOnSiteCap;
            if (Number.isFinite(parsed.dailyArp)) dailyArp = parsed.dailyArp;
            if (parsed.twitchData) {
              if (parsed.twitchData.underCap !== undefined) twitchUnderCap = !!parsed.twitchData.underCap;
              if (Number.isFinite(parsed.twitchData.totalPoints)) twitchArp = parsed.twitchData.totalPoints + (parsed.twitchData.bonusPoints || 0);
            }
          }
          break;
        }
      }
    } catch {}

    // 3. Extract 2x live streamers from Hive and Nexus sections
    const live2xStreamers = [];
    try {
      const headings = Array.from(document.querySelectorAll('.card-table-heading'));
      for (const h of headings) {
        const title = (h.textContent || '').trim();
        const is2x = title.includes('Hive') || title.includes('Nexus') || title.includes('2x');
        if (!is2x || title.includes('Partners')) continue;

        // Traverse sibling rows until next heading or end of card body
        let row = h.closest('.row')?.nextElementSibling;
        while (row && !row.querySelector('.card-table-heading')) {
          const liveBadge = row.querySelector('.quest-list__stream-live');
          const link = row.querySelector('a[href*="twitch.tv/"]');
          if (liveBadge && link) {
            const m = link.href.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
            if (m && m[1]) {
              const name = m[1].toLowerCase();
              if (!live2xStreamers.includes(name)) live2xStreamers.push(name);
            }
          }
          row = row.nextElementSibling;
        }
      }
    } catch {}

    return {
      loggedIn,
      user,
      arp,
      title: document.title,
      tosArp,
      tosCap,
      dailyArp,
      twitchStatus,
      twitchArp,
      twitchUnderCap,
      live2xStreamers,
    };
  });

  if (result.user) user = result.user;
  if (Number.isFinite(result.arp)) {
    arpBalance = result.arp;
    db.data.latestArp = { value: arpBalance, time: datetime() };
    log.status('ARP', arpBalance);
  }

  awaControlCenterState = {
    timeOnSiteArp: result.tosArp,
    timeOnSiteCap: result.tosCap,
    dailyArp: result.dailyArp,
    twitchStatus: result.twitchStatus,
    twitchArp: result.twitchArp,
    twitchUnderCap: result.twitchUnderCap,
    live2xStreamers: result.live2xStreamers || [],
  };

  if (Number.isFinite(result.tosArp) && Number.isFinite(result.tosCap)) {
    log.status('Time on Site', `${result.tosArp}/${result.tosCap} ARP`);
  }
  if (result.twitchStatus || Number.isFinite(result.twitchArp)) {
    const statusText = result.twitchUnderCap ? 'Incomplete' : 'Complete (Cap reached)';
    log.status('Twitch ARP', `${result.twitchArp ?? 0} ARP [${statusText}]`);
  }
  if (awaControlCenterState.live2xStreamers.length) {
    log.status('AWA 2x Live', awaControlCenterState.live2xStreamers.join(', '));
  }

  return result.loggedIn;
}

function arpTargetReached() {
  return cfg.awa_arp_target > 0 && Number.isFinite(arpBalance) && arpBalance >= cfg.awa_arp_target;
}

/**
 * Ensures user is authenticated.
 * - Logged in: Silent operation (no warning indicators).
 * - Logged out: Displays clear GUI warning in log & sends notification badge.
 */
async function ensureAwaLogin() {
  if (await readAwaLogin()) {
    log.status('AWA user', user);
    return true;
  }

  // GUI warning indicator for logged-out state
  log.warn('Not signed in to Alienware Arena');
  await notify('alienware-arena: not signed in. Open the Sessions tab/noVNC and sign in manually.');

  if (cfg.nowait || cfg.headless) {
    log.info('Run `SHOW=1 node src/platforms/alienware-arena.js` once to sign in with the persistent browser profile');
    return false;
  }

  if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
  await gotoWithRetry(page, AWA_URL, { waitUntil: 'domcontentloaded' });
  await awaitUserCaptchaSolve(page, {
    service: SITE_ID,
    label: 'Login captcha',
    captchaCheck: captchaVisible,
  });
  await page.waitForSelector('[data-is-logged-in="true"], a[href="/quests"]', { timeout: cfg.login_timeout });
  if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

  return await readAwaLogin();
}

async function checkTwitchLogin() {
  try {
    const cookies = await context.cookies('https://www.twitch.tv');
    const authCookie = cookies.find(c => c.name === 'auth-token' && c.value);
    const loginCookie = cookies.find(c => c.name === 'login' && c.value);
    if (authCookie) {
      return { loggedIn: true, user: loginCookie ? decodeURIComponent(loginCookie.value) : 'logged-in' };
    }
    return { loggedIn: false, user: null };
  } catch {
    return { loggedIn: false, user: null };
  }
}

async function ensureTwitchLogin() {
  const twitch = await checkTwitchLogin();
  if (twitch.loggedIn) {
    log.status('Twitch user', twitch.user);
    return true;
  }

  log.warn('Not signed in to Twitch (watch time will not track ARP)');
  await notify('alienware-arena: Twitch not signed in! Open Sessions tab/noVNC to log in to Twitch.', { kind: 'action' });

  if (cfg.nowait || cfg.headless) {
    return false;
  }

  // Interactive mode: open Twitch login page and allow user to log in
  log.info('Opening Twitch login page...');
  await gotoWithRetry(page, 'https://www.twitch.tv/login', { waitUntil: 'domcontentloaded' });
  await awaitUserCaptchaSolve(page, {
    service: SITE_ID,
    label: 'Twitch login / captcha',
    captchaCheck: async () => !(await checkTwitchLogin()).loggedIn,
  });

  return (await checkTwitchLogin()).loggedIn;
}

async function keepPageAlive(minutes, label, activity = 'scroll') {
  const end = Date.now() + minutes * 60 * 1000;
  let checkCycle = 0;
  let lastAwaCapCheckAt = 0;
  while (Date.now() < end) {
    checkCycle++;
    if (activity === 'twitch') {
      const state = await page.evaluate(() => {
        const mute = document.querySelector('[data-a-target="player-mute-unmute-button"]');
        if (mute && mute.getAttribute('data-muted') !== 'true') mute.click();
        const chat = document.querySelector('.chat-room, [data-a-target="chat-messages"]');
        if (chat) chat.style.display = 'none';

        // Check for Twitch player errors (e.g. Error #2000, #3000, #4000)
        const errorEl = document.querySelector('[data-a-target="player-overlay-contentgate"], [data-a-target="player-error"]');
        const hasError = !!errorEl;
        const errorText = errorEl ? errorEl.textContent?.trim() : null;

        // Check login indicator on Twitch page
        const isLoggedOut = !!document.querySelector('button[data-a-target="login-button"]');

        window.scrollBy(0, Math.round(Math.random() * 300 - 150));
        return { hasError, errorText, isLoggedOut };
      }).catch(() => ({ hasError: false, isLoggedOut: false }));

      if (state.isLoggedOut && checkCycle % 3 === 0) {
        log.warn('Twitch logged-out state detected during stream playback!');
        await notify('alienware-arena: Twitch logged out during stream playback!', { kind: 'action', attachLatestScreenshot: true });
      }

      if (state.hasError) {
        log.warn(`Twitch player error detected: ${state.errorText || 'playback issue'}; reloading page...`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    } else if (activity === 'awa') {
      // Check AWA session drop and Time on Site ARP cap every ~5 minutes (300,000ms)
      const now = Date.now();
      if (now - lastAwaCapCheckAt >= 5 * 60 * 1000) {
        lastAwaCapCheckAt = now;
        log.info('Refreshing Control Center to check updated Time on Site ARP...');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2500);

        const check = await page.evaluate(() => {
          const loggedIn = !!document.querySelector('[data-is-logged-in="true"], a[href="/quests"]');
          let tosArp = null;
          let tosCap = null;
          const tosArpEl = document.getElementById('control-center__tos-arp');
          const tosCapEl = document.getElementById('control-center__tos-max-arp');
          if (tosArpEl && tosArpEl.textContent) tosArp = Number(tosArpEl.textContent.trim());
          if (tosCapEl && tosCapEl.textContent) tosCap = Number(tosCapEl.textContent.trim());

          // Also check dailyArpData script tag if present
          try {
            const scripts = Array.from(document.querySelectorAll('script')).map(s => s.textContent || '');
            for (const s of scripts) {
              const m = s.match(/let\s+dailyArpData\s*=\s*(\{.+?\});/s);
              if (m) {
                const parsed = JSON.parse(m[1]);
                if (parsed) {
                  if (Number.isFinite(parsed.timeOnSiteArp)) tosArp = parsed.timeOnSiteArp;
                  if (Number.isFinite(parsed.timeOnSiteCap)) tosCap = parsed.timeOnSiteCap;
                }
                break;
              }
            }
          } catch {}

          return { loggedIn, tosArp, tosCap };
        }).catch(() => ({ loggedIn: true, tosArp: null, tosCap: null }));

        if (!check.loggedIn) {
          log.warn('AWA session expired during presence watch!');
          await notify('alienware-arena: Session expired during AWA presence!', { kind: 'action', attachLatestScreenshot: true });
          throw new Error('AWA session expired during presence');
        }

        if (Number.isFinite(check.tosArp) && Number.isFinite(check.tosCap)) {
          awaControlCenterState.timeOnSiteArp = check.tosArp;
          awaControlCenterState.timeOnSiteCap = check.tosCap;
          log.status('Time on Site', `${check.tosArp}/${check.tosCap} ARP`);
          if (check.tosArp >= check.tosCap) {
            log.ok(`Time on Site ARP reached daily max during presence (${check.tosArp}/${check.tosCap} ARP)!`);
            break; // Stop waiting immediately
          }
        }
      }

      await page.mouse.move(
        Math.round(100 + Math.random() * Math.max(200, cfg.width - 200)),
        Math.round(100 + Math.random() * Math.max(200, cfg.height - 200)),
      ).catch(() => {});
      await page.evaluate(() => window.scrollBy(0, Math.round(Math.random() * 500 - 250))).catch(() => {});
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

  // Check if Time on Site is already maxed out today
  if (Number.isFinite(awaControlCenterState.timeOnSiteArp) && Number.isFinite(awaControlCenterState.timeOnSiteCap)) {
    if (awaControlCenterState.timeOnSiteArp >= awaControlCenterState.timeOnSiteCap) {
      log.info(`Time on Site ARP is already maxed today (${awaControlCenterState.timeOnSiteArp}/${awaControlCenterState.timeOnSiteCap} ARP); skipping presence`);
      return true;
    }
  }

  await gotoWithRetry(page, AWA_URL, { waitUntil: 'domcontentloaded' });
  const solved = await awaitUserCaptchaSolve(page, {
    service: SITE_ID,
    label: 'AWA presence captcha',
    captchaCheck: captchaVisible,
  });
  if (!solved) return false;

  log.info(`Maintaining AWA presence for up to ${cfg.awa_presence_minutes} minutes (exits dynamically when capped)`);
  const startTs = Date.now();
  await keepPageAlive(cfg.awa_presence_minutes, 'AWA presence', 'awa');
  const elapsedMinutes = Math.max(1, Math.round((Date.now() - startTs) / 60000));
  logSession('AWA', 'control-center presence', elapsedMinutes);
  log.ok(`AWA presence complete (${elapsedMinutes}m elapsed)`);
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
    log.warn('Missing Twitch API credentials; cannot verify streamer live state');
    return null;
  }

  const url = `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(streamer)}`;
  const res = await fetch(url, {
    headers: {
      'Client-ID': cfg.awa_twitch_client_id,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    log.warn(`Twitch live check failed for ${streamer}: HTTP ${res.status}; will retry later`);
    return null;
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

async function watchStreamer(streamer, minutes, alreadyOnPage = false) {
  const url = `https://www.twitch.tv/${streamer}`;
  log.info(`Watching ${streamer} for ${minutes} minutes`);
  if (!alreadyOnPage) {
    await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
  }
  await keepPageAlive(minutes, `Twitch ${streamer}`, 'twitch');
  logSession('Twitch', `Watched ${streamer}`, minutes);
  notifyItems.push({ title: `Twitch: ${streamer}`, url, status: 'claimed', details: `${minutes} minutes watched` });
  return true;
}

function getCandidateStreamers() {
  const manualList = cfg.awa_twitch_streamers
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => /^[a-z0-9_]{3,25}$/i.test(s));

  if (cfg.awa_streamer_selection_mode === 'manual_only') {
    return manualList;
  }

  // auto_2x mode: Prioritize live Hive & Nexus streamers detected on Control Center
  const live2x = awaControlCenterState.live2xStreamers || [];
  if (live2x.length) {
    // Combine 2x live streamers first, followed by manual list (excluding duplicates)
    const combined = [...live2x];
    for (const m of manualList) {
      if (!combined.includes(m)) combined.push(m);
    }
    return combined;
  }

  return manualList;
}

async function runTwitchSessions() {
  let watched = 0;
  let offline = 0;
  let errors = 0;
  let waitCycles = 0;

  let sessionWatchMinutes = 0;
  while (sessionWatchMinutes < cfg.awa_daily_target_minutes) {
    // Check if Twitch ARP is already capped on Alienware Arena
    if (cfg.awa_stop_on_twitch_cap && !awaControlCenterState.twitchUnderCap) {
      log.ok('Twitch ARP maximum cap reached on Alienware Arena (underCap is false); stopping watch session');
      break;
    }

    const currentStreamers = getCandidateStreamers();
    if (!currentStreamers.length) {
      waitCycles++;
      const waitMinutes = Math.max(1, cfg.awa_twitch_recheck_minutes);
      log.info(`No 2x live streamers currently detected on Control Center; re-checking in ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}`);
      await page.waitForTimeout(waitMinutes * 60 * 1000);
      await readAwaLogin().catch(() => {});
      continue;
    }

    let liveFound = false;
    let liveCheckUnknown = false;

    for (const streamer of currentStreamers) {
      if (sessionWatchMinutes >= cfg.awa_daily_target_minutes) break;

      // Check cap before each stream attempt
      if (cfg.awa_stop_on_twitch_cap && !awaControlCenterState.twitchUnderCap) break;

      try {
        let live = null;
        let onPage = false;

        // If this streamer was directly detected as LIVE in AWA Hive/Nexus, we know they are live!
        if (awaControlCenterState.live2xStreamers.includes(streamer)) {
          log.info(`${streamer} is 2x LIVE on AWA Control Center`);
          live = true;
        } else {
          live = await isStreamerLive(streamer);
        }

        if (live === null) {
          // Browser-based fallback when Twitch API credentials are not configured
          const url = `https://www.twitch.tv/${streamer}`;
          await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(3500);
          onPage = true;
          const detectedLive = await page.evaluate(() => {
            const offlineIndicator = document.querySelector('[data-a-target="player-overlay-offline"], .channel-status-info--offline');
            const hasOfflineText = document.body?.innerText?.includes('is offline');
            const liveBadge = document.querySelector('.live-indicator-container, [status="live"], [aria-label="LIVE"]');
            const hasVideo = !!document.querySelector('video');
            return !offlineIndicator && !hasOfflineText && (!!liveBadge || hasVideo);
          }).catch(() => false);

          if (detectedLive) {
            log.info(`${streamer} is live (browser check)`);
            live = true;
          } else {
            log.info(`${streamer} is offline`);
            live = false;
          }
        }

        if (!live) {
          offline++;
          await page.waitForTimeout(jitterMs(5, 10));
          continue;
        }

        liveFound = true;
        const remaining = cfg.awa_daily_target_minutes - sessionWatchMinutes;
        const minutes = Math.max(1, Math.min(cfg.awa_watch_chunk_minutes, Math.ceil(remaining)));
        await watchStreamer(streamer, minutes, onPage);
        watched++;
        sessionWatchMinutes += minutes;

        // Re-read AWA Control Center status to update ARP points and cap status
        log.info('Checking AWA Control Center for updated Twitch ARP balance...');
        await readAwaLogin().catch(() => {});

        if (cfg.awa_stop_on_twitch_cap && !awaControlCenterState.twitchUnderCap) {
          log.ok('Twitch ARP maximum cap reached on Alienware Arena! Completing Twitch watch session.');
          break;
        }

        break;
      } catch (e) {
        errors++;
        log.warn(`${streamer} failed: ${e.message}`);
        await page.screenshot({ path: screenshot('failed', `${streamer}_${filenamify(datetime())}.png`), fullPage: true }).catch(() => {});
      }

      await page.waitForTimeout(jitterMs(10, 20));
    }

    if (cfg.awa_stop_on_twitch_cap && !awaControlCenterState.twitchUnderCap) break;
    if (sessionWatchMinutes >= cfg.awa_daily_target_minutes) break;

    if (!liveFound) {
      waitCycles++;
      const reason = liveCheckUnknown
        ? 'Live status unavailable'
        : 'No 2x/configured streamers are live';
      const waitMinutes = Math.max(1, cfg.awa_twitch_recheck_minutes);
      log.info(`${reason}; re-checking Control Center in ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}`);
      await page.waitForTimeout(waitMinutes * 60 * 1000);
      // Re-read Control Center to catch newly live Hive/Nexus streamers
      await readAwaLogin().catch(() => {});
    }
  }

  return { watched, offline, errors, waitCycles };
}

try {
  const wantsPresence = RUN_MODE === 'full' || RUN_MODE === 'presence';
  const wantsTwitch = RUN_MODE === 'full' || RUN_MODE === 'twitch';

  if (!await ensureAwaLogin()) {
    process.exitCode = 1;
  } else if (arpTargetReached()) {
    log.info(`ARP target reached: ${arpBalance}/${cfg.awa_arp_target}`);
    log.summary({ siteId: SITE_ID, claimed: 0, skipped: 0, display: 'pointsEarned', pointsEarned: 0 });
  } else {
    let twitch = { watched: 0, offline: 0, errors: 0, waitCycles: 0 };

    if (wantsPresence) {
      const awaOk = await runAwaPresence();
      if (!awaOk) throw new Error('AWA presence failed');
    }

    if (wantsTwitch) {
      if (cfg.awa_stop_on_twitch_cap && !awaControlCenterState.twitchUnderCap) {
        log.ok('Twitch ARP already maxed today on Alienware Arena (Complete / Cap reached)');
      } else {
        const twitchOk = await ensureTwitchLogin();
        if (!twitchOk) {
          log.warn('Skipping Twitch watching because Twitch is not signed in.');
          twitch.errors++;
        } else {
          twitch = await runTwitchSessions();
        }
      }
    }

    await readAwaLogin().catch(() => {});
    log.summary({
      siteId: SITE_ID,
      claimed: twitch.watched,
      skipped: twitch.offline + twitch.waitCycles,
      display: 'tracked',
      tracked: Number.isFinite(arpBalance) ? arpBalance : Math.round(todayTwitchTotal()),
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
    const arp = Number.isFinite(arpBalance) ? ` · ${arpBalance}${cfg.awa_arp_target > 0 ? '/' + cfg.awa_arp_target : ''} ARP` : '';
    const status = `${Math.round(todayTwitchTotal())}/${cfg.awa_daily_target_minutes} Twitch minutes today${arp}`;
    const body = notifyItems.length ? html_game_list(notifyItems) : status;
    await notify(`alienware-arena (${user}):<br>${status}<br>${body}`, { kind: process.exitCode ? 'action' : 'summary' });
  }
}

if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await closeContextSafely(context);
