#!/usr/bin/env bash
# Fixture-based self-test for scripts/scan-disabled-gates.sh
# (automation#49 Phase D.10). Deterministic, hermetic: it builds a
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

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scan-disabled-gates.sh"
[ -x "$src" ] || { echo "FAIL: scanner not found/executable at $src" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq is required for contract checks" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Minimal throwaway repo with the scanner installed at scripts/.
git -C "$work" init -q
git -C "$work" config user.email t@t.t
git -C "$work" config user.name t
mkdir -p "$work/scripts"
cp "$src" "$work/scripts/scan-disabled-gates.sh"

pass=0; failc=0
# run_case <expected:pass|fail> <description>
# Body stages files into $work; we then run the scanner against the index.
run_case() {
  local expect="$1" desc="$2" rc=0
  git -C "$work" add -A
  ( cd "$work" && bash scripts/scan-disabled-gates.sh ) >/dev/null 2>&1 || rc=$?
  if { [ "$expect" = pass ] && [ "$rc" -eq 0 ]; } || \
     { [ "$expect" = fail ] && [ "$rc" -ne 0 ]; }; then
    echo "  ok   [$expect] $desc"; pass=$((pass+1))
  else
    echo "  FAIL [$expect, got rc=$rc] $desc"; failc=$((failc+1))
  fi
}
write_clean_gate_contract() {
  mkdir -p "$work/.githooks" "$work/.github/workflows" "$work/helios"
  cat > "$work/.githooks/pre-commit" <<'HOOK'
#!/usr/bin/env bash
bash "$repo_root/scripts/scan-explicit-any.sh"
bash "$repo_root/scripts/scan-disabled-gates.sh"
bash "$repo_root/scripts/scan-test-resources.sh"
"$TSC" -p tsconfig.server.json
"$TSC" -p tsconfig.client.json --noEmit
"$TSX" scripts/smoke-server.ts
( cd "$repo_root/ads/google" && "$ADS_TSC" -p tsconfig.json --noEmit )
HOOK
  chmod +x "$work/.githooks/pre-commit"
  cat > "$work/.github/workflows/ci.yml" <<'JSON'
{
  "jobs": {
    "scanners": {
      "steps": [
        { "run": "./scripts/scan-explicit-any.sh" },
        { "run": "./scripts/scan-disabled-gates.sh" },
        { "run": "./scripts/scan-test-resources.sh" }
      ]
    },
    "helios": {
      "steps": [
        { "run": "npm run check" },
        { "run": "npm run build", "env": { "NODE_OPTIONS": "--max-old-space-size=8192" } }
      ]
    },
    "ads-google": { "steps": [{ "run": "npm run typecheck" }] }
  }
}
JSON
  cat > "$work/helios/package.json" <<'JSON'
{ "scripts": { "check": "npm run ensure-build-env && npm run typecheck && npm run typecheck:client && npm run test" } }
JSON
}
reset_fixtures() {
  rm -rf "$work/src" "$work/.githooks" "$work/.github" "$work/helios" "$work/AGENTS.md" "$work/deploy.sh"
  mkdir -p "$work/src"
  write_clean_gate_contract
}

echo "==> negative cases (must PASS — clean tree)"
reset_fixtures
printf '// @ts-expect-error intentional\nconst x: number = 1;\n' > "$work/src/ok.ts"
printf 'model.fit(data);\nconst s = "this test mentions test.only as text";\nit("real", () => {});\n' > "$work/src/ok.test.ts"
printf '# git commit --no-verify is forbidden here (prose)\nrun: echo hi\n' > "$work/.github/workflows/notes.yml"
printf '# Skip with `git commit --no-verify` only if you understand.\n# 1/3 compiling server (tsc -p tsconfig.server.json)\n' >> "$work/.githooks/pre-commit"
printf 'Do not use --no-verify. Run npm run lint manually.\n' > "$work/AGENTS.md"
run_case pass "clean tree: ts-expect-error, model.fit(), prose --no-verify, active \$TSC"

echo "==> positive cases (must FAIL — real violations)"
reset_fixtures; printf '// @ts-ignore\nconst x: number = "a";\n' > "$work/src/bad.ts"
run_case fail "@ts-ignore suppression"

reset_fixtures; printf '/* eslint-env */\n// @ts-nocheck\nexport const y = 1;\n' > "$work/src/bad2.ts"
run_case fail "@ts-nocheck suppression"

reset_fixtures; printf 'describe.skip("x", () => {});\n' > "$work/src/a.test.ts"
run_case fail ".skip in test"

reset_fixtures; printf 'it.only("y", () => {});\n' > "$work/src/b.test.ts"
run_case fail ".only in test"

reset_fixtures; printf 'test.concurrent.only("z", () => {});\n' > "$work/src/c.test.ts"
run_case fail "chained .concurrent.only in test"

reset_fixtures; printf 'describe.each(cases).skip("w", () => {});\n' > "$work/src/d.test.ts"
run_case fail "chained .each().skip in test"

reset_fixtures; printf 'fit("focused", () => {});\n' > "$work/src/e.test.ts"
run_case fail "fit() shorthand in test"

reset_fixtures; printf '#!/bin/bash\ngit commit --no-verify -m x\n' > "$work/deploy.sh"
run_case fail "--no-verify recipe in shell script"

reset_fixtures; printf 'jobs:\n  t:\n    steps:\n      # - run: npm run lint\n      - run: echo ok\n' > "$work/.github/workflows/ci.yml"
run_case fail "commented-out '- run: npm run lint' in workflow"

reset_fixtures; printf '# tsc -p tsconfig.server.json\n"$TSX" scripts/smoke.ts\n' > "$work/.githooks/pre-commit"
run_case fail "commented-out 'tsc -p' in pre-commit hook"

reset_fixtures; chmod -x "$work/.githooks/pre-commit"
run_case fail "pre-commit hook is not executable"

reset_fixtures; sed -i '/tsconfig.client.json --noEmit/d' "$work/.githooks/pre-commit"
run_case fail "pre-commit hook missing client typecheck"

reset_fixtures; jq '.scripts.check = "npm run ensure-build-env && npm run typecheck && npm run test"' "$work/helios/package.json" > "$work/helios/package.json.tmp" && mv "$work/helios/package.json.tmp" "$work/helios/package.json"
run_case fail "CI Helios check script missing client typecheck"

echo "==> staged-index semantics"
reset_fixtures; printf 'it.only("staged", () => {});\n' > "$work/src/idx.test.ts"
git -C "$work" add -A
# Remove the violation only from the working tree; index still has it.
printf 'it("clean wt", () => {});\n' > "$work/src/idx.test.ts"
rc=0; ( cd "$work" && bash scripts/scan-disabled-gates.sh ) >/dev/null 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then echo "  ok   [fail] scans staged index, not working tree"; pass=$((pass+1)); else echo "  FAIL: did not catch staged-only violation"; failc=$((failc+1)); fi

echo
echo "passed=$pass failed=$failc"
[ "$failc" -eq 0 ] || { echo "SELF-TEST FAILED" >&2; exit 1; }
echo "SELF-TEST OK"
