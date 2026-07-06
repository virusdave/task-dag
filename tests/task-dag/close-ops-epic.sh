#!/usr/bin/env bash
# Fixture test: `task-dag close-ops-epic --issue N` — the sanctioned way to
# close a single-repo, OPS-ONLY (no-code) epic (no implementation commit to
# link, no cross-repo delegated children). It must emit the SAME tree-equal
# `Closes-Epic: #N` merge on master that close-completed-issues.yml acts on
# (epic-as-parent AND matching trailer), constructed by the tool, and it
# must fail CLOSED on every abuse/premature-close path:
#   * happy path: undecomposed ops epic -> additive Closes-Epic merge pushed
#   * idempotent re-run (close already on master) -> no-op success
#   * idempotent after pending/<N> deleted (post-close cleanup) -> no-op
#   * decomposed root refused (has child leaves)
#   * cross-repo delegated child refused (-> use close-epic)
#   * blocked root refused (-> unblock first)
#   * foreign LIVE root-decompose lock refused
#   * non-interactive caller without --yes refused
#   * origin unreachable -> fail closed
# Each scenario uses a distinct issue number so they stay independent. The
# harness builds a throwaway bare origin + working clone (no network).
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t
# Our identity for calls that need to be "us".
export TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost TASK_DAG_CLAIMER_PID=$$

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

EMPTY_TREE=$(git mktree </dev/null)

# mint_epic <issue> — create an empty-tree epic root parented on master and
# publish tasks/pending/<N> + gh/issues/<N> to origin. Echoes the epic SHA.
mint_epic() {
  local n="$1" sha
  git fetch -q origin master
  sha=$(git commit-tree "$EMPTY_TREE" -p origin/master -m "Task: Ops epic ${n}

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

# is_close_merge_on_origin_master <issue> <epic-sha> — 0 iff origin/master
# reaches a merge with <epic-sha> as a parent AND a Closes-Epic:#<issue>
# trailer (the exact dual gate close-completed-issues.yml enforces).
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

# ── 1. Happy path ────────────────────────────────────────────────────────
E1=$(mint_epic 801)
if "$TD" close-ops-epic --issue 801 --yes >/dev/null 2>&1; then
  ok "1a: close-ops-epic exit 0 on an undecomposed ops epic"
else
  bad "1a: close-ops-epic failed on a valid ops epic"
fi
if is_close_merge_on_origin_master 801 "$E1"; then
  ok "1b: pushed a Closes-Epic:#801 merge with the epic as a parent"
else
  bad "1b: no matching Closes-Epic merge on origin/master"
fi
# Additive (no diff) merge.
git fetch -q origin master
CM=$(git log origin/master --merges --format='%H %P' | awk -v e="$E1" '{for(i=2;i<=NF;i++) if($i==e){print $1; exit}}')
if [ -n "$CM" ] && ! git diff-tree --no-commit-id --name-only -r "$CM" | grep -q .; then
  ok "1c: the close merge is additive (tree-equal to first parent)"
else
  bad "1c: the close merge carries a diff (should be additive)"
fi

# ── 2. Idempotent re-run (close already on master) ───────────────────────
BEFORE=$(git ls-remote origin refs/heads/master | awk '{print $1}')
if "$TD" close-ops-epic --issue 801 --yes >/dev/null 2>&1; then
  AFTER=$(git ls-remote origin refs/heads/master | awk '{print $1}')
  if [ "$BEFORE" = "$AFTER" ]; then
    ok "2: idempotent re-run is a no-op success (no duplicate close merge)"
  else
    bad "2: re-run moved origin/master (duplicate close merge)"
  fi
else
  bad "2: idempotent re-run did not exit 0"
fi

# ── 3. Idempotent after pending/<N> deleted (post-close cleanup) ─────────
# Simulate close-completed-issues.yml having deleted tasks/pending/801.
git push -q origin --delete refs/heads/tasks/pending/801 2>/dev/null || true
git update-ref -d refs/heads/tasks/pending/801 2>/dev/null || true
if "$TD" close-ops-epic --issue 801 --yes >/dev/null 2>&1; then
  ok "3: re-run after pending ref deleted is a no-op success (trailer scan)"
else
  bad "3: re-run after pending deletion did not converge to success"
fi

# ── 4. Decomposed root refused ───────────────────────────────────────────
E2=$(mint_epic 802)
"$TD" claim-root 802 >/dev/null 2>&1
printf '[{"title":"leaf A","type":"leaf"}]' > "$ROOT/spec.json"
"$TD" breakdown "$E2" --spec-file="$ROOT/spec.json" >/dev/null 2>&1
if "$TD" close-ops-epic --issue 802 --yes >/dev/null 2>&1; then
  bad "4: close-ops-epic wrongly closed a DECOMPOSED epic"
else
  rc=$?
  [ "$rc" -ne 0 ] && ok "4: decomposed root refused (non-zero exit $rc)" \
                  || bad "4: decomposed root not refused (exit $rc)"
fi
if is_close_merge_on_origin_master 802 "$E2"; then
  bad "4b: a close merge was pushed for the decomposed epic"
else
  ok "4b: no close merge pushed for the decomposed epic"
fi

# ── 5. Cross-repo delegated child refused ────────────────────────────────
E3=$(mint_epic 803)
DELG=$(git commit-tree "$EMPTY_TREE" -p "$E3" -m "kind: delegated")
git push -q origin "$DELG:refs/heads/tasks/delegated/803/acme/widgets/9"
if "$TD" close-ops-epic --issue 803 --yes >/dev/null 2>&1; then
  bad "5: close-ops-epic wrongly closed an epic with a delegated child"
else
  rc=$?
  [ "$rc" -ne 0 ] && ok "5: delegated-child epic refused (non-zero exit $rc)" \
                  || bad "5: delegated-child not refused (exit $rc)"
fi

# ── 6. Blocked root refused ──────────────────────────────────────────────
E4=$(mint_epic 804)
"$TD" block "$E4" --reason="awaiting operator go" >/dev/null 2>&1
if "$TD" close-ops-epic --issue 804 --yes >/dev/null 2>&1; then
  bad "6: close-ops-epic wrongly closed a BLOCKED epic root"
else
  rc=$?
  [ "$rc" -ne 0 ] && ok "6: blocked root refused (non-zero exit $rc)" \
                  || bad "6: blocked root not refused (exit $rc)"
fi

# ── 7. Foreign LIVE root-decompose lock refused ──────────────────────────
E5=$(mint_epic 805)
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOCK=$(git commit-tree "$EMPTY_TREE" -p "$E5" -m "Claim: Ops epic 805

Claim-Kind: root
Issue: #805
Task-Commit: ${E5}
Claimer: someone-else
Claimer-Host: otherhost
Claimer-PID: 1
Claimed-At: ${NOW}
TTL-Hours: 12")
git push -q origin "$LOCK:refs/heads/tasks/root-active/805"
if "$TD" close-ops-epic --issue 805 --yes >/dev/null 2>&1; then
  bad "7: close-ops-epic wrongly closed under a foreign live root lock"
else
  rc=$?
  [ "$rc" -ne 0 ] && ok "7: foreign live root lock refused (non-zero exit $rc)" \
                  || bad "7: foreign root lock not refused (exit $rc)"
fi

# ── 8. Non-interactive caller without --yes refused ──────────────────────
E6=$(mint_epic 806)
if "$TD" close-ops-epic --issue 806 </dev/null >/dev/null 2>&1; then
  bad "8: close-ops-epic closed without --yes from a non-TTY caller"
else
  rc=$?
  [ "$rc" -ne 0 ] && ok "8: non-TTY caller without --yes refused (non-zero exit $rc)" \
                  || bad "8: non-TTY-no-yes not refused (exit $rc)"
fi
if is_close_merge_on_origin_master 806 "$E6"; then
  bad "8b: a close merge was pushed despite missing --yes"
else
  ok "8b: no close merge pushed without confirmation"
fi

# ── 9. Origin unreachable -> fail closed ─────────────────────────────────
E7=$(mint_epic 807)
git remote set-url origin "$ROOT/does-not-exist.git"
if "$TD" close-ops-epic --issue 807 --yes >/dev/null 2>&1; then
  bad "9: close-ops-epic did not fail closed when origin was unreachable"
else
  rc=$?
  [ "$rc" -ne 0 ] && ok "9: origin unreachable -> fail closed (non-zero exit $rc)" \
                  || bad "9: origin-unreachable not refused (exit $rc)"
fi
git remote set-url origin "$ROOT/origin.git"

# ── 10. Missing --issue rejected ─────────────────────────────────────────
if "$TD" close-ops-epic --yes >/dev/null 2>&1; then
  bad "10: close-ops-epic accepted a call with no --issue"
else
  ok "10: missing --issue rejected"
fi

echo "----"
echo "close-ops-epic: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
