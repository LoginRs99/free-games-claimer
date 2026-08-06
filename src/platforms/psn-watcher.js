import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { datetime, notify, log, dataDir, handleSIGINT } from '#src/util.js';
import { fetchGamerPowerAll, filterFor } from '#src/gamerpower.js';
import { siteVersion } from '#src/sites.js';

// Watch-only PlayStation Plus / free-on-PSN tracker. No login, no
// browser context — a straight HTTPS fetch against GamerPower's public
// giveaways API, filtered to entries whose `platforms` field matches
// the PSN pattern (\bps[3-5]\b|playstation). GamerPower aggregates the
// PS Blog announcements + freebie promos into a single JSON surface;
// scraping playstation.com directly is a losing game (Sony redesigns
// constantly), so we lean on the aggregator that does that work.
//
// Notify-only — Sony's anti-bot fingerprinting has proven infeasible
// for auto-claim on the PSN store (Terebi42 #55, closed 2026-08-03).
// This watcher is the promised follow-through: users who asked for
// PSN support get an "action needed" ping when a new title lands,
// then claim manually on their console or phone.

handleSIGINT();
log.section(`PSN watcher (v${siteVersion('psn-watcher')})`);

let _summaryStats = { siteId: 'psn-watcher', claimed: 0, skipped: 0, display: 'onPage', onPage: 0, new: 0 };
process.on('exit', code => {
  if (!code) log.summary(_summaryStats);
});

const STATE_FILE = dataDir('psn-watch.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { products: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { products: {} }; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { log.warn(`Failed to save PSN watch state: ${e.message.split('\n')[0]}`); }
}

let entries;
try {
  const all = await fetchGamerPowerAll();
  entries = filterFor(all, 'psn');
  log.status('PSN entries from GamerPower', entries.length);
} catch (e) {
  log.warn(`PSN GamerPower fetch failed: ${e.message.split('\n')[0]}`);
  process.exit(0);
}

if (entries.length === 0) {
  log.info('No active PSN giveaways on GamerPower right now');
  process.exit(0);
}

// {id → product} map. GamerPower's `id` is stable across pulls, so
// use it as the dedup key; fall back to a title slug on the rare
// entry with no id field.
const products = new Map();
for (const e of entries) {
  const id = String(e.id || e.title || '').trim();
  const name = String(e.title || '').trim();
  if (!id || !name) continue;
  const url = e.open_giveaway_url || e.gamerpower_url || 'https://www.gamerpower.com/';
  const note = (e.platforms || 'psn').split(',')[0].trim();
  // Preserve endDate + worth from GamerPower so the Discoveries tab can
  // render the ends-at chip and the EXPIRED badge on stale promos.
  if (!products.has(id)) products.set(id, { name, url, note, endDate: e.end_date || null, worth: e.worth || null });
}

log.status('Free PSN items on page', products.size);

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
  siteId: 'psn-watcher',
  claimed: 0,
  skipped: 0,
  display: 'onPage',
  onPage: products.size,
  new: newEntries.length,
};

if (newEntries.length === 0) {
  log.info('No new PSN entries since last check');
  process.exit(0);
}

for (const e of newEntries) log.game(e.name, isFirstRun ? String(e.note) : `new — ${e.note}`);

// First-run: send ONE baseline notification so the user can verify coverage.
const subject = isFirstRun
  ? `PSN baseline: ${newEntries.length} free item${newEntries.length === 1 ? '' : 's'} being tracked (subsequent runs only ping on new entries)`
  : `PSN has ${newEntries.length} new free item${newEntries.length === 1 ? '' : 's'} — claim manually`;
log.info(subject);
const lines = [subject];
for (const e of newEntries) lines.push(`- ${e.name}: ${e.url}`);
const body = lines.join('<br>');
await notify(body).catch(err => log.warn(`Notify failed: ${err.message.split('\n')[0]}`));
