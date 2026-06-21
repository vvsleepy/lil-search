// cache.js
// -----------------------------------------------------------------------------
// THE DISTRIBUTED CACHE + CONSISTENT HASHING (the heart of the assignment).
//
// We have THREE separate Redis servers (the 3 Docker containers). A cache entry
// must live on exactly ONE of them. The question is: given a key like the prefix
// "ip", which of the 3 servers should hold it?
//
// The naive answer is `node = hash(key) % 3`. The problem: if you ever add or
// remove a server, `% 3` becomes `% 2` or `% 4`, and almost EVERY key suddenly
// maps to a different server — the whole cache is invalidated at once.
//
// CONSISTENT HASHING fixes this. We place the servers on an imaginary circle
// (a "ring") of numbers. A key is also hashed to a point on the circle, and it
// belongs to the first server found walking CLOCKWISE from that point. Now if a
// server is added/removed, only the keys in that one arc move — everything else
// stays put.
//
// VIRTUAL NODES: to spread keys evenly, each real server is placed at MANY points
// on the ring (here, 150 each), not just one. Without this, one server could
// randomly own a huge arc and get overloaded.
// -----------------------------------------------------------------------------

const crypto = require('crypto');
const Redis = require('ioredis');
const { log } = require('./logger');

// --- The three cache nodes (our 3 Redis containers) ---------------------------
// Each is a separate Redis. We create one client per node.
//
// WHERE the nodes live depends on how you run the app:
//   - Running the app on your machine (npm start): Redis is reached on localhost
//     at ports 6379/6380/6381 (the host ports docker-compose maps).
//   - Running the app INSIDE docker-compose: containers talk over the compose
//     network using service names (redis-0/redis-1/redis-2), all on port 6379.
// So we read an optional REDIS_NODES env var ("host:port,host:port,host:port");
// docker-compose sets it. With no env var we fall back to the localhost defaults.
function parseNodeDefs() {
  const env = process.env.REDIS_NODES;
  if (env) {
    return env.split(',').map((pair, i) => {
      const [host, port] = pair.trim().split(':');
      return { name: `redis-${i}`, host, port: parseInt(port, 10) || 6379 };
    });
  }
  return [
    { name: 'redis-0', host: '127.0.0.1', port: 6379 },
    { name: 'redis-1', host: '127.0.0.1', port: 6380 },
    { name: 'redis-2', host: '127.0.0.1', port: 6381 },
  ];
}

const NODE_DEFS = parseNodeDefs();

// Connection options chosen so a DOWN node fails FAST instead of hanging the
// suggestion request. If a node is unreachable we just treat it as a cache miss
// and fall back to SQLite (graceful degradation).
const REDIS_OPTS = {
  maxRetriesPerRequest: 1, // don't retry forever on a dead node
  connectTimeout: 1000,
  enableOfflineQueue: false, // fail immediately if not connected
  lazyConnect: false,
};

const nodes = NODE_DEFS.map((def) => {
  const client = new Redis({ host: def.host, port: def.port, ...REDIS_OPTS });
  // Without an 'error' listener ioredis would spam the console; we log once-ish.
  client.on('error', (err) => {
    log('CACHE', { node: def.name, error: err.code || err.message });
  });
  return { name: def.name, client };
});

// --- Settings -----------------------------------------------------------------
const VIRTUAL_NODES = 150; // points on the ring per real node
const CACHE_TTL_SECONDS = 60; // how long a cached suggestion list lives

// --- The hash function --------------------------------------------------------
// Turn any string into a number (0 .. 2^32-1) using MD5. MD5 isn't for security
// here — we just need a fast, evenly-spread hash to place things on the ring.
function hash(str) {
  const hex = crypto.createHash('md5').update(str).digest('hex');
  return parseInt(hex.slice(0, 8), 16); // first 32 bits is plenty
}

// --- Build the ring -----------------------------------------------------------
// ring = sorted list of { pos, node }. Each node appears VIRTUAL_NODES times.
const ring = [];
for (const node of nodes) {
  for (let v = 0; v < VIRTUAL_NODES; v++) {
    ring.push({ pos: hash(`${node.name}#${v}`), node });
  }
}
ring.sort((a, b) => a.pos - b.pos);

/**
 * Find which node owns a key (the consistent-hashing lookup).
 * Hash the key to a point, then walk clockwise to the first ring entry at or
 * after that point (wrapping past the end back to the start).
 *
 * @param {string} key
 * @returns {{name: string, client: object}}
 */
function getNode(key) {
  const pos = hash(key);

  // Binary search for the first ring entry with ring[i].pos >= pos.
  let lo = 0;
  let hi = ring.length - 1;
  let idx = 0; // default: wrap around to the first entry
  let found = false;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ring[mid].pos >= pos) {
      idx = mid;
      found = true;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (!found) idx = 0; // pos was past the last point -> wrap to the first
  return ring[idx].node;
}

// --- Cache keys ---------------------------------------------------------------
// We cache the SUGGESTION RESULT for a prefix, so the key is built from the prefix.
function cacheKey(prefix) {
  return `sugg:${prefix}`;
}

// --- Read / write helpers -----------------------------------------------------
// All of these are SAFE: if Redis is unreachable they don't throw, they just
// behave like "nothing cached", so the app keeps working from SQLite.

/**
 * Get cached suggestions for a prefix, or null on miss / error.
 * @returns {Promise<Array|null>}
 */
async function getCached(prefix) {
  const key = cacheKey(prefix);
  const node = getNode(key);
  try {
    const raw = await node.client.get(key);
    if (raw == null) return null; // miss
    return JSON.parse(raw); // hit
  } catch {
    return null; // node down / parse error -> treat as a miss
  }
}

/**
 * Store suggestions for a prefix on its owning node, with a TTL so it expires.
 */
async function setCached(prefix, suggestions) {
  const key = cacheKey(prefix);
  const node = getNode(key);
  try {
    // SET key <json> EX <seconds> -> value auto-expires after CACHE_TTL_SECONDS.
    await node.client.set(key, JSON.stringify(suggestions), 'EX', CACHE_TTL_SECONDS);
  } catch {
    // If the node is down we simply skip caching; not fatal.
  }
}

/**
 * Delete the cached entry for a prefix (used when its data changes — Step 6).
 */
async function invalidate(prefix) {
  const key = cacheKey(prefix);
  const node = getNode(key);
  try {
    await node.client.del(key);
  } catch {
    // ignore
  }
}

/**
 * Which node owns this prefix, plus whether it currently has a value cached.
 * Used by GET /cache/debug.
 */
async function debug(prefix) {
  const key = cacheKey(prefix);
  const node = getNode(key);
  let hit = false;
  try {
    hit = (await node.client.exists(key)) === 1;
  } catch {
    hit = false;
  }
  return { prefix, key, node: node.name, hit };
}

/**
 * Wait until a client is connected ("ready"), or give up after `ms`.
 * Needed at startup because connecting is async — pinging too early would
 * wrongly report a healthy node as down.
 */
function waitReady(client, ms = 2000) {
  if (client.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(val);
    };
    const onReady = () => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    client.once('ready', onReady);
  });
}

/**
 * Ping every node at startup so we can report which caches are reachable.
 * Waits for each connection to be ready first to avoid false "down" reports.
 */
async function pingAll() {
  const results = [];
  for (const node of nodes) {
    let up = false;
    if (await waitReady(node.client)) {
      try {
        await node.client.ping();
        up = true;
      } catch {
        up = false;
      }
    }
    results.push({ node: node.name, up });
  }
  return results;
}

module.exports = {
  getNode,
  cacheKey,
  getCached,
  setCached,
  invalidate,
  debug,
  pingAll,
  nodeNames: nodes.map((n) => n.name),
  CACHE_TTL_SECONDS,
  VIRTUAL_NODES,
};
