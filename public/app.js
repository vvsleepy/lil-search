// app.js — the browser-side logic for the typeahead UI.
// -----------------------------------------------------------------------------
// Responsibilities:
//   - Watch the search box and ask the server for suggestions as you type
//     (but DEBOUNCED, so we don't fire a request on every single keystroke).
//   - Show loading / error / "no results" states.
//   - Let you move through suggestions with the Up/Down arrow keys and pick one.
//   - Poll the server logs and show them in the logs panel.
// (Search submission is wired up in Step 3; trending in Step 5.)
// -----------------------------------------------------------------------------

// Grab the page elements once.
const input = document.getElementById('search-input');
const button = document.getElementById('search-button');
const list = document.getElementById('suggestions');
const statusEl = document.getElementById('status');
const logsEl = document.getElementById('logs');
const responseEl = document.getElementById('response');
const trendingEl = document.getElementById('trending');
const lookupInfo = document.getElementById('lookup-info');
const lookupText = document.getElementById('lookup-text');

// The suggestions currently shown, and which one is highlighted (-1 = none).
let current = [];
let activeIndex = -1;

// A token so that if responses come back out of order, we only use the newest.
let latestRequest = 0;

// --- Debounce helper ----------------------------------------------------------
// Returns a wrapped function that only runs AFTER the user stops calling it for
// `wait` milliseconds. This is how we "avoid unnecessary backend calls".
function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

// --- Fetch suggestions from the server ---------------------------------------
async function fetchSuggestions(q) {
  // Empty box -> clear everything, no request needed.
  if (!q.trim()) {
    hideSuggestions();
    setStatus('');
    lookupInfo.hidden = true;
    return;
  }

  const myRequest = ++latestRequest;
  setStatus('Searching…');

  try {
    const t0 = performance.now();
    const res = await fetch('/suggest?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const data = await res.json();
    const ms = performance.now() - t0;

    // If a newer keystroke already fired, ignore this (stale) response.
    if (myRequest !== latestRequest) return;

    render(data.suggestions);
    showLookup(data, ms);
  } catch (err) {
    if (myRequest !== latestRequest) return;
    hideSuggestions();
    lookupInfo.hidden = true;
    setStatus('Something went wrong: ' + err.message, true);
  }
}

// Show a friendly "what just happened" line so you can SEE the cache working.
function showLookup(data, ms) {
  if (!data || !data.node || data.cache === 'SKIP') {
    lookupInfo.hidden = true;
    return;
  }
  const hit = data.cache === 'HIT';
  lookupInfo.hidden = false;
  lookupInfo.classList.toggle('hit', hit);
  lookupInfo.classList.toggle('miss', !hit);
  lookupText.innerHTML = hit
    ? `Cache <strong>HIT</strong> — answered from Redis node <code>${data.node}</code> in ${ms.toFixed(0)} ms (no database needed)`
    : `Cache <strong>MISS</strong> — read from the database, then cached on Redis node <code>${data.node}</code> (${ms.toFixed(0)} ms)`;
}

// Run fetchSuggestions at most once per ~200ms of typing.
const debouncedFetch = debounce((q) => fetchSuggestions(q), 200);

// --- Rendering ----------------------------------------------------------------
function render(suggestions) {
  current = suggestions || [];
  activeIndex = -1;

  if (current.length === 0) {
    hideSuggestions();
    setStatus('No matching searches.');
    return;
  }

  setStatus('');
  list.innerHTML = '';

  current.forEach((item, i) => {
    const li = document.createElement('li');
    li.dataset.index = i;

    const term = document.createElement('span');
    term.className = 'term';
    term.textContent = item.query;

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = Number(item.count).toLocaleString();

    li.appendChild(term);
    li.appendChild(count);

    // Click a suggestion to pick it.
    li.addEventListener('click', () => choose(i));

    list.appendChild(li);
  });

  list.hidden = false;
}

function hideSuggestions() {
  list.hidden = true;
  list.innerHTML = '';
  current = [];
  activeIndex = -1;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// Visually highlight the row at activeIndex (for keyboard navigation).
function updateActive() {
  [...list.children].forEach((li, i) => {
    li.classList.toggle('active', i === activeIndex);
  });
}

// Pick a suggestion: put it in the box, close the dropdown, and search it.
function choose(i) {
  if (i < 0 || i >= current.length) return;
  input.value = current[i].query;
  hideSuggestions();
  submitSearch();
}

// --- Submit a search (POST /search) ------------------------------------------
async function submitSearch() {
  const q = input.value.trim();
  if (!q) return;

  hideSuggestions();

  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    // Show the dummy response the backend returns.
    showResponse(`${data.message} — "${q}"`);
    refreshTrending(); // reflect the new activity right away
  } catch (err) {
    showResponse('Search failed: ' + err.message, true);
  }
}

function showResponse(text, isError = false) {
  responseEl.textContent = text;
  responseEl.hidden = false;
  responseEl.style.background = isError ? '#fef2f2' : '#ecfdf5';
  responseEl.style.borderColor = isError ? '#fecaca' : '#a7f3d0';
}

// --- Events -------------------------------------------------------------------
input.addEventListener('input', () => debouncedFetch(input.value));

input.addEventListener('keydown', (e) => {
  // Only the arrow keys / enter / escape need special handling.
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (current.length === 0) return;
    activeIndex = Math.min(activeIndex + 1, current.length - 1);
    updateActive();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (current.length === 0) return;
    activeIndex = Math.max(activeIndex - 1, 0);
    updateActive();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // If a suggestion is highlighted, pick + search it; otherwise search what's typed.
    if (activeIndex >= 0) {
      choose(activeIndex);
    } else {
      submitSearch();
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

// Close the dropdown if you click anywhere outside the search area.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-area')) hideSuggestions();
});

// The search button submits whatever is in the box.
button.addEventListener('click', () => submitSearch());

// --- Trending panel -----------------------------------------------------------
async function refreshTrending() {
  try {
    const res = await fetch('/trending?n=10');
    const data = await res.json();
    const items = data.trending || [];

    if (items.length === 0) {
      trendingEl.innerHTML =
        '<li class="trending-empty">No recent searches yet — try searching a few times.</li>';
      return;
    }

    trendingEl.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'trending-item';

      const term = document.createElement('span');
      term.className = 'term';
      term.textContent = item.query;

      const score = document.createElement('span');
      score.className = 'count';
      score.textContent = 'recent ' + item.recent;

      li.appendChild(term);
      li.appendChild(score);

      // Click a trending item to search it.
      li.addEventListener('click', () => {
        input.value = item.query;
        submitSearch();
      });

      trendingEl.appendChild(li);
    });
  } catch {
    // Ignore trending fetch errors.
  }
}

// --- Live logs panel ----------------------------------------------------------
async function refreshLogs() {
  try {
    const res = await fetch('/logs?n=50');
    const data = await res.json();
    logsEl.textContent = data.lines.length
      ? data.lines.join('\n')
      : '(no activity yet)';
    // Auto-scroll to the newest line.
    logsEl.scrollTop = logsEl.scrollHeight;
  } catch {
    // Ignore log-fetch errors; they're not important to the user.
  }
}

setInterval(refreshLogs, 1500);
refreshLogs();

// Refresh trending periodically too (so decay is visible over time).
setInterval(refreshTrending, 3000);
refreshTrending();

// On page load, flush any searches buffered before the reload. This is one of the
// batch-write triggers ("flush on reload, or after a timeout, whichever first").
fetch('/flush', { method: 'POST' }).catch(() => {});
