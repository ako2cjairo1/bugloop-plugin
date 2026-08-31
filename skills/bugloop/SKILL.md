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

## Orchestrator judgment — gates check presence, not sense

The Iron Law stops you from skipping evidence. It does not stop you from
accepting bad evidence that happens to fill a field —
`bugloop.sh set repro.failing_output "x"` satisfies a gate; it doesn't mean
anything. Closing that gap is yours, every phase, before you call `set`:

| Phase | Ask before accepting | If no, or you're not sure |
|---|---|---|
| REPRO | Does `failing_output` actually describe the reported symptom — not a different failure that happened to occur? | Don't set the field. Re-run repro, or ask the user to clarify what they observed. |
| LOCATE | Do the sites plausibly relate to the symptom, or is this a shotgun grep hit? | Narrow the search. If it's genuinely unclear which code owns this, say so and ask rather than guessing. |
| HYPOTHESIZE | Does the falsifier describe something that could actually disprove the hypothesis, or did I write one that can't fail? | Rewrite it. A hypothesis with no real falsifier is a guess wearing the format. |
| PATCH | Does the diff match the hypothesis and stay inside LOCATE's blast radius, or did the change spread past what was named? | Stop before VERIFY. Report the mismatch to the user — scope drift here is exactly what this loop exists to catch. |
| VERIFY | Does `baseline_diff=CLEAN` reflect a real diff against `baseline.txt`, or does the verifier's report look thin/asserted rather than shown? | Ask bug-verifier for the literal output. Never accept PASS on the agent's word — that's the entire point of a verifier with no write tools. |
| REVIEW | Would a human actually sign off on this, or is `review.verdict` just the word "approved" with nothing behind it? | Push back on the reviewer agent; require real substance before setting the field. |

**Read the full ledger before acting in any state** — not just the field(s)
the next gate checks. Prior refuted hypotheses, prior receipts, and prior
concerns are context for the current step, not history to skip past. This
matters most right after `/clear` or a resumed session: the SessionStart
summary shows a few lines, not the whole file — Read the ledger for real
before continuing.

When a concern survives that self-check, log it so it persists like
everything else:
```bash
bash "$BL" receipt "echo 'CONCERN: <what looked wrong, specifically>'"
```
Then either resolve it inside the current state with more evidence — never
by guessing — or ask the user directly, citing what's uncertain. Same
standard as `NOT_A_BUG`: uncertainty gets surfaced, never quietly patched
over to keep the loop moving.

## Where the human gets asked

Every human-in-the-loop point here is a named, citable moment — never a
vague "check with the user sometime":

| Trigger | What's asked | Where |
|---|---|---|
| `POSSIBLE_NOT_A_BUG` from the reproducer | The citation + "outdated, or expected behavior?" | REPRO, before any test is written |
| An orchestrator-judgment concern (table above) that can't be resolved with more evidence | The specific thing that looks wrong, cited | Any state |
| `UNREPRODUCED` after 3 attempts | Whether to proceed on a guess anyway (discouraged), or wait for more evidence | REPRO |
| 3 hypotheses refuted → `ARCHITECTURE_QUESTION` | The three refuted hypotheses + what pattern they suggest | HYPOTHESIZE/VERIFY loop |
| `BLOCKED_NEEDS_HUMAN` | Whatever's actually blocking (credentials, a change outside agent permission) | Any state |
| `/bug-land` | Whether to commit | LANDED |

If a state seems to need a check-in that isn't on this list, that's a sign
the orchestrator-judgment table above should have caught it earlier — fix
the earlier phase, don't bolt on a rubber-stamp question here.

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

**The agent checks for contradicting evidence before writing anything** — a
false failing test poisons every gate downstream, which trusts it
unconditionally. Three outcomes come back:

- **Reproduced** (the common case) — fill the fields below and continue.
- **`POSSIBLE_NOT_A_BUG`** — the agent found an existing test, doc, or
  comment that asserts today's behavior is intentional, contradicting the
  report. Ask the user once, citing the exact evidence: *"`<file:line>`
  asserts `<what it says>` — is that outdated, or is your report describing
  expected behavior?"* Don't decide this yourself, and don't skip asking
  just because the evidence looks strong.
  - User says it's still a bug → proceed to a normal repro, note the
    citation in the ledger under `## repro` (it may matter for PATCH), and
    continue.
  - User confirms it's expected → `bash "$BL" set state NOT_A_BUG`, then
    see `references/failure-modes.md` → `NOT_A_BUG` and stop. No LOCATE,
    no PATCH.
- **`UNREPRODUCED`** — 3 distinct attempts (different inputs/angles) never
  trigger the symptom. See `references/failure-modes.md` → `UNREPRODUCED`.
  Do not guess a fix for a bug you cannot trigger.

If reproduced, fill the ledger:
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
```bash
bash "$BL" hypothesis add "<cause statement>" "<evidence citing repro/locate>" "<falsifier — what would disprove this>"
```
The engine writes the line itself (exact format, auto-numbered) — don't
hand-author it with Edit. This is deliberate: a hand-formatted line that
varies slightly between runs is exactly the kind of drift that made the old
gate count unreliable. `hypothesis add` also refuses outright if a
`status=testing` hypothesis already exists, so "one at a time" is enforced,
not just requested.

If a previous hypothesis was refuted, its line stays with `status=refuted`
— that's the record of what NOT to try again — via:
```bash
bash "$BL" hypothesis refute <n>
```

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

FAIL → `bash "$BL" hypothesis refute <n>`, go back to HYPOTHESIZE with the
failure as new evidence. **Do not patch again on top of a refuted
hypothesis.** After 3 refuted hypotheses:
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
LOCATE (`cavecrew-investigator`) and VERIFY (`bug-verifier`) are pure
mechanical work — grep/read, run a command and diff its output, no judgment
involved — run them on `haiku`. REPRO (`bug-reproducer`) runs on `sonnet`:
writing a test that fails for the *right* reason, and telling a real bug
apart from an existing-test contradiction, both take real reasoning — a bad
haiku-written repro costs more in retries than the tier saved. HYPOTHESIZE
and PATCH need the most reasoning of all — those stay on the main session
model, not a subagent tier.

## Reuse — don't reinvent
- LOCATE → `caveman:cavecrew-investigator`
- PATCH (1-2 files) → `caveman:cavecrew-builder`
- REVIEW → `caveman:cavecrew-reviewer`
- Test shaping → `superpowers:test-driven-development`
- Final claim discipline → `superpowers:verification-before-completion`

See `references/gates.md` for the exact field-by-field gate table,
`references/ledger-template.md` for the ledger schema, and
`references/failure-modes.md` for NOT_A_BUG / UNREPRODUCED / FLAKY /
ARCHITECTURE_QUESTION branches.
