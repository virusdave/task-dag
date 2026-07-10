#!/usr/bin/env bash
# Fixture test: `task-dag close-completed-epic --issue N` — the sanctioned
# closer for a decomposed local epic whose DAG children are already resolved
# but whose issue still lacks the canonical tree-equal `Closes-Epic:` merge.
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t
export TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost TASK_DAG_CLAIMER_PID=$$

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

EMPTY_TREE=$(git mktree </dev/null)

mint_epic() {
  local n="$1" sha
  git fetch -q origin master
  sha=$(git commit-tree "$EMPTY_TREE" -p origin/master -m "Task: Completed epic ${n}

Issue: #${n}
URL: https://github.com/test/test/issues/${n}
Author: tester
Status: pending
Type: epic")
  git update-ref "refs/heads/gh/issues/${n}" "$sha"
  git update-ref "refs/heads/tasks/pending/${n}" "$sha"
  git push -q origin "refs/heads/gh/issues/${n}" "refs/heads/tasks/pending/${n}"
  printf '%s\n' "$sha"
}

breakdown_epic() {
  local epic="$1" issue="$2" count="${3:-2}"
  "$TD" claim-root "$issue" >/dev/null 2>&1
  if [ "$count" = 3 ]; then
    printf '[{"title":"impl leaf","type":"leaf"},{"title":"ops leaf","type":"leaf"},{"title":"dropped optional leaf","type":"leaf"}]' > "$ROOT/spec-${issue}.json"
  else
    printf '[{"title":"leaf A","type":"leaf"},{"title":"leaf B","type":"leaf"}]' > "$ROOT/spec-${issue}.json"
  fi
  "$TD" breakdown "$epic" --spec-file="$ROOT/spec-${issue}.json" >/dev/null 2>&1
}

frontier_shorts() {
  git ls-remote origin 'refs/heads/tasks/frontier/*' \
    | sed -E 's#.*refs/heads/tasks/frontier/##' \
    | sort
}

is_close_merge_on_origin_master() {
  local n="$1" epic="$2" mc mp
  git fetch -q origin master
  while read -r mc mp; do
    case " $mp " in *" $epic "*) ;; *) continue ;; esac
    if git log -1 --format='%B' "$mc" | git interpret-trailers --parse 2>/dev/null \
       | grep -qE "^Closes-Epic:[[:space:]]*#?${n}([^0-9]|\$)"; then
      return 0
    fi
  done < <(git log origin/master --merges --format='%H %P')
  return 1
}

complete_regular_leaf() {
  local short="$1" file="$2"
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost TASK_DAG_CLAIMER_PID=$$ \
    "$TD" claim "$short" >/dev/null 2>&1
  echo "work $file" > "$file"; git add "$file"; git commit -qm "impl $file"
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost TASK_DAG_CLAIMER_PID=$$ \
    "$TD" complete "$short" >/dev/null 2>&1
}

complete_ops_leaf() {
  local short="$1"
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost TASK_DAG_CLAIMER_PID=$$ \
    "$TD" claim "$short" >/dev/null 2>&1
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost TASK_DAG_CLAIMER_PID=$$ \
    "$TD" complete-ops "$short" --evidence https://example.test/evidence \
      --authorization "fixture authorization" --yes >/dev/null 2>&1
  git fetch -q origin master
  git reset --hard -q origin/master
}

# ── 1. Happy path: completed + ops-completed + explicitly dropped child ──
E1=$(mint_epic 811)
breakdown_epic "$E1" 811 3
mapfile -t L < <(frontier_shorts)
if [ "${#L[@]}" = 3 ]; then ok "1a: breakdown published 3 leaves"; else bad "1a: expected 3 leaves, got ${#L[@]}"; fi
complete_regular_leaf "${L[0]}" impl811.txt
complete_ops_leaf "${L[1]}"
"$TD" drop "${L[2]}" --yes >/dev/null 2>&1
if "$TD" close-completed-epic --issue 811 --reason "rollout/done criteria recorded in issue trail" --yes >/dev/null 2>&1; then
  ok "1b: close-completed-epic exits 0 for completed decomposed epic"
else
  bad "1b: close-completed-epic failed for completed decomposed epic"
fi
if is_close_merge_on_origin_master 811 "$E1"; then
  ok "1c: pushed a Closes-Epic:#811 merge with the epic as a parent"
else
  bad "1c: no matching Closes-Epic merge on origin/master"
fi
CM=$(git log origin/master --merges --format='%H %P' | awk -v e="$E1" '{for(i=2;i<=NF;i++) if($i==e){print $1; exit}}')
if [ -n "$CM" ] && ! git diff-tree --no-commit-id --name-only -r "$CM" | grep -q .; then
  ok "1d: the close merge is additive (tree-equal to first parent)"
else
  bad "1d: the close merge carries a diff (should be additive)"
fi

# ── 2. Idempotent re-run ────────────────────────────────────────────────
BEFORE=$(git ls-remote origin refs/heads/master | awk '{print $1}')
if "$TD" close-completed-epic --issue 811 --reason "already recorded" --yes >/dev/null 2>&1; then
  AFTER=$(git ls-remote origin refs/heads/master | awk '{print $1}')
  [ "$BEFORE" = "$AFTER" ] && ok "2: idempotent re-run is a no-op success" \
                              || bad "2: re-run moved origin/master"
else
  bad "2: idempotent re-run did not exit 0"
fi

# ── 3. Missing reason rejected ──────────────────────────────────────────
E2=$(mint_epic 812)
breakdown_epic "$E2" 812 2
mapfile -t L2 < <(frontier_shorts | tail -2)
complete_regular_leaf "${L2[0]}" impl812a.txt
complete_regular_leaf "${L2[1]}" impl812b.txt
if "$TD" close-completed-epic --issue 812 --yes >/dev/null 2>&1; then
  bad "3: missing --reason was accepted"
else
  ok "3: missing --reason rejected"
fi

# ── 4. Incomplete decomposed epic rejected ──────────────────────────────
E3=$(mint_epic 813)
breakdown_epic "$E3" 813 2
if "$TD" close-completed-epic --issue 813 --reason "not done" --yes >/dev/null 2>&1; then
  bad "4: incomplete frontier leaves were accepted"
else
  ok "4: incomplete frontier leaves rejected"
fi
if is_close_merge_on_origin_master 813 "$E3"; then bad "4b: close merge pushed for incomplete epic"; else ok "4b: no close merge for incomplete epic"; fi

# ── 5. Blocked descendant rejected ──────────────────────────────────────
E4=$(mint_epic 814)
breakdown_epic "$E4" 814 2
mapfile -t L4 < <(frontier_shorts | tail -2)
"$TD" block "${L4[0]}" --reason="awaiting operator" >/dev/null 2>&1
if "$TD" close-completed-epic --issue 814 --reason "blocked" --yes >/dev/null 2>&1; then
  bad "5: blocked leaf was accepted"
else
  ok "5: blocked leaf rejected"
fi

# ── 6. Active descendant rejected ───────────────────────────────────────
E5=$(mint_epic 815)
breakdown_epic "$E5" 815 2
mapfile -t L5 < <(frontier_shorts | tail -2)
TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost TASK_DAG_CLAIMER_PID=$$ "$TD" claim "${L5[0]}" >/dev/null 2>&1
if "$TD" close-completed-epic --issue 815 --reason "active" --yes >/dev/null 2>&1; then
  bad "6: active leaf was accepted"
else
  ok "6: active leaf rejected"
fi

# ── 7. Delegated child rejected ─────────────────────────────────────────
E6=$(mint_epic 816)
breakdown_epic "$E6" 816 2
DELG=$(git commit-tree "$EMPTY_TREE" -p "$E6" -m "kind: delegated")
git push -q origin "$DELG:refs/heads/tasks/delegated/816/acme/widgets/9"
if "$TD" close-completed-epic --issue 816 --reason "delegated" --yes >/dev/null 2>&1; then
  bad "7: delegated-child epic was accepted"
else
  ok "7: delegated-child epic rejected"
fi

# ── 8. Undecomposed root rejected ───────────────────────────────────────
E7=$(mint_epic 817)
if "$TD" close-completed-epic --issue 817 --reason "undecomposed" --yes >/dev/null 2>&1; then
  bad "8: undecomposed root was accepted"
else
  ok "8: undecomposed root rejected"
fi

echo "----"
echo "close-completed-epic: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
