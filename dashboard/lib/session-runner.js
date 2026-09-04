'use strict';

// Spawns and tracks headless `claude -p` runs for the dashboard's "New Bug"
// / "Continue" feature.
//
// Why -p and not `claude --bg` (Claude Code's own background-agent system,
// with claude agents/logs/stop/rm as free lifecycle tooling): tested both
// for real. --bg can leave a session genuinely stuck -- blocked on a real
// interactive dialog with nothing recorded anywhere -- if the agent skips
// "record the pending question before asking" even once, since --bg keeps
// that dialog live for a later `claude attach`. -p cannot get stuck that
// way: it doesn't expose a real blocking prompt, so a question either gets
// durably recorded (the documented, common path) or narrated in the final
// text output -- either way the process exits, and this file's own hard
// timeout is a real backstop, not the only thing standing between "spawned"
// and "stuck forever."
//
// Consequence: this file owns real process lifecycle (pid, output capture,
// timeout) instead of being a thin wrapper. The tracker below is in-memory
// and does not survive a dashboard restart -- a real, stated limitation.
// It only affects the live-output/is-it-running convenience view; actual
// bugloop progress is safe on disk regardless, because the ledger -- not
// this tracker -- is the source of truth.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUGLOOP_ROOT = process.env.BUGLOOP_ROOT || path.join(os.homedir(), '.claude', 'bugloop');
const ALLOWLIST_FILE = path.join(BUGLOOP_ROOT, 'dashboard-projects.txt');
const BUG_MD_PATH = path.join(__dirname, '..', '..', 'commands', 'bug.md');

const MAX_CONCURRENT = parseInt(process.env.BUGLOOP_DASHBOARD_MAX_CONCURRENT || '3', 10);
const DEFAULT_BUDGET_USD = parseFloat(process.env.BUGLOOP_DASHBOARD_DEFAULT_BUDGET || '5');
const DEFAULT_TIMEOUT_MS = parseInt(process.env.BUGLOOP_DASHBOARD_TIMEOUT_MS || String(20 * 60 * 1000), 10);
const OUTPUT_CAP_BYTES = 200 * 1024;
const KEEP_COMPLETED_MS = 60 * 60 * 1000; // prune finished runs after an hour

const runs = new Map(); // id -> run record

// --- allowlist (read-only from here; only bugloop.sh dashboard-allow writes it) ---
function listAllowedProjects() {
  let text;
  try {
    text = fs.readFileSync(ALLOWLIST_FILE, 'utf8');
  } catch (e) {
    return [];
  }
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch (e) {
        return false;
      }
    });
}

function isAllowed(projectDir) {
  // Always re-read fresh -- never trust a cached list or a client-supplied
  // path on faith. Compare resolved absolute paths.
  const resolved = path.resolve(projectDir);
  return listAllowedProjects().some((p) => path.resolve(p) === resolved);
}

// --- prompt construction ---
// Slash commands (including this plugin's own /bug) don't resolve when
// Claude Code is invoked headlessly (-p or --bg) -- confirmed directly,
// not assumed: both gave "Unknown command: /bug-status" regardless of
// --plugin-dir/--setting-sources. The fix is to inline the command file's
// actual instructions as the prompt text instead of the slash-command
// shorthand -- verified end-to-end against a real ledger.
let cachedBugMdBody = null;
function buildPrompt(description) {
  if (cachedBugMdBody === null) {
    const raw = fs.readFileSync(BUG_MD_PATH, 'utf8');
    // Strip the --- frontmatter --- block.
    cachedBugMdBody = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  }
  const args = description && description.trim()
    ? description.trim()
    : 'Resume the open bugloop ledger for this project at its current state. If none is open, there is nothing to do -- say so and stop.';
  return cachedBugMdBody.replace(/\$ARGUMENTS/g, args);
}

// --- run tracking ---
function pruneOldRuns() {
  const now = Date.now();
  for (const [id, r] of runs) {
    // r.endedAt is only set once the child's real 'exit' event fires. A
    // 'timed-out' record has status !== 'running' the instant SIGTERM is
    // sent, but the process (and its concurrency slot) may still be alive
    // for the grace period -- endedAt stays null until it actually exits.
    // `now - null` coerces to `now`, always > KEEP_COMPLETED_MS, which was
    // deleting still-alive timed-out runs from the tracker on the very
    // next prune. Require a real endedAt before a record is eligible.
    if (r.status !== 'running' && r.endedAt !== null && now - r.endedAt > KEEP_COMPLETED_MS) {
      runs.delete(id);
    }
  }
}

function countRunning() {
  let n = 0;
  for (const r of runs.values()) if (r.status === 'running') n++;
  return n;
}

function appendOutput(record, chunk) {
  record.outputBuffer += chunk;
  if (record.outputBuffer.length > OUTPUT_CAP_BYTES) {
    record.outputBuffer = record.outputBuffer.slice(record.outputBuffer.length - OUTPUT_CAP_BYTES);
  }
}

function hasGitRepo(dir) {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory() || fs.statSync(path.join(dir, '.git')).isFile();
    // .git is a file (gitdir: ...) inside a worktree/submodule -- either counts.
  } catch (e) {
    return false;
  }
}

// onChange(record) is called on every status transition, for the caller to
// broadcast over SSE.
function spawnBugRun({ projectDir, description, maxBudgetUsd }, onChange) {
  pruneOldRuns();

  if (!isAllowed(projectDir)) {
    const err = new Error('This project is not on the dashboard allowlist. Run: bugloop.sh dashboard-allow <path>');
    err.code = 'NOT_ALLOWED';
    throw err;
  }
  if (countRunning() >= MAX_CONCURRENT) {
    const err = new Error(`Already ${MAX_CONCURRENT} bugs running -- wait for one to finish, or raise BUGLOOP_DASHBOARD_MAX_CONCURRENT.`);
    err.code = 'CONCURRENCY_LIMIT';
    throw err;
  }

  const cap = Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0 ? maxBudgetUsd : DEFAULT_BUDGET_USD;
  const prompt = buildPrompt(description);
  const useWorktree = hasGitRepo(projectDir);

  const args = [
    '-p', prompt,
    '--permission-mode', 'auto',
    '--max-budget-usd', String(cap),
  ];
  if (useWorktree) args.push('-w');

  const id = crypto.randomBytes(6).toString('hex');
  const child = spawn('claude', args, { cwd: projectDir });

  const record = {
    id,
    pid: child.pid,
    child,
    projectDir,
    description: description || '(continue)',
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    usedWorktree: useWorktree,
    outputBuffer: '',
  };
  runs.set(id, record);

  const timer = setTimeout(() => {
    if (record.status !== 'running') return;
    record.status = 'timed-out';
    appendOutput(record, `\n[bugloop dashboard] timed out after ${DEFAULT_TIMEOUT_MS}ms, sending SIGTERM\n`);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (record.status === 'timed-out' && record.exitCode === null) {
        appendOutput(record, '[bugloop dashboard] still alive after grace period, sending SIGKILL\n');
        child.kill('SIGKILL');
      }
    }, 10000);
    if (onChange) onChange(record);
  }, DEFAULT_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => appendOutput(record, chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => appendOutput(record, chunk.toString('utf8')));

  child.on('error', (err) => {
    clearTimeout(timer);
    record.status = 'failed';
    record.endedAt = Date.now();
    appendOutput(record, `\n[bugloop dashboard] failed to start: ${err.message}\n`);
    if (onChange) onChange(record);
  });

  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    record.exitCode = code;
    record.endedAt = Date.now();
    if (record.status === 'timed-out') {
      // already marked; leave as-is
    } else if (signal) {
      record.status = 'stopped';
    } else if (code === 0) {
      record.status = 'completed';
    } else {
      record.status = 'failed';
    }
    if (onChange) onChange(record);
  });

  return record;
}

function listRuns() {
  pruneOldRuns();
  return Array.from(runs.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((r) => ({
      id: r.id,
      pid: r.pid,
      projectDir: r.projectDir,
      description: r.description,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      status: r.status,
      exitCode: r.exitCode,
      usedWorktree: r.usedWorktree,
    }));
}

function getRunOutput(id) {
  const r = runs.get(id);
  if (!r) return null;
  return { id: r.id, status: r.status, output: r.outputBuffer };
}

function stopRun(id) {
  const r = runs.get(id);
  if (!r) return false;
  if (r.status !== 'running') return false;
  r.child.kill('SIGTERM');
  return true;
}

module.exports = {
  listAllowedProjects,
  isAllowed,
  buildPrompt,
  spawnBugRun,
  listRuns,
  getRunOutput,
  stopRun,
  MAX_CONCURRENT,
  DEFAULT_BUDGET_USD,
};
