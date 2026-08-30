---
description: Show the active BugLoop ledger and its current state
---

Run:
```bash
BL="$(cat ~/.claude/bugloop/.engine_root 2>/dev/null)/skills/bugloop/scripts/bugloop.sh"
[ -x "$BL" ] || BL=~/.claude/skills/bugloop/scripts/bugloop.sh
export PROJECT_DIR="$(pwd)"
bash "$BL" list
bash "$BL" state
```

Then Read the active ledger file (from the `list` output) and report to the
user, in plain terse form:
- current state
- the repro summary (test_cmd + failing_output)
- how many hypotheses are `testing` / `refuted` / `confirmed`
- what the next gate requires (check `references/gates.md` in the bugloop
  skill for the exact fields), and what's already filled vs missing

Do not editorialize or propose a fix here — this is a status read only.
