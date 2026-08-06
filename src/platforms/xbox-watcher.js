import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { datetime, notify, log, dataDir, handleSIGINT } from '#src/util.js';
import { fetchGamerPowerAll, filterFor } from '#src/gamerpower.js';
import { siteVersion } from '#src/sites.js';

// Watch-only Xbox / Game Pass / Free Play Days tracker. No login, no
// browser — filters GamerPower's public giveaways API for entries whose
// `platforms` field matches \bxbox\b (catches Xbox One, Series X|S,
// Game Pass promos, Free Play Days). Notify-only by design: Microsoft's
// GP portal + xbox.com/deals both require Xbox Live SSO which is
// infeasible to script reliably; a ping is the actionable output.
//
// This closes the "PSN + Xbox notify-only" gap in the notify surfaces
// alongside psn-watcher — same shape, same dedup pipeline, same
// aggregated notification body, different platform filter.

handleSIGINT();
log.section(`Xbox watcher (v${siteVersion('xbox-watcher')})`);

let _summaryStats = { siteId: 'xbox-watcher', claimed: 0, skipped: 0, display: 'onPage', onPage: 0, new: 0 };
process.on('exit', code => {
  if (!code) log.summary(_summaryStats);
});

const STATE_FILE = dataDir('xbox-watch.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { products: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { products: {} }; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { log.warn(`Failed to save Xbox watch state: ${e.message.split('\n')[0]}`); }
}

let entries;
try {
  const all = await fetchGamerPowerAll();
  entries = filterFor(all, 'xbox');
  log.status('Xbox entries from GamerPower', entries.length);
} catch (e) {
  log.warn(`Xbox GamerPower fetch failed: ${e.message.split('\n')[0]}`);
  process.exit(0);
}

if (entries.length === 0) {
  log.info('No active Xbox giveaways on GamerPower right now');
  process.exit(0);
}

const products = new Map();
for (const e of entries) {
  const id = String(e.id || e.title || '').trim();
  const name = String(e.title || '').trim();
  if (!id || !name) continue;
  const url = e.open_giveaway_url || e.gamerpower_url || 'https://www.gamerpower.com/';
  const note = (e.platforms || 'xbox').split(',')[0].trim();
  // Preserve endDate + worth from GamerPower for expiry/price signals on
  // the Discoveries tab.
  if (!products.has(id)) products.set(id, { name, url, note, endDate: e.end_date || null, worth: e.worth || null });
}

log.status('Free Xbox items on page', products.size);

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
  siteId: 'xbox-watcher',
  claimed: 0,
  skipped: 0,
  display: 'onPage',
  onPage: products.size,
  new: newEntries.length,
};

if (newEntries.length === 0) {
  log.info('No new Xbox entries since last check');
  process.exit(0);
}

for (const e of newEntries) log.game(e.name, isFirstRun ? String(e.note) : `new — ${e.note}`);

// First-run: send ONE baseline notification so the user can verify coverage.
const subject = isFirstRun
  ? `Xbox baseline: ${newEntries.length} free item${newEntries.length === 1 ? '' : 's'} being tracked (subsequent runs only ping on new entries)`
  : `Xbox has ${newEntries.length} new free item${newEntries.length === 1 ? '' : 's'} — claim manually`;
log.info(subject);
const lines = [subject];
for (const e of newEntries) lines.push(`- ${e.name}: ${e.url}`);
const body = lines.join('<br>');
await notify(body).catch(err => log.warn(`Notify failed: ${err.message.split('\n')[0]}`));
