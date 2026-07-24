#!/usr/bin/env bash
set -euo pipefail
TD="$(realpath "${1:?task-dag path required}")"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
git init -q --bare "$tmp/origin.git"
git init -q "$tmp/work"
git -C "$tmp/work" remote add origin "$tmp/origin.git"
git -C "$tmp/work" config user.name test
git -C "$tmp/work" config user.email test@example.com
empty=$(git -C "$tmp/work" hash-object -t tree /dev/null)
classify() {
  local issue=$1 body=$2 result
  printf '%s' "$body" >"$tmp/classify-body"
  result=$(source "$(dirname "$TD")/task-dag.d/cross-repo.sh"; _xrepo_classify_comment_body acme/widgets "$issue" "$tmp/classify-body")
  printf '%s\n' "${result%%$'\x1f'*}"
}
source "$(dirname "$TD")/task-dag.d/cross-repo.sh"
source "$(dirname "$TD")/task-dag.d/materialise.sh"
printf '%s\n' '{"lease":{"holder":"fixture","fence":1},"cycle":"fixture-cycle"}' >"$tmp/watchdog-token"
taskdag_comment_watchdog_check_file() { [ "$1" = "$tmp/watchdog-token" ] && [ "$2" -eq 510 ]; }
_xrepo_watchdog_token_valid_for "$tmp/watchdog-token" 480
! _xrepo_watchdog_token_valid_for "$tmp/missing-token" 480
taskdag_comment_watchdog_check_file() { [ "$2" -le 300 ]; }
! _xrepo_watchdog_token_valid_for "$tmp/watchdog-token" 480

# Peer epic identity alternatives are authoritative independently: canonical
# close retires pending, while legacy roots may predate gh/issues.
git init -q --bare "$tmp/peer-origin.git"
git init -q "$tmp/peer"
git -C "$tmp/peer" remote add origin "$tmp/peer-origin.git"
git -C "$tmp/peer" config user.name test
git -C "$tmp/peer" config user.email test@example.com
echo peer >"$tmp/peer/state"
git -C "$tmp/peer" add state
git -C "$tmp/peer" commit -qm peer
git -C "$tmp/peer" push -q origin HEAD:master
peer_root=$(git -C "$tmp/peer" commit-tree "$empty" -p HEAD -m 'Peer epic')
stale_root=$(git -C "$tmp/peer" commit-tree "$empty" -p HEAD -m 'Stale peer epic')
git -C "$tmp/peer" push -q origin "$peer_root:refs/heads/gh/issues/1"
git -C "$tmp/peer" update-ref refs/heads/tasks/pending/1 "$stale_root"
[ "$(_xrepo_refresh_peer_issue_root "$tmp/peer" 1)" = "$peer_root" ]
! git -C "$tmp/peer" show-ref --verify --quiet refs/heads/tasks/pending/1
git --git-dir="$tmp/peer-origin.git" update-ref -d refs/heads/gh/issues/1
git -C "$tmp/peer" push -q origin "$peer_root:refs/heads/tasks/pending/1"
git -C "$tmp/peer" update-ref refs/heads/gh/issues/1 "$stale_root"
[ "$(_xrepo_refresh_peer_issue_root "$tmp/peer" 1)" = "$peer_root" ]
! git -C "$tmp/peer" show-ref --verify --quiet refs/heads/gh/issues/1
git -C "$tmp/peer" push -q origin "$peer_root:refs/heads/gh/issues/1"
[ "$(_xrepo_refresh_peer_issue_root "$tmp/peer" 1)" = "$peer_root" ]
git -C "$tmp/peer" push -q --force origin "$stale_root:refs/heads/gh/issues/1"
! _xrepo_refresh_peer_issue_root "$tmp/peer" 1 >/dev/null
git --git-dir="$tmp/peer-origin.git" update-ref -d refs/heads/gh/issues/1
git --git-dir="$tmp/peer-origin.git" update-ref -d refs/heads/tasks/pending/1
! _xrepo_refresh_peer_issue_root "$tmp/peer" 1 >/dev/null

# A peer with no close is still waiting, not erroneous. A strict historical
# close can recover its unique root after both legacy identity refs are gone.
[ -z "$(_xrepo_resolve_peer_close "$tmp/peer" "$(git -C "$tmp/peer" rev-parse HEAD)" 2)" ]
{
  printf '%s\n' 'Task: Legacy peer epic' '' 'Issue: #2' 'Status: pending' 'Type: epic' ''
  # Keep enough trailing body data to force a producer-side SIGPIPE if the
  # header parser exits early under pipefail instead of consuming the stream.
  yes 'Large historical task body that must not affect header validation.' | head -n 4096 || true
} >"$tmp/legacy-root-message"
legacy_root=$(git -C "$tmp/peer" commit-tree "$empty" -p HEAD -F "$tmp/legacy-root-message")
legacy_base=$(git -C "$tmp/peer" rev-parse HEAD)
legacy_close=$(git -C "$tmp/peer" commit-tree "$(git -C "$tmp/peer" rev-parse "${legacy_base}^{tree}")" \
  -p "$legacy_base" -p "$legacy_root" -m $'Close legacy peer epic\n\nCloses-Epic: #2')
git -C "$tmp/peer" update-ref refs/heads/master "$legacy_close"
git -C "$tmp/peer" push -q origin master:master
[ "$(_xrepo_resolve_peer_close "$tmp/peer" "$legacy_close" 2)" = "$legacy_close"$'\t'"$legacy_root" ]

# The durable delegated-close validator uses the same historical resolver;
# both remote and stale local identity refs remain absent.
git -C "$tmp/work" config taskdag.peer-path.peer/repo.path "$tmp/peer"
taskdag_peer_worktree_for() { [ "$1" = peer/repo ] && printf '%s\n' "$tmp/peer"; }
digest=$(printf x | sha256sum | awk '{print $1}')
delegation=$(printf '%s\n' 'Delegation' '' \
  'Parent-Repo-Node-Id: PR_parent' 'Parent-Issue-Node-Id: PI_parent' \
  'Peer-Repo-Node-Id: PR_peer' 'Peer-Issue-Node-Id: PI_peer' \
  'Materialisation-Operation-Id: operation-2' "Declaration-Digest: $digest" \
  | git -C "$tmp/work" commit-tree "$empty")
record=$(printf '%s\n' 'Record delegated close' '' 'Task-Dag-Delegated-Close: v1' \
  'Parent-Repo: acme/widgets' 'Parent-Issue: #99' 'Peer-Repo: peer/repo' 'Peer-Issue: #2' \
  'Parent-Repo-Node-Id: PR_parent' 'Parent-Issue-Node-Id: PI_parent' \
  'Peer-Repo-Node-Id: PR_peer' 'Peer-Issue-Node-Id: PI_peer' \
  'Materialisation-Operation-Id: operation-2' "Declaration-Digest: $digest" \
  "Peer-Tip: $legacy_close" "Peer-Close: $legacy_close" "Peer-Epic: $legacy_root" \
  | git -C "$tmp/work" commit-tree "$empty" -p "$delegation")
(cd "$tmp/work" && _xrepo_validate_delegated_close_v1 "$record" "$delegation" \
  acme/widgets 99 peer/repo 2)
empty_legacy_marker=$(printf '%s\n' "$(git -C "$tmp/work" show -s --format=%B "$record")" 'Legacy-Delegation:' \
  | git -C "$tmp/work" commit-tree "$empty" -p "$delegation")
! (cd "$tmp/work" && _xrepo_validate_delegated_close_v1 "$empty_legacy_marker" "$delegation" \
  acme/widgets 99 peer/repo 2)
! git -C "$tmp/peer" show-ref --verify --quiet refs/heads/gh/issues/2
! git -C "$tmp/peer" show-ref --verify --quiet refs/heads/tasks/pending/2

legacy_delegation=$(printf '%s\n' 'Legacy delegation' | git -C "$tmp/work" commit-tree "$empty")
legacy_evidence=$(jq -ncS --arg close "$legacy_close" --arg root "$legacy_root" --arg delegation "$legacy_delegation" \
  '{parentRepo:"acme/widgets",parentIssue:99,peerRepo:"peer/repo",peerIssue:2,legacyDelegationSha:$delegation,peerTip:$close,peerClose:$close,peerEpic:$root}')
legacy_record=$(_taskdag_delegated_close_message "$legacy_evidence" \
  | git -C "$tmp/work" commit-tree "$empty" -p "$legacy_delegation")
(cd "$tmp/work" && _xrepo_validate_delegated_close_v1 "$legacy_record" "$legacy_delegation" \
  acme/widgets 99 peer/repo 2)
wrong_legacy_record=$(printf '%s\n' "$(git -C "$tmp/work" show -s --format=%B "$legacy_record" | sed "s/Legacy-Delegation: .*/Legacy-Delegation: $delegation/")" \
  | git -C "$tmp/work" commit-tree "$empty" -p "$legacy_delegation")
! (cd "$tmp/work" && _xrepo_validate_delegated_close_v1 "$wrong_legacy_record" "$legacy_delegation" \
  acme/widgets 99 peer/repo 2)
partial_delegation=$(printf '%s\n' 'Partial delegation' '' 'Parent-Repo-Node-Id: PR_parent' \
  | git -C "$tmp/work" commit-tree "$empty")
partial_evidence=$(jq -ncS --arg close "$legacy_close" --arg root "$legacy_root" --arg delegation "$partial_delegation" \
  '{parentRepo:"acme/widgets",parentIssue:99,peerRepo:"peer/repo",peerIssue:2,legacyDelegationSha:$delegation,peerTip:$close,peerClose:$close,peerEpic:$root}')
partial_record=$(_taskdag_delegated_close_message "$partial_evidence" \
  | git -C "$tmp/work" commit-tree "$empty" -p "$partial_delegation")
! (cd "$tmp/work" && _xrepo_validate_delegated_close_v1 "$partial_record" "$partial_delegation" \
  acme/widgets 99 peer/repo 2)
empty_partial_delegation=$(printf '%s\n' 'Partial delegation' '' 'Parent-Repo-Node-Id:' \
  | git -C "$tmp/work" commit-tree "$empty")
empty_partial_evidence=$(jq -ncS --arg close "$legacy_close" --arg root "$legacy_root" --arg delegation "$empty_partial_delegation" \
  '{parentRepo:"acme/widgets",parentIssue:99,peerRepo:"peer/repo",peerIssue:2,legacyDelegationSha:$delegation,peerTip:$close,peerClose:$close,peerEpic:$root}')
empty_partial_record=$(_taskdag_delegated_close_message "$empty_partial_evidence" \
  | git -C "$tmp/work" commit-tree "$empty" -p "$empty_partial_delegation")
! (cd "$tmp/work" && _xrepo_validate_delegated_close_v1 "$empty_partial_record" "$empty_partial_delegation" \
  acme/widgets 99 peer/repo 2)

# Two structurally valid historical roots for one issue are ambiguous.
ambiguous_a=$(git -C "$tmp/peer" commit-tree "$empty" -p HEAD -m $'Task: Ambiguous A\n\nIssue: #3\nStatus: pending\nType: epic')
ambiguous_b=$(git -C "$tmp/peer" commit-tree "$empty" -p HEAD -m $'Task: Ambiguous B\n\nIssue: #3\nStatus: pending\nType: epic')
ambiguous_close_a=$(git -C "$tmp/peer" commit-tree "$(git -C "$tmp/peer" rev-parse "${legacy_close}^{tree}")" \
  -p "$legacy_close" -p "$ambiguous_a" -m $'Close ambiguous A\n\nCloses-Epic: #3')
ambiguous_close_b=$(git -C "$tmp/peer" commit-tree "$(git -C "$tmp/peer" rev-parse "${ambiguous_close_a}^{tree}")" \
  -p "$ambiguous_close_a" -p "$ambiguous_b" -m $'Close ambiguous B\n\nCloses-Epic: #3')
! _xrepo_resolve_peer_close "$tmp/peer" "$ambiguous_close_b" 3 >/dev/null
metadata_sha=0123456789abcdef0123456789abcdef01234567
[ "$(classify 10 "Task metadata commit: $metadata_sha | Branch: tasks/pending/10")" = machine-skip ]
[ "$(classify 11 "Task metadata commit: $metadata_sha | Branch: tasks/pending/10")" = human ]
[ "$(classify 10 'Task metadata commit: 0123456 | Branch: tasks/pending/10')" = human ]
[ "$(classify 10 "Task metadata commit: $metadata_sha | Branch: tasks/pending/10 extra")" = human ]
[ "$(classify 10 $'Task metadata commit: '$metadata_sha$' | Branch: tasks/pending/10\n')" = human ]
[ "$(classify 10 $'Task metadata commit:\t'$metadata_sha$' | Branch: tasks/pending/10')" = human ]
clarification=$(printf '%s\n' 'kind: message' 'role: human' 'intent: clarification' '' \
  'issue:' '  number: 10' '  repo: acme/widgets' '' 'github:' '  comment_id: 98' \
  | git -C "$tmp/work" commit-tree "$empty")
manual_cleanup=$(printf '%s\n' 'kind: completion' 'role: system' 'intent: cross-repo-satisfied' '' \
  'issue:' '  repo: acme/widgets' '  number: 12' '' 'delegated:' '  repo: acme/peer' \
  '  number: 1' '' 'source:' '  repo: acme/peer' '  commit: abcdef123456' \
  '  comment_id: manual-cleanup-peer-1' \
  | git -C "$tmp/work" commit-tree "$empty")
git -C "$tmp/work" push -q origin \
  "$clarification:refs/heads/gh/comments/10/98" \
  "$manual_cleanup:refs/heads/gh/comments/12/manual-cleanup-peer-1"
mkdir "$tmp/bin"
cat >"$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
endpoint="${*: -1}"
printf '%s\n' "$endpoint" >>"$GH_LOG"
header() {
  printf 'HTTP/2 200\r\nx-ratelimit-remaining: 4999\r\nx-ratelimit-reset: 2000000000\r\n'
}
comment() {
  jq -nc --argjson id "$1" --arg issue "$2" --arg created "$3" --arg updated "$4" --arg body "$5" \
    '{id:$id,issue_url:("https://api.github.com/repos/Acme/Widgets/issues/"+$issue),created_at:$created,updated_at:$updated,body:$body,user:{login:"alice"},html_url:("https://github.com/Acme/Widgets/issues/"+$issue+"#issuecomment-"+($id|tostring))}'
}
case "$endpoint" in
  repos/acme/widgets)
    if [[ "${GH_TIMEOUT_REPO:-0}" == 1 ]]; then sleep 5; exit 1; fi
    header; printf '\r\n{"id":123}\n'
    ;;
  *issues/comments/99)
    header; printf '\r\n'; comment 99 10 2020-01-01T00:00:00Z 2020-01-01T00:00:00Z historical
    ;;
  *issues/comments?*) if [[ "${GH_CLOSED_ONLY:-0}" == 1 ]]; then
    header; printf '\r\n['
    comment 5 12 2025-01-02T00:00:00Z 2025-01-03T00:00:00Z late-closed-comment
    printf ']\n'
    exit 0
    fi
    ;;&
  *issues/comments*page=2*)
    header; printf '\r\n['
    comment 2 10 2025-01-02T00:00:00Z 2025-01-03T00:00:00Z work
    printf ','; comment 4 10 2025-01-02T00:00:00Z 2025-01-03T00:00:00Z '<!-- task-dag:status -->'
    printf ','; comment 5 12 2025-01-02T00:00:00Z 2025-01-03T00:00:00Z late-closed-comment
    printf ']\n'
    ;;
  *issues/comments?*)
    header
    link_id=123; [[ "${GH_BAD_NUMERIC_LINK:-0}" == 0 ]] || link_id=124
    printf 'link: <https://api.github.com/repositories/%s/issues/comments?sort=updated&direction=asc&per_page=100&since=2025-01-01T00%%3A00%%3A00Z&page=2>; rel="next"\r\n\r\n[' "$link_id"
    comment 1 10 2024-12-01T00:00:00Z 2025-01-03T00:00:00Z old
    printf ','; comment 2 10 2025-01-02T00:00:00Z 2025-01-03T00:00:00Z work
    printf ','; comment 3 11 2025-01-02T00:00:00Z 2025-01-03T00:00:00Z pull-request
    printf ']\n'
    ;;
  *issues/10) header; printf '\r\n{"number":10,"state":"open","title":"Issue ten","body":"","html_url":"https://github.com/acme/widgets/issues/10","user":{"login":"alice"}}\n' ;;
  *issues/11) header; printf '\r\n{"number":11,"state":"open","title":"Pull request","body":"","html_url":"https://github.com/acme/widgets/pull/11","user":{"login":"alice"},"pull_request":{}}\n' ;;
  *issues/12)
    if [[ "${GH_TIMEOUT_ISSUE:-0}" == 1 ]]; then sleep 5; exit 1; fi
    header; printf '\r\n{"number":12,"state":"closed","title":"Closed issue","body":"","html_url":"https://github.com/acme/widgets/issues/12","user":{"login":"alice"}}\n'
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/gh"
export GH_LOG="$tmp/gh.log"
cat >"$tmp/bin/reconcile-fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$TD" --help >/dev/null
taskdag_comment_watchdog_check_file() { :; }
taskdag_consumer_prepare() { :; }
taskdag_activation_snapshot_token() {
  jq -ncS --arg commit "$FIXTURE_COMMIT" --arg runtime "$FIXTURE_RUNTIME" '{activationCommit:$commit,authorityTip:$commit,digest:"3333333333333333333333333333333333333333333333333333333333333333",epoch:1,guardVersion:1,minimumCompatibleTaskDagCommit:$runtime,origin:"fixture",runtimeCommit:$runtime,state:"enabled"}'
}
taskdag_activation_validate_provenance() { [ -z "${GIT_SHALLOW_FILE:-}" ]; }
_taskdag_activation_runtime_commit() { printf '%s\n' "$FIXTURE_RUNTIME"; }
taskdag_consumer_fenced_scheduling_push() {
  local updates=$3 ref old new
  ref=$(jq -r '.[0].ref' <<<"$updates")
  old=$(jq -r '.[0].old' <<<"$updates")
  new=$(jq -r '.[0].new' <<<"$updates")
  git push -q origin "--force-with-lease=${ref}:${old}" "$new:$ref"
}
_xrepo_reconcile_comments_impl "$@"
EOF
chmod +x "$tmp/bin/reconcile-fixture"
export TD FIXTURE_COMMIT="$clarification" FIXTURE_RUNTIME="$(git -C "$(dirname "$TD")/.." rev-parse HEAD)"
# Initialization is explicit, watchdog-fenced, and performs no API work.
set +e
absent_out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    reconcile-fixture --mode complete --ingestion-start-at 2025-01-01T00:00:00Z --dry-run)
absent_rc=$?
set -e
[ "$absent_rc" -ne 0 ]
jq -e 'any(.failure_items[]; .message | contains("--initialize-index"))' <<<"$absent_out" >/dev/null
: >"$GH_LOG"
init_out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    reconcile-fixture --mode complete --ingestion-start-at 2025-01-01T00:00:00Z \
    --initialize-index --watchdog-token-file "$tmp/watchdog-token")
jq -e '.status == "success" and .requests == 0' <<<"$init_out" >/dev/null
[ ! -s "$GH_LOG" ]
index_tip=$(git --git-dir="$tmp/origin.git" rev-parse refs/heads/tasks/v1/reconcile-comments-index)
[ "$(git --git-dir="$tmp/origin.git" rev-list --parents -n1 "$index_tip" | wc -w)" -eq 1 ]
# Strict history validation rejects a merge successor even when its tree is
# otherwise byte-for-byte valid.
bad_index=$(printf 'Malformed index successor\n' | git -C "$tmp/work" commit-tree \
    "$(git --git-dir="$tmp/origin.git" rev-parse "$index_tip^{tree}")" -p "$index_tip" -p "$clarification")
! (cd "$tmp/work" && _xrepo_reconcile_index_read "$bad_index" "$tmp/bad-index" acme/widgets "")
refs_before=$(git --git-dir="$tmp/origin.git" for-each-ref --format='%(objectname) %(refname)' | sort)
: >"$tmp/validation-work"
out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    TASKDAG_VALIDATION_WORK_COUNTER="$tmp/validation-work" \
    reconcile-fixture --mode complete \
    --ingestion-start-at 2025-01-01T00:00:00Z --allow-comment 10:99 --dry-run)
[ ! -s "$tmp/validation-work" ]
[ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ]
jq -e '.schema_version == 1 and .status == "success" and .dry_run == true and
       .pages == 2 and .requests == 7 and .returned == 7 and .unique == 6 and
       .pre_boundary == 1 and .pull_requests == 1 and .eligible == 4 and
       .missing == 4 and .dispositions == {human:2,completion:0,machine_skip:2} and
       .attempted == 0 and .deferred == 4 and .failures == 0 and
       .recent_success_at == null and .complete_success_at == null' <<<"$out" >/dev/null
grep -q 'since=2024-12-31T23:45:00Z' "$GH_LOG"
grep -Fxq 'repositories/123/issues/comments?sort=updated&direction=asc&per_page=100&since=2025-01-01T00%3A00%3A00Z&page=2' "$GH_LOG"
refs_after=$(git --git-dir="$tmp/origin.git" for-each-ref --format='%(objectname) %(refname)' | sort)
[ "$refs_after" = "$refs_before" ]

# Apply mode: a late human comment on a closed issue is receipted without
# recreating work, while an immutable historical completion receipt for that
# same closed issue does not attempt close convergence against a retired root.
: >"$GH_LOG"
apply_out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    GH_CLOSED_ONLY=1 reconcile-fixture --mode complete \
    --ingestion-start-at 2025-01-01T00:00:00Z --watchdog-token-file "$tmp/watchdog-token" || true)
jq -e '.status == "failed" and .dry_run == false and .applied == 1 and
       .dispositions.machine_skip == 1 and
       any(.failure_items[]; .message | contains("coordination refs advanced after effects"))' <<<"$apply_out" >/dev/null
receipt=$(git --git-dir="$tmp/origin.git" rev-parse refs/heads/gh/comments/12/5)
[ "$(git --git-dir="$tmp/origin.git" rev-list --parents -n1 "$receipt" | wc -w)" -eq 1 ]
git --git-dir="$tmp/origin.git" show -s --format=%B "$receipt" | grep -Fxq 'Disposition: machine-skip'
! git --git-dir="$tmp/origin.git" show-ref --verify --quiet refs/heads/tasks/pending/12
! git --git-dir="$tmp/origin.git" for-each-ref --format='%(refname)' refs/heads/tasks/frontier/ | grep -q .
# The next sweep validates exactly the new immutable receipt, then clears the
# preserved queue. No previously indexed fact is reparsed.
: >"$tmp/validation-work"
apply_out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    GH_CLOSED_ONLY=1 TASKDAG_VALIDATION_WORK_COUNTER="$tmp/validation-work" \
    reconcile-fixture --mode complete --ingestion-start-at 2025-01-01T00:00:00Z \
    --watchdog-token-file "$tmp/watchdog-token")
jq -e '.status == "success" and .dry_run == false and .applied == 0 and
       .already_receipted == 1 and .failures == 0 and .complete_success_at != null' <<<"$apply_out" >/dev/null
[ "$(cut -f1 "$tmp/validation-work")" = receipt ]
# Immutable completion backlog converges before the potentially long API
# pagination scan, while the invocation still has its full time budget.
issue_line=$(grep -n -m1 '^repos/acme/widgets/issues/12$' "$GH_LOG" | cut -d: -f1)
list_line=$(grep -n -m1 '^repos/acme/widgets/issues/comments?' "$GH_LOG" | cut -d: -f1)
[ "$issue_line" -lt "$list_line" ]

# A deadline that expires inside convergence remains distinguishable from
# corrupt or absent authority; do not continue into nested Git and misreport
# the synthetic timeout as a missing master/HEAD tip.
set +e
timeout_out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    GH_TIMEOUT_REPO=1 GH_CLOSED_ONLY=1 reconcile-fixture --mode complete \
    --ingestion-start-at 2025-01-01T00:00:00Z --max-seconds 3 \
    --watchdog-token-file "$tmp/watchdog-token" 2>"$tmp/timeout.err")
timeout_rc=$?
set -e
[ "$timeout_rc" -eq 124 ]
jq -e '.status == "failed" and .failures == 1 and
       (.failure_items | length) == 1 and .failure_items[0].message == "time ceiling reached"' \
  <<<"$timeout_out" >/dev/null
! grep -Eq 'cannot resolve (a )?master/HEAD tip|integer expected' "$tmp/timeout.err"

set +e
mismatch_out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets GH_BAD_NUMERIC_LINK=1 \
    reconcile-fixture --mode complete \
    --ingestion-start-at 2025-01-01T00:00:00Z --dry-run)
mismatch_rc=$?
set -e
[ "$mismatch_rc" -ne 0 ]
jq -e '.status == "failed" and .failures == 1 and
       .failure_items == [{stage:"list",issue:null,comment_id:null,message:"unsafe pagination link"}]' \
  <<<"$mismatch_out" >/dev/null

unsupported=$(printf '%s\n' 'kind: message' 'role: human' 'intent: unsupported' '' \
  'issue:' '  number: 10' '  repo: acme/widgets' '' 'github:' '  comment_id: 97' \
  | git -C "$tmp/work" commit-tree "$empty")
git -C "$tmp/work" push -q origin "$unsupported:refs/heads/gh/comments/10/97"
set +e
bad_out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    reconcile-fixture --mode complete \
    --ingestion-start-at 2025-01-01T00:00:00Z --dry-run)
bad_rc=$?
set -e
[ "$bad_rc" -ne 0 ]
jq -e '.status == "failed" and .failures == 1 and
       .failure_items == [{stage:"snapshot",issue:10,comment_id:97,message:"malformed comment receipt"}]' \
  <<<"$bad_out" >/dev/null

# Activated delegated-close reconciliation must prepare the canonical
# consumer before its fenced scheduling write. Exercise the real preparation,
# activation guard, atomic push, and readback with a legacy delegation.
integration="$tmp/activated-delegated-close"
mkdir -p "$integration"
repo_root=$(cd "$(dirname "$TD")/.." && pwd)
runtime=$(git -C "$repo_root" rev-parse HEAD)
git init -q --bare "$integration/origin.git"
git clone -q "$repo_root" "$integration/parent"
git -C "$integration/parent" remote set-url origin "$integration/origin.git"
git -C "$integration/parent" config user.name test
git -C "$integration/parent" config user.email test@example.com
git -C "$integration/parent" push -q origin HEAD:master
git -C "$integration/parent" config taskdag.current-repo virusdave/task-dag
git -C "$integration/parent" config taskdag.virusdave/task-dag.id parent-id

git init -q --bare "$integration/peer-origin.git"
git init -q "$integration/peer"
git -C "$integration/peer" remote add origin "$integration/peer-origin.git"
git -C "$integration/peer" config user.name test
git -C "$integration/peer" config user.email test@example.com
printf peer >"$integration/peer/state"
git -C "$integration/peer" add state
git -C "$integration/peer" commit -qm 'Peer base'
integration_empty=$(git -C "$integration/peer" mktree </dev/null)
integration_root=$(git -C "$integration/peer" commit-tree "$integration_empty" -p HEAD \
  -m $'Task: Historical peer epic\n\nIssue: #2\nStatus: pending\nType: epic')
integration_base=$(git -C "$integration/peer" rev-parse HEAD)
integration_close=$(git -C "$integration/peer" commit-tree "$(git -C "$integration/peer" rev-parse "$integration_base^{tree}")" \
  -p "$integration_base" -p "$integration_root" -m $'Close historical peer epic\n\nCloses-Epic: #2')
git -C "$integration/peer" update-ref refs/heads/master "$integration_close"
git -C "$integration/peer" push -q origin master:master

integration_delegation=$(printf '%s\n' 'kind: delegated' 'role: system' 'intent: delegated-child' '' \
  'issue:' '  repo: virusdave/task-dag' '  number: 1' '' \
  'delegated:' '  repo: peer/repo' '  number: 2' \
  | git -C "$integration/parent" commit-tree "$integration_empty")
git -C "$integration/parent" push -q origin \
  "$integration_delegation:refs/heads/tasks/delegated/1/peer/repo/2"
git -C "$integration/parent" config taskdag.peer-path.peer/repo.path "$integration/peer"

registry_commit=1111111111111111111111111111111111111111
registry_blob=2222222222222222222222222222222222222222
jq -ncS --arg commit "$registry_commit" --arg blob "$registry_blob" \
  '{schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$commit,blob:$blob},repositories:[{repository:"virusdave/task-dag",repositoryId:"parent-id",name:"task-dag",repairMode:"off",repairBranch:null}]}' \
  >"$integration/registry"
source "$(dirname "$TD")/task-dag.d/activation.sh"
registry_id=$(_taskdag_activation_registry_id "$integration/registry")
jq -ncS --arg runtime "$runtime" --arg registry_commit "$registry_commit" \
  --arg registry_blob "$registry_blob" --arg id "$registry_id" \
  '{actor:"fixture",authoritativeTimestamp:"2026-07-20T00:00:00Z",minimumCompatibleTaskDagCommit:$runtime,registrySnapshot:{id:$id,schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$registry_commit,blob:$registry_blob},repositories:[{repository:"virusdave/task-dag",repositoryId:"parent-id",name:"task-dag",repairMode:"off",repairBranch:null}]},sourceTips:[{repository:"virusdave/task-dag",repositoryId:"parent-id",ref:"refs/heads/master",commit:$runtime}],state:"enabled"}' \
  >"$integration/activation"
(cd "$integration/parent" && "$TD" activation apply --spec-file "$integration/activation" >/dev/null)
activation_before=$(git --git-dir="$integration/origin.git" rev-parse refs/heads/tasks/v1/activation)

(cd "$integration/parent" && source "$TD" --help >/dev/null && \
  _xrepo_watchdog_fence() { :; } && \
  _xrepo_reconcile_delegated_close 1 peer/repo 2 "$integration_delegation")
close_ref=refs/heads/tasks/delegated-close/v1/1/peer/repo/2
integration_record=$(git --git-dir="$integration/origin.git" rev-parse "$close_ref")
activation_after=$(git --git-dir="$integration/origin.git" rev-parse refs/heads/tasks/v1/activation)
(cd "$integration/parent" && git fetch -q origin "$close_ref" && source "$TD" --help >/dev/null && \
  _xrepo_validate_delegated_close_v1 "$integration_record" "$integration_delegation" \
    virusdave/task-dag 1 peer/repo 2)
git --git-dir="$integration/origin.git" show -s --format=%B "$activation_after" \
  | grep -Fxq 'Writer-Class: scheduling'
git --git-dir="$integration/origin.git" show -s --format=%B "$activation_after" \
  | grep -Fxq 'Operation: reconcile-delegated-close'
git --git-dir="$integration/origin.git" show -s --format=%B "$activation_after" \
  | sed -n 's/^Target-Updates: //p' \
  | jq -e --arg ref "$close_ref" --arg record "$integration_record" \
      '. == [{ref:$ref,old:"",new:$record}]' >/dev/null
[ "$activation_after" != "$activation_before" ]
(cd "$integration/parent" && source "$TD" --help >/dev/null && \
  _xrepo_watchdog_fence() { :; } && \
  _xrepo_reconcile_delegated_close 1 peer/repo 2 "$integration_delegation")
[ "$integration_record" = "$(git --git-dir="$integration/origin.git" rev-parse "$close_ref")" ]
[ "$activation_after" = "$(git --git-dir="$integration/origin.git" rev-parse refs/heads/tasks/v1/activation)" ]

# Peer indexing scans genesis once, then only the first-parent delta. An
# unrelated fast-forward preserves the immutable oldest-close witness, and an
# unchanged cursor performs no history work at all.
peer_index_0="$integration/peer-index-0.json"
peer_index_1="$integration/peer-index-1.json"
peer_index_2="$integration/peer-index-2.json"
peer_work="$integration/peer-work.tsv"
(cd "$integration/parent" && source "$TD" --help >/dev/null && \
  TASKDAG_VALIDATION_WORK_COUNTER="$peer_work" _xrepo_index_peer_delta peer/repo "" "$peer_index_0")
witness_0=$(jq -c '.witnesses["2"]' "$peer_index_0")
printf unrelated >>"$integration/peer/state"
git -C "$integration/peer" add state
git -C "$integration/peer" commit -qm 'Advance peer without another close'
git -C "$integration/peer" push -q origin master:master
: >"$peer_work"
(cd "$integration/parent" && source "$TD" --help >/dev/null && \
  TASKDAG_VALIDATION_WORK_COUNTER="$peer_work" _xrepo_index_peer_delta peer/repo "$(cat "$peer_index_0")" "$peer_index_1")
[ "$(jq -c '.witnesses["2"]' "$peer_index_1")" = "$witness_0" ]
[ "$(cut -f1 "$peer_work")" = peer-delta ]
: >"$peer_work"
(cd "$integration/parent" && source "$TD" --help >/dev/null && \
  TASKDAG_VALIDATION_WORK_COUNTER="$peer_work" _xrepo_index_peer_delta peer/repo "$(cat "$peer_index_1")" "$peer_index_2")
[ ! -s "$peer_work" ]
(cd "$integration/parent" && source "$TD" --help >/dev/null && \
  _xrepo_validate_delegated_close_v1 "$integration_record" "$integration_delegation" \
    virusdave/task-dag 1 peer/repo 2 "" "$witness_0")
# Indexed creation combines the peer-level mutable cursor with the immutable
# issue witness; Peer-Tip must never be read from the witness itself.
indexed_delegation=$(printf '%s\n' 'kind: delegated' 'role: system' 'intent: delegated-child' '' \
  'issue:' '  repo: virusdave/task-dag' '  number: 4' '' \
  'delegated:' '  repo: peer/repo' '  number: 2' \
  | git -C "$integration/parent" commit-tree "$integration_empty")
indexed_ref=refs/heads/tasks/delegated/4/peer/repo/2
git -C "$integration/parent" push -q origin "$indexed_delegation:$indexed_ref"
indexed_proof=$(cd "$integration/parent" && source "$TD" --help >/dev/null && \
  _xrepo_normalize_delegation "$indexed_delegation" "$indexed_ref" virusdave/task-dag 4 peer/repo 2)
jq -ncS --arg ref "$indexed_ref" --argjson proof "$indexed_proof" '{version:1,delegations:{($ref):$proof}}' \
  >"$integration/indexed-proofs.json"
jq -ncS --argjson peer "$(cat "$peer_index_1")" '{version:1,peers:{"peer/repo":$peer}}' \
  >"$integration/indexed-peers.json"
(cd "$integration/parent" && source "$TD" --help >/dev/null && _xrepo_watchdog_fence() { :; } && \
  _XREPO_INDEX_PROOFS_FILE="$integration/indexed-proofs.json" \
  _XREPO_INDEX_PEERS_FILE="$integration/indexed-peers.json" \
  _xrepo_reconcile_delegated_close 4 peer/repo 2 "$indexed_delegation")
indexed_close=$(git --git-dir="$integration/origin.git" rev-parse refs/heads/tasks/delegated-close/v1/4/peer/repo/2)
[ "$(git --git-dir="$integration/origin.git" show -s --format='%(trailers:key=Peer-Tip,valueonly)' "$indexed_close")" \
  = "$(jq -r .tip "$peer_index_1")" ]
# Generic graph ancestry is insufficient: if the previous cursor appears only
# as a merge's second parent, the first-parent delta is discontinuous.
indexed_tip=$(jq -r .tip "$peer_index_1")
side_tip=$(printf 'Side line\n' | git -C "$integration/peer" commit-tree \
  "$(git -C "$integration/peer" rev-parse "$integration_base^{tree}")" -p "$integration_base")
second_parent_tip=$(printf 'Old cursor is second parent\n' | git -C "$integration/peer" commit-tree \
  "$(git -C "$integration/peer" rev-parse "$side_tip^{tree}")" -p "$side_tip" -p "$indexed_tip")
git -C "$integration/peer" push -q --force origin "$second_parent_tip:refs/heads/master"
! (cd "$integration/parent" && source "$TD" --help >/dev/null && \
  _xrepo_index_peer_delta peer/repo "$(cat "$peer_index_1")" "$integration/second-parent.json")
# Replacing the peer cursor with a non-descendant fails closed.
git -C "$integration/peer" push -q --force origin "$integration_base:refs/heads/master"
! (cd "$integration/parent" && source "$TD" --help >/dev/null && \
  _xrepo_index_peer_delta peer/repo "$(cat "$peer_index_1")" "$integration/non-ff.json")
echo "reconcile-comments fixture: ok"
