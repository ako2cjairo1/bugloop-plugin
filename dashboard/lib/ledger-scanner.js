'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const BUGLOOP_ROOT = process.env.BUGLOOP_ROOT || path.join(os.homedir(), '.claude', 'bugloop');

// All ledger .md files across every project directory. Mirrors what
// `bugloop.sh list` enumerates (any *.md under a project subdir) --
// baseline files are named `<ledger>.baseline.txt` (see bugloop.sh's
// per-ledger baseline fix) so a plain .md filter already excludes them,
// no special-casing needed.
function listLedgerPaths() {
  const results = [];
  if (!fs.existsSync(BUGLOOP_ROOT)) return results;
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(BUGLOOP_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(BUGLOOP_ROOT, d.name));
  } catch (e) {
    return results;
  }
  for (const dir of projectDirs) {
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.md'));
    } catch (e) {
      continue;
    }
    for (const f of files) {
      results.push(path.join(dir, f.name));
    }
  }
  return results;
}

// Which ledger (if any) is "active" for the project directory a given
// ledger lives in -- read-only mirror of bugloop.sh's active_ledger_path().
function activeLedgerFor(ledgerPath) {
  const dir = path.dirname(ledgerPath);
  const activeFile = path.join(dir, 'active.json');
  if (!fs.existsSync(activeFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
    return data.ledger || null;
  } catch (e) {
    return null;
  }
}

module.exports = { BUGLOOP_ROOT, listLedgerPaths, activeLedgerFor };
