// index.js
// -----------------------------------------------------------------------------
// The web server. It does two kinds of things:
//   1. Serves the web page (the files in public/).
//   2. Answers API requests from that page.
//
// Endpoints so far (more added in later steps):
//   GET /suggest?q=<prefix>  -> up to 10 suggestions starting with <prefix>
//   GET /logs?n=<number>     -> the most recent log lines (for the UI logs panel)
//
// Run with:  node server/index.js   (or: npm start)
// -----------------------------------------------------------------------------

const path = require('path');
const express = require('express');

const { getCandidates } = require('./db');
const cache = require('./cache');
const trending = require('./trending');
const batch = require('./batch');
const { log, getRecent } = require('./logger');

const app = express();
const PORT = 3000;

// Let routes read JSON bodies (used by POST /search in Step 3).
app.use(express.json());

// Serve the front-end files in public/ at the site root.
// e.g. public/index.html becomes http://localhost:3000/
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- GET /suggest?q=<prefix> --------------------------------------------------
// THE CACHE-ASIDE FLOW:
//   1. Look in the cache (the Redis node that owns this prefix).
//   2. HIT  -> return it immediately (fast).
//   3. MISS -> read SQLite, then store the result in that cache node (with a TTL).
// Returns JSON: { q, count, suggestions, cache: "HIT"|"MISS", node }
app.get('/suggest', async (req, res) => {
  const startedAt = Date.now();

  // Normalise the prefix once so the cache key and DB query agree.
  const q = (req.query.q || '').trim().toLowerCase();

  // Empty input: nothing to do, don't touch cache or DB.
  if (!q) {
    log('SUGGEST', { q: '', results: 0, cache: 'SKIP', ms: 0 });
    return res.json({ q: '', count: 0, suggestions: [], cache: 'SKIP', node: null });
  }

  // Which Redis node owns this prefix (consistent hashing).
  const node = cache.getNode(cache.cacheKey(q)).name;

  // 1) Try the cache. We cache the *count-based candidate pool* (stable), NOT the
  //    final order — recency is blended in fresh below so trending is always live.
  let candidates = await cache.getCached(q);
  let hit = candidates !== null;

  // 2) On a miss, read the candidate pool from SQLite and cache it (with a TTL).
  if (!hit) {
    candidates = getCandidates(q);
    await cache.setCached(q, candidates);
  }

  // 3) Blend in recent activity and take the top 10 (the "enhanced" ranking).
  const suggestions = trending.rerank(q, candidates);

  const ms = Date.now() - startedAt;
  log('SUGGEST', { q, node, cache: hit ? 'HIT' : 'MISS', results: suggestions.length, ms });

  res.json({
    q,
    count: suggestions.length,
    suggestions,
    cache: hit ? 'HIT' : 'MISS',
    node,
  });
});

// --- GET /cache/debug?prefix=<prefix> -----------------------------------------
// Shows which cache node is responsible for a prefix and whether it's a hit/miss.
// This is the assignment's required proof that consistent hashing is working.
app.get('/cache/debug', async (req, res) => {
  const prefix = (req.query.prefix || '').trim().toLowerCase();
  const info = await cache.debug(prefix); // { prefix, key, node, hit }
  log('CACHEDBG', { prefix, node: info.node, hit: info.hit });
  res.json(info);
});

// --- POST /search -------------------------------------------------------------
// The "dummy search API". The user submits a query; we record it (count +1) and
// reply with the required dummy message. The body is JSON: { "query": "iphone" }.
app.post('/search', (req, res) => {
  const raw = (req.body && (req.body.query || req.body.q)) || '';
  const query = String(raw).trim().toLowerCase();

  if (query) {
    batch.enqueue(query); // buffer the write (NOT a direct DB write anymore)
    trending.bump(query); // count this toward recent activity (in memory)
  }
  log('SEARCH', { query: query || '(empty)', buffered: Boolean(query) });

  // The assignment asks specifically for this response shape.
  res.json({ message: 'Searched' });
});

// --- GET /trending ------------------------------------------------------------
// The queries with the most recent activity right now (powers the UI panel).
app.get('/trending', (req, res) => {
  const n = parseInt(req.query.n, 10) || 10;
  const items = trending.getTrending(n);
  res.json({ trending: items });
});

// --- GET /stats ---------------------------------------------------------------
// Batch-write evidence: searches received vs rows actually written to the DB.
app.get('/stats', (req, res) => {
  res.json(batch.getStats());
});

// --- POST /flush --------------------------------------------------------------
// Force the batch buffer to flush now. The web page calls this on load, so
// reloading the page writes any pending searches to the database (and invalidates
// the affected caches). Returns the latest stats.
app.post('/flush', async (req, res) => {
  await batch.flush('reload');
  res.json(batch.getStats());
});

// --- GET /logs?n=<number> -----------------------------------------------------
// The UI polls this to show a live "what the server is doing" panel.
app.get('/logs', (req, res) => {
  const n = parseInt(req.query.n, 10) || 50;
  res.json({ lines: getRecent(n) });
});

// --- Start the server ---------------------------------------------------------
app.listen(PORT, async () => {
  log('SERVER', { msg: 'started', url: `http://localhost:${PORT}` });
  console.log(`Open http://localhost:${PORT}`);

  // Start the recency decay loop so short-lived spikes fade over time.
  trending.startDecay();

  // Start the batch writer (periodic flush of buffered searches).
  batch.start();

  // Report which cache nodes are reachable (so you know Redis/Docker is up).
  const pings = await cache.pingAll();
  const up = pings.filter((p) => p.up).map((p) => p.node);
  const down = pings.filter((p) => !p.up).map((p) => p.node);
  log('CACHE', { up: up.join(',') || 'none', down: down.join(',') || 'none' });
  if (down.length) {
    console.log(
      `WARNING: cache nodes down: ${down.join(', ')}. ` +
        `Suggestions still work (served from SQLite). Start Redis with: docker compose up -d`
    );
  }
});

// --- Graceful shutdown --------------------------------------------------------
// On Ctrl+C, flush any buffered searches so we don't lose them on a clean exit.
// (A hard crash can still lose the buffer — that trade-off is documented.)
async function shutdown() {
  log('SERVER', { msg: 'shutting down, flushing batch' });
  await batch.drain();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
