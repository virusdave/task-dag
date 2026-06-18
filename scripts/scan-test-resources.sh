#!/usr/bin/env bash
# Test-resource scanner (fleet-green epic, Phase D.11 — automation#49).
#
# Fails (exit 1) if any *committed* test file reaches for a production
# serving resource. Canon (rules/QUALITY_GATES.md, rules/SAFETY.md) is
# absolute: "No test, smoke check, or example may use a prod DB, live
# server, prod backend, or prod credential." A test that can reach prod
# is a latent way to corrupt or read live data from the test runner —
# which on this host (vps-nixos-3) has full prod access — so we gate it.
#
# It flags three classes of regression in committed test files:
#
#   1. Ambient-env fallbacks. `process.env.X ??= …` / `||= …` mutate the
#      ambient environment only when unset, so on a host where prod
#      config is already exported (the helios prod box) the test silently
#      inherits the PROD value. Same trap for a fallback *read* of a
#      sensitive var: `process.env.DATABASE_URL ?? '…'` (or `|| '…'`)
#      prefers the ambient prod value when present. Tests must force an
#      explicit test-only value, never fall back to ambient prod. (Plain
#      fallback reads of non-sensitive vars like `process.env.PORT ?? …`
#      are NOT flagged — only the curated sensitive vars below.)
#   2. Live connection strings. A DB / broker URL
#      (`postgres|postgresql|mysql|mariadb|mongodb|mongodb+srv|redis|
#      rediss|amqp|amqps://…`) whose host is NOT a loopback address or an
#      RFC-2606 / RFC-6761 reserved placeholder (`localhost`, `127.x`,
#      `0.0.0.0`, `::1`, or any host containing an `example` / `invalid`
#      / `test` / `localhost` label). Anything else is a real,
#      potentially-prod endpoint and is flagged.
#   3. Real credential material. A path into the host secret store
#      (`…/.secret/…`) or the live TigerData credentials file
#      (`tiger-cloud-db-<digits>…`). Tests must inline fake fixture text,
#      never read the real on-disk secret.
#
# What is scanned: the git INDEX (`git grep --cached`), i.e. exactly the
# content a commit would record — not stray unstaged working-tree edits.
# After a fresh checkout (CI) the index equals HEAD, so the same script
# doubles as the CI scanners-job gate (advisory; branch protection
# unavailable on this repo — see AGENTS.md). Scope is git-tracked, first-party
# test files only (`*.test.*`, `*.spec.*`, and `**/__tests__/**`);
# node_modules / dist / build output are never tracked so never scanned.
# Run from anywhere in the repo. All three classes are reported even
# though any one is enough to fail.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# This scanner's own source (and its shell self-test) obviously contains
# the very patterns it hunts for; never scan them. They are *.sh, not
# TS/JS test files, so they are naturally out of the test-file globs
# below — but exclude them explicitly for defence in depth.
self_rel="scripts/scan-test-resources.sh"
self_test_rel="scripts/scan-test-resources.test.sh"

# git-tracked first-party test files. Kept in one array so every class
# scans exactly the same surface.
test_globs=(
  '*.test.ts' '*.test.tsx' '*.test.mts' '*.test.cts'
  '*.test.js' '*.test.jsx' '*.test.mjs' '*.test.cjs'
  '*.spec.ts' '*.spec.tsx' '*.spec.mts' '*.spec.cts'
  '*.spec.js' '*.spec.jsx' '*.spec.mjs' '*.spec.cjs'
  '**/__tests__/**' '__tests__/**'
  ":!${self_rel}" ":!${self_test_rel}"
)

fail=0
note() { echo "  $1" >&2; }

# git grep wrapper that scans the staged index and FAILS CLOSED: exit 0
# (matches) prints them, exit 1 (no matches) is silent success, anything
# else is a real Git error and aborts the gate rather than passing it.
git_grep_cached() {
  local out status
  set +e
  out="$(git grep --cached -nE "$@")"
  status=$?
  set -e
  case "$status" in
    0) printf '%s\n' "$out" ;;
    1) : ;;
    *) echo "ERROR: 'git grep --cached -nE $*' failed (status $status)" >&2; exit "$status" ;;
  esac
}

# Drop comment-only lines from "path:lineno:code" grep output, so a URL
# or token that merely appears in a comment is not flagged as a live
# connection. Reads stdin, writes the surviving lines to stdout.
strip_comment_lines() {
  local line code trimmed
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    code="${line#*:}"; code="${code#*:}"          # drop "path:lineno:"
    trimmed="${code#"${code%%[![:space:]]*}"}"    # left-trim whitespace
    case "$trimmed" in
      '#'*|'//'*|'/*'*|'*'*|'<!--'*) : ;;         # comment line → ignore
      *) printf '%s\n' "$line" ;;
    esac
  done
}

# DB/broker URL schemes. Kept in one var so the cheap prefilter grep and
# the precise host extractor scan the SAME scheme set (a mismatch there
# is how `mongodb+srv://` URLs would slip past the prefilter).
conn_scheme_re='(postgres|postgresql|mysql|mariadb|mongodb|mongodb\+srv|redis|rediss|amqp|amqps)://'

# is_allowed_test_host <host> → 0 if the host is a loopback address or an
# RFC-2606 / RFC-6761 reserved DOCUMENTATION placeholder, else 1. Matching
# is label-based (dot-anchored), not substring, so a real host that merely
# *contains* a placeholder word — `db.notexample.com`, `invalid-prod.co` —
# is still treated as a live endpoint and flagged.
is_allowed_test_host() {
  local h dotted
  h="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$h" in
    ''|localhost|127.*|0.0.0.0|::1) return 0 ;;          # loopback / empty
  esac
  dotted=".$h."                                           # anchor both ends
  case "$dotted" in
    *.example.*|*.invalid.*|*.test.*|*.localhost.*) return 0 ;;
  esac
  return 1
}

# Given "path:lineno:code" lines on stdin, emit only those whose code
# embeds a DB/broker connection URL pointing at a non-loopback,
# non-placeholder host. Robust to multiple URLs per line.
flag_live_conn_urls() {
  local url_re="${conn_scheme_re}"'[^"'"'"'[:space:]`,)]+'
  local line code u host offending
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    code="${line#*:}"; code="${code#*:}"          # drop "path:lineno:"
    offending=0
    # Extract every URL token on the line.
    while IFS= read -r u; do
      [ -n "$u" ] || continue
      host="${u#*://}"            # drop scheme://
      host="${host##*@}"          # drop optional user[:pass]@
      case "$host" in
        '['*) host="${host#\[}"; host="${host%%\]*}" ;;  # [IPv6]
        *)    host="${host%%[:/?#]*}" ;;                  # drop :port /path ?q #frag
      esac
      if ! is_allowed_test_host "$host"; then offending=1; fi
    done < <(printf '%s\n' "$code" | grep -oE "$url_re" || true)
    if [ "$offending" -eq 1 ]; then printf '%s\n' "$line"; fi
  done
  return 0
}

# is_sensitive_env <VAR_NAME> → 0 if the env var name names a credential /
# connection secret, else 1. Segment-based (split on `_`) so `API_KEY`,
# `OAUTH2_CLIENT_SECRET`, `SWEED_AUTH_TOKEN` match while `MONKEY`,
# `SECRETARY`, `PORT` do not. `DATABASE_URL` / `DB_URL` are whole-name
# special cases (neither segment is sensitive on its own).
is_sensitive_env() {
  local name seg
  name="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  case "_${name}_" in
    *_DATABASE_URL_*|*_DB_URL_*|*_CONNECTION_STRING_*|*_DSN_*) return 0 ;;
  esac
  local IFS='_'
  for seg in $name; do
    case "$seg" in
      PASSWORD|PASSWD|PASS|SECRET|SECRETS|TOKEN|TOKENS|\
CREDENTIAL|CREDENTIALS|KEY|KEYS|APIKEY) return 0 ;;
    esac
  done
  return 1
}

# Given "path:lineno:code" lines on stdin (already broadly matched as a
# `process.env.X ??/|| …` fallback read), emit only those whose env var is
# sensitive. Handles dot (`process.env.FOO`) and bracket
# (`process.env['FOO']`) access, multiple per line.
flag_sensitive_env_fallback() {
  local read_re='process\.env(\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^]]+\])[[:space:]]*(\?\?|\|\|)'
  local line code tok name offending
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    code="${line#*:}"; code="${code#*:}"          # drop "path:lineno:"
    offending=0
    while IFS= read -r tok; do
      [ -n "$tok" ] || continue
      name="${tok#*process.env}"                  # strip up to process.env
      case "$name" in
        \[*) name="${name#\[}"; name="${name%%\]*}"
             name="${name//[\'\"[:space:]]/}" ;;  # bracket: strip quotes/space
        .*)  name="${name#.}"
             name="${name%%[^A-Za-z0-9_\$]*}" ;;  # dot: take the identifier
        *)   name="" ;;
      esac
      if [ -n "$name" ] && is_sensitive_env "$name"; then offending=1; fi
    done < <(printf '%s\n' "$code" | grep -oE "$read_re" || true)
    if [ "$offending" -eq 1 ]; then printf '%s\n' "$line"; fi
  done
  return 0
}

# ---------------------------------------------------------------------------
# 1. Ambient-env fallbacks in tests.
# ---------------------------------------------------------------------------
echo "==> 1/3 ambient-env fallbacks (??= / ||= and sensitive ?? / || reads)"
# 1a: mutate-ambient-if-unset on process.env — always wrong in a test
#     (it inherits the ambient prod value whenever one is already set).
mutate_re='process\.env(\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^]]+\])[[:space:]]*(\?\?=|\|\|=)'
mutate_hits="$(git_grep_cached -e "$mutate_re" -- "${test_globs[@]}" | strip_comment_lines)"
# 1b: fallback *read* of a SENSITIVE var — prefers ambient prod value.
#     Grep broadly for any `process.env.X ??/|| …`, then keep only the
#     sensitive var names (post-filtered in flag_sensitive_env_fallback)
#     so `process.env.PORT ?? '3000'` and friends stay green.
read_fallback_re='process\.env(\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^]]+\])[[:space:]]*(\?\?|\|\|)[^=]'
sensitive_hits="$(
  git_grep_cached -e "$read_fallback_re" -- "${test_globs[@]}" \
    | strip_comment_lines | flag_sensitive_env_fallback
)"
env_hits="$(printf '%s\n%s\n' "$mutate_hits" "$sensitive_hits" | grep -v '^$' || true)"
if [ -n "$env_hits" ]; then
  note "FAIL: tests must force explicit test-only config, not fall back to ambient prod env:"
  printf '%s\n' "$env_hits" | sed 's/^/    /' >&2
  fail=1
else
  echo "  ok"
fi

# ---------------------------------------------------------------------------
# 2. Live (non-loopback, non-placeholder) connection strings in tests.
# ---------------------------------------------------------------------------
echo "==> 2/3 live DB / broker connection strings"
conn_hits="$(
  git_grep_cached -e "$conn_scheme_re" -- "${test_globs[@]}" \
    | strip_comment_lines | flag_live_conn_urls
)"
if [ -n "$conn_hits" ]; then
  note "FAIL: tests point at a non-loopback DB/broker host (use localhost / an ephemeral test resource):"
  printf '%s\n' "$conn_hits" | sed 's/^/    /' >&2
  fail=1
else
  echo "  ok"
fi

# ---------------------------------------------------------------------------
# 3. Real credential material referenced from tests.
# ---------------------------------------------------------------------------
echo "==> 3/3 real credential paths (.secret/ store, TigerData creds file)"
# Catches `/…/.secret/…` and `~/.secret/…` paths, a quoted `'.secret'`
# path *component* (e.g. path.join(os.homedir(), '.secret', …)), and the
# live TigerData credentials filename (`tiger-cloud-db-…`, even when the
# trailing id is built dynamically).
cred_hits="$(
  git_grep_cached -e '\.secret/' -e '["'"'"']\.secret["'"'"']' -e 'tiger-cloud-db-' \
    -- "${test_globs[@]}" \
    | strip_comment_lines
)"
if [ -n "$cred_hits" ]; then
  note "FAIL: tests must inline fake fixture text, never read the live on-disk secret store:"
  printf '%s\n' "$cred_hits" | sed 's/^/    /' >&2
  fail=1
else
  echo "  ok"
fi

# ---------------------------------------------------------------------------
if [ "$fail" -ne 0 ]; then
  echo "FAILED: test(s) reach for a production serving resource." >&2
  exit 1
fi
echo "All clear: no test reaches a production serving resource."
