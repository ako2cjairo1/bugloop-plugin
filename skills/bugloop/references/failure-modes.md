# Failure-mode branches

Non-standard states. All of them are explicit `state:` values that block
`PATCH` — none of them are something you route around by proceeding anyway.
`NOT_A_BUG`, `ARCHITECTURE_QUESTION`, and `BLOCKED_NEEDS_HUMAN` are true
terminal states (the ledger is done, the Stop hook goes quiet); `UNREPRODUCED`
and `FLAKY` are resumable pauses (more evidence can reopen them).

Every branch below that asks the user something records it first:
`bash "$BL" pending ask "<verbatim>" "<context>"` before asking,
`bash "$BL" pending clear` after it's answered. This is what lets
`resume`/the Stop hook re-surface an unanswered question verbatim instead of
silently losing it across `/clear` or a dropped session.

## NOT_A_BUG

**Trigger:** during REPRO, `bug-reproducer` finds an existing test, doc, or
comment that directly asserts today's behavior is intentional, contradicting
the report (its `POSSIBLE_NOT_A_BUG` output) — **and** the user, asked once
with that citation, confirms it's expected rather than outdated.

**Never set this from the agent's report alone.** `POSSIBLE_NOT_A_BUG` is a
citation to put in front of the user, not a verdict. Record it, then ask,
citing the exact evidence:
```bash
bash "$BL" pending ask "<file:line> asserts <what it says> -- outdated, or expected behavior?" "POSSIBLE_NOT_A_BUG"
```
> `<file:line>` asserts `<what it says>` — is that outdated, or is your
> report describing expected behavior?

**Set (only after the user confirms):**
```bash
bash "$BL" pending clear
bash "$BL" set state NOT_A_BUG
bash "$BL" set repro.not_a_bug_evidence "<file:line — what it asserts>"
```

Stop here. No LOCATE, no HYPOTHESIZE, no PATCH — there is nothing to fix.
This is different from `UNREPRODUCED`: that's "couldn't trigger it,"
this is "triggered it, and it's correct." Closing a report this way is a
dismissive action if wrong, which is exactly why it needs the user's
confirmation and never just the agent's word.

If the user pushes back later ("no, really, it's a bug") — that's new
information, not a contradiction to relitigate. Reopen: set state back to
`TRIAGE` or `REPRO` and continue normally, this ledger, not a new one.

## UNREPRODUCED

**Trigger:** 3 distinct repro attempts (different inputs, different angles —
not the same command run 3 times) all fail to trigger the reported symptom.

**Set:**
```bash
bash "$BL" set state UNREPRODUCED
```

**Do not guess a fix for a bug you cannot trigger.** Instead, switch to
instrumentation mode:
1. Add targeted logging at the suspected boundary (don't shotgun-log the
   whole codebase).
2. Ask the user to run the instrumented build and paste the output, or ship
   it if this is a production issue with real traffic.
3. Once real evidence arrives, append it to the ledger under `## repro` and
   re-attempt REPRO — you're not starting a new ledger, this one continues.

Before step 2's ask: `bash "$BL" pending ask "..." "UNREPRODUCED"`, cleared
(`pending clear`) once the user responds — same as every other branch here.

If the user says "just try something," that is not evidence — say plainly
that a guess without repro risks a no-op patch, then proceed only under that
explicit direction, and note the assumption in the ledger.

## FLAKY

**Trigger:** the repro test is run 5x and does not fail consistently (some
green, some red, same code, same inputs).

**Set:**
```bash
bash "$BL" set state FLAKY
```

The flakiness itself is a separate bug — file it as such (a new `bugloop.sh
init "flaky test: <name>"`) and fix that first. Debugging the original
symptom on top of a flaky signal wastes cycles: you cannot tell a real fix
from noise.

## ARCHITECTURE_QUESTION

**Trigger:** 3 hypotheses have been marked `status=refuted` in the ledger's
`## hypotheses` section for the same bug.

**Set:**
```bash
bash "$BL" pending ask "3 hypotheses refuted: <summary of each + evidence>. What am I missing?" "ARCHITECTURE_QUESTION"
bash "$BL" set state ARCHITECTURE_QUESTION
```

**Stop. Do not attempt a 4th hypothesis.** Three failed root-cause guesses on
the same symptom is a signal the mental model of the system is wrong, not
that the next guess will land. Summarize for the user:
- the three refuted hypotheses and what evidence refuted each
- what that pattern suggests about the actual architecture
- ask directly, don't keep thrashing silently — then `pending clear` once
  they've answered

This mirrors `superpowers:systematic-debugging`'s "3+ fixes failed → question
architecture" step, but anchored to the ledger's hypothesis count instead of
an ad-hoc mental tally.

## BLOCKED_NEEDS_HUMAN

Catch-all terminal state for anything else that stops the loop cold: missing
credentials, a decision only the user can make, a fix that requires touching
code outside the agent's permission. `pending ask` with what's actually
blocking before setting the state, explain why in the ledger under
`## review`, and stop — same as the other two terminal-adjacent states, the
Stop hook goes quiet once here.
