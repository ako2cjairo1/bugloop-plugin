# Gate reference

Each row: the target state you're trying to enter, the command to check it,
and the exact ledger fields that must be non-empty. Run the gate command —
don't eyeball the ledger and decide it "looks done."

| Target | Command | Required fields | Notes |
|---|---|---|---|
| REPRO | `bugloop.sh gate REPRO` | `state` (ledger exists) | Sanity check only — real work starts here. May exit to `NOT_A_BUG` (user-confirmed) or `UNREPRODUCED` instead of proceeding |
| LOCATE | `bugloop.sh gate LOCATE` | `repro.test_cmd`, `repro.failing_output`, `baseline.captured_at` | Baseline must exist BEFORE any source edit |
| HYPOTHESIZE | `bugloop.sh gate HYPOTHESIZE` | `locate.sites` (or `state=UNREPRODUCED`/`NOT_A_BUG`) | Either exit state skips straight past LOCATE — nothing to locate for a bug that isn't one, or one you can't trigger |
| PATCH | `bugloop.sh gate PATCH` | exactly one `- [n] status=testing` line, plus everything LOCATE required | Written by `bugloop.sh hypothesis add` (never hand-edited) so the count this gate relies on can't drift with phrasing |
| VERIFY | `bugloop.sh gate VERIFY` | `patch.files_changed` | |
| REVIEW | `bugloop.sh gate REVIEW` | `verify.focused=PASS`, `verify.baseline_diff=CLEAN` | Any other value blocks — no partial credit |
| LANDED | `bugloop.sh gate LANDED` | `review.verdict` | Run `/bug-land` for the final full-suite receipt + commit. It also records `landed.committed`/`landed.commit_sha` — the gate itself doesn't require them, but a LANDED ledger without them means the fix may still be sitting uncommitted |

## Reading gate output

```
GATE FAIL -> PATCH
missing: exactly-one hypothesis[status=testing] required (found 0)
missing: repro.test_cmd repro.failing_output baseline.captured_at
```

Exit code is 1 on FAIL, 0 on PASS — safe to use in scripts or as a stop
condition. Fill exactly the named fields with `bugloop.sh set <field>
<value>`, then re-run the same gate.

## Why gates exist instead of trusting the model's judgement

Every field a gate checks corresponds to a claim that must be independently
falsifiable: a test command that actually runs, output that was actually
captured, a baseline that was actually measured before edits. A model
narrating "I've reproduced it and verified the fix" without these fields
existing on disk is exactly the failure mode this skill exists to prevent.

## Why `engine_version` is stamped at init

The plugin's `.engine_root` pointer only refreshes on SessionStart, so a
plugin update installed mid-session keeps resolving to the old script until
the next restart — this has actually happened during development. That's
not fixable from inside a script, but `engine_version` (the plugin cache
dir's commit-sha basename, or `manual-install`) makes it auditable: if two
runs of the same bug behave differently, this field is the first place to
check whether they even ran the same engine.
