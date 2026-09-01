'use strict';

// BugLoop Dashboard -- read-mostly monitor + decide UI.
// Never writes code, never runs tests, never drives the agent loop.
// Every mutation shells out to bugloop.sh (see lib/bugloop-cli.js); this
// server never writes a ledger field directly.

const fs = require('fs');
const path = require('path');
const express = require('express');
const chokidar = require('chokidar');

const { parseLedger } = require('./lib/ledger-parser');
const { BUGLOOP_ROOT, listLedgerPaths, activeLedgerFor } = require('./lib/ledger-scanner');
const { runBugloop } = require('./lib/bugloop-cli');

const PORT = parseInt(process.env.BUGLOOP_DASHBOARD_PORT || process.argv[2] || '4577', 10);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- id <-> path mapping -----------------------------------------------
// id is the ledger path relative to BUGLOOP_ROOT, URL-encoded as a single
// path segment. Unique by construction (real filesystem paths), no
// separate index/registry to keep in sync.
function idForPath(ledgerPath) {
  return encodeURIComponent(path.relative(BUGLOOP_ROOT, ledgerPath));
}
function pathForId(id) {
  let rel;
  try {
    rel = decodeURIComponent(id);
  } catch (e) {
    return null; // malformed percent-encoding -- treat as an invalid id, not a 500
  }
  const resolved = path.resolve(BUGLOOP_ROOT, rel);
  // Refuse anything that escapes BUGLOOP_ROOT (defense in depth against a
  // crafted id -- every real id is produced by idForPath above and can't
  // do this, but never trust a client-supplied path segment blindly).
  if (!resolved.startsWith(path.resolve(BUGLOOP_ROOT) + path.sep)) return null;
  return resolved;
}

// --- summarizing a parsed ledger for the list view ----------------------
function summarize(ledgerPath) {
  let stat;
  try {
    stat = fs.statSync(ledgerPath);
  } catch (e) {
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch (e) {
    return null;
  }
  const parsed = parseLedger(text);
  const f = parsed.fields;
  const project = path.basename(path.dirname(ledgerPath));
  const active = activeLedgerFor(ledgerPath) === ledgerPath;
  return {
    id: idForPath(ledgerPath),
    title: parsed.title || '(untitled)',
    project,
    state: f.state || 'UNKNOWN',
    createdAt: f.created_at || null,
    engineVersion: f.engine_version || null,
    pendingQuestion: f['pending.question'] || '',
    pendingAnswer: f['pending.answer'] || '',
    isActive: active,
    mtimeMs: stat.mtimeMs,
  };
}

function detail(ledgerPath) {
  let stat;
  try {
    stat = fs.statSync(ledgerPath);
  } catch (e) {
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch (e) {
    return null;
  }
  const parsed = parseLedger(text);
  const project = path.basename(path.dirname(ledgerPath));
  const active = activeLedgerFor(ledgerPath) === ledgerPath;
  return {
    id: idForPath(ledgerPath),
    path: ledgerPath,
    title: parsed.title || '(untitled)',
    project,
    isActive: active,
    mtimeMs: stat.mtimeMs,
    fields: parsed.fields,
    hypotheses: parsed.hypotheses,
    receipts: parsed.receipts,
  };
}

// --- REST API -------------------------------------------------------------

app.get('/api/bugs', (req, res) => {
  const summaries = listLedgerPaths()
    .map(summarize)
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ root: BUGLOOP_ROOT, bugs: summaries });
});

app.get('/api/bugs/:id', (req, res) => {
  const p = pathForId(req.params.id);
  if (!p) return res.status(400).json({ error: 'invalid id' });
  const d = detail(p);
  if (!d) return res.status(404).json({ error: 'ledger not found' });
  res.json(d);
});

// Records an answer to the ledger's pending question WITHOUT interpreting
// or acting on it -- the terminal-side orchestrator does that on its next
// resume. See bugloop.sh's `pending answer` for why this split exists.
//
// Concurrency safety: the client sends back the mtimeMs it loaded the
// ledger at; if the file has changed since, refuse rather than silently
// racing a concurrent writer (a terminal session driving the same bug).
app.post('/api/bugs/:id/answer', async (req, res) => {
  const p = pathForId(req.params.id);
  if (!p) return res.status(400).json({ error: 'invalid id' });

  const { answer, expectedMtimeMs } = req.body || {};
  if (typeof answer !== 'string' || answer.trim() === '') {
    return res.status(400).json({ error: 'answer text required' });
  }

  let stat;
  try {
    stat = fs.statSync(p);
  } catch (e) {
    return res.status(404).json({ error: 'ledger not found' });
  }
  if (typeof expectedMtimeMs === 'number' && Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) {
    return res.status(409).json({
      error: 'This ledger changed since you opened it — refresh and try again.',
      currentMtimeMs: stat.mtimeMs,
    });
  }

  try {
    await runBugloop(p, ['pending', 'answer', answer]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true });
});

// --- Live updates: SSE, backed by a chokidar watch on the ledger tree ---
const sseClients = new Set();

function broadcast(eventName, payload) {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(data);
  }
}

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function onLedgerChange(changedPath) {
  const base = path.basename(changedPath);
  // .md ledgers (add/change/delete) and active.json (rewritten by
  // `bugloop.sh switch`, which touches no .md file) both need to reach the
  // frontend -- it ignores the specific id in the payload and just
  // refetches whatever's on screen, so one event shape covers both.
  if (!changedPath.endsWith('.md') && base !== 'active.json') return;
  broadcast('ledger-changed', { id: changedPath.endsWith('.md') ? idForPath(changedPath) : null });
}

if (fs.existsSync(BUGLOOP_ROOT)) {
  chokidar
    .watch(BUGLOOP_ROOT, {
      ignoreInitial: true,
      depth: 2,
      // Debounces rapid repeat writes to the SAME file (bugloop.sh's
      // atomic writes are mv-based, so this mostly guards against a burst
      // of several `set` calls in quick succession) at the watcher level,
      // per-path -- not a hand-rolled global flag, which would drop
      // legitimate changes to OTHER files arriving in the same window.
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    .on('add', onLedgerChange)
    .on('change', onLedgerChange)
    .on('unlink', onLedgerChange);
}

// Global error handler -- catches anything unhandled, including a
// malformed percent-encoded URL segment, which throws INSIDE Express's own
// router while matching :id (before any route handler runs, so the
// try/catch in pathForId above never sees it). Without this, Express's
// default handler returns a generic HTML stack-trace page instead of the
// JSON errors every real route in this file returns.
app.use((err, req, res, next) => {
  res.status(400).json({ error: 'Bad request' });
});

// Bind to loopback ONLY. This serves every ledger across every project
// (repro output, file paths, hypotheses) and an unauthenticated write
// endpoint -- app.listen(PORT) with no host binds all interfaces
// (0.0.0.0/::), which would expose both to anyone on the same network.
// There is no auth layer here; loopback-only is the entire security model.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`bugloop dashboard: http://localhost:${PORT}`);
  console.log(`watching: ${BUGLOOP_ROOT}`);
});
