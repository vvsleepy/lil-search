# PROCESS — how we built this, step by step (and why)

This document is the "story" of the project. After each build step we add a section
explaining **what we did**, **definitions** of any new word, and **why** we chose that
approach. If someone asks "why did you do it this way?" the answer is here, in plain
English.

---

## The big idea (read this first)

A typeahead system has to answer one question very, very fast, thousands of times:

> "The user typed `ip` — what are the 10 most popular searches that start with `ip`?"

Doing a database lookup every single time is slow. So the trick is:

1. Keep the *truth* (every query and how many times it was searched) in a reliable
   **database** (we use **SQLite**).
2. Keep *recent answers* in a fast **cache** (we use **Redis**) so repeated questions
   are answered instantly.
3. Spread the cache across several nodes (a **distributed cache**) and use
   **consistent hashing** to decide which node holds which answer.
4. Don't write to the database on every search — **batch** the writes together.
5. Let **recent** activity bump things up the list (**trending**), but make that effect
   fade over time so old spikes don't dominate forever.

Everything below builds these pieces one at a time.

---

## Step 0 — Project setup

**What we did**
- Set up a Node.js project (`package.json`) with three dependencies we'll add: `express`
  (web server), `better-sqlite3` (database), `ioredis` (talks to Redis).
- Wrote `docker-compose.yml` describing **3 Redis containers** on ports 6379/6380/6381.
  These are our 3 cache nodes.
- Wrote `server/logger.js`, a tiny helper that writes events to the console **and** to
  `logs/app.log`, and remembers the latest lines so the web page can show them.
- Created the folder layout and these two docs.

**Definitions**
- **Node.js** — lets us run JavaScript on the server (not just in the browser).
- **Express** — a small library that makes it easy to define web endpoints like
  `GET /suggest`.
- **Docker / container** — a way to run a program (here, Redis) in an isolated box without
  installing it directly on your computer. `docker compose up` starts all 3 at once.
- **Redis** — an in-memory database that is extremely fast at "give me the value for this
  key" — perfect for a cache.
- **Dependency** — code written by other people that our project uses; installed with
  `npm install`.

**Why these choices**
- *SQLite* for the database: it's a single file, needs no separate server, and is plenty
  fast for this assignment. Easiest possible "real database".
- *Redis in Docker* for the cache: Redis is the industry-standard cache, and Docker lets
  us run 3 copies with one command — a genuine distributed setup that's still easy to run.
- *Logging from day one*: the assignment is graded partly on *showing* behaviour (cache
  hits, routing, batching). Logging early means we get that evidence for free.

---

## Step 1 — Load the dataset into SQLite

**What we did**
- Chose the **English Word Frequency** list (Google Web Trillion Word Corpus, from
  norvig.com): 333,333 rows of `word <TAB> count`. We downloaded it to `data/count_1w.txt`.
- Wrote `data/load_data.js`, which:
  1. Creates the database file `data/queries.db`.
  2. Creates one table, `queries(query, count, recent, updated_at)`.
  3. Reads the whole file, splits each line into word + count, and inserts every row in
     **one transaction**.
- Ran it: 333,333 rows loaded in ~3.4 seconds.

**Definitions**
- **Primary data store** — the reliable "source of truth". Ours is SQLite (one file).
- **Transaction** — a group of database writes that are committed together, all-or-nothing.
  Doing all inserts in one transaction is dramatically faster than one-at-a-time (SQLite
  saves to disk once at the end instead of 333,333 times).
- **PRIMARY KEY / index** — making `query` the primary key means it's unique *and*
  automatically indexed. That index is what lets us later find "all words starting with
  `ip`" quickly instead of scanning every row.
- **PRAGMA** — a SQLite setting. We used `journal_mode=WAL` and `synchronous=OFF` to speed
  up the bulk load.

**Why these choices**
- *Why this dataset:* it already has a real `count` for every entry, so we don't have to
  invent or derive popularity numbers. The data being single words is fine — the assignment
  accepts "keywords", and the typeahead mechanics are identical whether entries are words
  or phrases.
- *Why a count column at all:* the basic 60% ranking is "sort suggestions by count", so we
  need a popularity number per query. The published word frequency is exactly that.
- *The `recent` column* starts at 0 and is used later (Step 5) for trending. We add it now
  so we don't have to change the table shape later.

---

## Step 2 — Suggestions API + basic UI

**What we did**
- `server/db.js`: a `getSuggestions(prefix)` function that returns the top 10 words starting
  with a prefix, most popular first. It trims + lowercases the input and handles
  empty/missing/no-match gracefully (returns an empty list, never an error).
- `server/index.js`: a small Express web server with:
  - `GET /suggest?q=<prefix>` → the suggestions as JSON.
  - `GET /logs?n=<n>` → recent log lines (so the page can show them).
  - serving the `public/` folder as the website.
- `public/index.html`, `style.css`, `app.js`: the search page — a search box, a dropdown
  that fills in as you type, loading / error / "no results" messages, **arrow-key
  navigation**, and a live **logs panel**.
- Tested it: `/suggest?q=ip` returns 10 results in 1–4 ms; `IP` (uppercase) gives the same
  results; empty and nonsense inputs return an empty list instead of crashing.

**Definitions**
- **Prefix search** — finding everything that *starts with* some letters (e.g. "ip" → ipod,
  iphone…). We do it with a fast **range scan** on the indexed `query` column:
  `query >= 'ip' AND query < 'iq'`.
- **Endpoint / API route** — a URL the server answers, like `GET /suggest`.
- **Debounce** — waiting a short moment (200 ms) after the user stops typing before calling
  the server, so we don't send a request for every single keystroke. (It lives in `app.js`.)
- **Static files** — plain files (HTML/CSS/JS) the server hands to the browser unchanged.

**Why these choices**
- *Range scan instead of `LIKE 'ip%'`:* the range form is guaranteed to use the index, so it
  stays fast even though the table has 333k rows. (We confirmed ~1–4 ms responses.)
- *All DB code in `db.js`:* keeps SQL in one place; the web layer just calls functions. This
  is the "modular, readable" the rubric asks for.
- *Debounce on the front-end:* directly satisfies "the UI should avoid unnecessary backend
  calls".
- *Logs panel from the start:* makes the system's behaviour visible for the demo/screenshots.

---

## Step 3 — Search submission + query-count updates

**What we did**
- `server/db.js`: added `recordSearch(query)` — an **UPSERT** that inserts a new query with
  count 1, or, if it already exists, adds 1 to its count.
- `server/index.js`: added `POST /search`, which records the query and returns the required
  dummy response `{"message":"Searched"}`.
- `public/app.js`: wired the **Search button**, the **Enter key**, and **clicking/selecting a
  suggestion** to submit the search and show the response on the page.
- Tested it: searching a brand-new word created it (count 1), searching again bumped it to 2,
  and an empty submission still returns `Searched` but records nothing.

**Definitions**
- **UPSERT** — "update or insert": one SQL statement that inserts a row, or updates it if it
  already exists. We use SQLite's `INSERT ... ON CONFLICT(query) DO UPDATE`.
- **POST** — the HTTP method used to send data *to* the server (here, the query being
  searched), as opposed to GET which just *fetches* data.
- **Request body** — the JSON payload sent with a POST, e.g. `{ "query": "iphone" }`.

**Why these choices**
- *Increment by 1 per search:* simple and honest. Because the dataset's real counts are huge
  (billions), one search barely moves the all-time ranking — which is exactly *why* the
  assignment also wants **trending/recency** (Step 5): recent activity is what should visibly
  re-order suggestions in a demo, not the slow-moving all-time count.
- *Direct DB write for now:* easiest correct version. In **Step 6** we replace this with a
  **batch writer** so we don't hit the database on every single request.
- *Selecting a suggestion searches it:* matches how real search boxes behave (click a
  suggestion → it searches), and satisfies the "search on Enter or button click" requirement.

---

## Step 4 — Distributed cache + consistent hashing

**What we did**
- `server/cache.js`: connects to all **3 Redis nodes** (one client each) and builds a
  **consistent-hashing ring** to decide which node owns each prefix.
- Wired the **cache-aside** flow into `GET /suggest`: check the owning Redis node first; on a
  **miss**, read SQLite and store the result back in that node with a 60-second **TTL**.
- Added `GET /cache/debug?prefix=` → reports the owning node + hit/miss.
- Made the cache **safe**: if a Redis node is down, reads/writes silently fall back to SQLite,
  so suggestions never break.
- **Proved it works:** routed 14 prefixes and then listed the keys actually stored on each
  Redis container — the physical placement matched the ring's predictions exactly (e.g. `ip`,
  `book`, `java`, `pizza` all on `redis-2`). First `/suggest` is a MISS, the second is a HIT.

**Definitions**
- **Cache** — a small, fast store of recent answers so we don't redo expensive work.
- **Cache-aside** — the app checks the cache first and, on a miss, loads from the database and
  *then* fills the cache. (The cache sits "aside" the database.)
- **TTL (time to live)** — how long a cached entry survives before it auto-expires. Ours is
  60s, set with Redis `SET key value EX 60`.
- **Distributed cache** — the cache is split across several servers (our 3 Redis nodes), not
  one, so it can hold more and survive a single node failing.
- **Consistent hashing** — a rule for "which node owns this key" using a hash *ring*. Adding or
  removing a node only moves the keys in one arc, instead of reshuffling everything (which is
  what `hash % N` would do).
- **Virtual nodes** — placing each real node at many points (150) on the ring so keys spread
  evenly instead of one node accidentally owning a huge slice.
- **Hit / miss** — a *hit* means the answer was already in the cache; a *miss* means we had to
  go to the database.

**Why these choices**
- *Real Redis (not an in-memory map):* the assignment specifically wants a *distributed* cache;
  3 real Redis nodes make the routing genuinely meaningful, and `redis-cli` lets us *prove* a
  key lives on the predicted node.
- *Consistent hashing instead of `% 3`:* `% 3` would scatter almost every key to a new node the
  moment we add/remove a server, wiping the cache. Consistent hashing moves only a small slice.
  **This router is our own code — it's the core thing to explain in the viva; Redis is just
  storage behind it.**
- *Cache key = the prefix's result:* we cache the finished top-10 list, because *computing* it
  (scanning + sorting) is the expensive part; caching the answer skips all of it.
- *Graceful fallback:* treating a dead node as a miss means a Redis outage degrades performance
  but never breaks the feature.

---

## Step 5 — Trending searches (recency-aware ranking)

**What we did**
- `server/trending.js`: keeps an **in-memory map** of each query's *recent activity* score.
  Every `/search` adds +1 (`bump`). A timer **decays** all scores (×0.5 every 30s) so spikes
  fade. `rerank()` blends recency into the count-based candidate pool; `getTrending()` lists
  the most-recent queries.
- `server/db.js`: added `getCandidates(prefix)` (top 50 by count, the pool to re-rank) and
  `getCount(query)`.
- `server/index.js`: `/suggest` now caches the **candidate pool** and blends recency in
  **live**; `/search` calls `bump`; added `GET /trending`; the decay loop starts on boot.
- UI: a **Trending now** panel that updates as you search; clicking an item searches it.
- **Demonstrated it:** for prefix `piz`, `pizzo` normally ranks #9 by count (78k) — after
  searching it 3 times it jumped to **#1**, above `pizza` (14.7M). Meanwhile `pizza`'s recent
  score decayed 5 → 0.625, showing spikes don't last forever.

**The 5 points the assignment asks us to explain**
1. **How recent searches are tracked:** an in-memory `Map<query, score>`; each search adds +1.
2. **How recent activity affects ranking:** final `score = count + weight * recent`, where
   `weight` = the top candidate's count, so even one recent search is worth ~one "most popular
   item" and visibly lifts the query.
3. **How we avoid permanent over-ranking:** exponential **decay** (×0.5 every 30s); once a
   query stops being searched its recent score shrinks to ~0 and it falls back down.
4. **How the cache stays correct when rankings change:** we **don't cache the final order** —
   only the stable count-based candidate pool (with a 60s TTL). Recency is applied fresh on
   every request, so trending is always live. (When counts themselves change, the batch writer
   invalidates the affected prefix — Step 6.)
5. **Trade-offs (freshness vs latency vs complexity):** keeping recency in memory makes it
   instant and always-fresh and adds **zero** database writes, but it's per-process and resets
   if the server restarts — fine for this assignment's demo. Caching only the candidate pool
   keeps reads fast *and* rankings fresh, at the cost of a tiny re-rank on each request.

**Definitions**
- **Recency / trending** — favouring things searched *recently*, not just *often overall*.
- **Decay** — repeatedly shrinking the recent scores so old activity fades automatically.
- **Blended score** — a single number combining all-time count and recent activity, used to
  sort suggestions.

**Why these choices**
- *In-memory recency, not a DB column:* recency changes on every search; writing it to disk each
  time would create the exact write pressure Step 6 is meant to remove.
- *Cache the candidate pool, not the final list:* gives us fast reads **and** always-live
  trending — the cleanest answer to "how is the cache updated when rankings change".
- *Weight = top candidate count:* makes recency impactful on any dataset without a hand-tuned
  magic number that would break if the data scale changed.

---

## Step 6 — Batch writes

**What we did**
- `server/batch.js`: `POST /search` now drops the query into an in-memory **buffer**
  (`Map<query, count>`, so repeats aggregate automatically). The buffer flushes when the
  **earliest** of three things happens: the **page is reloaded** (`POST /flush`), a **30s
  timeout** elapses, or **200 distinct queries** pile up. A flush writes the aggregated counts
  to SQLite in **one transaction**, then **invalidates** the cache for every affected prefix.
- `server/db.js`: added `applyBatch(items)` — one transaction that adds each query's aggregated
  amount.
- `server/index.js`: `/search` enqueues instead of writing; added `GET /stats` (the
  write-reduction evidence); the flusher starts on boot; Ctrl+C **drains** the buffer first.
- **Proved it:** 60 searches across 3 words resulted in only **4 row-writes (93% reduction)**;
  one flush folded 29 searches into 2 rows. Counts still landed correctly (`apple` went up by
  the right amount), and the `app` cache entry was **invalidated** by the flush (hit → miss).

**Definitions**
- **Buffer / queue** — a temporary in-memory holding area for work not done yet (here, pending
  count updates).
- **Aggregation** — combining repeats before writing (5×"pizza" → one "+5"), so one row-write
  covers many searches.
- **Flush** — taking everything in the buffer and writing it out at once.
- **Write reduction** — the whole point: far fewer database writes than searches.

**Failure trade-offs (the assignment asks for this explicitly)**
- If the process **crashes** between flushes, the buffered (not-yet-written) searches are
  **lost**, so a few counts under-count slightly. We accept this for the assignment: counts are
  popularity hints, not money, and a small loss doesn't hurt suggestions.
- We reduce the window three ways: a flush on **page reload**, a **30s timeout**, and a
  **graceful shutdown** that flushes on Ctrl+C. For real durability you'd write to an
  append-only log first (write-ahead log) and replay it on restart — noted as a future
  improvement, intentionally left out to keep this simple.
- **Latency vs freshness vs safety:** buffering makes `/search` instant (no disk wait) and slows
  write pressure, at the cost of suggestions lagging reality by up to one flush interval. Cache
  invalidation on flush keeps the lag bounded and predictable.

**Why these choices**
- *Map buffer:* aggregates repeats for free and bounds memory to "distinct queries since last
  flush".
- *Flush on reload **and** by time **and** size:* reload is a natural checkpoint (you see fresh
  data after refreshing); the 30s timeout keeps data fresh under light load; the size cap
  protects memory under a sudden spike. A longer timeout also means cached suggestion pools live
  longer between flushes, which makes cache HITs easy to see in a live demo.
- *Invalidate prefixes on flush:* this is the moment counts actually change, so it's exactly
  when the cached pools should be dropped — tying batch writes and cache freshness together.

---

## Step 7 — Performance benchmark + documentation

**What we did**
- `bench/measure.js`: a script that hits the running server with 200 searches and 3,000
  suggestion requests and reports **p95 latency**, **cache hit rate**, and **DB read/write
  counts**.
- Filled in the README's performance report, design-choices table, and API examples; finalised
  this PROCESS document.

**The measured result (full 333,333-row dataset):**
- Suggest latency: mean 4.5 ms, **p95 6.3 ms**.
- **Cache hit rate 99.0%** (2,970 hits / 30 misses). The 30 misses are exactly the 30 distinct
  prefixes — one cold miss each, every repeat a hit.
- **Batch write reduction 96%** (200 searches → 8 row-writes).

**Definitions**
- **Latency** — how long one request takes, end to end.
- **p95 (95th percentile)** — 95% of requests were *at least this fast*; a better "typical
  worst case" than the average, which a few slow requests can distort.
- **Hit rate** — share of suggestion requests answered from cache instead of the database.

**Why these choices**
- *Benchmark reuses prefixes:* so the cache warms up and the hit rate reflects real usage
  (popular prefixes asked repeatedly).
- *Report p95, not just average:* the assignment asks for it, and it's the honest measure of
  what users feel.

---

## Quick map: where each requirement lives (for the viva)

| Requirement | File(s) | One-line summary |
|---|---|---|
| Suggestions (top 10 by count, prefix, case-insensitive) | `server/db.js`, `public/app.js` | indexed range scan + debounced UI |
| Search API returns `{"message":"Searched"}` | `server/index.js` (`POST /search`) | records the query, returns the dummy message |
| Query-count updates | `server/db.js`, `server/batch.js` | UPSERT, applied via the batch writer |
| Distributed cache + consistent hashing | `server/cache.js` | 3 Redis nodes + our hash ring (`GET /cache/debug`) |
| Trending (recency + decay) | `server/trending.js` | in-memory score, blended into ranking, decays |
| Batch writes | `server/batch.js` | buffer → aggregate → one transaction → invalidate |
| Performance report | `bench/measure.js` | p95 latency, hit rate, write reduction |

**If you can explain the three "hearts" of this project, you can defend the whole thing:**
1. **The consistent-hashing ring** in `cache.js` — why it beats `hash % 3`.
2. **The recency blend + decay** in `trending.js` — how recent activity lifts a query and then
   fades.
3. **The batch buffer + flush** in `batch.js` — how it cuts writes and what it risks on a crash.
