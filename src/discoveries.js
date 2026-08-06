// v2.11.1: unified Discoveries source loader.
//
// Prior to v2.11.1 the Discoveries tab only surfaced GamerPower + FGF
// listings. Notify-only watchers (indiegala, psn-watcher, xbox-watcher,
// fanatical, humble-bundle, lenovo-gaming, ubisoft) wrote their own
// state files and dispatched apprise directly — invisible in the
// panel. Users had to look at three different places to know what fgc
// had discovered.
//
// This module reads every watcher's state file (all share the same
// shape: { products: { <id>: { name, url, note, firstSeen } } }) and
// exports helpers to fold them into the aggregated /api/discoveries
// pipeline alongside GamerPower and FGF entries. Cross-source dedup
// happens in the panel handler using the same matchKey helpers the
// aggregators already use.
//
// Priority order for dedup collisions (highest wins):
//   1. Direct-storefront watcher (indiegala, psn, xbox, fanatical,
//      humble-bundle, lenovo-gaming, ubisoft) — they scrape the
//      storefront itself, so URLs are direct claim links.
//   2. GamerPower — aggregator, one hop removed from the storefront.
//   3. FGF (Reddit) — community-curated, most drift from storefront.
//
// A dedup collision keeps the primary source's fields (URL, tags,
// dates), then attaches `alsoOn: [<source names>]` so the panel can
// render "also on gamerpower" style provenance without cluttering.

import { readFileSync, existsSync } from 'node:fs';
import { dataDir } from './util.js';

// The full set of notify-only watchers in the site registry. Each
// carries the collector-key its products should be tagged with in the
// Discoveries pipeline. Choosing the collector-key here (rather than
// falling back to a heuristic on the URL/note) keeps coverage badges
// deterministic — the panel's coverageFor() switch has an entry for
// each of these.
export const WATCHER_SOURCES = [
  { source: 'indiegala',      stateFile: 'indiegala-watch.json',      collectorKey: 'indiegala',      fallbackUrl: 'https://freebies.indiegala.com/' },
  { source: 'psn',            stateFile: 'psn-watch.json',            collectorKey: 'psn',            fallbackUrl: 'https://store.playstation.com/en-us/pages/deals' },
  { source: 'xbox',           stateFile: 'xbox-watch.json',           collectorKey: 'xbox',           fallbackUrl: 'https://www.xbox.com/en-US/live/free-play-days' },
  { source: 'fanatical',      stateFile: 'fanatical-watch.json',      collectorKey: 'fanatical',      fallbackUrl: 'https://www.fanatical.com/en/free-games-keys' },
  { source: 'humble-bundle',  stateFile: 'humble-bundle-watch.json',  collectorKey: 'humble-bundle',  fallbackUrl: 'https://www.humblebundle.com/store' },
  { source: 'lenovo-gaming',  stateFile: 'lenovo-gaming-watch.json',  collectorKey: 'lenovo-gaming', fallbackUrl: 'https://gaming.lenovo.com/game-key-drops' },
  { source: 'ubisoft',        stateFile: 'ubisoft-watch.json',        collectorKey: 'ubisoft',        fallbackUrl: 'https://store.ubisoft.com/us/free-games' },
];

// Priority integer for cross-source dedup. Lower = higher priority.
// Watchers all tied at 1 (direct-source), aggregators graded below.
export const SOURCE_PRIORITY = {
  indiegala: 1,
  psn: 1,
  xbox: 1,
  fanatical: 1,
  'humble-bundle': 1,
  'lenovo-gaming': 1,
  ubisoft: 1,
  gamerpower: 2,
  freegamefindings: 3,
};

// Read one watcher's state file. Returns { products: {} } on any error
// so callers can degrade gracefully without try/catch. First-run fresh
// deploys have no state files yet — that's the normal empty-map case.
export function readWatcherState(stateFile) {
  const path = dataDir(stateFile);
  if (!existsSync(path)) return { products: {} };
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return { products: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.products !== 'object') return { products: {} };
    return parsed;
  } catch { return { products: {} }; }
}

// Load raw product entries for every watcher and stamp each with its
// source name. The panel's /api/discoveries handler transforms these
// into full Discovery items (with dedup keys, coverage badges, user
// state) using the same pipeline it applies to GP/FGF entries.
export function loadAllWatcherProducts() {
  const out = [];
  for (const w of WATCHER_SOURCES) {
    const st = readWatcherState(w.stateFile);
    for (const [id, p] of Object.entries(st.products || {})) {
      if (!p || !p.name) continue;
      // Fall back to the source's landing page when a watcher's state
      // file has no per-product URL (Ubisoft is the primary case — its
      // product-tile metadata doesn't expose a canonical /product/N URL).
      // Preserves the "click to claim" UX; user lands on the storefront
      // and can navigate to the specific title from there.
      const url = String(p.url || '').trim() || w.fallbackUrl || '';
      out.push({
        source: w.source,
        collectorKey: w.collectorKey,
        id,
        title: String(p.name || '').trim(),
        url,
        note: p.note || null,
        firstSeen: p.firstSeen || null,
        endDate: p.endDate || null,
        worth: p.worth || null,
      });
    }
  }
  return out;
}
