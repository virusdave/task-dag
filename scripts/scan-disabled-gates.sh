#!/usr/bin/env bash
# Disabled-gate scanner (fleet-green epic, Phase D.10 — automation#49).
#
# Fails (exit 1) if any *committed, first-party* source disables or
# weakens a quality gate. It flags four classes of regression:
#
#   1. `@ts-ignore` / `@ts-nocheck` — silent TypeScript suppressions.
#      (`@ts-expect-error` is NOT flagged: it is self-validating — the
#      compiler errors if the suppressed line stops erroring — so it is
#      an equal-or-stronger gate, which canon explicitly permits.)
#   2. `.skip` / `.only` (incl. chained `.concurrent.only` / `.each().only`
#      and the `xit`/`xdescribe`/… shorthands) in committed test files —
#      these silently drop or narrow tests.
#   3. `--no-verify` *recipes* — actual invocations that bypass the
#      pre-commit gate, in scripts / CI / package manifests. Prose that
#      merely mentions `--no-verify` in a comment or in Markdown docs is
#      NOT flagged.
#   4. Commented-out gate invocations in the gate-bearing files
#      (`.githooks/`, `.github/workflows/`) — e.g. a `tsc` / `eslint` /
#      `vitest` / `jest` / `npm run lint` step that someone disabled by
#      prefixing it with a comment marker instead of deleting it.
#
# What is scanned: the git INDEX (`git grep --cached`), i.e. exactly the
# content a commit would record — not stray unstaged working-tree edits.
# After a fresh checkout (CI) the index equals HEAD, so the same script
# doubles as the CI scanners-job gate (automation#49 Phase D.8;
# advisory — branch protection unavailable, see AGENTS.md).
#
# Scope is restricted to git-tracked, first-party files; node_modules,
# dist, and build output are never tracked so are never scanned. Run from
# anywhere in the repo. All four classes are reported even though any one
# is enough to fail.

set -euo pipefail

# Innocuous --help / -h: print this tool's header usage and exit 0 before any
# effect (canon: rules/QUALITY_GATES.md "Every tool must have an innocuous
# --help"). Handled first, ahead of all other work, so probing the interface
# never triggers a scan.
for _arg in "$@"; do
  case "$_arg" in
    -h|--help)
      awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
      exit 0
      ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# This scanner's own source obviously contains the very patterns it
# hunts for; never scan it against itself. (Its *.test.sh sibling is a
# shell fixture, not a TS/JS test file, so it is naturally out of scope.)
self_rel="scripts/scan-disabled-gates.sh"
self_test_rel="scripts/scan-disabled-gates.test.sh"

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

# Drop comment-only lines from "path:lineno:code" grep output, so prose
# that merely mentions a forbidden token is not flagged. Reads stdin,
# writes the surviving lines to stdout.
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

# ---------------------------------------------------------------------------
# 1. @ts-ignore / @ts-nocheck in first-party source.
# ---------------------------------------------------------------------------
echo "==> 1/4 @ts-ignore / @ts-nocheck suppressions"
ts_hits="$(
  git_grep_cached -e '@ts-(ignore|nocheck)\b' -- \
    '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' \
    ":!${self_rel}"
)"
if [ -n "$ts_hits" ]; then
  note "FAIL: use @ts-expect-error (self-validating) instead of @ts-ignore/@ts-nocheck:"
  printf '%s\n' "$ts_hits" | sed 's/^/    /' >&2
  fail=1
else
  echo "  ok"
fi

# ---------------------------------------------------------------------------
# 2. .skip / .only (and shorthands) in committed test files.
# ---------------------------------------------------------------------------
echo "==> 2/4 .skip / .only in committed tests"
# A leading [^[:alnum:]_$.] (or start-of-line) guard ensures the test
# global is a real call site, not a property like `model.fit(...)` or
# `foo.test.only`. Chained modifiers (`.concurrent`, `.each(...)`, …)
# between the global and the terminal `.skip`/`.only` are tolerated.
# The terminal `.skip`/`.only` must be invoked (`(`) or further chained
# (`.`), which is always true for a real focused/skipped test but not for
# an incidental string literal like "...mentions test.only as text".
skip_re='(^|[^[:alnum:]_$.])(describe|it|test|suite|bench|context)([[:space:]]*\.[[:space:]]*[[:alnum:]_]+([[:space:]]*\([^)]*\))?)*[[:space:]]*\.[[:space:]]*(skip|only)[[:space:]]*[(.]'
shorthand_re='(^|[^[:alnum:]_$.])(xit|fit|xtest|ftest|xdescribe|fdescribe|xcontext|fcontext)[[:space:]]*\('
skip_hits="$(
  git_grep_cached -e "$skip_re" -e "$shorthand_re" -- \
    '*.test.ts' '*.test.tsx' '*.test.mts' '*.test.cts' \
    '*.test.js' '*.test.jsx' '*.test.mjs' '*.test.cjs' \
    '*.spec.ts' '*.spec.tsx' '*.spec.mts' '*.spec.cts' \
    '*.spec.js' '*.spec.jsx' '*.spec.mjs' '*.spec.cjs' \
    '**/__tests__/**' | strip_comment_lines
)"
if [ -n "$skip_hits" ]; then
  note "FAIL: committed tests must not be skipped/focused (.skip/.only/xit/fit/…):"
  printf '%s\n' "$skip_hits" | sed 's/^/    /' >&2
  fail=1
else
  echo "  ok"
fi

# ---------------------------------------------------------------------------
# 3. --no-verify recipes (executable lines only; not prose/comments/docs).
# ---------------------------------------------------------------------------
echo "==> 3/4 --no-verify recipes"
nv_hits="$(
  git_grep_cached -e '--no-verify' -- \
    . ':!*.md' ':!docs/**' ":!${self_rel}" ":!${self_test_rel}" | strip_comment_lines
)"
if [ -n "$nv_hits" ]; then
  note "FAIL: --no-verify bypasses the pre-commit gate; remove these recipes:"
  printf '%s\n' "$nv_hits" | sed 's/^/    /' >&2
  fail=1
else
  echo "  ok"
fi

# ---------------------------------------------------------------------------
# 4. Commented-out gate invocations in gate-bearing files.
# ---------------------------------------------------------------------------
echo "==> 4/4 commented-out checks in .githooks / .github/workflows"
# Anchor on a comment whose body *starts* with an executable gate-runner
# shape: an optional GitHub Actions "- run:" prefix and/or leading env
# assignments, then a package-manager gate script, an npx tool call, or a
# direct tsc/eslint/vitest/jest/playwright binary (incl. the hook's
# "$TSC"/"$TSX"). Prose like "compiling server (tsc -p …)" does not start
# with these shapes and so is not flagged.
commented_gate='^[[:space:]]*#[[:space:]]*(-[[:space:]]*run:[[:space:]]*)?([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*((npm|pnpm)[[:space:]]+(test([[:space:]]|$)|run[[:space:]]+[^#]*(lint|test|typecheck|type-check|build|check|smoke))|yarn[[:space:]]+(lint|test|build|typecheck)([[:space:]]|$)|npx[[:space:]]+[^#]*(tsc|eslint|vitest|jest|playwright)|((\./)?node_modules/\.bin/)?(tsc|eslint|vitest|jest|playwright)([[:space:]]|$)|"?[$](TSC|TSX)"?)'
commented_hits="$(
  git_grep_cached -e "$commented_gate" -- \
    '.githooks/*' '.github/workflows/*.yml' '.github/workflows/*.yaml'
)"
if [ -n "$commented_hits" ]; then
  note "FAIL: a quality-gate step appears commented out (re-enable or delete it):"
  printf '%s\n' "$commented_hits" | sed 's/^/    /' >&2
  fail=1
else
  echo "  ok"
fi

# ---------------------------------------------------------------------------
if [ "$fail" -ne 0 ]; then
  echo "FAILED: disabled / weakened gate(s) detected." >&2
  exit 1
fi
echo "All clear: no disabled or weakened gates found."
