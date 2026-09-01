---
description: Start the BugLoop web dashboard — monitor bugs and answer pending decisions from a browser
---

Resolve the engine and start the dashboard:

```bash
BL="$(cat ~/.claude/bugloop/.engine_root 2>/dev/null)/skills/bugloop/scripts/bugloop.sh"
[ -x "$BL" ] || BL=~/.claude/skills/bugloop/scripts/bugloop.sh
bash "$BL" dashboard
```

This starts a local server (default `http://localhost:4577`, override with
`bugloop.sh dashboard --port <N>`) in the foreground. It installs its own
`node_modules` on first run if missing — report that step if it happens,
it's a one-time thing.

Report the URL to the user plainly. **Do not open a browser automatically**
— print the link and let them click it.

Remind them what the dashboard is for, briefly, if this is their first time
asking: it shows every bug across every project, and lets them answer a
pending question from a browser instead of the terminal — it does not write
code, run tests, or drive the fix itself. Claude Code, in a terminal, is
still what's actually working the bug; the dashboard is the monitor+decide
surface, not a replacement for it.

This command blocks the terminal it runs in (the server runs in the
foreground) — mention that the user may want to run it in a separate
terminal/session if they still want to use this one for the actual `/bug`
work.
