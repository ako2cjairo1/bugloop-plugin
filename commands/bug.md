---
description: Start or resume the BugLoop deterministic debugging workflow
---

Invoke the `bugloop` skill for this task: $ARGUMENTS

Before doing anything else:
1. Resolve the engine script (works for either plugin or manual install):
   ```bash
   BL="$(cat ~/.claude/bugloop/.engine_root 2>/dev/null)/skills/bugloop/scripts/bugloop.sh"
   [ -x "$BL" ] || BL=~/.claude/skills/bugloop/scripts/bugloop.sh
   export PROJECT_DIR="$(pwd)"
   ```
2. Check for an already-open ledger: `bash "$BL" list` and `bash "$BL" state`.
3. If one is open and not `LANDED`, resume it at its current state — do not start a new one for the same bug.
4. If none is open, `bash "$BL" init "<description from $ARGUMENTS>"` and begin at TRIAGE.

Follow the bugloop skill's states and gates exactly. Do not skip a gate check
before transitioning state.
