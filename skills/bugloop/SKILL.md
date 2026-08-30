---
name: bugloop
description: Use for any bug, test failure, or unexpected behavior that will take more than a trivial one-line fix — before proposing fixes. Deterministic state machine (TRIAGE→REPRO→LOCATE→HYPOTHESIZE→PATCH→VERIFY→REVIEW→LANDED) anchored on a disk ledger with hard gates per transition. Survives /clear. Use when the user reports a bug, asks to debug/fix/investigate a failure, or invokes /bug.
---

# BugLoop

State machine for bug fixing. A ledger file on disk is the single source of
truth — not this conversation. Gates are enforced by `bugloop.sh gate <state>`,
not by your judgment. **Never hand-wave past a gate failure.**

## The Iron Law

```
NO STATE TRANSITION WITHOUT A PASSING GATE.
NO "VERIFIED" CLAIM WITHOUT A RECEIPT IN THE LEDGER.
```

If `bugloop.sh gate <target>` prints `GATE FAIL`, you cannot act as if you were
in `<target>`. Fill the missing fields it names, then gate again.

## Setup (once per message that touches a bug)

```bash
# Resolve the engine script regardless of install method (plugin cache path
# varies by version; user-level install is fixed). The plugin's SessionStart
# hook keeps .engine_root fresh automatically — this just reads it back.
BL="$(cat ~/.claude/bugloop/.engine_root 2>/dev/null)/skills/bugloop/scripts/bugloop.sh"
[ -x "$BL" ] || BL=~/.claude/skills/bugloop/scripts/bugloop.sh
export PROJECT_DIR="$(pwd)"   # or the actual project root
```

Check for an already-open ledger before starting a new one:

```bash
bash "$BL" list
bash "$BL" state   # errors if none active — that's fine, means start fresh
```

If one is open and not `LANDED`, **resume it** — read the ledger file directly
with Read, pick up at its `state:` field. Do not `init` a second one for the
same bug. (A SessionStart hook already prints a summary of any open ledger —
if you see that at the top of this session, that's the one to resume.)

## States and what to do in each

### TRIAGE — start here
```bash
bash "$BL" init "<one-line bug description>"
```
This auto-detects `test_cmd` from the project's `package.json`/`Makefile`/
`pyproject.toml`/`go.mod`/`Cargo.toml`. If it printed a "could not
auto-detect" note, ask the user once for the test command and:
```bash
bash "$BL" set test_cmd "<cmd>"
```
Then, in parallel (one message, multiple tool calls): attempt to reproduce,
run `git log -S <suspect-symbol>` on the suspect area, and search for
existing tests near the suspect code. Don't serialize these.

### REPRO — get a failing test + baseline
Delegate to the **bug-reproducer** agent (or do it directly for trivial
cases): write the smallest test that fails for the reported reason, capture
the literal failing output.

```bash
bash "$BL" set repro.test_path "<path>"
bash "$BL" set repro.test_cmd "<cmd that runs just this test>"
bash "$BL" set repro.failing_output "<literal output, one line summary>"
```

**Then capture the baseline before touching any source file:**
```bash
bash "$BL" baseline
```
This runs the full suite once and records what already fails — VERIFY later
diffs against this, not against an idealized "everything green."

If repro fails after 3 distinct attempts (different inputs/angles), see
`references/failure-modes.md` → `UNREPRODUCED`. Do not guess a fix for a bug
you cannot trigger.

Gate before leaving this state:
```bash
bash "$BL" gate LOCATE
```

### LOCATE — find the responsible code + blast radius
Spawn `caveman:cavecrew-investigator` (read-only, cheap, keeps file reads out
of main context). Ask it for: where the suspect symbol is defined, and every
caller of it (blast radius — this list decides what VERIFY must not break).

```bash
bash "$BL" set locate.sites "path:line, path:line, ..."
```

### HYPOTHESIZE — one falsifiable claim
Write exactly one hypothesis line directly into the ledger (Edit tool, under
`## hypotheses`):
```
- [1] status=testing :: <cause statement> :: <evidence citing repro/locate> :: <falsifier — what would disprove this>
```
One at a time. Not three. If a previous hypothesis was refuted, its line
stays with `status=refuted` — that's the record of what NOT to try again.

```bash
bash "$BL" gate PATCH
```

### PATCH — narrowest fix
1–2 files → spawn `caveman:cavecrew-builder`. More than that, or an
architectural change → do it in the main thread, one change only, no
drive-by refactors. See `superpowers:test-driven-development` for how to
shape the fix around the failing test if you haven't already.

```bash
bash "$BL" set patch.files_changed "path/one.ts, path/two.ts"
bash "$BL" gate VERIFY
```

### VERIFY — someone else checks, not the author
Spawn the **bug-verifier** agent (it has no Edit/Write — structurally cannot
"fix" the test to pass). Give it `repro.test_cmd`, the blast-radius test
list from LOCATE, and the baseline file path. It returns exactly `PASS` or
`FAIL` with literal output.

```bash
bash "$BL" set verify.focused "PASS"        # or FAIL
bash "$BL" set verify.baseline_diff "CLEAN" # or the new failures found
```

FAIL → mark the current hypothesis `status=refuted` in the ledger, go back to
HYPOTHESIZE with the failure as new evidence. **Do not patch again on top of
a refuted hypothesis.** After 3 refuted hypotheses:
`bash "$BL" set state ARCHITECTURE_QUESTION` and stop — ask the user. Do not
attempt a 4th guess.

```bash
bash "$BL" gate REVIEW
```

### REVIEW
Spawn `caveman:cavecrew-reviewer` on the diff.
```bash
bash "$BL" set review.verdict "<verdict>"
bash "$BL" gate LANDED
```

### LANDED
Use `/bug-land` — full suite receipt, then commit if the user wants it. This
is a terminal state; the Stop hook goes quiet once here.

## Model tiering
LOCATE and REPRO and VERIFY are mechanical — run their agents on `haiku`.
HYPOTHESIZE and PATCH need real reasoning — stay on the main model.

## Reuse — don't reinvent
- LOCATE → `caveman:cavecrew-investigator`
- PATCH (1-2 files) → `caveman:cavecrew-builder`
- REVIEW → `caveman:cavecrew-reviewer`
- Test shaping → `superpowers:test-driven-development`
- Final claim discipline → `superpowers:verification-before-completion`

See `references/gates.md` for the exact field-by-field gate table,
`references/ledger-template.md` for the ledger schema, and
`references/failure-modes.md` for UNREPRODUCED / FLAKY / ARCHITECTURE_QUESTION
branches.
