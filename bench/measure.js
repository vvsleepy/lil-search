// measure.js
// -----------------------------------------------------------------------------
// A tiny benchmark for the performance report. It talks to a RUNNING server and
// reports the three numbers the assignment asks for:
//   - p95 latency of GET /suggest
//   - cache hit rate
//   - database read / write counts (reads ≈ cache misses; writes from /stats)
//
// HOW TO RUN (server must already be up):
//   1. docker compose up -d
//   2. npm start          (in one terminal)
//   3. npm run bench      (in another terminal)
// -----------------------------------------------------------------------------

const BASE = 'http://localhost:3000';

// A pool of prefixes. We reuse them on purpose so the cache warms up and we can
// observe hits (the first time a prefix is asked is a MISS, later times are HITs).
const PREFIXES = [
  'a', 'ap', 'app', 'appl', 'apple', 'ba', 'ban', 'car', 'do', 'dog',
  'java', 'pi', 'piz', 'sea', 'sun', 'tre', 'wat', 'boo', 'book', 'mu',
  'mus', 'music', 'ph', 'pho', 'phone', 'ne', 'new', 'ti', 'tim', 'time',
];

const SEARCHES = 200; // submitted searches (to exercise batch writes)
const SUGGESTS = 3000; // suggestion requests (to measure latency + hit rate)

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

async function main() {
  // Quick connectivity check with a friendly message if the server isn't up.
  try {
    await fetch(`${BASE}/stats`);
  } catch {
    console.error(`Could not reach ${BASE}. Start the server first: npm start`);
    process.exit(1);
  }

  // --- Phase A: searches (exercise batch writes) ------------------------------
  console.log(`Phase A: sending ${SEARCHES} searches...`);
  const words = ['apple', 'banana', 'cherry', 'dog', 'java', 'music', 'phone', 'time'];
  for (let i = 0; i < SEARCHES; i++) {
    const q = pick(words);
    await fetch(`${BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
  }
  // Force a flush so all buffered searches are written before we read stats.
  await fetch(`${BASE}/flush`, { method: 'POST' });

  // --- Phase B: suggestions (measure latency + hit rate) ----------------------
  console.log(`Phase B: sending ${SUGGESTS} suggestion requests...`);
  const latencies = [];
  let hits = 0;
  let misses = 0;

  for (let i = 0; i < SUGGESTS; i++) {
    const q = pick(PREFIXES);
    const t0 = performance.now();
    const res = await fetch(`${BASE}/suggest?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const ms = performance.now() - t0;

    latencies.push(ms);
    if (data.cache === 'HIT') hits++;
    else if (data.cache === 'MISS') misses++;
  }

  latencies.sort((a, b) => a - b);
  const mean = latencies.reduce((s, x) => s + x, 0) / latencies.length;

  // --- Pull batch-write stats from the server ---------------------------------
  const stats = await (await fetch(`${BASE}/stats`)).json();

  // --- Report -----------------------------------------------------------------
  const hitRate = hits + misses > 0 ? (100 * hits) / (hits + misses) : 0;

  console.log('\n========== PERFORMANCE REPORT ==========');
  console.log(`Suggest requests:      ${SUGGESTS}`);
  console.log('--- Latency (GET /suggest) ---');
  console.log(`  mean:  ${mean.toFixed(2)} ms`);
  console.log(`  p50:   ${percentile(latencies, 50).toFixed(2)} ms`);
  console.log(`  p95:   ${percentile(latencies, 95).toFixed(2)} ms`);
  console.log(`  p99:   ${percentile(latencies, 99).toFixed(2)} ms`);
  console.log(`  max:   ${latencies[latencies.length - 1].toFixed(2)} ms`);
  console.log('--- Cache ---');
  console.log(`  hits:   ${hits}`);
  console.log(`  misses: ${misses}   (each miss = 1 DB read)`);
  console.log(`  hit rate: ${hitRate.toFixed(1)}%`);
  console.log('--- Database writes (batching) ---');
  console.log(`  searches received: ${stats.received}`);
  console.log(`  rows written:      ${stats.rowsWritten}`);
  console.log(`  write reduction:   ${stats.reductionPct}%`);
  console.log('========================================');
}

main();
