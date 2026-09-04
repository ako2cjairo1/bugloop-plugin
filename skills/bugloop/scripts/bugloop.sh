#!/usr/bin/env bash
# bugloop.sh — state engine for the BugLoop workflow
# Subcommands: init state set receipt baseline hypothesis switch pending gate resume nag list dashboard dashboard-allow dashboard-disallow
set -euo pipefail

ROOT="${BUGLOOP_ROOT:-$HOME/.claude/bugloop}"

# Set via BUGLOOP_LEDGER env var or a --ledger <path> flag (stripped out of
# argv in main()). When set, every mutating subcommand acts on this ledger
# directly instead of resolving through active.json -- lets a second caller
# (the dashboard, a script) address a specific in-flight bug without
# disturbing what a concurrent terminal session's active ledger is.
LEDGER_OVERRIDE="${BUGLOOP_LEDGER:-}"

need_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "bugloop: jq required but not found" >&2
    exit 2
  fi
}
need_jq

# When invoked as a plugin hook, CLAUDE_PLUGIN_ROOT is set by the harness and
# points at this script's actual (versioned, cache-path) install location.
# Persist it so prose instructions in SKILL.md / commands — which cannot see
# that env var themselves — can resolve this script's path on any machine,
# regardless of whether bugloop was installed as a plugin or copied by hand.
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  mkdir -p "$ROOT" 2>/dev/null || true
  printf '%s' "$CLAUDE_PLUGIN_ROOT" > "$ROOT/.engine_root" 2>/dev/null || true
fi

# --- project slug: basename + short hash of absolute cwd ---
project_slug() {
  local abs
  abs="$(cd "${PROJECT_DIR:-$PWD}" && pwd)"
  local base
  base="$(basename "$abs")"
  local hash
  hash="$(printf '%s' "$abs" | shasum -a 256 2>/dev/null | cut -c1-8)"
  if [ -z "$hash" ]; then
    hash="$(printf '%s' "$abs" | md5 2>/dev/null | cut -c1-8)"
  fi
  echo "${base}-${hash}"
}

PROJ_DIR="$ROOT/$(project_slug)"
ACTIVE_FILE="$PROJ_DIR/active.json"

mkdir_proj() { mkdir -p "$PROJ_DIR"; }

active_ledger_path() {
  if [ -f "$ACTIVE_FILE" ]; then
    jq -r '.ledger // empty' "$ACTIVE_FILE" 2>/dev/null || true
  fi
}

require_active() {
  if [ -n "$LEDGER_OVERRIDE" ]; then
    if [ ! -f "$LEDGER_OVERRIDE" ]; then
      echo "bugloop: --ledger path not found: $LEDGER_OVERRIDE" >&2
      exit 1
    fi
    echo "$LEDGER_OVERRIDE"
    return 0
  fi
  local lp
  lp="$(active_ledger_path)"
  if [ -z "$lp" ] || [ ! -f "$lp" ]; then
    echo "bugloop: no active ledger for this project. Run 'bugloop.sh init \"<desc>\"' first." >&2
    exit 1
  fi
  echo "$lp"
}

# atomic json write
write_json() {
  local path="$1" content="$2"
  local tmp
  tmp="$(mktemp "${path}.XXXXXX")"
  printf '%s' "$content" > "$tmp"
  mv "$tmp" "$path"
}

slug_id() {
  local desc="$1"
  local d
  d="$(date +%Y-%m-%d)"
  local s
  s="$(printf '%s' "$desc" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed -e 's/-\+/-/g' -e 's/^-//' -e 's/-$//' | cut -c1-40)"
  [ -z "$s" ] && s="bug"
  echo "${d}-${s}"
}

detect_test_cmd() {
  local dir="${PROJECT_DIR:-$PWD}"
  if [ -f "$dir/package.json" ]; then
    if jq -e '.scripts.test' "$dir/package.json" >/dev/null 2>&1; then
      echo "npm test"
      return
    fi
  fi
  if [ -f "$dir/Makefile" ] && grep -qE '^test:' "$dir/Makefile" 2>/dev/null; then
    echo "make test"
    return
  fi
  if [ -f "$dir/pyproject.toml" ] || [ -f "$dir/pytest.ini" ] || [ -f "$dir/setup.cfg" ]; then
    echo "pytest"
    return
  fi
  if [ -f "$dir/go.mod" ]; then
    echo "go test ./..."
    return
  fi
  if [ -f "$dir/Cargo.toml" ]; then
    echo "cargo test"
    return
  fi
  echo ""
}

cmd_init() {
  local desc="${1:-}"
  if [ -z "$desc" ]; then
    echo "usage: bugloop.sh init \"<bug description>\"" >&2
    exit 2
  fi
  mkdir_proj
  local id ledger test_cmd engine_version
  id="$(slug_id "$desc")"
  ledger="$PROJ_DIR/${id}.md"
  if [ -f "$ledger" ]; then
    ledger="$PROJ_DIR/${id}-$(date +%H%M%S).md"
  fi
  test_cmd="$(detect_test_cmd)"
  # Records which engine build handled this bug. CLAUDE_PLUGIN_ROOT's cache
  # path is named by commit sha, so its basename doubles as a version stamp
  # -- makes the .engine_root staleness issue (a mid-session plugin update
  # not taking effect until restart) auditable instead of silent.
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    engine_version="$(basename "$CLAUDE_PLUGIN_ROOT")"
  else
    engine_version="manual-install"
  fi

  cat > "$ledger" <<EOF
# Bug: $desc

state: TRIAGE
project_dir: ${PROJECT_DIR:-$PWD}
created_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
test_cmd: ${test_cmd:-UNKNOWN}
engine_version: ${engine_version}

## pending
pending.question:
pending.context:
pending.asked_at:
pending.answer:

## repro
repro.test_path:
repro.test_cmd:
repro.failing_output:
repro.not_a_bug_evidence:

## baseline
baseline.captured_at:
baseline.failing_tests:

## locate
locate.sites:

## hypotheses
<!-- add one line per hypothesis, format:
- [n] status=STATUS :: statement :: evidence :: falsifier
STATUS is one of: testing, refuted, confirmed -->

## patch
patch.files_changed:

## verify
verify.focused:
verify.baseline_diff:

## review
review.verdict:
review.rejection_count:

## landed
landed.committed:
landed.commit_sha:

## receipts
<!-- appended by 'receipt' subcommand -->
EOF

  write_json "$ACTIVE_FILE" "$(jq -n --arg l "$ledger" --arg id "$id" '{ledger:$l, id:$id}')"
  echo "bugloop: initialized $ledger"
  echo "state: TRIAGE"
  if [ -z "$test_cmd" ]; then
    echo "note: could not auto-detect test command — set it manually with 'bugloop.sh set test_cmd \"<cmd>\"'"
  fi
  return 0
}

# Escapes ERE metacharacters in a field name before it's used to build an
# awk/grep regex. Field names today are all [a-z_.] -- only '.' is a live
# metachar -- but an unescaped '.' matches any character, so "repro.test_cmd"
# would also match a hypothetical "reproXtest_cmd" line. Closing this on
# principle before a new field name ever collides under the wildcard.
re_escape() {
  printf '%s' "$1" | sed 's/[.[\*^$/]/\\&/g'
}

get_field() {
  local ledger="$1" field="$2"
  local fe
  fe="$(re_escape "$field")"
  awk -v f="$field:" -v fe="${fe}:" '
    $0 ~ "^"fe" " || $0 == f {
      sub("^"fe" *", "");
      print;
      exit
    }
  ' "$ledger"
}

cmd_state() {
  local ledger
  ledger="$(require_active)"
  grep -m1 '^state:' "$ledger" | sed 's/^state: *//'
}

cmd_set() {
  local field="$1" value="$2"
  local ledger
  ledger="$(require_active)"
  reject_multiline "$field value" "$value"
  local tmp fe
  tmp="$(mktemp)"
  fe="$(re_escape "$field")"
  if grep -qE "^${fe}:" "$ledger"; then
    awk -v f="$field" -v fe="$fe" -v v="$value" '
      BEGIN{done=0}
      $0 ~ "^"fe":" && done==0 { print f": " v; done=1; next }
      { print }
    ' "$ledger" > "$tmp"
  else
    cp "$ledger" "$tmp"
    printf '\n%s: %s\n' "$field" "$value" >> "$tmp"
  fi
  mv "$tmp" "$ledger"
  echo "bugloop: set $field"
}

cmd_receipt() {
  local runcmd="$*"
  local ledger
  ledger="$(require_active)"
  local dir
  dir="$(get_field "$ledger" project_dir)"
  [ -z "$dir" ] && dir="$PWD"
  local out ec
  set +e
  out="$(cd "$dir" && eval "$runcmd" 2>&1)"
  ec=$?
  set -e
  # On a verbose suite, the actual failing assertion can scroll past a blind
  # tail -40, leaving the ledger's permanent record -- the one thing that
  # survives /clear -- without the detail that matters. Prefer lines that
  # look like a failure, with context; fall back to tail -40 on a clean run
  # (nothing to prefer) or exotic output with no recognizable failure marker.
  local excerpt
  # tail, not head: the definitive failure (assertion, root cause, final
  # summary) is almost always the LAST match in verbose output -- a run
  # with 200 benign "0 errors, 0 failures" lines and one real failure at
  # the end must keep the end, not the earliest matches.
  excerpt="$(printf '%s' "$out" | grep -inE -B3 -A3 'fail|error|✗|panic' 2>/dev/null | tail -n 60 || true)"
  if [ -z "$excerpt" ]; then
    excerpt="$(printf '%s' "$out" | tail -n 40)"
  fi
  {
    echo ""
    echo "### $(date -u +%Y-%m-%dT%H:%M:%SZ) — \`$runcmd\` — exit $ec"
    echo '```'
    echo "$excerpt"
    echo '```'
  } >> "$ledger"
  echo "$out"
  echo "bugloop: receipt appended (exit $ec)" >&2
  return "$ec"
}

cmd_baseline() {
  local ledger
  ledger="$(require_active)"
  local dir tc
  dir="$(get_field "$ledger" project_dir)"
  tc="$(get_field "$ledger" test_cmd)"
  [ -z "$dir" ] && dir="$PWD"
  if [ -z "$tc" ] || [ "$tc" = "UNKNOWN" ]; then
    echo "bugloop: no test_cmd set. Run 'bugloop.sh set test_cmd \"<cmd>\"' first." >&2
    exit 1
  fi
  # Per-ledger, not per-project: with --ledger/switch letting two bugs be
  # worked concurrently on one project, a shared $PROJ_DIR/baseline.txt
  # would let one ledger's baseline run silently overwrite another's.
  local baseline_file="${ledger%.md}.baseline.txt"
  set +e
  (cd "$dir" && eval "$tc") > "$baseline_file" 2>&1
  set -e
  cmd_set baseline.captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local failcount
  failcount="$(grep -ciE 'fail' "$baseline_file" || true)"
  cmd_set baseline.failing_tests "${failcount} lines matched 'fail' — see $baseline_file"
  echo "bugloop: baseline captured -> $baseline_file"
}

# Everything below scopes to the '## hypotheses' section only, never the
# whole file -- a receipt block verbatim-embeds command/test output, which
# can easily contain a line that looks like "- [12] ..." (a numbered list,
# a checklist) with nothing to do with an actual hypothesis. Scanning the
# whole ledger for that shape desyncs numbering from what a human expects.
hypotheses_section() {
  local ledger="$1"
  awk '
    /^## / { inhyp = ($0 == "## hypotheses"); next }
    inhyp { print }
  ' "$ledger"
}

count_testing_hypotheses() {
  local ledger="$1"
  hypotheses_section "$ledger" | grep -cE '^- \[[0-9]+\] status=testing' || true
}

# A field value containing a literal newline breaks the awk -v assignments
# below (crashes with a raw, non-'bugloop:'-prefixed error) -- reject it up
# front with a clear message instead of letting awk fail opaquely.
reject_multiline() {
  local label="$1"; shift
  local v
  for v in "$@"; do
    case "$v" in
      *$'\n'*)
        echo "bugloop: $label must be single-line (no embedded newlines) -- ledger fields are one line each" >&2
        exit 2
        ;;
    esac
  done
}

cmd_hypothesis() {
  local sub="${1:-}"
  shift || true
  local ledger
  ledger="$(require_active)"
  case "$sub" in
    add)
      local statement="${1:-}" evidence="${2:-}" falsifier="${3:-}"
      if [ -z "$statement" ] || [ -z "$evidence" ] || [ -z "$falsifier" ]; then
        echo "usage: bugloop.sh hypothesis add \"<statement>\" \"<evidence>\" \"<falsifier>\"" >&2
        exit 2
      fi
      reject_multiline "hypothesis statement/evidence/falsifier" "$statement" "$evidence" "$falsifier"
      local testing_count
      testing_count="$(count_testing_hypotheses "$ledger")"
      if [ "$testing_count" -ge 1 ]; then
        echo "bugloop: refuse -- a hypothesis is already status=testing. Refute or confirm it first (hypothesis refute/confirm <n>)." >&2
        exit 1
      fi
      local maxn
      maxn="$(hypotheses_section "$ledger" | grep -oE '^- \[[0-9]+\]' | grep -oE '[0-9]+' | sort -n | tail -1 || true)"
      [ -z "$maxn" ] && maxn=0
      local n=$((maxn + 1))
      local line="- [$n] status=testing :: $statement :: $evidence :: $falsifier"
      local tmp
      tmp="$(mktemp)"
      awk -v newline="$line" '
        !inserted && /^## patch$/ { print newline; print ""; inserted=1 }
        { print }
      ' "$ledger" > "$tmp"
      mv "$tmp" "$ledger"
      echo "bugloop: hypothesis $n added (status=testing)"
      ;;
    refute|confirm)
      local n="${1:-}"
      if [ -z "$n" ]; then
        echo "usage: bugloop.sh hypothesis $sub <n>" >&2
        exit 2
      fi
      local newstatus
      if [ "$sub" = "refute" ]; then newstatus="refuted"; else newstatus="confirmed"; fi
      if ! hypotheses_section "$ledger" | grep -qE "^- \\[$n\\] status="; then
        echo "bugloop: no hypothesis [$n] found" >&2
        exit 1
      fi
      local tmp
      tmp="$(mktemp)"
      awk -v n="$n" -v ns="$newstatus" '
        /^## / { inhyp = ($0 == "## hypotheses"); print; next }
        {
          if (inhyp && $0 ~ ("^- \\[" n "\\] status=")) {
            sub(/status=[a-zA-Z]+/, "status=" ns)
          }
          print
        }
      ' "$ledger" > "$tmp"
      mv "$tmp" "$ledger"
      echo "bugloop: hypothesis $n -> status=$newstatus"
      ;;
    *)
      echo "usage: bugloop.sh hypothesis add|refute|confirm ..." >&2
      exit 2
      ;;
  esac
}

gate_missing() {
  local ledger="$1"; shift
  local missing=()
  for field in "$@"; do
    local v
    v="$(get_field "$ledger" "$field")"
    if [ -z "$v" ]; then
      missing+=("$field")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    printf '%s\n' "${missing[*]}"
    return 1
  fi
  return 0
}

cmd_gate() {
  local target="$1"
  local ledger
  ledger="$(require_active)"
  # collect problems into one array; each case appends, never overwrites
  local problems=()

  add_missing_fields() {
    local m
    m="$(gate_missing "$ledger" "$@" || true)"
    if [ -n "$m" ]; then
      problems+=("$m")
    fi
    return 0
  }

  case "$target" in
    REPRO)
      add_missing_fields state
      ;;
    LOCATE)
      add_missing_fields repro.test_cmd repro.failing_output baseline.captured_at
      ;;
    HYPOTHESIZE)
      local sites
      sites="$(get_field "$ledger" locate.sites)"
      if [ -z "$sites" ] && ! grep -qiE '^state: *(UNREPRODUCED|NOT_A_BUG)' "$ledger" 2>/dev/null; then
        problems+=("locate.sites (or state=UNREPRODUCED/NOT_A_BUG)")
      fi
      ;;
    PATCH)
      local testing_count
      testing_count="$(count_testing_hypotheses "$ledger")"
      if [ "$testing_count" -ne 1 ]; then
        problems+=("exactly-one hypothesis[status=testing] required (found $testing_count)")
      fi
      add_missing_fields repro.test_cmd repro.failing_output baseline.captured_at
      ;;
    VERIFY)
      add_missing_fields patch.files_changed
      ;;
    REVIEW)
      grep -qE '^verify\.focused: *PASS' "$ledger" || problems+=("verify.focused=PASS required")
      grep -qE '^verify\.baseline_diff: *CLEAN' "$ledger" || problems+=("verify.baseline_diff=CLEAN required")
      ;;
    LANDED)
      add_missing_fields review.verdict
      ;;
    *)
      echo "bugloop: unknown gate target '$target'" >&2
      exit 2
      ;;
  esac

  if [ "${#problems[@]}" -gt 0 ]; then
    echo "GATE FAIL -> $target"
    printf 'missing: %s\n' "${problems[@]}"
    exit 1
  fi
  echo "GATE PASS -> $target"
}

cmd_resume() {
  if [ ! -f "$ACTIVE_FILE" ]; then
    exit 0
  fi
  local ledger
  ledger="$(active_ledger_path)"
  [ -z "$ledger" ] || [ ! -f "$ledger" ] && exit 0
  local state
  state="$(grep -m1 '^state:' "$ledger" | sed 's/^state: *//')"
  if [ "$state" = "LANDED" ]; then
    exit 0
  fi
  echo "bugloop: open ledger found — state=$state"
  echo "ledger: $ledger"
  local pending answer
  pending="$(get_field "$ledger" pending.question)"
  answer="$(get_field "$ledger" pending.answer)"
  if [ -n "$pending" ] && [ -n "$answer" ]; then
    echo "ANSWERED, NOT YET ACTED ON: \"$pending\" -> \"$answer\""
  elif [ -n "$pending" ]; then
    echo "UNANSWERED QUESTION: $pending"
  fi
  echo "--- summary ---"
  sed -n '1,10p' "$ledger"
  echo "..."
  echo "Resume with the bugloop skill; do not restart from scratch."
}

cmd_nag() {
  if [ ! -f "$ACTIVE_FILE" ]; then
    exit 0
  fi
  local ledger
  ledger="$(active_ledger_path)"
  [ -z "$ledger" ] || [ ! -f "$ledger" ] && exit 0
  local state
  state="$(grep -m1 '^state:' "$ledger" | sed 's/^state: *//')"

  # Tier 1: truly done, no exceptions. A closed bug never nags again, even
  # if a pending.* field was somehow left stale (e.g. an orchestrator that
  # slipped straight to `set state NOT_A_BUG` without going through
  # `pending clear` first -- a documentation-discipline gap, not something
  # the engine enforces, so this stays defensive).
  case "$state" in
    LANDED|NOT_A_BUG|"")
      exit 0
      ;;
  esac

  # Tier 2: an answered-but-unacted question is always worth surfacing for
  # any state that reaches here -- including BLOCKED_NEEDS_HUMAN and
  # ARCHITECTURE_QUESTION, which are themselves pending-question triggers,
  # so an answer arriving for THEIR question is exactly what should break
  # tier 3's silence for them below.
  local pending answer
  pending="$(get_field "$ledger" pending.question)"
  answer="$(get_field "$ledger" pending.answer)"
  if [ -n "$pending" ] && [ -n "$answer" ]; then
    echo "bugloop: answered, not yet acted on (state=$state) — \"$pending\" -> \"$answer\""
    return 0
  fi

  # Tier 3: paused, waiting on a human, but nothing new to report yet.
  case "$state" in
    BLOCKED_NEEDS_HUMAN|ARCHITECTURE_QUESTION)
      exit 0
      ;;
    *)
      if [ -n "$pending" ]; then
        echo "bugloop: unanswered question (state=$state) — $pending"
      else
        echo "bugloop: ledger still open (state=$state) — $ledger"
      fi
      ;;
  esac
}

cmd_list() {
  if [ ! -d "$ROOT" ]; then
    echo "no bugloop ledgers yet"
    exit 0
  fi
  find "$ROOT" -name '*.md' -maxdepth 2 2>/dev/null
}

cmd_dashboard() {
  local port="${BUGLOOP_DASHBOARD_PORT:-4577}"
  if [ "${1:-}" = "--port" ]; then
    port="${2:-$port}"
  elif [ -n "${1:-}" ]; then
    port="$1"
  fi

  # dashboard/ is a sibling of skills/ -- resolved relative to this
  # script's own location (not .engine_root/cwd) so it always matches
  # whichever install of bugloop is actually running this command.
  local script_dir dash_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  dash_dir="$(cd "$script_dir/../../../dashboard" 2>/dev/null && pwd || true)"
  if [ -z "$dash_dir" ] || [ ! -f "$dash_dir/server.js" ]; then
    echo "bugloop: dashboard/ not found next to this engine (expected near $script_dir)" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "bugloop: node is required to run the dashboard (not found on PATH)" >&2
    exit 1
  fi

  if [ ! -d "$dash_dir/node_modules" ]; then
    echo "bugloop: installing dashboard dependencies (first run only)..." >&2
    if ! (cd "$dash_dir" && npm install --silent); then
      echo "bugloop: npm install failed" >&2
      exit 1
    fi
  fi

  echo "bugloop: starting dashboard on port $port (Ctrl+C to stop)"
  cd "$dash_dir"
  BUGLOOP_DASHBOARD_PORT="$port" exec node server.js
}

# The dashboard's "spawn a new bug" feature reads this allowlist to decide
# which directories it may run an autonomous session in -- it never writes
# to this file itself. Only a terminal (a human) can expand what the web
# UI is allowed to touch. See dashboard/lib/session-runner.js.
cmd_dashboard_allow() {
  local path="${1:-}"
  if [ -z "$path" ]; then
    echo "usage: bugloop.sh dashboard-allow <path>" >&2
    exit 2
  fi
  local abs
  abs="$(cd "$path" 2>/dev/null && pwd || true)"
  if [ -z "$abs" ]; then
    echo "bugloop: not a directory: $path" >&2
    exit 1
  fi
  mkdir -p "$ROOT"
  local list="$ROOT/dashboard-projects.txt"
  touch "$list"
  if grep -qxF "$abs" "$list" 2>/dev/null; then
    echo "bugloop: already allowed: $abs"
    return 0
  fi
  echo "$abs" >> "$list"
  echo "bugloop: dashboard may now spawn bugs in: $abs"
}

cmd_dashboard_disallow() {
  local path="${1:-}"
  if [ -z "$path" ]; then
    echo "usage: bugloop.sh dashboard-disallow <path>" >&2
    exit 2
  fi
  local abs
  abs="$(cd "$path" 2>/dev/null && pwd || true)"
  [ -z "$abs" ] && abs="$path"
  local list="$ROOT/dashboard-projects.txt"
  if [ ! -f "$list" ]; then
    echo "bugloop: no allowlist yet"
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  grep -vxF "$abs" "$list" > "$tmp" || true
  mv "$tmp" "$list"
  echo "bugloop: removed (if present): $abs"
}

cmd_switch() {
  local query="${1:-}"
  if [ -z "$query" ]; then
    echo "usage: bugloop.sh switch <id-or-partial-match>" >&2
    exit 2
  fi
  mkdir_proj
  local matches
  matches="$(find "$PROJ_DIR" -maxdepth 1 -name "*${query}*.md" 2>/dev/null || true)"
  local count
  count="$(printf '%s\n' "$matches" | grep -c . || true)"
  if [ "$count" -eq 0 ]; then
    echo "bugloop: no ledger matching '$query' in $PROJ_DIR" >&2
    exit 1
  fi
  if [ "$count" -gt 1 ]; then
    echo "bugloop: ambiguous match for '$query' -- multiple ledgers:" >&2
    printf '%s\n' "$matches" >&2
    exit 1
  fi
  local ledger="$matches"
  local id
  id="$(basename "$ledger" .md)"
  write_json "$ACTIVE_FILE" "$(jq -n --arg l "$ledger" --arg id "$id" '{ledger:$l, id:$id}')"
  echo "bugloop: switched active ledger -> $ledger"
}

# Owns pending.question/pending.context/pending.asked_at as one atomic unit
# -- same reasoning as the hypothesis subcommand family: three fields that
# always change together are a bug waiting to happen as three separate
# `set` calls a caller has to remember every time. Here specifically:
# docs/prose asking for pending.question + pending.context but never
# pending.asked_at is exactly the kind of drift this replaces.
cmd_pending() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    ask)
      local question="${1:-}" context="${2:-}"
      if [ -z "$question" ]; then
        echo "usage: bugloop.sh pending ask \"<question>\" \"<context>\"" >&2
        exit 2
      fi
      # cmd_set independently rejects multiline values for each field below.
      # Reset pending.answer too -- a brand-new question can't already have
      # a valid answer, so any value sitting there is necessarily stale
      # (e.g. a session exited after the dashboard recorded an answer but
      # before `pending clear` ran). Leaving it would attach an old answer
      # to a new, unrelated question.
      cmd_set pending.question "$question" >/dev/null
      cmd_set pending.context "$context" >/dev/null
      cmd_set pending.asked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
      cmd_set pending.answer "" >/dev/null
      echo "bugloop: pending question recorded"
      ;;
    clear)
      cmd_set pending.question "" >/dev/null
      cmd_set pending.context "" >/dev/null
      cmd_set pending.asked_at "" >/dev/null
      cmd_set pending.answer "" >/dev/null
      echo "bugloop: pending question cleared"
      ;;
    answer)
      local answer="${1:-}"
      if [ -z "$answer" ]; then
        echo "usage: bugloop.sh pending answer \"<answer text>\"" >&2
        exit 2
      fi
      # Records the answer only -- does NOT clear pending.question or act
      # on it. That's deliberate: something not writing code (a human via
      # the dashboard, a script) can record what was decided, but only the
      # orchestrator actually driving the loop interprets it and clears the
      # question once it has genuinely acted on the answer.
      cmd_set pending.answer "$answer" >/dev/null
      echo "bugloop: pending answer recorded (not yet cleared -- orchestrator must act on it)"
      ;;
    *)
      echo "usage: bugloop.sh pending ask|answer|clear ..." >&2
      exit 2
      ;;
  esac
}

main() {
  # Strip a LEADING --ledger <path> global flag, before the subcommand name
  # only -- once a subcommand starts, its own arguments are never inspected
  # or touched, so a hypothesis statement, pending.question text, etc. that
  # happens to equal the literal string "--ledger" can't be misread as the
  # flag.
  while [ "$#" -gt 0 ] && [ "$1" = "--ledger" ]; do
    LEDGER_OVERRIDE="${2:-}"
    shift 2
  done

  local sub="${1:-}"
  shift || true
  case "$sub" in
    init) cmd_init "$@" ;;
    state) cmd_state "$@" ;;
    set) cmd_set "$@" ;;
    receipt) cmd_receipt "$@" ;;
    baseline) cmd_baseline "$@" ;;
    hypothesis) cmd_hypothesis "$@" ;;
    switch) cmd_switch "$@" ;;
    pending) cmd_pending "$@" ;;
    gate) cmd_gate "$@" ;;
    resume) cmd_resume "$@" ;;
    nag) cmd_nag "$@" ;;
    list) cmd_list "$@" ;;
    dashboard) cmd_dashboard "$@" ;;
    dashboard-allow) cmd_dashboard_allow "$@" ;;
    dashboard-disallow) cmd_dashboard_disallow "$@" ;;
    *)
      cat >&2 <<USAGE
usage: bugloop.sh [--ledger <path>] <subcommand> [args]
  init "<desc>"          create new ledger, set active
  state                   print current state of active ledger
  set <field> <value>     write a field
  receipt "<cmd>"         run cmd, append receipt (stdout+exit) to ledger
  baseline                run test_cmd, capture full-suite baseline
  hypothesis add "<s>" "<e>" "<f>"   add a testing hypothesis (refuses if one is already testing)
  hypothesis refute|confirm <n>      flip a hypothesis's status
  switch <id-or-partial-match>       repoint active.json at an existing ledger
  pending ask "<question>" "<context>"   record a durable pending question (all 3 fields, atomically)
  pending answer "<text>"                record an answer (e.g. from the dashboard) without acting on it
  pending clear                          clear all 4 pending fields after the answer has been acted on
  gate <target-state>     check required fields before transition
  resume                  print open-ledger summary (SessionStart hook)
  nag                     warn if ledger open and not terminal (Stop hook)
  list                    list all ledgers
  dashboard [--port N]    start the local web dashboard (monitor + answer pending decisions)
  dashboard-allow <path>    let the dashboard spawn new bugs in <path> (terminal-only)
  dashboard-disallow <path> revoke that

  --ledger <path> (or BUGLOOP_LEDGER env var) targets any subcommand at a
  specific ledger directly, without touching active.json.
USAGE
      exit 2
      ;;
  esac
}

main "$@"
