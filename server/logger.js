// logger.js
// -----------------------------------------------------------------------------
// One tiny logging helper used by the whole app.
//
// WHY we have this: the assignment asks us to *show* how the system behaves
// (cache hits/misses, consistent-hashing routing, batch flushes). Printing those
// events to a log is the evidence. We log to TWO places:
//   1. the console (so you see it live in the terminal), and
//   2. a file at logs/app.log (so you can attach it to your submission).
//
// We also keep the last N lines in memory (`recent`) so the web UI can ask for
// them via GET /logs and show a live "logs panel" in screenshots.
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// Make sure the logs/ folder exists before we try to write into it.
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

// A small in-memory list of the most recent log lines (newest last).
// We cap it so memory never grows forever.
const recent = [];
const MAX_RECENT = 200;

/**
 * Write one log line.
 * @param {string} event   - a short category, e.g. "SUGGEST", "SEARCH", "BATCH".
 * @param {object} details - any extra data to record, e.g. { prefix: "ip", hit: true }.
 */
function log(event, details = {}) {
  // Build a human-readable timestamp like 2026-06-21T10:00:00.000Z
  const time = new Date().toISOString();

  // Turn the details object into "key=value" pieces for an easy-to-read line.
  const parts = Object.entries(details).map(([k, v]) => `${k}=${v}`);
  const line = `${time} [${event}] ${parts.join(' ')}`.trim();

  // 1) Print to the console.
  console.log(line);

  // 2) Append to the log file (one line at a time).
  fs.appendFile(LOG_FILE, line + '\n', () => {});

  // 3) Remember it for the UI log panel.
  recent.push(line);
  if (recent.length > MAX_RECENT) recent.shift(); // drop the oldest
}

/**
 * Return the most recent log lines (used by GET /logs).
 * @param {number} n - how many lines to return.
 */
function getRecent(n = 50) {
  return recent.slice(-n);
}

module.exports = { log, getRecent, LOG_FILE };
