#!/usr/bin/env bash
# Hermetic contract test for the GitHub issue-event compatibility adapter.
set -euo pipefail
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/scripts/create-task-commit.sh
cat >"$ROOT/task-dag" <<'EOF'
#!/usr/bin/env bash
printf '%s\0' "$@" >"$CAPTURE"
EOF
chmod +x "$ROOT/task-dag"
export CAPTURE="$ROOT/args" TASK_DAG_CLI="$ROOT/task-dag"
export ISSUE_NUMBER=42 ISSUE_TITLE=Root ISSUE_AUTHOR=tester ISSUE_URL=https://github.com/owner/repo/issues/42
export ISSUE_REPOSITORY=owner/repo ISSUE_REPOSITORY_ID=R_target ISSUE_NODE_ID=I_42 ISSUE_LABELS=''

run_adapter() { ISSUE_BODY=$1 bash "$SCRIPT" >/dev/null; mapfile -d '' -t ARGS <"$CAPTURE"; }
has_pair() { local i; for ((i=0;i<${#ARGS[@]}-1;i++)); do [ "${ARGS[$i]}" = "$1" ] && [ "${ARGS[$((i+1))]}" = "$2" ] && return 0; done; return 1; }

run_adapter 'ordinary provider issue'
has_pair --issue-id I_42
! printf '%s\n' "${ARGS[@]}" | grep -q '^--materialisation-'
echo 'PASS: missing marker uses ordinary provider origin'

operation=$(printf 'a%.0s' {1..64}); declaration=$(printf 'd%.0s' {1..64})
run_adapter $'projected body\n\n<!-- task-dag-materialisation:v1 source=source/repo source-id=R_source operation='"$operation"' declaration='"$declaration"' -->'
has_pair --materialisation-source-repository source/repo
has_pair --materialisation-source-repository-id R_source
has_pair --materialisation-operation-id "$operation"
has_pair --materialisation-declaration-digest "$declaration"
echo 'PASS: exact canonical marker fields reach strict ingress'

ISSUE_BODY=$'x\n<!-- task-dag-materialisation:v1 source=source/repo source-id=R_source operation='"$operation"' declaration='"$declaration"$' -->\n<!-- task-dag-materialisation:v1 source=source/repo source-id=R_source operation='"$operation"' declaration='"$declaration"' -->' \
  bash "$SCRIPT" >/dev/null 2>&1 && { echo 'FAIL: duplicate marker accepted'; exit 1; }
echo 'PASS: ambiguous marker fails before ingress'

for bad_body in \
  '<!-- task-dag-materialisation: source=source/repo -->' \
  '<!-- task-dag-materialisation:v1 malformed -->' \
  $'<!-- task-dag-materialisation:v1 source=source/repo source-id=R_source operation='"$operation"' declaration='"$declaration"$' -->\n<!-- task-dag-materialisation:v1 malformed -->'; do
  rm -f "$CAPTURE"
  ISSUE_BODY="$bad_body" bash "$SCRIPT" >/dev/null 2>&1 && { echo 'FAIL: reserved malformed marker accepted'; exit 1; }
  [ ! -e "$CAPTURE" ] || { echo 'FAIL: malformed marker reached mutation ingress'; exit 1; }
done
echo 'PASS: old, malformed, and exact-plus-malformed reserved markers fail mutation-free'

ISSUE_LABELS=blocked-at-birth ISSUE_BODY=ordinary bash "$SCRIPT" >/dev/null 2>&1 \
  && { echo 'FAIL: blocked-at-birth legacy path accepted'; exit 1; }
echo 'PASS: retired blocked-at-birth path remains fail-closed'
