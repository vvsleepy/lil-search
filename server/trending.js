// trending.js
// -----------------------------------------------------------------------------
// TRENDING = recency-aware ranking (the first 20%-marks feature).
//
// THE IDEA:
//   The basic ranking sorts only by all-time `count`. But something searched a
//   lot in the LAST few minutes should jump up, even if its all-time count is
//   modest. So we keep a small "recent activity" score per query and BLEND it
//   into the ranking.
//
// THE THREE THINGS THE ASSIGNMENT ASKS US TO EXPLAIN:
//   1. How recent searches are tracked
//        -> an in-memory Map: every search adds +1 to that query's recent score.
//   2. How recent activity affects ranking
//        -> final score = count + (weight * recent), where `weight` is the top
//           candidate's count, so even one recent search visibly lifts a query.
//   3. How we avoid permanently over-ranking a short-lived spike
//        -> DECAY: every interval we multiply all recent scores by a factor < 1,
//           so a spike fades back to zero over a few minutes on its own.
//
// WHY IN MEMORY (not a DB column):
//   Recency changes on every single search. Writing that to disk each time would
//   create exactly the write pressure the assignment wants us to avoid. Keeping
//   it in memory makes it free and instant; we never cache it, so it's always live.
// -----------------------------------------------------------------------------

const db = require('./db');
const { log } = require('./logger');

// --- Tunable settings (documented trade-offs) ---------------------------------
const DECAY_FACTOR = 0.5; // each interval, recent scores are halved
const DECAY_INTERVAL_MS = 30_000; // ...every 30 seconds
const DROP_BELOW = 0.05; // forget a query once its recent score is tiny

// query -> recent activity score (a number that grows on search, shrinks on decay)
const recent = new Map();

/**
 * Record recent activity for a query (called on every /search).
 * @param {string} query - already lowercased/trimmed.
 */
function bump(query, amount = 1) {
  if (!query) return;
  recent.set(query, (recent.get(query) || 0) + amount);
}

/** The current recent score for a query (0 if none). */
function getRecent(query) {
  return recent.get(query) || 0;
}

/** All currently-tracked queries that start with `prefix`. */
function recentMatching(prefix) {
  const out = [];
  for (const [query, score] of recent) {
    if (query.startsWith(prefix)) out.push(query);
  }
  return out;
}

/**
 * Re-rank a pool of count-based candidates using recent activity.
 *
 * @param {string} prefix     - the (lowercased) prefix being searched.
 * @param {Array<{query,count}>} candidates - pool from db.getCandidates (by count).
 * @returns {Array<{query, count, recent, score}>} top 10 by blended score.
 */
function rerank(prefix, candidates) {
  // Start from the count-based pool.
  const counts = new Map(candidates.map((c) => [c.query, c.count]));

  // Make sure recently-searched words for this prefix are in the pool too, even
  // if their all-time count was too low to be a top-50 candidate.
  for (const query of recentMatching(prefix)) {
    if (!counts.has(query)) {
      const c = db.getCount(query);
      if (c != null) counts.set(query, c);
    }
  }

  // `weight` scales a single recent search to be worth roughly the most popular
  // candidate's count — so recent activity has a visible, dataset-independent
  // effect instead of being drowned out by huge all-time counts.
  const topCount = candidates.length ? candidates[0].count : 1;
  const weight = Math.max(topCount, 1);

  const scored = [];
  for (const [query, count] of counts) {
    const r = getRecent(query);
    scored.push({ query, count, recent: r, score: count + weight * r });
  }

  // Highest blended score first; keep the top 10.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 10);
}

/**
 * The trending list: queries with the most recent activity right now.
 * @param {number} n
 * @returns {Array<{query, recent, count}>}
 */
function getTrending(n = 10) {
  return [...recent.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([query, score]) => ({
      query,
      recent: Math.round(score * 100) / 100,
      count: db.getCount(query) ?? 0,
    }));
}

// --- Decay loop ---------------------------------------------------------------
function decayOnce() {
  let dropped = 0;
  for (const [query, score] of recent) {
    const next = score * DECAY_FACTOR;
    if (next < DROP_BELOW) {
      recent.delete(query);
      dropped++;
    } else {
      recent.set(query, next);
    }
  }
  log('DECAY', { tracked: recent.size, dropped, factor: DECAY_FACTOR });
}

let decayTimer = null;
function startDecay() {
  if (decayTimer) return;
  // unref() lets the process exit naturally even with this timer pending.
  decayTimer = setInterval(decayOnce, DECAY_INTERVAL_MS);
  if (decayTimer.unref) decayTimer.unref();
}

module.exports = {
  bump,
  getRecent,
  rerank,
  getTrending,
  startDecay,
  DECAY_FACTOR,
  DECAY_INTERVAL_MS,
};
