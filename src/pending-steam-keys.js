// Shared queue for Prime → Steam auto-redeem (2A / v2.11.0).
//
// prime-gaming.js appends {title, code, addedAt} entries here when it
// captures a Steam key and PG_STEAM_AUTOREDEEM is on. steam.js drains
// the queue at the end of its regular claim pass by posting each code
// to Steam's /account/registerkey. The two runners are serialized in
// the same daily loop (Prime claimOrder 2 → Steam claimOrder 4), so
// no locking is needed — Prime is fully done writing before Steam
// starts reading.
//
// File shape: `{ pending: [{title, code, addedAt, attempts, lastError, lastAttemptAt}] }`.
// `attempts` starts at 0; steam.js increments on each attempt. Successfully
// redeemed entries are dropped from the queue entirely (see markRedeemed).
// Entries that hit a *permanent* redeem failure (invalid code, already
// owned) are also dropped — the user is notified via the standard channel.
// Only *transient* failures (Steam rate-limit, network) stay in the queue
// for the next daily run to retry.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dataDir, datetime } from './util.js';

const QUEUE_FILE = dataDir('pending-steam-keys.json');

// Cap the retry budget so a permanently-broken code doesn't sit in the
// queue forever eating one Steam POST per day. When exceeded, steam.js
// treats the entry as manual-intervention needed and drops it.
export const MAX_ATTEMPTS_BEFORE_DROP = 5;

function readQueueRaw() {
  if (!existsSync(QUEUE_FILE)) return { pending: [] };
  try {
    const j = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
    if (!j || !Array.isArray(j.pending)) return { pending: [] };
    return j;
  } catch { return { pending: [] }; }
}

function writeQueueRaw(q) {
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
}

// Append if new (dedup on normalized code). Returns true if a new entry
// was added, false if the code was already in the queue.
export function enqueueSteamKey({ title, code }) {
  const norm = String(code || '').trim();
  if (!norm) return false;
  const q = readQueueRaw();
  if (q.pending.some(e => (e.code || '').trim() === norm)) return false;
  q.pending.push({
    title: String(title || '').trim() || '(untitled)',
    code: norm,
    addedAt: datetime(),
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
  });
  writeQueueRaw(q);
  return true;
}

export function loadPendingKeys() {
  return readQueueRaw().pending;
}

// Drop the entry — call after a successful redeem OR a permanent failure
// (invalid code, already owned) that shouldn't be retried.
export function dropKey(code) {
  const norm = String(code || '').trim();
  const q = readQueueRaw();
  const before = q.pending.length;
  q.pending = q.pending.filter(e => (e.code || '').trim() !== norm);
  if (q.pending.length !== before) writeQueueRaw(q);
}

// Transient failure — bump attempts + record last error. If the retry
// cap is exceeded, drop the entry and return true so the caller can
// flip its "needs-manual" notification.
export function bumpKeyAttempt(code, error) {
  const norm = String(code || '').trim();
  const q = readQueueRaw();
  const entry = q.pending.find(e => (e.code || '').trim() === norm);
  if (!entry) return false;
  entry.attempts = (entry.attempts || 0) + 1;
  entry.lastError = String(error || '').slice(0, 200);
  entry.lastAttemptAt = datetime();
  const drop = entry.attempts >= MAX_ATTEMPTS_BEFORE_DROP;
  if (drop) q.pending = q.pending.filter(e => (e.code || '').trim() !== norm);
  writeQueueRaw(q);
  return drop;
}
