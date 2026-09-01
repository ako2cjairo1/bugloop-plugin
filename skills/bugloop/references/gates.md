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
| REVIEW | `bugloop.sh gate REVIEW` | `verify.focused=PASS`, `verify.baseline_diff=CLEAN` | Any other value blocks — no partial credit. REVIEW itself is bounded-adversarial: `review.rejection_count` caps at 2 before the reviewer must approve, approve-with-caveats, or escalate — see SKILL.md's REVIEW section |
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

## Why pending.question is durable, not conversational

Every human-in-the-loop point (`POSSIBLE_NOT_A_BUG`, `UNREPRODUCED`,
`ARCHITECTURE_QUESTION`, `BLOCKED_NEEDS_HUMAN`, `/bug-land`'s commit ask,
an orchestrator-judgment concern) records the question in the ledger
*before* asking it. A question asked only inside a conversation turn and
never written to disk is a question the next session — after `/clear`, a
crash, a dropped connection — has no way to know was ever pending; it might
silently re-decide, ask something differently worded, or just stall.

Three subcommands own this as one lifecycle, `bugloop.sh pending ...`:

- **`ask "<question>" "<context>"`** — sets `pending.question`,
  `pending.context`, and `pending.asked_at` together, always all three,
  right before the orchestrator asks the question (in conversation, or
  wherever it's asking).
- **`answer "<text>"`** — records a decision *without acting on it*. This
  is what the dashboard calls when a human answers from the browser — it
  can write down what was decided, but only the orchestrator, on its next
  `resume`, actually interprets the answer and acts on it. `pending.answer`
  stays separate from clearing the question specifically so "answered" and
  "acted on" aren't conflated.
- **`clear`** — wipes all four `pending.*` fields. Only called by the
  orchestrator, only after it has genuinely acted on the answer (whether
  that answer arrived in the same conversation turn or was recorded earlier
  by something else).

`bugloop.sh resume` (SessionStart) and `nag` (Stop) both surface this
automatically — an unanswered question prints as `UNANSWERED QUESTION:
...`, an answered-but-not-yet-acted-on one as `ANSWERED, NOT YET ACTED ON:
... -> ...` — so the terminal UX gets this for free either way. This is
also the entire query behind a dashboard's "needs your decision" view:
every ledger where `pending.question` isn't empty.

## Targeting a specific ledger

`active.json` (per project) only ever points at one ledger. `--ledger
<path>` — placed *before* the subcommand, e.g. `bugloop.sh --ledger
<path> set field value` (or the `BUGLOOP_LEDGER` env var, either order) —
acts on a different, specific ledger directly, without touching what's
active — needed the
moment more than one bug is in flight for the same project, or when
something other than the driving terminal session (a dashboard) needs to
act on a ledger. `bugloop.sh switch <id-or-partial-match>` repoints
`active.json` itself, for when you want a different ledger to become the
default target going forward.

## Why `engine_version` is stamped at init

The plugin's `.engine_root` pointer only refreshes on SessionStart, so a
plugin update installed mid-session keeps resolving to the old script until
the next restart — this has actually happened during development. That's
not fixable from inside a script, but `engine_version` (the plugin cache
dir's commit-sha basename, or `manual-install`) makes it auditable: if two
runs of the same bug behave differently, this field is the first place to
check whether they even ran the same engine.
