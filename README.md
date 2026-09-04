# bugloop

Deterministic bug-fixing workflow for Claude Code. A disk ledger — not the
conversation — is the source of truth for a state machine
(`TRIAGE → REPRO → LOCATE → HYPOTHESIZE → PATCH → VERIFY → REVIEW → LANDED`,
with `NOT_A_BUG` / `UNREPRODUCED` / `FLAKY` / `ARCHITECTURE_QUESTION` /
`BLOCKED_NEEDS_HUMAN` as named exit branches — never a silent guess), with a
hard gate checked before every transition, a pre-fix baseline that VERIFY
diffs against, and a verifier agent with no Edit/Write tools so it cannot
"fix" a test to make it pass.

Survives `/clear` — a SessionStart hook prints a summary of any open ledger
so the loop resumes instead of restarting.

## Install

**Local checkout (this machine, or after `git clone`/`scp`):**
```bash
claude plugin marketplace add /path/to/bugloop-plugin
claude plugin install bugloop@bugloop
```

**From a Git remote** (after you push this repo somewhere, e.g. GitHub):
```bash
claude plugin marketplace add <owner>/<repo>          # GitHub shorthand
# or
claude plugin marketplace add https://github.com/<owner>/<repo>.git
claude plugin install bugloop@bugloop
```

Then restart Claude Code (or start a new session) so the plugin's hooks and
skill register.

## Requirements

- `bash`, `jq` on PATH (`brew install jq` / `apt install jq` / etc.)
- A project with an auto-detectable test command (`package.json` scripts.test,
  `Makefile` test target, `pytest`/`pyproject.toml`, `go.mod`, or
  `Cargo.toml`) — otherwise you'll be asked for one on first use.

## Use

```
/bug "<describe the bug>"     # start or resume the loop
/bug-status                   # show current state + what the next gate needs
/bug-land                     # final gate: full-suite receipt, then commit
/bug-dashboard                # start the web dashboard (see below)
```

Or just describe a bug in conversation — the `bugloop` skill triggers
automatically for anything beyond a trivial one-line fix.

## Dashboard

`bugloop.sh dashboard` (or `/bug-dashboard`) starts a local web UI —
`http://localhost:4577` by default, bound to loopback only — that shows
every bug across every project at a glance, and lets you answer a pending
question or a commit decision from a browser instead of the terminal.
Every write it makes shells out to `bugloop.sh`, the same engine the
terminal uses, so there's one source of truth for ledger mutation either
way.

It needs `node` (18+) on PATH; installs its own dependencies
(`express`, `chokidar`) into `dashboard/node_modules` on first run.

### New Bug / Continue — opt-in, and materially more powerful

By default the dashboard is read-mostly: it monitors ledgers and lets you
answer questions, nothing more. **New Bug** and **Continue** are a
different kind of feature — they spawn a real, autonomous `claude -p`
session that writes code, runs tests, and can commit, triggered from an
unauthenticated local web page. That's a genuinely bigger risk surface
than answering a text field, so it's off by default and stays scoped by an
explicit allowlist:

```bash
bugloop.sh dashboard-allow /path/to/project      # terminal-only
bugloop.sh dashboard-disallow /path/to/project   # revoke it
```

The dashboard **reads** `~/.claude/bugloop/dashboard-projects.txt` to
populate the project picker; it never writes to that file itself, and
re-validates the chosen project against a fresh read on every spawn
request. If nothing is allowed yet, New Bug shows a disabled state
explaining this command instead of silently offering nowhere to spawn.

Every spawned run: uses `--permission-mode auto` and a per-run
`--max-budget-usd` cap (default $5, overridable per run), runs in an
isolated git worktree + branch when the target is a git repo (so it can
never touch your actual working directory or uncommitted changes), and is
capped at 3 concurrent runs by default. A hard timeout (20 min default)
kills a run that doesn't finish. Slash commands like `/bug` don't resolve
in headless mode — confirmed directly, not assumed — so spawned runs use
`commands/bug.md`'s instructions inlined as the prompt instead; the result
is identical either way.

**Known limitation, stated plainly:** run tracking (status, output) lives
in the dashboard server's memory and does not survive a restart. Actual
bugloop progress is never at risk either way — the ledger, not this
tracker, is the source of truth — but a restart loses the live-output view
for anything that was running.

## Data

Ledgers live in `~/.claude/bugloop/<project-slug>/` regardless of how this
plugin was installed — that directory is not part of the plugin and is never
touched by upgrades or reinstalls.

## What's inside

- `skills/bugloop/` — SKILL.md (the state machine + gates), the `bugloop.sh`
  engine, and reference docs (`gates.md`, `ledger-template.md`,
  `failure-modes.md`)
- `commands/` — `/bug`, `/bug-status`, `/bug-land`, `/bug-dashboard`
- `agents/` — `bug-reproducer` (writes the failing test), `bug-verifier`
  (checks the fix independently, no write tools)
- `dashboard/` — the local web UI: an Express + chokidar server
  (`server.js`, `lib/`) and a vanilla-JS single-page frontend (`public/`).
  `lib/bugloop-cli.js` shells out to `bugloop.sh` for every ledger write —
  never writes a field directly. `lib/session-runner.js` is the opt-in New
  Bug/Continue spawner (`dashboard-allow`-gated, `-p` not `--bg` — see its
  header comment for why, confirmed by real testing not assumption).
