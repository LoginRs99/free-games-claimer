import { chromium } from 'patchright';
import { resolve, jsonDb, datetime, filenamify, prompt, notify, html_game_list, handleSIGINT, closeContextSafely, awaitUserCaptchaSolve, log } from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';

const SITE_ID = 'steamgifts';
const SITE_NAME = 'SteamGifts';
const BASE = 'https://www.steamgifts.com';
const URL_HOME = `${BASE}/`;
const URL_LOGIN = `${BASE}/?login`;

const FILTER_URLS = {
  All: 'search?page={page}&point_max={points}',
  Wishlist: 'search?page={page}&type=wishlist&point_max={points}',
  Recommended: 'search?page={page}&type=recommended&point_max={points}',
  Copies: 'search?page={page}&copy_min=2&point_max={points}',
  DLC: 'search?page={page}&dlc=true&point_max={points}',
  Group: 'search?page={page}&type=group&point_max={points}',
  New: 'search?page={page}&type=new&point_max={points}',
};

const DEFAULT_SPECIAL_STAGES = ['Wishlist', 'Recommended', 'Group'];

const screenshot = (...a) => resolve(cfg.dir.screenshots, SITE_ID, ...a);
const db = await jsonDb('steamgifts.json', {});

log.section(`${SITE_NAME} (v${siteVersion(SITE_ID)})`);
log.status('Mode', cfg.sg_gift_type);
log.status('Min points', cfg.sg_min_points);
log.status('Max entries', cfg.sg_max_entries);

const context = await chromium.launchPersistentContext(cfg.dir.browser + '-steamgifts', {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US',
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined,
  recordHar: cfg.record ? { path: `data/record/steamgifts-${filenamify(datetime())}.har` } : undefined,
  handleSIGINT: false,
  args: [
    '--hide-crash-restore-bubble',
  ],
});

handleSIGINT(context);
if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage();
await page.setViewportSize({ width: cfg.width, height: cfg.height });

const notifyItems = [];
let user = 'unknown';
let xsrfToken = null;
let points = 0;

function normalizePhpSessid(value) {
  return String(value || '')
    .trim()
    .replace(/^PHPSESSID=/i, '')
    .split(';')[0]
    .trim();
}

async function seedPhpSessidCookie() {
  const value = normalizePhpSessid(cfg.sg_cookie);
  if (!value) return false;

  await context.addCookies([{
    name: 'PHPSESSID',
    value,
    domain: '.steamgifts.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  log.status('Cookie auth', 'PHPSESSID from config');
  return true;
}

const ignoredWords = cfg.sg_ignored_words
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function sleepMs(baseMs) {
  const variance = baseMs * 0.2;
  return Math.max(1000, Math.round(baseMs + (Math.random() * 2 - 1) * variance));
}

async function captchaVisible() {
  return await page.locator([
    'iframe[src*="captcha"]',
    'iframe[title*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    '#challenge-stage',
    '.cf-challenge',
    '[data-translate="checking_browser"]',
  ].join(', ')).first().isVisible().catch(() => false);
}

async function botProtectionVisible() {
  if (await captchaVisible()) return true;
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return /just a moment|checking your browser|verify you are human|cloudflare/i.test(document.title || '')
      || /just a moment|checking your browser|verify you are human|cloudflare/i.test(text);
  }).catch(() => true);
}

async function readSession() {
  await page.goto(URL_HOME, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const data = await page.evaluate(() => {
    const token = document.querySelector('input[name="xsrf_token"]')?.value || null;
    const pointsText = document.querySelector('.nav__points')?.textContent?.trim() || '';
    const userText = document.querySelector('.nav__avatar-outer-wrap, .nav__username, a[href^="/user/"]')?.textContent?.trim() || '';
    const loginLink = !!document.querySelector('a[href*="login"], a[href*="/login"]');
    return { token, pointsText, userText, loginLink, title: document.title };
  });

  const pointDigits = (data.pointsText || '').replace(/[^\d]/g, '');
  const parsedPoints = Number(pointDigits);
  if (!data.token || !pointDigits || !Number.isFinite(parsedPoints)) {
    return { loggedIn: false, title: data.title, loginLink: data.loginLink };
  }

  xsrfToken = data.token;
  points = parsedPoints;
  user = data.userText || 'member';
  return { loggedIn: true };
}

async function login() {
  const seededCookie = await seedPhpSessidCookie();
  while (!(await readSession()).loggedIn) {
    log.warn('Not signed in to SteamGifts');
    if (cfg.nowait) process.exit(1);

    await notify(seededCookie
      ? 'steamgifts: configured PHPSESSID is expired or invalid. Update SG_COOKIE in Settings, or open the Sessions tab/noVNC and sign in with Steam.'
      : 'steamgifts: no longer signed in. Add SG_COOKIE in Settings, or open the Sessions tab/noVNC and sign in with Steam.');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
    log.status('Login timeout', `${cfg.login_timeout / 1000}s`);

    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    log.info('Waiting for manual SteamGifts login in the browser');

    if (cfg.headless) {
      log.info('Run `SHOW=1 node steamgifts` once to login in the opened browser');
      await closeContextSafely(context);
      process.exit(1);
    }

    await Promise.race([
      page.waitForSelector('.nav__points'),
      prompt({ message: 'Press Enter after SteamGifts login is complete' }),
    ]).catch(() => {});

    await awaitUserCaptchaSolve(page, {
      service: SITE_ID,
      label: 'Login captcha',
      captchaCheck: captchaVisible,
    });

    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }

  log.status('User', user);
  log.status('Points', points);
  db.data[user] ||= { entries: {}, wins: {} };
  db.data[user].entries ||= {};
  db.data[user].wins ||= {};
  db.data[user].latestPoints = { value: points, time: datetime() };
}

function configuredStages() {
  const stages = cfg.sg_special_stages
    .split(',')
    .map(s => s.trim())
    .filter(s => FILTER_URLS[s]);
  return stages.length ? stages : DEFAULT_SPECIAL_STAGES;
}

function filterTemplates() {
  if (cfg.sg_gift_type === 'Special Mode') {
    return configuredStages().map(stage => ({ name: stage, template: FILTER_URLS[stage] }));
  }
  const mode = FILTER_URLS[cfg.sg_gift_type] ? cfg.sg_gift_type : 'All';
  return [{ name: mode, template: FILTER_URLS[mode] }];
}

function makeSearchUrl(template, pageNum) {
  return `${BASE}/giveaways/${template.replace('{page}', pageNum).replace('{points}', Math.max(0, points))}`;
}

async function readGiveaways(searchUrl, stageName) {
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000 + Math.round(Math.random() * 1500));

  return await page.evaluate(({ includePinned, ignoredWords, stageName }) => {
    const rows = Array.from(document.querySelectorAll('.giveaway__row-inner-wrap'));
    return rows.map(row => {
      if (row.classList.contains('is-faded')) return null;
      const nameLink = row.querySelector('a.giveaway__heading__name');
      if (!nameLink) return null;
      const title = nameLink.textContent.trim();
      if (ignoredWords.some(w => title.toLowerCase().includes(w))) return null;
      const href = nameLink.getAttribute('href') || '';
      const code = href.split('/').filter(Boolean)[1];
      if (!code) return null;
      const pinned = !!row.closest('.pinned-giveaways__inner-wrap');
      if (!includePinned && pinned) return null;
      const costText = Array.from(row.querySelectorAll('.giveaway__heading__thin')).pop()?.textContent || '';
      const cost = Number(costText.replace(/[^\d]/g, ''));
      if (!Number.isFinite(cost)) return null;
      return {
        id: code,
        title,
        url: `https://www.steamgifts.com${href}`,
        cost,
        pinned,
        stage: stageName,
      };
    }).filter(Boolean);
  }, { includePinned: cfg.sg_include_pinned, ignoredWords, stageName });
}

async function postGiveawayEntry(giveaway) {
  if (!xsrfToken) throw new Error('missing xsrf token');

  const res = await page.request.post(`${BASE}/ajax.php`, {
    form: {
      xsrf_token: xsrfToken,
      do: 'entry_insert',
      code: giveaway.id,
    },
    headers: {
      referer: giveaway.url,
      'x-requested-with': 'XMLHttpRequest',
    },
    timeout: 30000,
  });

  let body;
  let text = '';
  try { body = await res.json(); }
  catch {
    text = await res.text().catch(() => '');
    return { ok: false, status: res.status(), text };
  }

  if (body?.type === 'success') {
    if (body.points != null) points = Number(body.points);
    else points -= giveaway.cost;
    return { ok: true };
  }

  const msg = body?.msg || `HTTP ${res.status()}`;
  if (/not have enough points/i.test(msg) && body?.points != null) points = Number(body.points);
  return { ok: false, status: res.status(), msg };
}

function looksLikeBotProtection(result) {
  const haystack = `${result.status || ''} ${result.msg || ''} ${result.text || ''}`;
  return /403|just a moment|checking your browser|verify you are human|cloudflare/i.test(haystack);
}

async function clearBotProtection(giveaway) {
  log.warn(`${giveaway.title} — SteamGifts bot protection detected, opening giveaway page for manual solve`);
  await page.goto(giveaway.url, { waitUntil: 'domcontentloaded' });
  const solved = await awaitUserCaptchaSolve(page, {
    service: SITE_ID,
    label: 'SteamGifts bot protection',
    captchaCheck: botProtectionVisible,
  });
  if (!solved) return false;
  await readSession();
  return true;
}

async function enterGiveaway(giveaway) {
  let result = await postGiveawayEntry(giveaway);
  if (result.ok) return true;

  if (looksLikeBotProtection(result) && await clearBotProtection(giveaway)) {
    result = await postGiveawayEntry(giveaway);
    if (result.ok) return true;
  }

  if (result.text) throw new Error(`unexpected response ${result.status}: ${result.text.slice(0, 120)}`);
  const msg = result.msg || `HTTP ${result.status || 'unknown'}`;
  throw new Error(msg);
}

async function checkWins() {
  try {
    await page.goto(`${BASE}/giveaways/won`, { waitUntil: 'domcontentloaded' });
    const wins = await page.evaluate(() => Array.from(document.querySelectorAll('.giveaway__row-inner-wrap'))
      .filter(row => !row.classList.contains('is-faded'))
      .map(row => {
        const a = row.querySelector('a.giveaway__heading__name');
        if (!a) return null;
        const href = a.getAttribute('href') || '';
        const id = href.split('/').filter(Boolean)[1] || a.textContent.trim();
        return { id, title: a.textContent.trim(), url: `https://www.steamgifts.com${href}` };
      })
      .filter(Boolean));

    const fresh = wins.filter(w => !db.data[user].wins[w.id]);
    for (const w of fresh) {
      db.data[user].wins[w.id] = { title: w.title, url: w.url, time: datetime() };
      notifyItems.push({ title: `Won: ${w.title}`, url: w.url, status: 'action' });
    }
    if (fresh.length) {
      log.info(`Wins found — ${fresh.map(w => w.title).join(', ')}`);
      await notify(`steamgifts: you won ${fresh.length} giveaway${fresh.length > 1 ? 's' : ''}<br>${html_game_list(fresh.map(w => ({ ...w, status: 'action' })))}`);
    } else {
      log.info('No new wins found');
    }
  } catch (e) {
    log.warn(`Win check skipped — ${e.message}`);
  }
}

try {
  await login();
  await checkWins();

  if (points < cfg.sg_min_points) {
    log.warn(`Points (${points}) below minimum (${cfg.sg_min_points})`);
    log.summary({ siteId: SITE_ID, claimed: 0, skipped: 0, display: 'pointsEarned', pointsEarned: 0 });
  } else {
    let entered = 0;
    let skipped = 0;
    let failed = 0;
    const seen = new Set();

    for (const filter of filterTemplates()) {
      if (entered >= cfg.sg_max_entries || points < cfg.sg_min_points) break;
      log.status('Filter', filter.name);

      const maxPages = Math.max(1, cfg.sg_max_pages);
      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        if (entered >= cfg.sg_max_entries || points < cfg.sg_min_points) break;

        const searchUrl = makeSearchUrl(filter.template, pageNum);
        log.info(`Checking page ${pageNum}: ${searchUrl}`);
        const giveaways = await readGiveaways(searchUrl, filter.name);
        if (!giveaways.length) {
          if (pageNum === 1) log.warn(`No eligible giveaways for ${filter.name}`);
          break;
        }

        for (const giveaway of giveaways) {
          if (entered >= cfg.sg_max_entries || points < cfg.sg_min_points) break;
          if (seen.has(giveaway.id)) continue;
          seen.add(giveaway.id);

          if (db.data[user].entries[giveaway.id]?.status === 'entered') {
            log.owned(giveaway.title);
            skipped++;
            continue;
          }

          if (giveaway.cost > points) {
            log.skip(giveaway.title, `${giveaway.cost}P > ${points}P`);
            skipped++;
            continue;
          }

          if (cfg.dryrun) {
            log.warn(`${giveaway.title} — dry run, skipping entry`);
            skipped++;
            continue;
          }

          await page.waitForTimeout(sleepMs(cfg.sg_entry_delay_sec * 1000));

          try {
            await enterGiveaway(giveaway);
            db.data[user].entries[giveaway.id] = {
              title: giveaway.title,
              url: giveaway.url,
              cost: giveaway.cost,
              stage: giveaway.stage,
              time: datetime(),
              status: 'entered',
            };
            entered++;
            log.ok(`${giveaway.title} — entered (${giveaway.cost}P, ${points}P left)`);
            notifyItems.push({ title: giveaway.title, url: giveaway.url, status: 'claimed' });
          } catch (e) {
            failed++;
            db.data[user].entries[giveaway.id] = {
              title: giveaway.title,
              url: giveaway.url,
              cost: giveaway.cost,
              stage: giveaway.stage,
              time: datetime(),
              status: `failed: ${e.message}`,
            };
            log.warn(`${giveaway.title} — ${e.message}`);
            notifyItems.push({ title: giveaway.title, url: giveaway.url, status: 'failed', details: e.message });
            await page.screenshot({ path: screenshot('failed', `${giveaway.id}_${filenamify(datetime())}.png`), fullPage: true }).catch(() => {});
          }
        }
      }
    }

    log.summary({
      siteId: SITE_ID,
      claimed: entered,
      skipped,
      display: 'failed',
      failed,
    });
  }
} catch (error) {
  process.exitCode ||= 1;
  log.fail(`Exception: ${error.message || error}`);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode !== 130) await notify(`steamgifts failed: ${error.message.split('\n')[0]}`, { attachLatestScreenshot: true });
} finally {
  await db.write();
  const actionable = notifyItems.some(g => g.status === 'failed' || g.status === 'action');
  if (notifyItems.some(g => ['claimed', 'failed', 'action'].includes(g.status))) {
    await notify(`steamgifts (${user}, ${points}P):<br>${html_game_list(notifyItems)}`, { kind: actionable ? 'action' : 'summary' });
  }
}

if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await closeContextSafely(context);
