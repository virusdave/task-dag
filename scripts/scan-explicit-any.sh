#!/usr/bin/env bash
# Explicit-`any` scanner (fleet-green epic, Phase D.9 — automation#49).
#
# Fails (exit 1) if any *committed, first-party* TypeScript source uses
# the `any` type. This is the grep-gate fallback the epic prescribes for
# repos without ESLint: there is no ESLint config anywhere in this repo
# (no `.eslintrc*`, no `eslint.config.*`, no eslint dep in any
# package.json), so we cannot use
# `@typescript-eslint/no-explicit-any: error` and instead enforce the
# same rule with a precise, AST-free pattern match.
#
# Forbidden first-party shapes flagged (canon "No first-party `any`").
# Every `any` below is *terminator-anchored*: it only matches when the
# `any` keyword is immediately followed (modulo whitespace) by a real
# type-position terminator (`; , ) ] } > | & = [ { /` or end-of-line) or
# a type-position keyword, so prose like "case sizing: any nonzero" in a
# string (where `any` is followed by a letter) is NOT flagged.
#
#   1. `as any`                      — escape-hatch casts.
#   2. `: any …`                     — annotations: `: any`, `: any[]`,
#                                      `: any)`, `: any;`, `: any =`,
#                                      `: any,`, `: any | null`,
#                                      `: any // trailing comment`.
#   3. `any[]`                       — array-of-any.
#   4. `<any …`                      — leading generic arg / cast:
#                                      Array<any>, Promise<any>,
#                                      Map<any, …>, Promise<any | null>.
#   5. `, any …`                     — trailing generic arg:
#                                      Record<string, any>, Map<…, any>,
#                                      Record<string, any | undefined>.
#   6. `= any …`                     — generic default (<T = any>) AND
#                                      type aliases (`type X = any`).
#   7. `extends|satisfies|keyof any` — constraints, satisfies, keyof any.
#   8. `| any …` / `& any …`         — `any` in a union/intersection.
#
# NOT flagged (deliberately, to avoid false positives):
#   - `Promise.any([...])`, `z.any()`, `_.any(...)` — the `.any(` *method*
#     call shape is never matched; only the `any` *type* shapes above are.
#   - Postgres `= any($1::int[])` in SQL string literals — `= any(` is not
#     one of the flagged shapes.
#   - `'any'` string literals / `z.enum(['any'])` — never adjacent to a
#     type terminator.
#   - prose mentioning "any …" in comments (comment-only lines are
#     stripped) or in strings (terminator-anchored `: any` excludes
#     `: any <word>`).
#
# Scope: first-party TypeScript *source trees* the epic types — helios's
# `helios/src` and the `ads/` package — matching the issue's "grep gate
# over first-party `src`". One-off operational scripts under
# `helios/scripts/` are intentionally out of scope (they are throwaway
# operator tooling, not the typed application/source surface, and are not
# under a `src` tree). If that surface is later folded into the typed
# gate, add its root to SCAN_ROOTS below.
#
# What is scanned: the git INDEX (`git grep --cached`), i.e. exactly the
# content a commit would record — not stray unstaged working-tree edits.
# After a fresh checkout (CI) the index equals HEAD, so the same script
# doubles as the required-status CI gate (automation#49 Phase D.8) and
# the pre-commit gate (Phase D.12).
#
# Scope is restricted to git-tracked, first-party files; node_modules,
# dist, and build output are never tracked so are never scanned. Run from
# anywhere in the repo.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# First-party TypeScript source roots the typed gate covers. Add a root
# here (e.g. a new package's src) to extend coverage.
SCAN_ROOTS=(helios/src ads)

# Build the pathspec list: every TS-family extension under each root.
# Git pathspec `*` spans `/`, so `helios/src/*.ts` matches recursively.
pathspecs=()
for root in "${SCAN_ROOTS[@]}"; do
  for ext in ts tsx mts cts; do
    pathspecs+=("${root}/*.${ext}")
  done
done

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
# that merely mentions a forbidden token in a `//`, `/* */`, or `*`
# continuation line is not flagged. Reads stdin, writes survivors.
strip_comment_lines() {
  local line code trimmed
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    code="${line#*:}"; code="${code#*:}"          # drop "path:lineno:"
    trimmed="${code#"${code%%[![:space:]]*}"}"    # left-trim whitespace
    case "$trimmed" in
      '//'*|'/*'*|'*'*) : ;;                       # comment line → ignore
      *) printf '%s\n' "$line" ;;
    esac
  done
}

# The forbidden first-party `any` *type* shapes (see header). Each is
# anchored so it matches a real type position, never a method call, SQL
# string, or prose. The shared terminator class (a real type-position
# follower) is `[];,)}>|&=[{/]` plus optional-whitespace-then-EOL.
any_patterns=(
  '\bas[[:space:]]+any\b'                                         # 1. as any
  ':[[:space:]]*any([[:space:]]*[];,)}>|&=[{/]|[[:space:]]*$)'    # 2. : any …
  '\bany\[\]'                                                     # 3. any[]
  '<[[:space:]]*any([[:space:]]*[];,)}>|&=[{/]|[[:space:]]*$)'    # 4. <any …
  ',[[:space:]]*any([[:space:]]*[];,)}>|&=[{/]|[[:space:]]*$)'    # 5. , any …
  '=[[:space:]]*any([[:space:]]*[];,)}>|&=[{/]|[[:space:]]*$)'    # 6. = any …
  '\b(extends|satisfies|keyof)[[:space:]]+any\b'                  # 7. extends/satisfies/keyof any
  '[|&][[:space:]]*any([[:space:]]*[];,)}>|&=[{/]|[[:space:]]*$)' # 8. | any … / & any …
)

grep_args=()
for p in "${any_patterns[@]}"; do grep_args+=(-e "$p"); done

echo "==> scanning ${SCAN_ROOTS[*]} for first-party \`any\` types"
any_hits="$(
  git_grep_cached "${grep_args[@]}" -- "${pathspecs[@]}" | strip_comment_lines
)"
if [ -n "$any_hits" ]; then
  note "FAIL: first-party \`any\` is forbidden (canon: use unknown + narrowing,"
  note "      generics, discriminated unions, or explicit boundary types):"
  printf '%s\n' "$any_hits" | sed 's/^/    /' >&2
  fail=1
else
  echo "  ok"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED: first-party \`any\` detected." >&2
  exit 1
fi
echo "All clear: no first-party \`any\` found."
