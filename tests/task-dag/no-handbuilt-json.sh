#!/usr/bin/env bash
# Regression guard for epic #10 ("eliminate hand-built JSON (and YAML) in the
# task-dag CLI and scripts"). It FAILS if a hand-built JSON/YAML *construction*
# idiom reappears in scripts/ or .github/scripts/ — the class of bug that has
# repeatedly taken the dispatcher out: an unescaped quote, backslash, or
# newline interpolated straight into a JSON document silently corrupts it, the
# launcher's `jq` parse fails closed, and the whole repo is skipped every cycle.
#
# CONTRACT — this guard is intentionally NOT a shell/JSON parser. It prevents
# *reintroduction* of the known bad construction idioms. Whether the APPROVED
# emitters actually escape their values correctly is proven DYNAMICALLY by the
# adversarial round-trip tests (emitter-json.sh, frontier-json.sh,
# blocked-json.sh, delegated-block-json.sh): those feed values containing
# quotes/backslashes/newlines through the real emitters and assert the output
# parses under `jq -e` and round-trips verbatim. This static guard and those
# dynamic tests are complementary halves of the same gate.
#
# Detectors (each violation must be on the explicit ALLOWLIST below or fail):
#   R1  Double-quoted escaped-key JSON construction: an echo/printf whose
#       string contains `\"key\":`. The APPROVED serialization idiom uses a
#       SINGLE-quoted printf format (`printf '{"k":%s}' "$(json_escape "$v")"`)
#       so it never contains `\"`; a `\"key\":` therefore means JSON is being
#       assembled inside a double-quoted, interpolation-prone shell string.
#   R2  `$` interpolation inside a single-quoted printf JSON format string
#       (`printf '{...$foo...}'`) — a value pasted into the format instead of
#       fed through a `%s`/`%d` conversion from an escaped argument.
#   R3  YAML/Python regression from the delegated_to conversion (leaf @4):
#       any non-comment `python`/`python3` invocation or a `<<PY` heredoc. The
#       delegated_to block is now emitted/consumed with jq; hand-rolled YAML
#       via embedded Python must not come back.
#   R4  JSON heredocs (`cat <<JSON …`): allowed only as explicitly reviewed
#       exceptions, pinned by a hash of the heredoc body. These are the
#       fixed-structure, byte-preserving `--json` emitters whose every
#       interpolated value already goes through json_escape / json_int_or_null
#       / json_number_or_null / json_str_or_null / json_str_array (or is an
#       internal boolean literal). A NEW or EDITED JSON heredoc changes the
#       hash and trips this guard on purpose: any change to a golden `--json`
#       emitter must be re-reviewed (and its golden fixture updated) before its
#       hash is re-pinned here.
#
# Constant no-interpolation literals (e.g. `echo '{"treeFix":false}'`, the JWT
# header `printf '{"alg":"RS256","typ":"JWT"}'`) are single-quoted with no `\"`
# and no `$`, so no detector matches them and they need no allowlist entry.
#
# Usage: no-handbuilt-json.sh [--print-heredoc-hashes] [PATH_TO_task-dag_CLI]
set -uo pipefail

# Handle the R4 re-pinning helper BEFORE deriving TD, so the flag is never
# mistaken for the CLI path.
PRINT_HEREDOC_HASHES=false
if [ "${1:-}" = "--print-heredoc-hashes" ]; then
    PRINT_HEREDOC_HASHES=true
    shift
fi

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
REPO="$(cd "$(dirname "$TD")/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required"; echo "PASS=0 FAIL=1"; exit 1; }

# ---------------------------------------------------------------------------
# In-scope files: the shell that emits/consumes JSON/YAML for the dispatcher.
# ---------------------------------------------------------------------------
in_scope_files() {
    local f
    for f in "$REPO/scripts/task-dag" \
             "$REPO/scripts/"*.sh \
             "$REPO/scripts/task-dag.d/"*.sh \
             "$REPO/.github/scripts/"*.sh; do
        [ -f "$f" ] && printf '%s\n' "$f"
    done
}

# Strip a path down to a repo-relative label for stable, readable output.
rel() { printf '%s\n' "${1#"$REPO"/}"; }

# lstrip helper.
lstrip() { local s="$1"; printf '%s' "${s#"${s%%[![:space:]]*}"}"; }

# ---------------------------------------------------------------------------
# ALLOWLIST
# ---------------------------------------------------------------------------
# R1: the `deps --json` object in scripts/task-dag is a deliberately
# hand-structured, byte-preserving emitter (leaf @1, Oracle-approved): its keys
# are constant literals and its only interpolated values are hardened —
# `blockedAncestor` via json_str_or_null, `allMet` is an internal true/false
# literal, and the per-dependency entries are emitted by an allowlisted JSON
# heredoc (R4) whose values go through json_escape. Rewriting it to jq would
# change the golden `--json` bytes the dispatcher and fixtures depend on.
# Matched by exact trimmed line content (line numbers drift; content does not).
R1_ALLOW=(
'echo "{\"dependencies\": [], \"allMet\": true, \"blockedAncestor\": $blocked_ancestor_json}"'
'echo "  \"dependencies\": ["'
'echo "  \"allMet\": $all_met,"'
'echo "  \"blockedAncestor\": $blocked_ancestor_json"'
)

# R4: sha256 of each approved JSON-heredoc body (scripts/task-dag). Re-pin only
# after re-reviewing the emitter AND updating its golden fixture. To recompute:
#   bash tests/task-dag/no-handbuilt-json.sh --print-heredoc-hashes
R4_ALLOW=(
'ede201cbde149d318fd88bd0c01fe0ed2ecec523d0783889bfa5b2e5523136de'  # task-dag `list --json` entry
'2b381e104b153954a22e68c8a502be1df0fd8251ebd68020f9acc104a924b30e'  # reap `--json` entry
'e3b00b50fec75e79f2e6fb0fe3d3fb33645131d7cc3f3d0c3eeafe88f9b3c5d1'  # show `--json` object
'3f4e3f16bb1877bf733d467d32f0d92cf9a16038a5f4d8c8ae4d5376d7c33fa7'  # deps `--json` dependency entry
)

in_allow() { local needle="$1"; shift; local x; for x in "$@"; do [ "$x" = "$needle" ] && return 0; done; return 1; }

# ---------------------------------------------------------------------------
# Detectors. Each prints "<rel-file>:<lineno>\t<trimmed>" for a raw finding.
# One `grep -nE` pass per file keeps the whole suite fast; comment lines (first
# non-blank char `#`) are dropped in _emit.
# ---------------------------------------------------------------------------

# Turn `grep -nE` output ("<lineno>:<raw>") into "<rel-file>:<lineno>\t<trimmed>",
# skipping comment lines.
_emit() { # $1=file
    local file="$1" n raw t line
    while IFS= read -r line; do
        n="${line%%:*}"; raw="${line#*:}"
        t="$(lstrip "$raw")"
        [ "${t:0:1}" = "#" ] && continue
        printf '%s:%s\t%s\n' "$(rel "$file")" "$n" "$t"
    done
}

# R1 — double-quoted escaped-key JSON construction.
scan_r1() {
    grep -nE '(echo|printf).*\\"[A-Za-z_][A-Za-z0-9_]*\\"[[:space:]]*:' "$1" 2>/dev/null | _emit "$1"
}

# R2 — `$` interpolated into a single-quoted printf JSON format string.
scan_r2() {
    grep -nE "printf[[:space:]]+'[^']*\{[^']*\\\$[^']*'" "$1" 2>/dev/null | _emit "$1"
}

# R3 — Python invocation / PY heredoc (hand-rolled YAML regression).
scan_r3() {
    grep -nE "(^|[[:space:]|;&(])python3?([[:space:]]|\$)|<<-?'?PY([^A-Za-z0-9_]|\$)" "$1" 2>/dev/null | _emit "$1"
}

# R4 — JSON heredocs: emit "<sha>\t<rel-file>:<start-line>" per `<<JSON` body.
scan_r4() {
    local file="$1" n=0 inb=0 body="" start=0 line trimmed
    while IFS= read -r line || [ -n "$line" ]; do
        n=$((n+1))
        if [ "$inb" = 1 ]; then
            trimmed="$(lstrip "$line")"
            if [ "$trimmed" = "JSON" ]; then
                printf '%s\t%s:%s\n' \
                    "$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)" \
                    "$(rel "$file")" "$start"
                inb=0; body=""
                continue
            fi
            body+="$line"$'\n'
        elif [[ "$line" =~ \<\<-?\'?JSON\'?([^A-Za-z0-9_]|$) ]]; then
            inb=1; body=""; start="$n"
        fi
    done < "$file"
}

# Optional helper: recompute the R4 hashes (for re-pinning after a reviewed
# change). Invoked with --print-heredoc-hashes.
if [ "$PRINT_HEREDOC_HASHES" = true ]; then
    while IFS= read -r f; do scan_r4 "$f"; done < <(in_scope_files)
    exit 0
fi

# ---------------------------------------------------------------------------
# Run detectors over the in-scope files.
# ---------------------------------------------------------------------------
violations=0
report() { echo "  $1"; violations=$((violations+1)); }

while IFS= read -r f; do
    # R1 / R2 / R3: line-level, allowlist by trimmed content.
    while IFS=$'\t' read -r loc content; do
        [ -z "${loc:-}" ] && continue
        in_allow "$content" "${R1_ALLOW[@]}" && continue
        report "R1 hand-built double-quoted JSON: $loc  ->  $content"
    done < <(scan_r1 "$f")

    while IFS=$'\t' read -r loc content; do
        [ -z "${loc:-}" ] && continue
        report "R2 interpolation in single-quoted printf JSON format: $loc  ->  $content"
    done < <(scan_r2 "$f")

    while IFS=$'\t' read -r loc content; do
        [ -z "${loc:-}" ] && continue
        report "R3 Python/YAML-heredoc regression: $loc  ->  $content"
    done < <(scan_r3 "$f")

    # R4: heredoc bodies, allowlist by body hash.
    while IFS=$'\t' read -r h loc; do
        [ -z "${h:-}" ] && continue
        in_allow "$h" "${R4_ALLOW[@]}" && continue
        report "R4 unreviewed JSON heredoc (body hash $h): $loc"
    done < <(scan_r4 "$f")
done < <(in_scope_files)

if [ "$violations" -eq 0 ]; then
    ok "no hand-built JSON/YAML construction outside the reviewed allowlist"
else
    bad "$violations hand-built JSON/YAML finding(s) not on the allowlist (see above)"
fi

# ---------------------------------------------------------------------------
# Self-tests: the detectors must actually FIRE on known-bad input and stay
# QUIET on the approved safe idioms, so the guard cannot silently rot into an
# always-pass no-op.
# ---------------------------------------------------------------------------
SB="$(mktemp)"; trap 'rm -f "$SB"' EXIT
cat > "$SB" <<'BAD'
#!/usr/bin/env bash
echo "{\"ok\":false,\"reason\":\"nope\",\"sha\":\"$task_sha\"}"
printf '{"repo":$repo}\n'
python3 - <<'PY'
print("no")
PY
cat <<JSON
{"title": "$raw_title"}
JSON
BAD
[ -n "$(scan_r1 "$SB")" ] && ok "self-test: R1 fires on bad double-quoted JSON" || bad "self-test: R1 missed bad input"
[ -n "$(scan_r2 "$SB")" ] && ok "self-test: R2 fires on interpolated printf format" || bad "self-test: R2 missed bad input"
[ -n "$(scan_r3 "$SB")" ] && ok "self-test: R3 fires on python/PY heredoc" || bad "self-test: R3 missed bad input"
badhash="$(scan_r4 "$SB" | cut -f1)"
{ [ -n "$badhash" ] && ! in_allow "$badhash" "${R4_ALLOW[@]}"; } \
    && ok "self-test: R4 flags a new/unreviewed JSON heredoc" || bad "self-test: R4 missed new heredoc"

SG="$(mktemp)"; trap 'rm -f "$SB" "$SG"' EXIT
cat > "$SG" <<'GOOD'
#!/usr/bin/env bash
printf '{"ok":%s,"reason":%s}\n' "$ok" "$(json_escape "$reason")"
echo '{"treeFix":false}'
printf '{"alg":"RS256","typ":"JWT"}'
echo "Error: duplicate Tree-Fix trailers (fix=${x:-0})" >&2
GOOD
{ [ -z "$(scan_r1 "$SG")" ] && [ -z "$(scan_r2 "$SG")" ] && [ -z "$(scan_r3 "$SG")" ] && [ -z "$(scan_r4 "$SG")" ]; } \
    && ok "self-test: safe idioms + constant literals + messages are NOT flagged" \
    || bad "self-test: a safe idiom was wrongly flagged"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
