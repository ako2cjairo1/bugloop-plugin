'use strict';

// Every write the dashboard makes goes through bugloop.sh -- the engine is
// the single source of truth for ledger-mutation logic. This file never
// writes a ledger field directly; it only shells out.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveEngine() {
  // Prefer the dashboard's own sibling engine FIRST, not the .engine_root
  // pointer. That pointer is written by a SessionStart hook tied to
  // whatever Claude Code session happens to be running, and can legitimately
  // lag behind a plugin update within that session (this bit the CLI
  // itself more than once during development). The dashboard and its
  // sibling skills/ directory, by contrast, always ship together as one
  // commit -- installed, updated, and versioned atomically as a pair -- so
  // the sibling path is guaranteed to be the exact matching engine, not a
  // possibly-stale pointer to a different install.
  const sibling = path.join(__dirname, '..', '..', 'skills', 'bugloop', 'scripts', 'bugloop.sh');
  if (fs.existsSync(sibling)) return sibling;

  const pointerFile = path.join(os.homedir(), '.claude', 'bugloop', '.engine_root');
  if (fs.existsSync(pointerFile)) {
    const root = fs.readFileSync(pointerFile, 'utf8').trim();
    const candidate = path.join(root, 'skills', 'bugloop', 'scripts', 'bugloop.sh');
    if (root && fs.existsSync(candidate)) return candidate;
  }

  const manualInstall = path.join(os.homedir(), '.claude', 'skills', 'bugloop', 'scripts', 'bugloop.sh');
  if (fs.existsSync(manualInstall)) return manualInstall;

  return null;
}

// Runs `bugloop.sh --ledger <ledgerPath> <...args>`, targeting a specific
// ledger directly without touching active.json for that project.
function runBugloop(ledgerPath, args) {
  return new Promise((resolve, reject) => {
    const engine = resolveEngine();
    if (!engine) {
      reject(new Error('bugloop.sh not found (checked .engine_root pointer, manual install, and sibling path)'));
      return;
    }
    const fullArgs = [engine, '--ledger', ledgerPath, ...args];
    execFile('bash', fullArgs, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || '').trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

module.exports = { runBugloop, resolveEngine };
