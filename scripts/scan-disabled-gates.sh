#!/usr/bin/env bash
# Disabled-gate scanner (fleet-green epic, Phase D.10 — automation#49).
#
# Fails (exit 1) if any *committed, first-party* source disables or
# weakens a quality gate. It flags five classes of regression:
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
#   5. Drift in the repo's required gate contract — the committed
#      pre-commit hook must be executable and must still run the same
#      fast pre-master gates that CI advertises, including the Helios
#      client typecheck (no carve-out).
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
command -v jq >/dev/null || { echo "ERROR: jq is required for gate contract checks." >&2; exit 1; }

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

git_show_cached() {
  local path="$1" out status
  set +e
  out="$(git show ":$path" 2>/dev/null)"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "ERROR: required tracked file missing from index: $path" >&2
    fail=1
    return 1
  fi
  printf '%s\n' "$out"
}

require_cached_text() {
  local path="$1" label="$2" needle="$3" content="$4"
  if ! printf '%s\n' "$content" | grep -Fq -- "$needle"; then
    note "FAIL: $path is missing required gate: $label ($needle)"
    fail=1
  fi
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
echo "==> 1/5 @ts-ignore / @ts-nocheck suppressions"
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
echo "==> 2/5 .skip / .only in committed tests"
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
echo "==> 3/5 --no-verify recipes"
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
echo "==> 4/5 commented-out checks in .githooks / .github/workflows"
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
# 5. Required pre-commit / CI gate contract (automation#49 Phase D.12).
# ---------------------------------------------------------------------------
echo "==> 5/5 required pre-commit / CI gate contract"
contract_fail_before="$fail"

precommit_mode="$(git ls-files -s -- .githooks/pre-commit | awk '{print $1}')"
if [ "$precommit_mode" != "100755" ]; then
  note "FAIL: .githooks/pre-commit must be tracked and executable (mode 100755; got ${precommit_mode:-missing})"
  fail=1
fi

precommit_content="$(git_show_cached .githooks/pre-commit || true)"
ci_content="$(git_show_cached .github/workflows/ci.yml || true)"
helios_pkg_content="$(git_show_cached helios/package.json || true)"

if [ -n "$precommit_content" ]; then
  require_cached_text .githooks/pre-commit "repo-wide explicit-any scanner" "scripts/scan-explicit-any.sh" "$precommit_content"
  require_cached_text .githooks/pre-commit "repo-wide disabled-gate scanner" "scripts/scan-disabled-gates.sh" "$precommit_content"
  require_cached_text .githooks/pre-commit "repo-wide test-resource scanner" "scripts/scan-test-resources.sh" "$precommit_content"
  require_cached_text .githooks/pre-commit "Helios server compile/typecheck" "tsconfig.server.json" "$precommit_content"
  require_cached_text .githooks/pre-commit "Helios client typecheck (no carve-out)" "tsconfig.client.json --noEmit" "$precommit_content"
  require_cached_text .githooks/pre-commit "Helios in-process smoke" "scripts/smoke-server.ts" "$precommit_content"
  require_cached_text .githooks/pre-commit "ads/google typecheck" "ads/google" "$precommit_content"
  require_cached_text .githooks/pre-commit "ads/google typecheck command" "tsconfig.json --noEmit" "$precommit_content"
fi

if [ -n "$ci_content" ]; then
  require_cached_text .github/workflows/ci.yml "repo-wide explicit-any scanner" "./scripts/scan-explicit-any.sh" "$ci_content"
  require_cached_text .github/workflows/ci.yml "repo-wide disabled-gate scanner" "./scripts/scan-disabled-gates.sh" "$ci_content"
  require_cached_text .github/workflows/ci.yml "repo-wide test-resource scanner" "./scripts/scan-test-resources.sh" "$ci_content"
  require_cached_text .github/workflows/ci.yml "Helios full check" "npm run check" "$ci_content"
  require_cached_text .github/workflows/ci.yml "Helios production build" "npm run build" "$ci_content"
  require_cached_text .github/workflows/ci.yml "Helios client build heap" "--max-old-space-size=8192" "$ci_content"
  require_cached_text .github/workflows/ci.yml "ads/google typecheck" "npm run typecheck" "$ci_content"
fi

if [ -n "$helios_pkg_content" ]; then
  helios_check_script="$(printf '%s\n' "$helios_pkg_content" | jq -r '.scripts.check // empty')"
  if [[ "$helios_check_script" != *"npm run typecheck"* || "$helios_check_script" != *"npm run typecheck:client"* || "$helios_check_script" != *"npm run test"* ]]; then
    note "FAIL: helios/package.json scripts.check must include server typecheck, client typecheck, and tests (got: ${helios_check_script:-missing})"
    fail=1
  fi
fi

if [ "$fail" -eq "$contract_fail_before" ]; then
  echo "  ok"
fi

# ---------------------------------------------------------------------------
if [ "$fail" -ne 0 ]; then
  echo "FAILED: disabled / weakened gate(s) detected." >&2
  exit 1
fi
echo "All clear: no disabled or weakened gates found."
