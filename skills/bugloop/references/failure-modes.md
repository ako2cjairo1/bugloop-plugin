# Failure-mode branches

Three non-standard states. All three are explicit `state:` values that block
`PATCH` — none of them are something you route around by proceeding anyway.

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
bash "$BL" set state ARCHITECTURE_QUESTION
```

**Stop. Do not attempt a 4th hypothesis.** Three failed root-cause guesses on
the same symptom is a signal the mental model of the system is wrong, not
that the next guess will land. Summarize for the user:
- the three refuted hypotheses and what evidence refuted each
- what that pattern suggests about the actual architecture
- ask directly, don't keep thrashing silently

This mirrors `superpowers:systematic-debugging`'s "3+ fixes failed → question
architecture" step, but anchored to the ledger's hypothesis count instead of
an ad-hoc mental tally.

## BLOCKED_NEEDS_HUMAN

Catch-all terminal state for anything else that stops the loop cold: missing
credentials, a decision only the user can make, a fix that requires touching
code outside the agent's permission. Set it, explain why in the ledger under
`## review`, and stop — same as the other two terminal-adjacent states, the
Stop hook goes quiet once here.
