---
description: Final gate for BugLoop — full suite receipt, then commit
---

This is the LANDED gate. Only run this after `/bug-status` shows state=REVIEW
with a `review.verdict` already set.

1. Resolve the engine script and project dir:
   ```bash
   BL="$(cat ~/.claude/bugloop/.engine_root 2>/dev/null)/skills/bugloop/scripts/bugloop.sh"
   [ -x "$BL" ] || BL=~/.claude/skills/bugloop/scripts/bugloop.sh
   export PROJECT_DIR="$(pwd)"
   ```
2. `bash "$BL" gate LANDED` — if this prints `GATE FAIL`, stop and report
   exactly what's missing. Do not force past it.
3. If it passes, run the FULL suite one more time as the final receipt (not
   just the focused test):
   ```bash
   bash "$BL" receipt "<test_cmd from the ledger>"
   ```
   If this fails, the ledger is not actually done — go back to VERIFY in the
   bugloop skill, do not paper over it here.
4. Set the ledger's state to LANDED:
   ```bash
   bash "$BL" set state LANDED
   ```
5. Ask the user whether to commit. If yes, stage exactly the files listed in
   `patch.files_changed` (plus the failing test added in REPRO) and write a
   commit message describing the root cause fixed, not just the symptom.
   Reference the ledger path in the commit body if useful for future lookup.
6. Report completion plainly: what was fixed, root cause, what the receipt
   showed. Do not claim success without having just run step 3's receipt in
   this turn.
