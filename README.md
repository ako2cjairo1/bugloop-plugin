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
`http://localhost:4577` by default — that shows every bug across every
project at a glance, and lets you answer a pending question or a commit
decision from a browser instead of the terminal. It's a monitor+decide
surface, not a replacement for the agent: **it never writes code, runs
tests, or drives the loop itself** — Claude Code, in a terminal, is still
what actually works the bug. Every write it makes shells out to
`bugloop.sh`, the same engine the terminal uses, so there's one source of
truth for ledger mutation either way.

It needs `node` (18+) on PATH; installs its own two dependencies
(`express`, `chokidar`) into `dashboard/node_modules` on first run.

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
  Read-mostly; every write shells out to `bugloop.sh`, never writes a
  ledger field directly.
