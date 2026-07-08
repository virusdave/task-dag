#!/usr/bin/env bash
# Fixture-based self-test for scripts/scan-explicit-any.sh
# (automation#49 Phase D.9). Deterministic, hermetic: it builds a
# throwaway git repo in a temp dir, stages fixtures under the scanned
# roots (helios/src, ads) and out-of-scope roots, and asserts the
# scanner's exit status. Touches no prod resource. Run: bash this file.

set -euo pipefail

# Innocuous --help / -h: print this tool's header usage and exit 0 before any
# effect (canon: rules/QUALITY_GATES.md "Every tool must have an innocuous
# --help"). Handled first, ahead of all other work, so probing the interface
# never builds the throwaway repo or runs the fixtures.
for _arg in "$@"; do
  case "$_arg" in
    -h|--help)
      awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
      exit 0
      ;;
  esac
done

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scan-explicit-any.sh"
[ -x "$src" ] || { echo "FAIL: scanner not found/executable at $src" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Minimal throwaway repo with the scanner installed at scripts/.
git -C "$work" init -q
git -C "$work" config user.email t@t.t
git -C "$work" config user.name t
mkdir -p "$work/scripts"
cp "$src" "$work/scripts/scan-explicit-any.sh"

pass=0; failc=0
# run_case <expected:pass|fail> <description>
# Body stages files into $work; we then run the scanner against the index.
run_case() {
  local expect="$1" desc="$2" rc=0
  git -C "$work" add -A
  ( cd "$work" && bash scripts/scan-explicit-any.sh ) >/dev/null 2>&1 || rc=$?
  if { [ "$expect" = pass ] && [ "$rc" -eq 0 ]; } || \
     { [ "$expect" = fail ] && [ "$rc" -ne 0 ]; }; then
    echo "  ok   [$expect] $desc"; pass=$((pass+1))
  else
    echo "  FAIL [$expect, got rc=$rc] $desc"; failc=$((failc+1))
  fi
}
reset_fixtures() {
  rm -rf "$work/helios" "$work/ads"
  mkdir -p "$work/helios/src/worker" "$work/helios/scripts" "$work/ads/google/lib"
}

echo "==> negative cases (must PASS — clean / non-type uses of 'any')"
reset_fixtures
cat > "$work/helios/src/worker/ok.ts" <<'EOF'
// Defensive default: any unmatched job_type falls through here.
const sql = 'select * from j where id = any($1::int[])'
const note = 'case sizing: any nonzero recommendation rounds up'
const a = await Promise.any([p1, p2])
const schema = z.object({ labData: z.array(z.any()).optional() })
const found = list.find((t) => t.id === 3)
let anyVar: number = 1
const anyOf = ['x']
const x: number = 1
export { sql, note, a, schema, found, anyVar, anyOf, x }
EOF
cat > "$work/ads/google/lib/ok.ts" <<'EOF'
const r = _.any(items)
const msg = 'Google did NOT cite any specific creative policy topic'
export { r, msg }
EOF
run_case pass "clean: SQL =any(), prose ': any', Promise.any, z.any(), .find(), anyVar, x:number"

echo "==> out-of-scope cases (must PASS — violations outside scanned roots)"
reset_fixtures; printf 'const e = x as any\n' > "$work/helios/scripts/oneoff.ts"
run_case pass "helios/scripts/*.ts is out of scope (operator one-offs)"

reset_fixtures; printf 'const e = x as any\n' > "$work/rootfile.ts"
run_case pass "repo-root *.ts is out of scope"

echo "==> positive cases (must FAIL — real first-party 'any' types)"
reset_fixtures; printf 'const e = error as any\n' > "$work/helios/src/worker/bad.ts"
run_case fail "as any cast (helios/src)"

reset_fixtures; printf 'export function f(a: any): void {}\n' > "$work/helios/src/worker/bad.ts"
run_case fail ": any parameter annotation"

reset_fixtures; printf 'let v: any\n' > "$work/helios/src/worker/bad.ts"
run_case fail ": any at end of line"

reset_fixtures; printf 'const xs: any[] = []\n' > "$work/helios/src/worker/bad.ts"
run_case fail "any[] array type"

reset_fixtures; printf 'const p: Promise<any> = load()\n' > "$work/helios/src/worker/bad.ts"
run_case fail "<any> generic arg"

reset_fixtures; printf 'const m: Map<any, string> = new Map()\n' > "$work/helios/src/worker/bad.ts"
run_case fail "<any, generic arg"

reset_fixtures; printf 'const r: Record<string, any> = {}\n' > "$work/helios/src/worker/bad.ts"
run_case fail ", any> trailing generic arg"

reset_fixtures; printf 'type Box<X = any> = { v: X }\n' > "$work/helios/src/worker/bad.ts"
run_case fail "= any> generic default"

reset_fixtures; printf 'type Payload = any\n' > "$work/helios/src/worker/bad.ts"
run_case fail "= any type alias (end of line)"

reset_fixtures; printf 'export type Payload = any;\n' > "$work/helios/src/worker/bad.ts"
run_case fail "= any; type alias"

reset_fixtures; printf 'function f<T extends any>(x: T): void {}\n' > "$work/helios/src/worker/bad.ts"
run_case fail "extends any generic constraint"

reset_fixtures; printf 'const k = (x: unknown) => x satisfies any\n' > "$work/helios/src/worker/bad.ts"
run_case fail "satisfies any"

reset_fixtures; printf 'type K = keyof any\n' > "$work/helios/src/worker/bad.ts"
run_case fail "keyof any"

reset_fixtures; printf 'let v: any | null = null\n' > "$work/helios/src/worker/bad.ts"
run_case fail ": any | null union"

reset_fixtures; printf 'type R = Record<string, any | undefined>\n' > "$work/helios/src/worker/bad.ts"
run_case fail ", any | undefined trailing generic union"

reset_fixtures; printf 'type P = Promise<any | null>\n' > "$work/helios/src/worker/bad.ts"
run_case fail "<any | null leading generic union"

reset_fixtures; printf 'let v: any // TODO drop this\n' > "$work/helios/src/worker/bad.ts"
run_case fail ": any with trailing line comment"

reset_fixtures; printf 'const e = x as any\n' > "$work/ads/google/lib/bad.ts"
run_case fail "as any cast (ads/ in scope)"

reset_fixtures
printf 'interface S {\n  employees: any[]\n  [key: string]: any\n}\n' > "$work/helios/src/worker/bad.d.ts"
run_case fail "first-party .d.ts with any[] / : any"

echo "==> comment / string false-positive guards (must PASS)"
reset_fixtures; printf '// const x: any = foo  (disabled escape hatch, in a comment)\nexport const y = 1\n' > "$work/helios/src/worker/ok.ts"
run_case pass "comment-only line mentioning ': any' is not flagged"

reset_fixtures; printf 'const doc = "the field type: any value is allowed"\n' > "$work/helios/src/worker/ok.ts"
run_case pass "string ': any value' (followed by a word) is not flagged"

echo "==> staged-index semantics"
reset_fixtures; printf 'const e = x as any\n' > "$work/helios/src/worker/idx.ts"
git -C "$work" add -A
# Remove the violation only from the working tree; index still has it.
printf 'const e = x as unknown\n' > "$work/helios/src/worker/idx.ts"
rc=0; ( cd "$work" && bash scripts/scan-explicit-any.sh ) >/dev/null 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then echo "  ok   [fail] scans staged index, not working tree"; pass=$((pass+1)); else echo "  FAIL: did not catch staged-only violation"; failc=$((failc+1)); fi

echo
echo "passed=$pass failed=$failc"
[ "$failc" -eq 0 ] || { echo "SELF-TEST FAILED" >&2; exit 1; }
echo "SELF-TEST OK"
