// load_data.js
// -----------------------------------------------------------------------------
// STEP 1: Load the dataset into our primary data store (SQLite).
//
// WHAT THIS DOES (in plain words):
//   1. Opens (creates) a SQLite database file at data/queries.db.
//   2. Creates one table called `queries` to hold every word and how popular it is.
//   3. Reads the dataset file (data/count_1w.txt) line by line.
//   4. Inserts all ~333,333 rows in ONE transaction (fast + safe).
//
// THE DATASET:
//   We use the "English Word Frequency" list (Google Web Trillion Word Corpus),
//   downloaded from https://norvig.com/ngrams/count_1w.txt
//   Each line looks like:   word <TAB> count        e.g.   "the    23135851162"
//   It ALREADY has a count for every word, so we don't have to invent or derive
//   one. That is exactly the `query | count` shape the assignment asks for.
//
// WHY SQLite:
//   It's a real SQL database that lives in a single file. No server to install,
//   no passwords, no setup. Perfect for a "primary data store" in a small project.
//
// HOW TO RUN:
//   node data/load_data.js
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// --- File locations -----------------------------------------------------------
const DATA_DIR = __dirname; // the data/ folder (this file lives in it)
const SOURCE_FILE = path.join(DATA_DIR, 'count_1w.txt'); // the raw dataset
const DB_FILE = path.join(DATA_DIR, 'queries.db'); // the database we build

// --- Safety check: is the dataset actually here? ------------------------------
if (!fs.existsSync(SOURCE_FILE)) {
  console.error('ERROR: dataset not found at', SOURCE_FILE);
  console.error('Download it first (see README), e.g.:');
  console.error('  curl -L -o data/count_1w.txt https://norvig.com/ngrams/count_1w.txt');
  process.exit(1);
}

console.log('Loading dataset from:', SOURCE_FILE);
const startedAt = Date.now();

// --- Open the database --------------------------------------------------------
// Start fresh each run so re-loading is predictable (delete an old db if present).
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
const db = new Database(DB_FILE);

// PRAGMAs = settings that make bulk loading much faster.
//   journal_mode=WAL  -> better read/write concurrency for the running server.
//   synchronous=OFF   -> skip waiting for the disk on every write (fine for a
//                        one-off bulk load; we trade a little crash-safety for speed).
db.pragma('journal_mode = WAL');
db.pragma('synchronous = OFF');

// --- Create the table ---------------------------------------------------------
// Columns:
//   query      -> the word/search text (the PRIMARY KEY, so it is unique + indexed).
//   count      -> all-time popularity (used for the basic "sort by count" ranking).
//   recent     -> recent-activity score for trending (Step 5). Starts at 0.
//   updated_at -> last time this row changed (millis). Handy for debugging/trending.
//
// Because `query` is the PRIMARY KEY, SQLite automatically builds an index on it.
// That index is what makes prefix search ("words starting with 'ip'") fast.
db.exec(`
  CREATE TABLE queries (
    query      TEXT PRIMARY KEY,
    count      INTEGER NOT NULL,
    recent     REAL    NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`);

// --- Prepare the insert statement (compiled once, reused for every row) --------
// ON CONFLICT(query) DO UPDATE ... means: if the same word appears twice, we ADD
// the counts together instead of crashing. That is the "aggregate duplicates"
// behaviour the assignment mentions. (This dataset has no duplicates, but this
// keeps us correct if a dataset ever does.)
const insert = db.prepare(`
  INSERT INTO queries (query, count, updated_at)
  VALUES (@query, @count, @updated_at)
  ON CONFLICT(query) DO UPDATE SET count = count + excluded.count
`);

// Wrapping many inserts in ONE transaction is the single biggest speed win:
// SQLite commits once at the end instead of once per row.
const insertMany = db.transaction((rows) => {
  for (const row of rows) insert.run(row);
});

// --- Read + parse the file ----------------------------------------------------
// The file is ~5 MB, small enough to read fully into memory in one go.
const text = fs.readFileSync(SOURCE_FILE, 'utf8');
const lines = text.split('\n');

const now = Date.now();
const rows = [];
let skipped = 0;

for (const line of lines) {
  if (!line) continue; // skip blank lines (e.g. the trailing newline)

  // Each line is "word<TAB>count". Split on the tab character.
  const tab = line.indexOf('\t');
  if (tab === -1) {
    skipped++;
    continue;
  }

  const word = line.slice(0, tab).trim().toLowerCase(); // store lowercase
  const count = parseInt(line.slice(tab + 1).trim(), 10);

  // Skip rows that are empty or have a non-numeric / negative count.
  if (!word || !Number.isFinite(count) || count < 0) {
    skipped++;
    continue;
  }

  rows.push({ query: word, count, updated_at: now });
}

console.log(`Parsed ${rows.length} rows (skipped ${skipped}). Inserting...`);

// --- Insert everything --------------------------------------------------------
insertMany(rows);

// --- Report -------------------------------------------------------------------
const total = db.prepare('SELECT COUNT(*) AS n FROM queries').get().n;
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Done. ${total} rows in the database (took ${seconds}s).`);
console.log('Database file:', DB_FILE);

// A tiny sanity peek so you can SEE it worked: top 5 words by count.
const sample = db.prepare('SELECT query, count FROM queries ORDER BY count DESC LIMIT 5').all();
console.log('Top 5 by count:', sample.map((r) => `${r.query}(${r.count})`).join(', '));

db.close();
