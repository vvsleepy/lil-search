// batch.js
// -----------------------------------------------------------------------------
// BATCH WRITES (the other 20%-marks feature).
//
// THE PROBLEM:
//   Writing to the database on every single search is wasteful. If 500 people
//   search "iphone" in a few seconds, that's 500 separate disk writes for what
//   is really "+500 to one row".
//
// THE FIX:
//   Don't write immediately. Instead drop each search into an in-memory BUFFER.
//   A flusher runs every few seconds (or when the buffer gets big), ADDS UP the
//   repeats, and writes them to SQLite in ONE transaction. Far fewer writes.
//
// We use a Map<query, count> as the buffer, so repeats are aggregated as they
// arrive (the Map naturally keeps one entry per query).
// -----------------------------------------------------------------------------

const db = require('./db');
const cache = require('./cache');
const { log } = require('./logger');

// --- Tunable settings ---------------------------------------------------------
// We flush when the EARLIEST of these happens:
//   1. the page is reloaded (the browser calls POST /flush on load), or
//   2. this timeout elapses, or
//   3. the buffer fills up (safety net so memory can't grow unbounded).
// A longer timeout means cached suggestion pools survive longer between flushes,
// which makes cache HITs easy to demonstrate (a flush invalidates changed prefixes).
const FLUSH_INTERVAL_MS = 30000; // 30s timeout fallback
const MAX_BATCH = 200; // ...or sooner if this many distinct queries pile up

// The buffer: query -> how many times it was searched since the last flush.
const buffer = new Map();

// Stats so we can PROVE the write reduction (received vs actually written).
const stats = {
  received: 0, // total searches enqueued (all time)
  rowsWritten: 0, // total rows written to SQLite (all time)
  flushes: 0, // number of flushes
  lastFlush: null, // details of the most recent flush
};

/**
 * Enqueue a search (called by POST /search instead of writing immediately).
 * @param {string} query - already lowercased/trimmed and non-empty.
 */
function enqueue(query) {
  if (!query) return;
  buffer.set(query, (buffer.get(query) || 0) + 1);
  stats.received++;

  // Size-based flush: if lots of *distinct* queries pile up, flush early.
  if (buffer.size >= MAX_BATCH) flush('size');
}

/**
 * Flush the buffer: aggregate -> one DB transaction -> invalidate caches.
 * @param {string} reason - "size" | "timer" | "shutdown" (for the log).
 */
async function flush(reason = 'timer') {
  if (buffer.size === 0) return;

  // Snapshot the buffer and clear it immediately so new searches keep buffering.
  const items = [...buffer.entries()].map(([query, amount]) => ({ query, amount }));
  const searchesInBatch = items.reduce((sum, it) => sum + it.amount, 0);
  buffer.clear();

  // ONE transaction writes all the aggregated rows.
  const rows = db.applyBatch(items);

  // The counts changed, so the cached suggestion pools that include these words
  // are now stale. Invalidate every prefix of each changed word (e.g. "pizza"
  // -> p, pi, piz, pizz, pizza). Words are short, so this is a handful of keys.
  let invalidated = 0;
  for (const it of items) {
    for (let i = 1; i <= it.query.length; i++) {
      await cache.invalidate(it.query.slice(0, i));
      invalidated++;
    }
  }

  // Update + log stats. "searches=N wrote=M" is the write-reduction evidence:
  // we received N searches but only performed M row-writes (M <= N).
  stats.rowsWritten += rows;
  stats.flushes++;
  stats.lastFlush = { reason, searches: searchesInBatch, rows, invalidated };
  log('BATCH', { reason, searches: searchesInBatch, wrote: rows, invalidated });
}

/** Start the periodic flush timer. */
let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => flush('timer'), FLUSH_INTERVAL_MS);
}

/** Flush whatever is left (used on graceful shutdown). */
async function drain() {
  await flush('shutdown');
}

/** Current stats + a derived write-reduction figure. */
function getStats() {
  const { received, rowsWritten, flushes } = stats;
  // Reduction = how much smaller the write count is vs the search count.
  const reductionPct =
    received > 0 ? Math.round((1 - rowsWritten / received) * 100) : 0;
  return { ...stats, buffered: buffer.size, reductionPct };
}

module.exports = {
  enqueue,
  flush,
  start,
  drain,
  getStats,
  FLUSH_INTERVAL_MS,
  MAX_BATCH,
};
