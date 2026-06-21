# PROCESS — how I built this, step by step (and why)

This is basically the story of how the project came together. After every step I've
written down what I actually did, what any new term means, and why I picked that
approach over the alternatives. If you're wondering "why did you do it this way?" — the
answer should be in here somewhere, written in plain English, not textbook language.

---

## The big idea (read this first)

A typeahead system really only has to answer one question, over and over, super fast:

> "The user typed `ip` — what are the 10 most popular searches that start with `ip`?"

If you hit the database every single time someone types a letter, it's going to be slow.
So the plan was:

1. Keep the *real* data — every query and how many times it's been searched — in a proper
   **database**. I used **SQLite**.
2. Keep *recent answers* sitting in a fast **cache** (**Redis**) so the same question
   asked twice doesn't need a second trip to the database.
3. Spread that cache across a few nodes (a **distributed cache**) and use **consistent
   hashing** to figure out which node should hold which answer.
4. Don't write to the database on every single search — **batch** those writes up instead.
5. Let **recent** activity push things up the list (**trending**), but make sure that
   effect fades over time so an old spike doesn't sit at #1 forever.

Everything below is just building these five pieces one at a time.

---

## Step 0 — Project setup

**What I did**
- Started a Node.js project (`package.json`) and pulled in three things I knew I'd need:
  `express` for the web server, `better-sqlite3` for the database, and `ioredis` to talk
  to Redis.
- Wrote `docker-compose.yml` to spin up **3 Redis containers** on ports 6379/6380/6381 —
  these are my 3 cache nodes.
- Wrote `server/logger.js`, a small helper that prints events to the console *and* writes
  them to `logs/app.log`, and keeps the latest lines around so the page can display them.
- Set up the folder structure and started these two docs.

**Definitions**
- **Node.js** — runs JavaScript on the server instead of just in a browser.
- **Express** — a lightweight library for defining web endpoints, like `GET /suggest`.
- **Docker / container** — runs a program (Redis, in this case) in its own isolated box
  without you having to install it directly on your machine. `docker compose up` brings
  all 3 up together.
- **Redis** — an in-memory database, extremely fast at "give me the value for this key" —
  exactly what you want for a cache.
- **Dependency** — someone else's code that the project relies on, pulled in with
  `npm install`.

**Why I went this way**
- *SQLite for the database:* it's a single file, no separate server to set up, and more
  than fast enough for an assignment-sized dataset. The simplest version of a "real"
  database.
- *Redis in Docker for the cache:* Redis is basically the standard cache people reach for,
  and Docker lets me run 3 instances with one command — a genuinely distributed setup
  without a painful setup process.
- *Logging from day one:* part of this gets graded on showing the behavior (cache hits,
  routing, batching), so if logging is in from the start, I get that proof basically for
  free later.

---

## Step 1 — Load the dataset into SQLite

**What I did**
- Went with the **English Word Frequency** list (Google Web Trillion Word Corpus, from
  norvig.com) — 333,333 rows of `word <TAB> count`. Downloaded it to `data/count_1w.txt`.
- Wrote `data/load_data.js`, which:
  1. Creates the database file `data/queries.db`.
  2. Creates one table, `queries(query, count, recent, updated_at)`.
  3. Reads through the file, splits each line into word + count, and inserts every row in
     **one transaction**.
- Ran it — all 333,333 rows loaded in about 3.4 seconds.

**Definitions**
- **Primary data store** — the source of truth. Mine is SQLite, one file.
- **Transaction** — a batch of writes that get committed together, all-or-nothing. Doing
  every insert inside one transaction is way faster than doing them one at a time, since
  SQLite only has to save to disk once at the end instead of 333,333 times.
- **PRIMARY KEY / index** — making `query` the primary key makes it unique *and*
  automatically indexed. That index is the reason I can later find "every word starting
  with `ip`" quickly instead of scanning the whole table.
- **PRAGMA** — a SQLite setting. I used `journal_mode=WAL` and `synchronous=OFF` just to
  speed the bulk load up.

**Why I went this way**
- *Why this dataset:* every row already comes with a real `count`, so I didn't have to
  invent popularity numbers myself. It's single words rather than full phrases, but that's
  fine — the assignment just asks for "keywords," and the typeahead mechanics don't care
  whether an entry is one word or three.
- *Why bother with a count column:* the basic ranking requirement is "sort by count," so I
  need a popularity number per query, and the published word frequency is exactly that.
- *The `recent` column* starts at 0 and only gets used later, in Step 5, for trending. I
  added it now so I wouldn't have to go back and alter the table shape afterward.

---

## Step 2 — Suggestions API + basic UI

**What I did**
- `server/db.js`: a `getSuggestions(prefix)` function that returns the top 10 words
  starting with a given prefix, most popular first. It trims and lowercases the input and
  handles empty/missing/no-match input gracefully — empty list back, never an error.
- `server/index.js`: a small Express server with:
  - `GET /suggest?q=<prefix>` → suggestions as JSON.
  - `GET /logs?n=<n>` → recent log lines (so the page can show them).
  - serves the `public/` folder as the actual site.
- `public/index.html`, `style.css`, `app.js`: the search page itself — search box, a
  dropdown that fills in as you type, loading/error/"no results" states, **arrow-key
  navigation**, and a live **logs panel**.
- Tested it: `/suggest?q=ip` comes back with 10 results in 1–4 ms; typing `IP` gives the
  same results as `ip`; empty or nonsense input returns an empty list instead of blowing
  up.

**Definitions**
- **Prefix search** — finding everything that *starts with* certain letters (e.g. "ip" →
  ipod, iphone…). I do this with a fast **range scan** on the indexed `query` column:
  `query >= 'ip' AND query < 'iq'`.
- **Endpoint / API route** — a URL the server responds to, like `GET /suggest`.
- **Debounce** — waiting a short pause (200 ms) after someone stops typing before calling
  the server, so it's not firing a request on every keystroke. Lives in `app.js`.
- **Static files** — plain HTML/CSS/JS files the server just hands to the browser as-is.

**Why I went this way**
- *Range scan instead of `LIKE 'ip%'`:* the range version is guaranteed to use the index,
  so it stays fast even with 333k rows in the table. (Confirmed: ~1–4 ms responses.)
- *Keeping all the DB code in `db.js`:* keeps SQL in one spot, with the web layer just
  calling functions — the kind of modular setup the rubric is looking for.
- *Debounce on the front end:* directly addresses the "don't make unnecessary backend
  calls" point.
- *Logs panel from the start:* makes the system's behavior visible for the demo and
  screenshots later.

---

## Step 3 — Search submission + query-count updates

**What I did**
- `server/db.js`: added `recordSearch(query)` — an **UPSERT** that inserts a new query at
  count 1, or, if it's already there, bumps its count by 1.
- `server/index.js`: added `POST /search`, which records the query and sends back the
  required dummy response `{"message":"Searched"}`.
- `public/app.js`: wired up the **Search button**, the **Enter key**, and **clicking a
  suggestion** to all trigger a search and show the response on the page.
- Tested it: searching a brand-new word created it at count 1, searching it again bumped
  it to 2, and submitting an empty query still returned `Searched` but didn't record
  anything.

**Definitions**
- **UPSERT** — short for "update or insert": one SQL statement that inserts a row, or
  updates it if it's already there. I used SQLite's
  `INSERT ... ON CONFLICT(query) DO UPDATE`.
- **POST** — the HTTP method for sending data *to* the server (here, the query someone
  searched), as opposed to GET, which just *fetches* data.
- **Request body** — the JSON sent along with a POST, e.g. `{ "query": "iphone" }`.

**Why I went this way**
- *Bumping by 1 per search:* simple and honest. Since the dataset's real counts are in the
  billions, one search barely moves the all-time ranking — which is actually the whole
  reason **trending/recency** (Step 5) matters: recent activity is what should visibly
  reorder suggestions in a demo, not the slow-moving all-time count.
- *Writing straight to the DB for now:* the simplest correct version to start with. In
  **Step 6** I swap this out for a **batch writer** so the database isn't getting hit on
  every single request.
- *Clicking a suggestion triggers a search:* matches how real search boxes behave, and
  covers the "search on Enter or button click" requirement too.

---

## Step 4 — Distributed cache + consistent hashing

**What I did**
- `server/cache.js`: connects to all **3 Redis nodes** (one client per node) and builds a
  **consistent-hashing ring** to decide which node should own which prefix.
- Wired a **cache-aside** flow into `GET /suggest`: check the owning Redis node first, and
  on a **miss**, read from SQLite and store the result back on that node with a 60-second
  **TTL**.
- Added `GET /cache/debug?prefix=` → tells you the owning node + whether it's a hit or
  miss.
- Made the cache **fail-safe**: if a Redis node happens to be down, reads/writes just fall
  back to SQLite quietly, so suggestions never actually break.
- **Proved it works:** routed 14 different prefixes, then checked which keys actually
  landed on each Redis container — the real placement matched what the ring predicted
  exactly (`ip`, `book`, `java`, `pizza` all landing on `redis-2`, for example). First
  `/suggest` call for a prefix is a MISS, second one's a HIT.

**Definitions**
- **Cache** — a small, fast store of recent answers so you don't redo expensive work.
- **Cache-aside** — the app checks the cache first, and on a miss, loads from the database
  and *then* fills the cache. The cache sits "aside" the database rather than in front of
  it automatically.
- **TTL (time to live)** — how long a cached entry sticks around before expiring on its
  own. Mine is 60s, set with Redis `SET key value EX 60`.
- **Distributed cache** — the cache is spread across multiple servers (my 3 Redis nodes)
  instead of one, so it can hold more and survive one node going down.
- **Consistent hashing** — a way to decide "which node owns this key" using a hash *ring*.
  Adding or removing a node only shuffles the keys in one arc of the ring, instead of
  reshuffling everything (which is what plain `hash % N` would do).
- **Virtual nodes** — placing each real node at many points (150) around the ring so keys
  spread out evenly instead of one node randomly ending up owning a huge chunk.
- **Hit / miss** — a *hit* means the answer was already sitting in the cache; a *miss*
  means it had to go to the database.

**Why I went this way**
- *Real Redis, not just an in-memory map:* the assignment specifically wants a
  *distributed* cache, and 3 actual Redis nodes make the routing genuinely mean something —
  plus `redis-cli` lets me actually *prove* a key lives where it's supposed to.
- *Consistent hashing over `% 3`:* `% 3` would scatter almost every key onto a different
  node the second I add or remove a server, basically wiping the cache. Consistent hashing
  only moves a small slice. **This router is code I wrote myself — it's the main thing
  worth explaining in the viva; Redis itself is just storage sitting behind it.**
- *Cache key = the prefix's result:* I cache the finished top-10 list because computing it
  (scanning + sorting) is the expensive part — caching the answer skips all of that work.
- *Graceful fallback:* treating a dead node as a miss means a Redis outage costs you some
  performance but never actually breaks the feature.

---

## Step 5 — Trending searches (recency-aware ranking)

**What I did**
- `server/trending.js`: keeps an **in-memory map** of each query's recent-activity score.
  Every `/search` adds +1 (`bump`). A timer **decays** all the scores (×0.5 every 30s) so
  spikes fade out. `rerank()` blends recency into the count-based candidate pool;
  `getTrending()` lists the queries with the most recent activity.
- `server/db.js`: added `getCandidates(prefix)` (top 50 by count — the pool that gets
  re-ranked) and `getCount(query)`.
- `server/index.js`: `/suggest` now caches the **candidate pool** and blends recency in
  **live**; `/search` calls `bump`; added `GET /trending`; the decay loop kicks off at
  boot.
- UI: a **Trending now** panel that updates as you search; clicking an item searches it.
- **Demonstrated it:** for the prefix `piz`, `pizzo` normally sits at #9 by count (78k) —
  after searching it 3 times it jumped to **#1**, ahead of `pizza` (14.7M). Meanwhile
  `pizza`'s recent score decayed from 5 down to 0.625, showing spikes don't stick around
  forever.

**The 5 things the assignment wants explained**
1. **How recent searches are tracked:** an in-memory `Map<query, score>`; every search adds
   +1.
2. **How recent activity affects ranking:** final `score = count + weight * recent`, where
   `weight` is the top candidate's count — so even one recent search is worth about one
   "most popular item" and visibly lifts the query.
3. **How over-ranking doesn't become permanent:** exponential **decay** (×0.5 every 30s) —
   once a query stops getting searched, its recent score shrinks toward 0 and it drops back
   down on its own.
4. **How the cache stays correct as rankings shift:** I deliberately **don't cache the
   final order** — only the stable, count-based candidate pool (60s TTL). Recency gets
   applied fresh on every request, so trending is always live. (When counts themselves
   change, the batch writer invalidates the affected prefix — that's Step 6.)
5. **Trade-offs (freshness vs. latency vs. complexity):** keeping recency in memory makes
   it instant and always fresh, and adds **zero** extra database writes — but it's tied to
   the process and resets if the server restarts, which is fine for a demo. Caching just
   the candidate pool keeps reads fast *and* rankings fresh, at the cost of a tiny re-rank
   on every request.

**Definitions**
- **Recency / trending** — favoring things searched *recently*, not just *often overall*.
- **Decay** — repeatedly shrinking recent scores so old activity fades out automatically.
- **Blended score** — one number combining all-time count and recent activity, used for
  sorting.

**Why I went this way**
- *In-memory recency instead of a DB column:* recency changes on every single search;
  writing that to disk each time would create the exact write pressure Step 6 is trying to
  get rid of.
- *Caching the candidate pool, not the final list:* gives me fast reads **and** always-live
  trending — the cleanest answer to "how does the cache stay updated when rankings change."
- *Weight = top candidate's count:* keeps recency meaningful on any dataset without
  hardcoding a magic number that would break if the data scale ever changed.

---

## Step 6 — Batch writes

**What I did**
- `server/batch.js`: `POST /search` now drops the query into an in-memory **buffer**
  (`Map<query, count>`, so repeats aggregate automatically). The buffer flushes whenever
  the **earliest** of three things happens: the **page reloads** (`POST /flush`), a
  **30s timeout** passes, or **200 distinct queries** pile up. A flush writes the
  aggregated counts to SQLite in **one transaction**, then **invalidates** the cache for
  every prefix that was affected.
- `server/db.js`: added `applyBatch(items)` — one transaction that adds each query's
  aggregated amount.
- `server/index.js`: `/search` now enqueues instead of writing directly; added `GET /stats`
  (the write-reduction proof); the flusher starts on boot; Ctrl+C **drains** the buffer
  before shutting down.
- **Proved it:** 60 searches across 3 words resulted in just **4 row-writes (93%
  reduction)**; one flush folded 29 searches down into 2 rows. Counts still came out
  right (`apple` went up by the correct amount), and the `app` cache entry got
  **invalidated** by the flush (hit → miss).

**Definitions**
- **Buffer / queue** — a temporary in-memory holding spot for work that hasn't happened
  yet — here, pending count updates.
- **Aggregation** — combining repeats before writing (5×"pizza" → one "+5"), so a single
  row-write covers a bunch of searches at once.
- **Flush** — taking everything sitting in the buffer and writing it all out at once.
- **Write reduction** — the whole point: way fewer database writes than there were
  searches.

**Failure trade-offs (the assignment specifically asks about this)**
- If the process **crashes** between flushes, whatever's still buffered gets **lost**, so
  some counts under-count slightly. I'm fine with that here — counts are popularity hints,
  not financial data, so a small loss doesn't really hurt suggestion quality.
- I shrink that risk window three ways: a flush on **page reload**, a **30s timeout**, and
  a **graceful shutdown** that flushes on Ctrl+C. For real durability you'd want an
  append-only log written first and replayed on restart — that's a reasonable future
  improvement, just left out on purpose to keep this simple.
- **Latency vs. freshness vs. safety:** buffering makes `/search` return instantly (no disk
  wait), and eases write pressure, at the cost of suggestions lagging real counts by up to
  one flush interval. Cache invalidation on flush keeps that lag bounded and predictable.

**Why I went this way**
- *Map as the buffer:* aggregates repeats for free and keeps memory use bounded to
  "distinct queries since the last flush."
- *Flushing on reload **and** on a timer **and** on size:* reload is a natural checkpoint
  (you see fresh data right after refreshing); the 30s timeout keeps things fresh under
  light load; the size cap protects memory if there's a sudden spike. A longer timeout
  also means cached suggestion pools stick around longer between flushes, which makes
  cache HITs easy to spot in a live demo.
- *Invalidating prefixes on flush:* that's the exact moment counts actually change, so
  it's exactly when the cached pools should get dropped — ties the batch writer and cache
  freshness together cleanly.

---

## Step 7 — Performance benchmark + documentation

**What I did**
- `bench/measure.js`: a script that hammers the running server with 200 searches and
  3,000 suggestion requests and reports **p95 latency**, **cache hit rate**, and **DB
  read/write counts**.
- Filled in the README's performance report, design-choices table, and API examples, and
  finished up this PROCESS document.

**The measured result (full 333,333-row dataset):**
- Suggest latency: mean 4.5 ms, **p95 6.3 ms**.
- **Cache hit rate 99.0%** (2,970 hits / 30 misses). The 30 misses line up exactly with
  the 30 distinct prefixes used — one cold miss each, every repeat after that a hit.
- **Batch write reduction 96%** (200 searches → 8 row-writes).

**Definitions**
- **Latency** — how long a single request takes, start to finish.
- **p95 (95th percentile)** — 95% of requests were *at least this fast*; a more honest
  "typical worst case" than an average, which a few slow outliers can skew.
- **Hit rate** — the share of suggestion requests answered from cache instead of the
  database.

**Why I went this way**
- *Benchmark reuses prefixes:* so the cache actually warms up and the hit rate reflects
  real usage — popular prefixes getting asked repeatedly, like in real life.
- *Reporting p95 instead of just the average:* the assignment asks for it specifically,
  and it's a more honest measure of what users actually feel.

---

## Quick map: where each requirement lives (for the viva)

| Requirement | File(s) | One-line summary |
|---|---|---|
| Suggestions (top 10 by count, prefix, case-insensitive) | `server/db.js`, `public/app.js` | indexed range scan + debounced UI |
| Search API returns `{"message":"Searched"}` | `server/index.js` (`POST /search`) | records the query, returns the dummy message |
| Query-count updates | `server/db.js`, `server/batch.js` | UPSERT, applied via the batch writer |
| Distributed cache + consistent hashing | `server/cache.js` | 3 Redis nodes + my own hash ring (`GET /cache/debug`) |
| Trending (recency + decay) | `server/trending.js` | in-memory score, blended into ranking, decays |
| Batch writes | `server/batch.js` | buffer → aggregate → one transaction → invalidate |
| Performance report | `bench/measure.js` | p95 latency, hit rate, write reduction |

---