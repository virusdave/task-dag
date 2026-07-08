#!/usr/bin/env bash
# Fixture-based self-test for scripts/scan-test-resources.sh
# (automation#49 Phase D.11). Deterministic, hermetic: it builds a
# throwaway git repo in a temp dir, stages fixtures, and asserts the
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

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scan-test-resources.sh"
[ -x "$src" ] || { echo "FAIL: scanner not found/executable at $src" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Minimal throwaway repo with the scanner installed at scripts/.
git -C "$work" init -q
git -C "$work" config user.email t@t.t
git -C "$work" config user.name t
mkdir -p "$work/scripts"
cp "$src" "$work/scripts/scan-test-resources.sh"

pass=0; failc=0
# run_case <expected:pass|fail> <description>
# Body stages files into $work; we then run the scanner against the index.
run_case() {
  local expect="$1" desc="$2" rc=0
  git -C "$work" add -A
  ( cd "$work" && bash scripts/scan-test-resources.sh ) >/dev/null 2>&1 || rc=$?
  if { [ "$expect" = pass ] && [ "$rc" -eq 0 ]; } || \
     { [ "$expect" = fail ] && [ "$rc" -ne 0 ]; }; then
    echo "  ok   [$expect] $desc"; pass=$((pass+1))
  else
    echo "  FAIL [$expect, got rc=$rc] $desc"; failc=$((failc+1))
  fi
}
reset_fixtures() { rm -rf "$work/src" "$work/__tests__"; mkdir -p "$work/src"; }

echo "==> negative cases (must PASS — clean tree)"
reset_fixtures
# Loopback + reserved-placeholder hosts, fixture-text creds, and a
# non-sensitive env fallback are all legitimate in tests.
printf "const BASE = { DATABASE_URL: 'postgres://helios:helios@127.0.0.1:5432/helios_test' }\n" > "$work/src/a.test.ts"
printf "const u = 'postgres://tsdbadmin:secret@db.example.tsdb.cloud.timescale.com:30667/tsdb?sslmode=require'\n" > "$work/src/parse.test.ts"
printf "const c = { DATABASE_URL: 'postgres://example.invalid/db', SWEED_AUTH_TOKEN: 'test-sweed-token' }\n" > "$work/src/sweed.test.ts"
printf "const port = process.env.PORT ?? '3000'\nconst dbg = process.env.DEBUG ?? ''\n" > "$work/src/cfg.test.ts"
printf "const m = process.env.MONKEY || 'banana'\nconst s = process.env.SECRETARY || 'x'\n" > "$work/src/words.test.ts"
printf "// const url = process.env.DATABASE_URL ??= 'prod' (commented prose)\nit('ok', () => {})\n" > "$work/src/comment.test.ts"
printf "const adminUrl = 'https://helios.freshlybaked.us/reviews/' + id\n" > "$work/src/url.test.ts"
run_case pass "clean: loopback/example hosts, fixture creds, PORT/MONKEY/SECRETARY fallbacks, commented ??=, https site URL"

echo "==> positive cases (must FAIL — real violations)"
reset_fixtures; printf "process.env.DATABASE_URL ??= 'postgres://x/y'\n" > "$work/src/a.test.ts"
run_case fail "process.env.DATABASE_URL ??= ambient fallback"

reset_fixtures; printf "process.env.SESSION_COOKIE_SECRET ||= 'fallback'\n" > "$work/src/b.test.ts"
run_case fail "process.env.X ||= ambient fallback"

reset_fixtures; printf "const url = process.env.DATABASE_URL ?? 'postgres://localhost/db'\n" > "$work/src/c.test.ts"
run_case fail "sensitive ?? fallback read (DATABASE_URL)"

reset_fixtures; printf "const t = process.env.SWEED_AUTH_TOKEN || 'x'\n" > "$work/src/d.test.ts"
run_case fail "sensitive || fallback read (_TOKEN)"

reset_fixtures; printf "const u = process.env['DATABASE_URL'] ?? 'postgres://localhost/db'\n" > "$work/src/d2.test.ts"
run_case fail "sensitive ?? fallback read via bracket access"

reset_fixtures; printf "const s = process.env.OAUTH2_CLIENT_SECRET || 'x'\n" > "$work/src/d3.test.ts"
run_case fail "sensitive || fallback read with digits in name (OAUTH2_CLIENT_SECRET)"

reset_fixtures; printf "const u = 'postgres://admin:pw@db.prod.timescale.com:5432/main'\n" > "$work/src/e.test.ts"
run_case fail "non-loopback prod postgres host"

reset_fixtures; printf "const r = 'rediss://cache.prod.example.evilcorp.io:6380'\n" > "$work/src/f.test.ts"
# NOTE: contains an 'example' label → must be treated as placeholder → PASS.
run_case pass "host with an example label is a reserved placeholder"

reset_fixtures; printf "const u = 'postgres://admin:pw@db.notexample.com:5432/prod'\n" > "$work/src/f2.test.ts"
# 'notexample' must NOT be allowlisted by substring → FAIL (label-anchored).
run_case fail "host containing 'example' as a substring (notexample) is still flagged"

reset_fixtures; printf "const u = 'postgres://admin:pw@invalid-prod.company.com:5432/prod'\n" > "$work/src/f3.test.ts"
run_case fail "host with 'invalid-' prefix label is still flagged"

reset_fixtures; printf "const m = 'mongodb+srv://user:pw@cluster0.abcd.mongodb.net/test'\n" > "$work/src/h2.test.ts"
run_case fail "mongodb+srv:// scheme is caught by the prefilter"

reset_fixtures; printf "const r = 'redis://cache.prod.internal:6379'\n" > "$work/src/g.test.ts"
run_case fail "non-loopback redis host"

reset_fixtures; printf "const m = 'mongodb://user:pw@cluster0.abcd.mongodb.net/test'\n" > "$work/src/h.test.ts"
run_case fail "non-loopback mongodb host"

reset_fixtures; printf "const creds = readFileSync('/home/amp-local/.secret/tigerdata/db.txt')\n" > "$work/src/i.test.ts"
run_case fail ".secret/ store path"

reset_fixtures; printf "const p = path.join(os.homedir(), '.secret', 'tigerdata')\n" > "$work/src/i2.test.ts"
run_case fail "split '.secret' path component"

reset_fixtures; printf "const f = 'tiger-cloud-db-94793-credentials.txt'\n" > "$work/src/j.test.ts"
run_case fail "live TigerData credentials filename"

reset_fixtures; printf "const f = \`tiger-cloud-db-\${id}-credentials.txt\`\n" > "$work/src/j2.test.ts"
run_case fail "TigerData creds filename with dynamic id"

reset_fixtures; mkdir -p "$work/__tests__"; printf "const u = 'postgresql://u:p@10.0.0.5:5432/db'\n" > "$work/__tests__/k.ts"
run_case fail "violation inside __tests__/ dir"

reset_fixtures; printf "const u = 'postgres://u:p@db.prod.net:5432/x'\n" > "$work/src/l.spec.ts"
run_case fail "violation in a .spec.ts file"

echo "==> staged-index semantics"
reset_fixtures; printf "process.env.DATABASE_URL ??= 'postgres://x/y'\n" > "$work/src/idx.test.ts"
git -C "$work" add -A
# Remove the violation only from the working tree; index still has it.
printf "const ok = 1\n" > "$work/src/idx.test.ts"
rc=0; ( cd "$work" && bash scripts/scan-test-resources.sh ) >/dev/null 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then echo "  ok   [fail] scans staged index, not working tree"; pass=$((pass+1)); else echo "  FAIL: did not catch staged-only violation"; failc=$((failc+1)); fi

echo "==> non-test source is out of scope"
reset_fixtures; printf "process.env.DATABASE_URL ??= 'postgres://prod.host/db'\n" > "$work/src/app.ts"
run_case pass "ambient fallback in a NON-test .ts file is ignored (test-scoped gate)"

echo
echo "passed=$pass failed=$failc"
[ "$failc" -eq 0 ] || { echo "SELF-TEST FAILED" >&2; exit 1; }
echo "SELF-TEST OK"
