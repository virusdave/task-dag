#!/usr/bin/env bash
# Fixture test: `task-dag complete-ops` — the sanctioned way to complete an
# operations-only LEAF without an implementation commit. It must record the
# durable done fact as normal task parentage on master, carry Ops-* audit
# trailers, preserve the normal `complete` empty-implementation guard, and fail
# closed on roots, decomposed nodes, unsatisfied deps, bad audit inputs, and
# foreign active claims.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
case "$TD" in /*) ;; *) TD="$(pwd)/$TD" ;; esac
ORDER_HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-completion-order-hook.sh"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t
export TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost TASK_DAG_CLAIMER_PID=$$

git init -q --bare "$ROOT/origin.git"
git -C "$ROOT/origin.git" config gc.auto 0
git -C "$ROOT/origin.git" config maintenance.auto false
bash "$ORDER_HOOK" "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
git config gc.auto 0
git config maintenance.auto false
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

EMPTY_TREE=$(git mktree </dev/null)

mint_epic() {
  local n="$1" sha
  git fetch -q origin master
  sha=$(git commit-tree "$EMPTY_TREE" -p origin/master -m "Task: Ops leaf epic ${n}

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

breakdown_spec() {
  local epic="$1" spec="$2" force="${3:-}"
  printf '%s' "$spec" > "$ROOT/spec.json"
  "$TD" claim-root 901 --force >/dev/null 2>&1 || true
  "$TD" breakdown "$epic" --spec-file="$ROOT/spec.json" ${force:+--force} --json 2>/dev/null
}

shorts_from_json() {
  grep -oE '"shortSha":"[0-9a-f]+"' | cut -d'"' -f4
}

ops_args=(--evidence https://github.com/test/test/issues/901#issuecomment-1 --authorization "operator approved on test issue" --yes)

EPIC=$(mint_epic 901)

# ── 1. Happy path: a BLOCKED leaf can be completed and gets audited. ───────
LEAF=$(breakdown_spec "$EPIC" '[{"title":"ops blocked leaf","type":"leaf"}]' force | shorts_from_json | head -1)
if [ -n "$LEAF" ]; then
  LEAF_SHA=$(git rev-parse "refs/heads/tasks/frontier/$LEAF")
  "$TD" block "$LEAF" --reason="ops evidence exists; waiting for no-code primitive" >/dev/null 2>&1
  BEFORE=$(git ls-remote origin refs/heads/master | awk '{print $1}')
  out=$("$TD" complete-ops "$LEAF" "${ops_args[@]}" 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then ok "1a: complete-ops succeeds on a blocked leaf"; else bad "1a: complete-ops failed (rc=$rc): $out"; fi
  CM=$(git log HEAD --merges --format='%H %P' | awk -v t="$LEAF_SHA" '{for(i=2;i<=NF;i++) if($i==t){print $1; exit}}')
  REMOTE_AFTER=$(git ls-remote origin refs/heads/master | awk '{print $1}')
  if [ -n "$CM" ] && [ "$BEFORE" = "$REMOTE_AFTER" ] && echo "$out" | grep -q '^task-dag publish$'; then
    ok "1b: local completion merge created without moving origin/master"
  else
    bad "1b: completion was not local-only or omitted explicit push"
  fi
  if [ -n "$CM" ] \
     && [ "$(git rev-list --parents -n 1 "$CM" | wc -w)" -eq 3 ] \
     && [ "$(git rev-parse "$CM^2")" = "$LEAF_SHA" ] \
     && [ "$(git rev-parse "$CM^{tree}")" = "$(git rev-parse "$CM^1^{tree}")" ]; then
    ok "1c: ops completion has exact tree-equal base/task shape"
  else
    bad "1c: ops completion has a non-canonical parent or tree shape"
  fi
  if [ -n "$CM" ] && git log -1 --format='%B' "$CM" | git interpret-trailers --parse \
      | grep -q '^Ops-Completion: true$' \
      && git log -1 --format='%B' "$CM" | git interpret-trailers --parse \
      | grep -q '^Ops-Evidence: https://github.com/test/test/issues/901#issuecomment-1$' \
      && git log -1 --format='%B' "$CM" | git interpret-trailers --parse \
      | grep -q '^Ops-Authorization: operator approved on test issue$'; then
    ok "1d: Ops-* audit trailers are present"
  else
    bad "1d: Ops-* audit trailers missing"
  fi
  f=$(git ls-remote origin "refs/heads/tasks/frontier/$LEAF" | wc -l)
  b=$(git ls-remote origin "refs/heads/tasks/blocked/$LEAF_SHA" | wc -l)
  bm=$(git ls-remote origin "refs/heads/tasks/blocked-meta/$LEAF_SHA" | wc -l)
  if [ "$f" -eq 1 ] && [ "$b" -eq 1 ] && [ "$bm" -eq 1 ]; then
    ok "1e: local completion leaves all scheduling refs unchanged"
  else
    bad "1e: local completion mutated scheduling refs (frontier=$f blocked=$b meta=$bm)"
  fi
  "$TD" publish >/dev/null
  if [ "$(git ls-remote origin "refs/heads/tasks/blocked/$LEAF_SHA" | wc -l)" -eq 1 ]; then
    ok "1f: explicit push publishes without deleting scheduling refs"
  else
    bad "1f: explicit push unexpectedly cleaned scheduling refs"
  fi
  "$TD" graph-converge --range "$BEFORE..HEAD" >/dev/null 2>&1
  converge_rc=$?
  if [ "$converge_rc" -eq 0 ] && [ "$(git ls-remote origin "refs/heads/tasks/blocked/$LEAF_SHA" | wc -l)" -eq 0 ]; then
    ok "1g: graph-converge cleans blocked scheduling refs after publication"
  elif [ "$converge_rc" -eq 75 ] && [ "$(git ls-remote origin "refs/heads/tasks/blocked/$LEAF_SHA" | wc -l)" -eq 1 ]; then
    ok "1g: migration drain defers blocked-ref projection"
  else
    bad "1g: graph-converge rc=$converge_rc produced an invalid blocked-ref state"
  fi
  AFTER1=$(git ls-remote origin refs/heads/master | awk '{print $1}')
  out=$("$TD" complete-ops "$LEAF" "${ops_args[@]}" 2>&1); rc=$?
  AFTER2=$(git ls-remote origin refs/heads/master | awk '{print $1}')
  if [ "$rc" -eq 0 ] && [ "$AFTER1" = "$AFTER2" ] && echo "$out" | grep -qi 'already'; then
    ok "1h: idempotent rerun does not mint a duplicate completion"
  else
    bad "1h: idempotent rerun moved master or failed (rc=$rc before=$AFTER1 after=$AFTER2 out=$out)"
  fi
  if ! git log origin/master --merges --format='%B' | grep -q '^Closes-Epic: #901$' \
    && echo "$out" | grep -qi 'already'; then
    ok "1i: completion remains durable while legacy epic close is drained"
  else
    bad "1i: drained completion emitted a legacy Closes-Epic merge"
  fi
  git clone -q --no-local "$ROOT/origin.git" "$ROOT/keepalive"
  (
    set -e
    cd "$ROOT/keepalive" || exit 1
    git config gc.auto 0
    git config maintenance.auto false
    git fetch -q origin master
    git checkout -q -B master origin/master
    for i in $(seq 1 50); do
      printf 'keepalive %s\n' "$i" >> keepalive.txt
      git add keepalive.txt
      git commit -qm "Keep alive after ops completion $i"
    done
    git push -q origin HEAD:master
  )
  setup_rc=$?
  if [ "$setup_rc" -eq 0 ]; then
    git fetch -q origin master
    git reset --hard -q origin/master
    AFTER_LONG=$(git ls-remote origin refs/heads/master | awk '{print $1}')
    out=$("$TD" complete-ops "$LEAF" "${ops_args[@]}" 2>&1); rc=$?
    AFTER_LONG2=$(git ls-remote origin refs/heads/master | awk '{print $1}')
    if [ "$rc" -eq 0 ] && [ "$AFTER_LONG" = "$AFTER_LONG2" ] && echo "$out" | grep -qi 'already'; then
      ok "1j: long-history idempotent rerun scans without SIGPIPE failure"
    else
      bad "1j: long-history idempotent rerun failed or moved master (rc=$rc out=$out)"
    fi
  else
    bad "1j setup: could not create long post-completion history"
  fi
fi

# ── 2. Normal complete still rejects empty implementation commits. ─────────
git checkout -q master 2>/dev/null || true; git reset --hard -q origin/master
EMPTY_LEAF=$(breakdown_spec "$EPIC" '[{"title":"normal complete empty guard","type":"leaf"}]' force | shorts_from_json | head -1)
if [ -n "$EMPTY_LEAF" ]; then
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost "$TD" claim "$EMPTY_LEAF" >/dev/null 2>&1
  git commit --allow-empty -qm "Empty no-op impl"
  out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost "$TD" complete "$EMPTY_LEAF" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] && echo "$out" | grep -qi 'Empty commit detected'; then
    ok "2: normal complete still rejects an empty implementation commit"
  else
    bad "2: normal complete accepted/failed unexpectedly for empty impl (rc=$rc): $out"
  fi
fi

# Reset to published master before commands that require HEAD == origin/master.
git fetch -q origin master; git reset --hard -q origin/master

# ── 3. Audit input and confirmation guards fail before mutation. ───────────
BAD_LEAF=$(breakdown_spec "$EPIC" '[{"title":"bad input leaf","type":"leaf"}]' force | shorts_from_json | head -1)
if [ -n "$BAD_LEAF" ]; then
  BEFORE=$(git ls-remote origin refs/heads/master | awk '{print $1}')
  if "$TD" complete-ops "$BAD_LEAF" --authorization ok --yes >/dev/null 2>&1; then bad "3a: missing evidence accepted"; else ok "3a: missing evidence rejected"; fi
  if "$TD" complete-ops "$BAD_LEAF" --evidence http://example.test/e --authorization ok --yes >/dev/null 2>&1; then bad "3b: non-https evidence accepted"; else ok "3b: non-https evidence rejected"; fi
  if "$TD" complete-ops "$BAD_LEAF" --evidence https://example.test/e --authorization $'bad\ntrailer' --yes >/dev/null 2>&1; then bad "3c: trailer-injection authorization accepted"; else ok "3c: trailer-injection authorization rejected"; fi
  if "$TD" complete-ops "$BAD_LEAF" --evidence https://example.test/e --authorization ok </dev/null >/dev/null 2>&1; then bad "3d: noninteractive call without --yes accepted"; else ok "3d: noninteractive call without --yes rejected"; fi
  if TASK_DAG_CLAIMER=$'me\nOps-Evidence: forged' "$TD" complete-ops "$BAD_LEAF" --evidence https://example.test/e --authorization ok --yes >/dev/null 2>&1; then bad "3e: trailer-injection claimer env accepted"; else ok "3e: trailer-injection claimer env rejected"; fi
  AFTER=$(git ls-remote origin refs/heads/master | awk '{print $1}')
  if [ "$BEFORE" = "$AFTER" ]; then ok "3f: rejected inputs did not move master"; else bad "3f: rejected inputs moved master"; fi
fi

# ── 4. Roots and decomposed/intermediate nodes are refused. ────────────────
if "$TD" complete-ops "$EPIC" "${ops_args[@]}" >/dev/null 2>&1; then
  bad "4a: pending epic root accepted by complete-ops"
else
  ok "4a: pending epic root refused"
fi
PARENT=$(breakdown_spec "$EPIC" '[{"title":"structural parent","type":"task"}]' force | shorts_from_json | head -1)
if [ -n "$PARENT" ]; then
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=myhost "$TD" claim "$PARENT" >/dev/null 2>&1 || true
  PARENT_SHA=$(git rev-parse "refs/heads/tasks/active/$PARENT"^ 2>/dev/null || git rev-parse "$PARENT")
  printf '[{"title":"child under structural parent","type":"leaf"}]' > "$ROOT/spec-child.json"
  "$TD" breakdown "$PARENT_SHA" --spec-file="$ROOT/spec-child.json" >/dev/null 2>&1
  git fetch -q origin master; git reset --hard -q origin/master
  if "$TD" complete-ops "$PARENT_SHA" "${ops_args[@]}" >/dev/null 2>&1; then
    bad "4b: decomposed/intermediate node accepted by complete-ops"
  else
    ok "4b: decomposed/intermediate node refused"
  fi
fi

# ── 5. Unsatisfied dependencies are not bypassed by --force. ───────────────
mapfile -t DEP_LEAVES < <(breakdown_spec "$EPIC" '[{"title":"ops dependency","type":"leaf"},{"title":"ops dependent","type":"leaf","dependencies":["@1"]}]' force | shorts_from_json)
DEP_TARGET="${DEP_LEAVES[1]:-}"
if [ -n "$DEP_TARGET" ]; then
  if "$TD" complete-ops "$DEP_TARGET" "${ops_args[@]}" --force >/dev/null 2>&1; then
    bad "5: --force bypassed an unsatisfied dependency"
  else
    ok "5: unsatisfied dependency refused even with --force"
  fi
  DEP_SOURCE="${DEP_LEAVES[0]:-}"
  if [ -n "$DEP_SOURCE" ] && "$TD" complete-ops "$DEP_SOURCE" "${ops_args[@]}" >/dev/null 2>&1; then
    ok "5b: dependency source leaf can be completed even though another task depends on it"
  else
    bad "5b: dependency source leaf was mistaken for a decomposed parent"
  fi
fi

# ── 6. Foreign active claims are respected. ────────────────────────────────
FOREIGN=$(breakdown_spec "$EPIC" '[{"title":"foreign claimed ops leaf","type":"leaf"}]' force | shorts_from_json | head -1)
if [ -n "$FOREIGN" ]; then
  TASK_DAG_CLAIMER=alice TASK_DAG_CLAIMER_HOST=hostA "$TD" claim "$FOREIGN" >/dev/null 2>&1
  out=$(TASK_DAG_CLAIMER=bob TASK_DAG_CLAIMER_HOST=hostB "$TD" complete-ops "$FOREIGN" "${ops_args[@]}" 2>&1); rc=$?
  a=$(git ls-remote origin "refs/heads/tasks/active/$FOREIGN" | wc -l)
  if [ "$rc" -ne 0 ] && [ "$a" -eq 1 ] && echo "$out" | grep -qi 'claimed by alice'; then
    ok "6: foreign active claim refused and left intact"
  else
    bad "6: foreign active claim not protected (rc=$rc active=$a out=$out)"
  fi
fi

echo "----"
echo "complete-ops: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
