import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { datetime, notify, log, dataDir, handleSIGINT } from '#src/util.js';
import { launchContext, gotoWithRetry } from '#src/browser.js';
import { cfg } from '#src/config.js';
import { siteVersion } from '#src/sites.js';

// Watch-only IndieGala free-games / giveaway tracker. No login, no
// auto-claim — loads freebies.indiegala.com in a real browser (their
// public /showcase/ + freebies pages are Cloudflare-fronted; a bare
// fetch reliably 403s, a real browser navigation works), captures
// whichever API response the SPA fires, and diffs against a saved
// baseline. Pushes an aggregated notification on new free items.
//
// Pattern matches fanatical.js / humble-bundle.js:
// - Wide response interceptor rather than a hard-coded endpoint, so a
//   backend rename by IndieGala doesn't silently break the collector.
// - DOM fallback path: if API interception yields nothing, parse the
//   rendered product cards. IndieGala's freebies page is
//   server-side-rendered enough that this usually returns real data
//   even when the API surface changes shape.
// - Notify-only. IndieGala's actual claim flow requires a logged-in
//   session and a per-item "get the game" click; auto-claim is a
//   later phase gated on real live data. See feedback_notify_only_pattern.

handleSIGINT();
log.section(`IndieGala (v${siteVersion('indiegala')})`);

let _summaryStats = { siteId: 'indiegala', claimed: 0, skipped: 0, display: 'onPage', onPage: 0, new: 0 };
process.on('exit', code => {
  if (!code) log.summary(_summaryStats);
});

const URL_PAGE = cfg.indiegala_page_url || 'https://freebies.indiegala.com/'; // INDIEGALA_PAGE_URL override

const INDIEGALA_NAV = { attempts: 2, backoffMs: 5000, gotoOpts: { waitUntil: 'domcontentloaded', timeout: 30000 }, siteId: 'indiegala' };
const STATE_FILE = dataDir('indiegala-watch.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { products: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { products: {} }; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { log.warn(`Failed to save IndieGala watch state: ${e.message.split('\n')[0]}`); }
}

let context, page;
const captured = [];
let apiResponses = 0;
try {
  ({ context, page } = await launchContext('indiegala', {
    record: false,
    sigint: false,
    contextOptions: { headless: false },
  }));
  context.setDefaultTimeout(30000);

  // Wide-cast interceptor. IndieGala uses multiple API surfaces across
  // freebies + showcase (/showcase_api/, /api/), and their SPA has moved
  // endpoints twice in the last year — we accept anything under those
  // prefixes and extract whatever looks like product records.
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/\/(?:showcase_api|api|freebies)\//i.test(url)) return;
      if (!resp.ok()) return;
      const ct = resp.headers()['content-type'] || '';
      if (!/json/i.test(ct)) return;
      apiResponses++;
      const json = await resp.json().catch(() => null);
      if (!json) return;
      // Products can appear at .products, .items, .games, .showcase, or
      // as a top-level array. Try each in order, take the first hit.
      const buckets = [json.products, json.items, json.games, json.showcase, json.data, json];
      for (const b of buckets) {
        if (!Array.isArray(b)) continue;
        for (const p of b) {
          if (p && typeof p === 'object' && (p.title || p.name || p.game_name)) captured.push(p);
        }
        if (captured.length) break;
      }
    } catch { /* swallow */ }
  });

  await gotoWithRetry(page, URL_PAGE, INDIEGALA_NAV);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // DOM fallback: even if the SPA didn't fire an API request that we
  // caught, the rendered product cards usually contain the same data.
  // We pick a wide selector union so a card class rename doesn't tank
  // the collector — each candidate has been seen live at some point
  // in IndieGala's card layouts. Extract the visible product name +
  // href; the notify pipeline only needs those two.
  if (captured.length === 0) {
    try {
      const domProducts = await page.evaluate(() => {
        const out = [];
        // Cards on freebies.indiegala.com generally wrap in an anchor
        // pointing at /store/game/<slug> or /showcase/<slug>.
        const anchors = document.querySelectorAll('a[href*="/store/game/"], a[href*="/showcase/"], a[href*="/games/"]');
        for (const a of anchors) {
          const href = a.href || '';
          if (!href) continue;
          const titleEl = a.querySelector('h2, h3, h4, [class*="title" i], [class*="name" i]') || a;
          const title = (titleEl.textContent || '').trim();
          if (!title || title.length > 200) continue;
          out.push({ title, url: href });
        }
        return out;
      });
      for (const p of domProducts) captured.push({ title: p.title, url: p.url, _fromDom: true });
    } catch (e) {
      log.info(`IndieGala DOM fallback failed: ${e.message.split('\n')[0]}`);
    }
  }
} catch (e) {
  log.warn(`IndieGala watch fetch failed: ${e.message.split('\n')[0]}`);
  try { if (context) await context.close(); } catch {}
  process.exit(0);
} finally {
  try { if (context) await context.close(); } catch {}
}

log.status('Product records captured', captured.length);
if (captured.length === 0) {
  if (apiResponses === 0) {
    log.warn('IndieGala /api endpoints not observed and DOM fallback empty — page shape may have changed');
  } else {
    log.info('IndieGala responded but no free items visible right now — nothing to claim');
  }
  process.exit(0);
}

// Build a de-duped {id → product} map keyed on slug (or title as last resort).
const products = new Map();
for (const r of captured) {
  if (!r || typeof r !== 'object') continue;
  const name = String(r.title || r.name || r.game_name || '').trim();
  if (!name) continue;
  const slug = r.slug || r.url_slug || (r.url ? String(r.url).replace(/^.*\/([^/?#]+)[/?#]?.*$/, '$1') : null);
  const id = slug || name.toLowerCase();
  if (!id) continue;
  let url = r.url ? String(r.url) : null;
  if (!url && slug) url = `https://www.indiegala.com/store/game/${slug}`;
  if (!url) url = URL_PAGE;
  if (!products.has(id)) products.set(id, { name, url, note: 'indiegala' });
}

log.status('Free products on page', products.size);

const prev = loadState();
const newEntries = [];
const current = {};

for (const [id, info] of products) {
  current[id] = { ...info, firstSeen: prev.products?.[id]?.firstSeen || datetime() };
  if (!prev.products?.[id]) newEntries.push({ id, ...info });
}

const isFirstRun = Object.keys(prev.products || {}).length === 0;
saveState({ products: current });

_summaryStats = {
  siteId: 'indiegala',
  claimed: 0,
  skipped: 0,
  display: 'onPage',
  onPage: products.size,
  new: newEntries.length,
};

if (newEntries.length === 0) {
  log.info('No new IndieGala free items since last check');
  process.exit(0);
}

if (isFirstRun) {
  log.info(`Baseline established with ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'} (no notification on first run)`);
  for (const e of newEntries) log.game(e.name, String(e.note));
  process.exit(0);
}

for (const e of newEntries) log.game(e.name, `new — ${e.note}`);

const subject = `IndieGala has ${newEntries.length} new free item${newEntries.length === 1 ? '' : 's'} — claim manually`;
log.info(subject);
const lines = [subject];
for (const e of newEntries) lines.push(`- ${e.name}: ${e.url}`);
const body = lines.join('<br>');
await notify(body).catch(err => log.warn(`Notify failed: ${err.message.split('\n')[0]}`));
