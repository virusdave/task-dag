#!/usr/bin/env bash
set -euo pipefail
TD="$(realpath "${1:?task-dag path required}")"
TASKDAG_SCRIPT_DIR=$(dirname "$TD")
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
source "$(dirname "$TD")/task-dag.d/git-objects.sh"
source "$(dirname "$TD")/task-dag.d/child-map.sh"
source "$(dirname "$TD")/task-dag.d/claim-model.sh"
source "$(dirname "$TD")/task-dag.d/repository-identity.sh"
source "$(dirname "$TD")/task-dag.d/github-origin.sh"
source "$(dirname "$TD")/task-dag.d/blocked-core.sh"
taskdag_consumer_prepare() {
  TASKDAG_CONSUMER_READY=true
  TASKDAG_CHILD_MAP_REFS=$(git for-each-ref --format='%(objectname) %(refname)' refs/heads/tasks/pending/ refs/heads/gh/issues/)
}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
git init -q --bare "$tmp/origin.git"
git init -q "$tmp/work"
git -C "$tmp/work" remote add origin "$tmp/origin.git"
git -C "$tmp/work" config user.name test
git -C "$tmp/work" config user.email test@example.com
git -C "$tmp/work" config taskdag.current-repo acme/widgets
empty=$(git -C "$tmp/work" hash-object -t tree /dev/null)
classify() {
  local issue=$1 body=$2 result
  printf '%s' "$body" >"$tmp/classify-body"
  result=$(source "$(dirname "$TD")/task-dag.d/cross-repo.sh"; _xrepo_classify_comment_body acme/widgets "$issue" "$tmp/classify-body")
  printf '%s\n' "${result%%$'\x1f'*}"
}
source "$(dirname "$TD")/task-dag.d/cross-repo.sh"
source "$(dirname "$TD")/task-dag.d/materialise-parsing.sh"
source "$(dirname "$TD")/task-dag.d/materialise-intent.sh"
taskdag_json_no_duplicate_keys() { jq empty "$1"; }
taskdag_json_file_is_single_strict() { jq empty "$1"; }
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
git -C "$tmp/work" push -q origin \
  "$delegation:refs/heads/tasks/delegated/99/peer/repo/2" \
  "$record:refs/heads/tasks/delegated-close/v1/99/peer/repo/2"
status_no_delegation=$(cd "$tmp/work" && _xrepo_epic_status 98 2>&1)
[ "$status_no_delegation" = '[task-dag] epic has no delegations: 98' ]
status_v1_complete=$(cd "$tmp/work" && _xrepo_epic_status 99 2>&1)
[ "$status_v1_complete" = 'epic ready-to-close: 99' ]
git --git-dir="$tmp/origin.git" update-ref -d refs/heads/tasks/delegated-close/v1/99/peer/repo/2
status_v1_missing=$(cd "$tmp/work" && _xrepo_epic_status 99 2>&1)
[ "$status_v1_missing" = 'epic still waiting: 99 missing peer/repo#2' ]
git --git-dir="$tmp/origin.git" update-ref -d refs/heads/tasks/delegated/99/peer/repo/2
git -C "$tmp/work" update-ref -d refs/heads/tasks/delegated/99/peer/repo/2
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
locale_issue_2=$(printf '%s\n' 'kind: message' 'role: human' 'intent: clarification' '' \
  'issue:' '  number: 2' '  repo: acme/widgets' '' 'github:' '  comment_id: 96' \
  | git -C "$tmp/work" commit-tree "$empty")
locale_issue_20=$(printf '%s\n' 'kind: message' 'role: human' 'intent: clarification' '' \
  'issue:' '  number: 20' '  repo: acme/widgets' '' 'github:' '  comment_id: 97' \
  | git -C "$tmp/work" commit-tree "$empty")
manual_cleanup=$(printf '%s\n' 'kind: completion' 'role: system' 'intent: cross-repo-satisfied' '' \
  'issue:' '  repo: acme/widgets' '  number: 12' '' 'delegated:' '  repo: acme/peer' \
  '  number: 1' '' 'source:' '  repo: acme/peer' '  commit: abcdef123456' \
  '  comment_id: manual-cleanup-peer-1' \
  | git -C "$tmp/work" commit-tree "$empty")
git -C "$tmp/work" push -q origin \
  "$clarification:refs/heads/gh/comments/10/98" \
  "$locale_issue_2:refs/heads/gh/comments/2/96" \
  "$locale_issue_20:refs/heads/gh/comments/20/97" \
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
    # Keep the provider delay strictly beyond the command budget, with enough
    # headroom for index preparation under the parallel fixture runner. An
    # equal sleep/deadline boundary can surface an unrelated earlier stage.
    if [[ "${GH_TIMEOUT_REPO:-0}" == 1 ]]; then sleep 20; exit 1; fi
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
  *issues/1|*issues/2|*issues/20)
    number=${endpoint##*/}
    header; printf '\r\n'
    jq -nc --argjson number "$number" '{number:$number,state:"closed",title:"Closed locale fixture",body:"",html_url:("https://github.com/acme/widgets/issues/"+($number|tostring)),user:{login:"alice"}}'
    ;;
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
taskdag_consumer_prepare() {
  TASKDAG_CONSUMER_READY=true
  TASKDAG_CHILD_MAP_REFS=$(git for-each-ref --format='%(objectname) %(refname)' refs/heads/tasks/pending/ refs/heads/gh/issues/)
}
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
jq -e 'any(.failure_items[]; .message == "reconciliation checkpoint repair is required (reason: absent)")' <<<"$absent_out" >/dev/null
: >"$GH_LOG"
init_out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    reconcile-fixture --mode complete --ingestion-start-at 2025-01-01T00:00:00Z \
    --initialize-index --watchdog-token-file "$tmp/watchdog-token")
jq -e '.status == "success" and .requests == 0' <<<"$init_out" >/dev/null
[ ! -s "$GH_LOG" ]
index_tip=$(git --git-dir="$tmp/origin.git" rev-parse refs/heads/tasks/v1/reconcile-comments-index)
[ "$(git --git-dir="$tmp/origin.git" rev-list --parents -n1 "$index_tip" | wc -w)" -eq 1 ]
# A missing derived checkpoint repairs through the same full-census path,
# returns before API effects, and publishes explicit old/new/reason evidence.
git --git-dir="$tmp/origin.git" update-ref -d refs/heads/tasks/v1/reconcile-comments-index "$index_tip"
: >"$GH_LOG"
repair_out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    reconcile-fixture --mode complete --ingestion-start-at 2025-01-01T00:00:00Z \
    --watchdog-token-file "$tmp/watchdog-token")
jq -e '.status == "success" and .requests == 0 and
       any(.warnings[]; .type == "checkpoint-reconstructed" and .old == null and
           (.new | test("^[0-9a-f]{40}$")) and .reason == "absent")' <<<"$repair_out" >/dev/null
[ ! -s "$GH_LOG" ]
index_tip=$(git --git-dir="$tmp/origin.git" rev-parse refs/heads/tasks/v1/reconcile-comments-index)
[ "$(git --git-dir="$tmp/origin.git" rev-list --parents -n1 "$index_tip" | wc -w)" -eq 1 ]
[ "$(git --git-dir="$tmp/origin.git" show "$index_tip:queue.tsv")" = $'10\n12\n2\n20' ]
# Checkpoint reads reject every Git mechanism that can hide, lazily supply, or
# rewrite the ordinary reachable-object closure.
(cd "$tmp/work" && _xrepo_reconcile_checkpoint_store_safe)
! (cd "$tmp/work" && GIT_SHALLOW_FILE="$tmp/shallow" _xrepo_reconcile_checkpoint_store_safe)
! (cd "$tmp/work" && GIT_OBJECT_DIRECTORY="$tmp/objects" _xrepo_reconcile_checkpoint_store_safe)
! (cd "$tmp/work" && GIT_ALTERNATE_OBJECT_DIRECTORIES="$tmp/objects" _xrepo_reconcile_checkpoint_store_safe)
! (cd "$tmp/work" && GIT_GRAFT_FILE="$tmp/grafts" _xrepo_reconcile_checkpoint_store_safe)
git -C "$tmp/work" config remote.origin.promisor yes
! (cd "$tmp/work" && _xrepo_reconcile_checkpoint_store_safe)
git -C "$tmp/work" config --unset remote.origin.promisor
git -C "$tmp/work" config remote.origin.partialCloneFilter blob:none
! (cd "$tmp/work" && _xrepo_reconcile_checkpoint_store_safe)
git -C "$tmp/work" config --unset remote.origin.partialCloneFilter
mkdir -p "$tmp/work/.git/objects/info" "$tmp/work/.git/objects/pack" "$tmp/work/.git/info"
printf '%s\n' "$tmp/origin.git/objects" >"$tmp/work/.git/objects/info/alternates"
! (cd "$tmp/work" && _xrepo_reconcile_checkpoint_store_safe)
rm "$tmp/work/.git/objects/info/alternates"
: >"$tmp/work/.git/objects/pack/pack-fixture.promisor"
! (cd "$tmp/work" && _xrepo_reconcile_checkpoint_store_safe)
rm "$tmp/work/.git/objects/pack/pack-fixture.promisor"
: >"$tmp/work/.git/info/grafts"
! (cd "$tmp/work" && _xrepo_reconcile_checkpoint_store_safe)
rm "$tmp/work/.git/info/grafts"
git -C "$tmp/work" update-ref "refs/replace/$clarification" "$clarification"
! (cd "$tmp/work" && _xrepo_reconcile_checkpoint_store_safe)
git -C "$tmp/work" update-ref -d "refs/replace/$clarification"
# Strict history validation rejects a merge successor even when its tree is
# otherwise byte-for-byte valid.
bad_index=$(printf 'Malformed index successor\n' | git -C "$tmp/work" commit-tree \
    "$(git --git-dir="$tmp/origin.git" rev-parse "$index_tip^{tree}")" -p "$index_tip" -p "$clarification")
! (cd "$tmp/work" && _xrepo_reconcile_index_read "$bad_index" "$tmp/bad-index" acme/widgets "")
# Persisted manifests accept only complete delegated-close ref names. A valid
# v1 fixture with a suffix must not pass by matching a path prefix.
malformed_manifest_tree="$tmp/malformed-manifest-tree"
git -C "$tmp/work" archive "$index_tip" | tar -x -C "$tmp" --transform='s,^,malformed-manifest-tree/,'
printf '%s\t%s\n' "$clarification" 'refs/heads/tasks/delegated-close/v1/1/acme/peer/2/suffix' \
  >>"$malformed_manifest_tree/manifest.tsv"
LC_ALL=C sort -t $'\t' -k2,2 "$malformed_manifest_tree/manifest.tsv" -o "$malformed_manifest_tree/manifest.tsv"
malformed_index=$(git -C "$tmp/work" add --all --dry-run >/dev/null 2>&1; \
  idx=$(mktemp); rm -f "$idx"; \
  while IFS= read -r path; do blob=$(git -C "$tmp/work" hash-object -w "$malformed_manifest_tree/$path"); GIT_INDEX_FILE=$idx git -C "$tmp/work" update-index --add --cacheinfo "100644,$blob,$path"; done < <(find "$malformed_manifest_tree" -type f -printf '%P\n'); \
  tree=$(GIT_INDEX_FILE=$idx git -C "$tmp/work" write-tree); rm -f "$idx"; git -C "$tmp/work" commit-tree "$tree" -p "$index_tip" -m malformed)
! (cd "$tmp/work" && _xrepo_reconcile_index_read_one "$malformed_index" "$tmp/malformed-index" acme/widgets)
# Canonical manifests remain valid when the caller's locale sorts numeric ref
# components differently. This shape reproduces the production join failure:
# the current generation adds issue 1 ahead of persisted issues 10, 2, and 20.
locale -a | grep -Fxq en_US.utf8
mkdir "$tmp/locale-parent" "$tmp/locale-current"
cat >"$tmp/locale-parent/manifest.tsv" <<'EOF'
1111111111111111111111111111111111111111	refs/heads/gh/comments/10/1
2222222222222222222222222222222222222222	refs/heads/gh/comments/2/1
3333333333333333333333333333333333333333	refs/heads/gh/comments/20/1
EOF
cat >"$tmp/locale-current/manifest.tsv" <<'EOF'
0000000000000000000000000000000000000000	refs/heads/gh/comments/1/1
1111111111111111111111111111111111111111	refs/heads/gh/comments/10/1
2222222222222222222222222222222222222222	refs/heads/gh/comments/2/1
3333333333333333333333333333333333333333	refs/heads/gh/comments/20/1
EOF
LC_ALL=C sort -c -t $'\t' -k2,2 "$tmp/locale-parent/manifest.tsv"
LC_ALL=C sort -c -t $'\t' -k2,2 "$tmp/locale-current/manifest.tsv"
! LC_ALL=en_US.utf8 sort -c -t $'\t' -k2,2 "$tmp/locale-parent/manifest.tsv" 2>/dev/null
! LC_ALL=en_US.utf8 sort -c -t $'\t' -k2,2 "$tmp/locale-current/manifest.tsv" 2>/dev/null
printf '%s\n' '{"generation":1}' >"$tmp/locale-parent/metadata.json"
printf '%s\n' '{"generation":2}' >"$tmp/locale-current/metadata.json"
printf '%s\n' '{"delegations":{}}' >"$tmp/locale-parent/proofs.json"
printf '%s\n' '{"delegations":{}}' >"$tmp/locale-current/proofs.json"
printf '%s\n' '{"peers":{}}' >"$tmp/locale-parent/peers.json"
printf '%s\n' '{"peers":{}}' >"$tmp/locale-current/peers.json"
LC_ALL=en_US.utf8 _xrepo_reconcile_index_validate_successor \
  "$tmp/locale-current" "$tmp/locale-parent" "$tmp/locale-join"
[ "$(wc -l <"$tmp/locale-join.manifest")" -eq 3 ]

# Checkpoint cache validation is bounded by the successor delta, not by the
# checkpoint's total age.  Build a long immutable chain, bootstrap its tip in
# one authority unit, then exercise every discontinuity at the helper boundary.
assert_fixture() { [ "$1" = true ] || { echo "fixture assertion failed: $2" >&2; exit 1; }; }
checkpoint="$tmp/checkpoint-helper"
mkdir "$checkpoint"
: >"$checkpoint/manifest"
: >"$checkpoint/queue"
printf '%s\n' '{"delegations":{},"version":1}' >"$checkpoint/proofs"
printf '%s\n' '{"peers":{},"version":1}' >"$checkpoint/peers"
activation=$(jq -ncS --arg commit "$clarification" --arg runtime "$(git -C "$(dirname "$TD")/.." rev-parse HEAD)" \
  '{activationCommit:$commit,authorityTip:$commit,digest:"3333333333333333333333333333333333333333333333333333333333333333",epoch:1,guardVersion:1,minimumCompatibleTaskDagCommit:$runtime}')
export GIT_DIR="$tmp/work/.git"
_taskdag_activation_runtime_commit() { jq -r .minimumCompatibleTaskDagCommit <<<"$activation"; }
taskdag_activation_validate_provenance() { :; }
checkpoint_tip=""
for generation in $(seq 0 24); do
  checkpoint_tip=$(_xrepo_reconcile_index_commit "$checkpoint_tip" "$checkpoint/manifest" "$checkpoint/queue" \
    "$tmp/watchdog-token" acme/widgets "$activation" "$checkpoint/proofs" "$checkpoint/peers")
done
git -C "$tmp/work" update-ref "$_XREPO_RECONCILE_INDEX_CACHE_REF" "$checkpoint_tip"
cache_before=$(git -C "$tmp/work" rev-parse "$_XREPO_RECONCILE_INDEX_CACHE_REF")
_xrepo_reconcile_index_read "$checkpoint_tip" "$checkpoint/index" acme/widgets
: >"$checkpoint/bootstrap-work"; : >"$checkpoint/bootstrap-queue"
TASKDAG_VALIDATION_WORK_COUNTER="$checkpoint/bootstrap-work" \
  _xrepo_reconcile_index_bootstrap_authority "$checkpoint/index" "$checkpoint/index/manifest.tsv" \
    "$tmp/origin.git" acme/widgets "$checkpoint/bootstrap-queue"
printf 'checkpoint-bootstrap\tauthority\n' >>"$checkpoint/bootstrap-work"
assert_fixture "$([ "$(wc -l <"$checkpoint/bootstrap-work")" -eq 1 ] && echo true || echo false)" \
  "long-chain authority bootstrap must perform exactly one bootstrap-authority unit"
assert_fixture "$([ "$(git -C "$tmp/work" rev-parse "$_XREPO_RECONCILE_INDEX_CACHE_REF")" = "$cache_before" ] && echo true || echo false)" \
  "authority bootstrap must not mutate the private cache ref"
printf '%s\n' 2147483648 >"$checkpoint/overflow-queue"
if _xrepo_reconcile_index_commit "$checkpoint_tip" "$checkpoint/manifest" "$checkpoint/overflow-queue" \
  "$tmp/watchdog-token" acme/widgets "$activation" "$checkpoint/proofs" "$checkpoint/peers" >/dev/null; then
  assert_fixture false "an out-of-contract reconstructed queue must fail before candidate publication"
fi
bad_activation=$(jq -c '.minimumCompatibleTaskDagCommit="ffffffffffffffffffffffffffffffffffffffff"' <<<"$activation")
bad_activation_parent=$(_xrepo_reconcile_index_commit "$checkpoint_tip" "$checkpoint/manifest" "$checkpoint/queue" \
  "$tmp/watchdog-token" acme/widgets "$bad_activation" "$checkpoint/proofs" "$checkpoint/peers")
healed_activation_tip=$(_xrepo_reconcile_index_commit "$bad_activation_parent" "$checkpoint/manifest" "$checkpoint/queue" \
  "$tmp/watchdog-token" acme/widgets "$activation" "$checkpoint/proofs" "$checkpoint/peers")
if _xrepo_reconcile_index_read "$healed_activation_tip" "$checkpoint/healed-activation" acme/widgets "$activation"; then
  assert_fixture false "a valid tip must not conceal an activation-invalid direct parent"
fi

# A current advertisement may strictly contain the checkpoint manifest.  The
# bootstrap helper intentionally validates only checkpoint-covered authority.
printf '%s\t%s\n' "$clarification" refs/heads/gh/comments/99/999 >"$checkpoint/superset"
cat "$checkpoint/index/manifest.tsv" >>"$checkpoint/superset"
LC_ALL=C sort -t $'\t' -k2,2 "$checkpoint/superset" -o "$checkpoint/superset"
LC_ALL=C join -t $'\t' -j 2 -o 1.1,1.2,2.1 "$checkpoint/index/manifest.tsv" "$checkpoint/superset" >"$checkpoint/covered"
assert_fixture "$([ "$(wc -l <"$checkpoint/covered")" -eq "$(wc -l <"$checkpoint/index/manifest.tsv")" ] && echo true || echo false)" \
  "strictly-superset advertisement must preserve every checkpoint-covered fact"

# Exactly N valid successors produce N work records; an unchanged tip produces
# none. Invalid middle generations, first-parent divergence, second-parent-only
# ancestry, and a simulated cache-CAS race all fail without changing the cache.
delta_base=$checkpoint_tip
delta_tip=$delta_base
for generation in 1 2 3; do
  delta_tip=$(_xrepo_reconcile_index_commit "$delta_tip" "$checkpoint/manifest" "$checkpoint/queue" \
    "$tmp/watchdog-token" acme/widgets "$activation" "$checkpoint/proofs" "$checkpoint/peers")
done
: >"$checkpoint/delta-work"
(cd "$tmp/work" && TASKDAG_VALIDATION_WORK_COUNTER="$checkpoint/delta-work" \
  _xrepo_reconcile_index_validate_cached "$delta_tip" "$delta_base" "$checkpoint/valid-delta" acme/widgets "$activation")
assert_fixture "$([ "$(wc -l <"$checkpoint/delta-work")" -eq 3 ] && echo true || echo false)" \
  "three cached successors must log exactly three checkpoint-delta units"
: >"$checkpoint/delta-work"
(cd "$tmp/work" && TASKDAG_VALIDATION_WORK_COUNTER="$checkpoint/delta-work" \
  _xrepo_reconcile_index_validate_cached "$delta_base" "$delta_base" "$checkpoint/no-delta" acme/widgets "$activation")
assert_fixture "$([ ! -s "$checkpoint/delta-work" ] && echo true || echo false)" \
  "unchanged cached checkpoint must log zero delta units"
bad_middle=$(printf 'Invalid middle generation\n' | git -C "$tmp/work" commit-tree "$(git -C "$tmp/work" rev-parse "$delta_base^{tree}")" -p "$delta_base")
bad_tail=$(printf 'Tail after invalid middle\n' | git -C "$tmp/work" commit-tree "$(git -C "$tmp/work" rev-parse "$delta_base^{tree}")" -p "$bad_middle")
if (cd "$tmp/work" && _xrepo_reconcile_index_validate_cached "$bad_tail" "$delta_base" "$checkpoint/bad-middle" acme/widgets "$activation"); then
  assert_fixture false "invalid middle checkpoint successor must fail"
fi
diverged=$(printf 'First-parent divergence\n' | git -C "$tmp/work" commit-tree "$(git -C "$tmp/work" rev-parse "$delta_base^{tree}")")
if (cd "$tmp/work" && _xrepo_reconcile_index_validate_cached "$diverged" "$delta_base" "$checkpoint/diverged" acme/widgets "$activation"); then
  assert_fixture false "first-parent-diverged checkpoint tip must fail"
fi
second_parent=$(printf 'Cache only second parent\n' | git -C "$tmp/work" commit-tree "$(git -C "$tmp/work" rev-parse "$delta_base^{tree}")" -p "$diverged" -p "$delta_base")
if (cd "$tmp/work" && _xrepo_reconcile_index_validate_cached "$second_parent" "$delta_base" "$checkpoint/second-parent" acme/widgets "$activation"); then
  assert_fixture false "second-parent-only checkpoint ancestry must fail"
fi
if git -C "$tmp/work" update-ref "$_XREPO_RECONCILE_INDEX_CACHE_REF" "$delta_tip" "$diverged"; then
  assert_fixture false "checkpoint cache confirm race must reject stale expected old value"
fi
assert_fixture "$([ "$(git -C "$tmp/work" rev-parse "$_XREPO_RECONCILE_INDEX_CACHE_REF")" = "$cache_before" ] && echo true || echo false)" \
  "all checkpoint mismatch/race failures must leave private cache unchanged"
git -C "$tmp/work" update-ref -d "$_XREPO_RECONCILE_INDEX_CACHE_REF" "$cache_before"
unset GIT_DIR

locale_issue_1=$(printf '%s\n' 'kind: message' 'role: human' 'intent: clarification' '' \
  'issue:' '  number: 1' '  repo: acme/widgets' '' 'github:' '  comment_id: 95' \
  | git -C "$tmp/work" commit-tree "$empty")
git -C "$tmp/work" push -q origin "$locale_issue_1:refs/heads/gh/comments/1/95"
refs_before=$(git --git-dir="$tmp/origin.git" for-each-ref --format='%(objectname) %(refname)' | sort)
: >"$tmp/validation-work"
out=$(cd "$tmp/work" && LC_ALL=en_US.utf8 PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    TASKDAG_CHECKPOINT_FETCH_SLOW_SECONDS=0 \
    TASKDAG_VALIDATION_WORK_COUNTER="$tmp/validation-work" \
    reconcile-fixture --mode complete \
    --ingestion-start-at 2025-01-01T00:00:00Z --allow-comment 10:99 --dry-run)
[ "$(awk -F '\t' '$1=="checkpoint-bootstrap"{boot++} $1=="receipt"{receipts++} END{print boot ":" receipts}' "$tmp/validation-work")" = 1:5 ]
[ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ]
jq -e '.schema_version == 1 and .status == "success" and .dry_run == true and
       .pages == 2 and .requests == 7 and .returned == 7 and .unique == 6 and
       .pre_boundary == 1 and .pull_requests == 1 and .eligible == 4 and
       .missing == 4 and .dispositions == {human:2,completion:0,machine_skip:2} and
       .attempted == 0 and .deferred == 4 and .failures == 0 and
       any(.warnings[]; .type == "checkpoint-fetch-slow" and .threshold_seconds == 0) and
       .recent_success_at == null and .complete_success_at == null' <<<"$out" >/dev/null
grep -q 'since=2024-12-31T23:45:00Z' "$GH_LOG"
grep -Fxq 'repositories/123/issues/comments?sort=updated&direction=asc&per_page=100&since=2025-01-01T00%3A00%3A00Z&page=2' "$GH_LOG"
refs_after=$(git --git-dir="$tmp/origin.git" for-each-ref --format='%(objectname) %(refname)' | sort)
[ "$refs_after" = "$refs_before" ]

# Apply mode: a late human comment on a closed issue is receipted without
# recreating work, while an immutable historical completion receipt for that
# same closed issue does not attempt close convergence against a retired root.
: >"$GH_LOG"
apply_out=$(cd "$tmp/work" && LC_ALL=en_US.utf8 PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
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
[ "$(cut -f1 "$tmp/validation-work")" = $'checkpoint-delta\nreceipt' ]
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
    --ingestion-start-at 2025-01-01T00:00:00Z --max-seconds 15 \
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

# The atomic helper batches three human comments (including two for one issue)
# behind one preparation and one fenced push.  Its create-only payload is
# sorted and unique, and prepared child-map refs are the parent authority.
batch="$tmp/batch-helper"; mkdir "$batch"
batch_root_31=$(printf 'Issue 31 root\n' | git -C "$tmp/work" commit-tree "$empty")
batch_root_32=$(printf 'Issue 32 root\n' | git -C "$tmp/work" commit-tree "$empty")
git -C "$tmp/work" update-ref refs/heads/tasks/pending/31 "$batch_root_31"
git -C "$tmp/work" update-ref refs/heads/tasks/pending/32 "$batch_root_32"
git -C "$tmp/work" push -q origin "$batch_root_31:refs/heads/tasks/pending/31" "$batch_root_32:refs/heads/tasks/pending/32"
for issue in 31 32; do
  jq -nc --argjson number "$issue" '{number:$number,title:"Batch issue",body:"",html_url:("https://example.invalid/"+($number|tostring)),user:{login:"alice"}}' >"$batch/issue-$issue.json"
done
printf alpha >"$batch/body-301"; printf beta >"$batch/body-302"; printf gamma >"$batch/body-303"
for spec in '31 301' '31 302' '32 303'; do
  set -- $spec
  jq -ncS --argjson issue "$1" --arg cid "$2" '{issue:$issue,cid:$cid,disposition:"human",author:"alice",url:"https://example.invalid/comment",created:"2026-01-01T00:00:00Z",updated:"2026-01-01T00:00:00Z"}' >>"$batch/staged"
done
: >"$batch/counters"
(cd "$tmp/work" && \
  _xrepo_ensure_issue_epic() {
    local root; [ "$1" = 31 ] && root="$batch_root_31" || root="$batch_root_32"
    if [ "${2:-}" = --with-ref ]; then printf '%s\trefs/heads/tasks/pending/%s\n' "$root" "$1"; else printf '%s\n' "$root"; fi
  } && \
  taskdag_consumer_prepare() { printf 'prepare\n' >>"$batch/counters"; TASKDAG_CONSUMER_READY=true; TASKDAG_CHILD_MAP_REFS=$(git for-each-ref --format='%(objectname) %(refname)' refs/heads/tasks/pending/ refs/heads/gh/issues/); } && \
  _xrepo_watchdog_fence() { printf 'fence\n' >>"$batch/counters"; } && \
  taskdag_consumer_fenced_scheduling_push() { printf 'push\n' >>"$batch/counters"; cat >"$batch/payload" <<<"$3"; } && \
  _xrepo_reconcile_apply_batch "$batch" acme/widgets "$batch/staged" "$batch/applied" "$batch/result")
assert_fixture "$([ "$(grep -c '^prepare$' "$batch/counters")" -eq 1 ] && echo true || echo false)" "three-comment batch must prepare exactly once"
assert_fixture "$([ "$(grep -c '^push$' "$batch/counters")" -eq 1 ] && echo true || echo false)" "three-comment batch must fenced-push exactly once"
assert_fixture "$([ "$(grep -c '^fence$' "$batch/counters")" -eq 1 ] && echo true || echo false)" "three-comment batch must check the watchdog fence exactly once"
jq -e 'length==6 and all(.[];.old=="") and ([.[].ref]|sort==. and length==(unique|length))' "$batch/payload" >/dev/null \
  || assert_fixture false "batch update payload must be sorted, unique, and create-only"
assert_fixture "$([ "$(cat "$batch/applied")" -eq 3 ] && echo true || echo false)" "three-comment batch applied count must equal three"
assert_fixture "$([ "$(jq -r '[.[].new]|unique|length' "$batch/payload")" -eq 6 ] && echo true || echo false)" "three comments must create three unique receipts and three unique effects"

# A ready typed snapshot is still reader-only. The gate must fire before any
# legacy root lookup/writer and therefore cannot even leave a dangling object.
writer_gate="$tmp/writer-gate"; mkdir "$writer_gate"
jq -nc '{title:"Writer gate",body:"",html_url:"https://example.invalid/91",user:{login:"alice"}}' >"$writer_gate/issue.json"
native_snapshot=$(jq -ncS --arg epic "epic-v1:$(printf 'a%.0s' {1..64})" --arg root "$batch_root_31" \
  '{status:"ready",parent:{epicId:$epic,kind:"native-epic-v1",rootCommit:$root,projectedIssueNumber:"91"}}')
before_objects=$(git -C "$tmp/work" count-objects -v); before_refs=$(git -C "$tmp/work" for-each-ref --format='%(refname) %(objectname)')
set +e
(cd "$tmp/work" && \
  _xrepo_ensure_issue_epic() { assert_fixture false "native writer gate called legacy ensure"; } && \
  taskdag_emit_origin_epic_close() { assert_fixture false "native writer gate called legacy close writer"; } && \
  _xrepo_apply_ready_snapshot_close "$native_snapshot" 91 "$writer_gate/issue.json" "$tmp/work/.git")
native_rc=$?
set -e
after_objects=$(git -C "$tmp/work" count-objects -v); after_refs=$(git -C "$tmp/work" for-each-ref --format='%(refname) %(objectname)')
assert_fixture "$([ "$native_rc" -eq 75 ] && [ "$before_objects" = "$after_objects" ] && [ "$before_refs" = "$after_refs" ] && echo true || echo false)" \
  "native ready snapshot must return writer-gated rc 75 without object/ref mutation"

# Completion convergence must perform the identity gate before the legacy
# reconciler, then recapture and revalidate so an adoption race fails closed.
converge_gate="$tmp/converge-gate"; mkdir "$converge_gate"
printf '0\n' >"$converge_gate/captures"; : >"$converge_gate/calls"
set +e
(cd "$tmp/work" && \
  _xrepo_capture_parent_snapshot() { printf 'delegation\n' >"$3"; } && \
  _xrepo_strict_snapshot_status() { printf '%s\n' "$native_snapshot"; } && \
  _xrepo_reconcile_issue_delegated_closes() { printf 'reconcile\n' >>"$converge_gate/calls"; } && \
  _xrepo_ensure_issue_epic() { printf 'ensure\n' >>"$converge_gate/calls"; } && \
  taskdag_emit_origin_epic_close() { printf 'close\n' >>"$converge_gate/calls"; } && \
  _xrepo_converge_completion_issue 91 acme/widgets)
native_converge_rc=$?
set -e
assert_fixture "$([ "$native_converge_rc" -eq 75 ] && [ ! -s "$converge_gate/calls" ] && echo true || echo false)" \
  "native completion gate must return 75 before reconcile or legacy writers"

malformed_snapshot='{"parent":{"kind":"legacy-adoption-v1"},"status":"ready"}'
before_objects=$(git -C "$tmp/work" count-objects -v); before_refs=$(git -C "$tmp/work" for-each-ref --format='%(refname) %(objectname)')
set +e
(cd "$tmp/work" && \
  _xrepo_capture_parent_snapshot() { printf 'delegation\n' >"$3"; } && \
  _xrepo_strict_snapshot_status() { printf '%s\n' "$malformed_snapshot"; } && \
  _xrepo_reconcile_issue_delegated_closes() { printf 'reconcile\n' >>"$converge_gate/calls"; } && \
  _xrepo_converge_completion_issue 91 acme/widgets)
malformed_converge_rc=$?
set -e
after_objects=$(git -C "$tmp/work" count-objects -v); after_refs=$(git -C "$tmp/work" for-each-ref --format='%(refname) %(objectname)')
assert_fixture "$([ "$malformed_converge_rc" -eq 2 ] && [ ! -s "$converge_gate/calls" ] && [ "$before_objects" = "$after_objects" ] && [ "$before_refs" = "$after_refs" ] && echo true || echo false)" \
  "malformed completion gate must return rc 2 before reconcile or object/ref mutation"

# A v1-only parent has no typed registry record. It follows the original
# numeric completion flow, deriving the live root after reconciliation.
v1_snapshot='{"parent":null,"status":"ready"}'
: >"$converge_gate/calls"; printf '0\n' >"$converge_gate/captures"
(cd "$tmp/work" && \
  _xrepo_capture_parent_snapshot() { n=$(cat "$converge_gate/captures"); printf '%s\n' "$((n+1))" >"$converge_gate/captures"; printf 'delegation\n' >"$3"; } && \
  _xrepo_strict_snapshot_status() { printf '%s\n' "$v1_snapshot"; } && \
  _xrepo_reconcile_issue_delegated_closes() { printf 'reconcile\n' >>"$converge_gate/calls"; } && \
  _xrepo_ensure_issue_epic() { printf 'ensure\n' >>"$converge_gate/calls"; printf '%s\n' "$batch_root_31"; } && \
  _xrepo_watchdog_fence() { printf 'fence\n' >>"$converge_gate/calls"; } && \
  taskdag_emit_origin_epic_close() { printf 'close:%s:%s\n' "$1" "$2" >>"$converge_gate/calls"; } && \
  _xrepo_converge_completion_issue 91 acme/widgets) \
  || assert_fixture false "v1-only completion must retain numeric convergence"
assert_fixture "$([ "$(cat "$converge_gate/captures")" -eq 2 ] && [ "$(cat "$converge_gate/calls")" = $'reconcile\nensure\nfence\nclose:91:'"$batch_root_31" ] && echo true || echo false)" \
  "v1-only completion must reconcile before deriving and closing its numeric root"

adoption_snapshot=$(jq -ncS --arg epic "epic-v1:$(printf 'b%.0s' {1..64})" --arg root "$batch_root_31" \
  '{status:"ready",parent:{epicId:$epic,kind:"legacy-adoption-v1",rootCommit:$root,projectedIssueNumber:"91"}}')
(cd "$tmp/work" && \
  taskdag_epic_registry_record() { jq -ncS --arg root "$batch_root_31" '{legacyAdoption:{issueNumber:"91"},rootCommit:$root}'; } && \
  _xrepo_ensure_issue_epic() { [ "$1" = 91 ] && printf '%s\n' "$batch_root_31"; } && \
  _xrepo_watchdog_fence() { :; } && \
  taskdag_emit_origin_epic_close() { [ "$1" = 91 ] && [ "$2" = "$batch_root_31" ]; } && \
  _xrepo_apply_ready_snapshot_close "$adoption_snapshot" 91 "$writer_gate/issue.json" "$tmp/work/.git") \
  || assert_fixture false "matching legacy adoption must reach the numeric writer"
if (cd "$tmp/work" && \
  taskdag_epic_registry_record() { jq -ncS --arg root "$batch_root_31" '{legacyAdoption:{issueNumber:"92"},rootCommit:$root}'; } && \
  _xrepo_ensure_issue_epic() { assert_fixture false "mismatched adoption called legacy ensure"; } && \
  taskdag_emit_origin_epic_close() { assert_fixture false "mismatched adoption called legacy writer"; } && \
  _xrepo_apply_ready_snapshot_close "$adoption_snapshot" 91 "$writer_gate/issue.json" "$tmp/work/.git"); then
  assert_fixture false "mismatched legacy adoption must fail before writers"
fi

: >"$converge_gate/calls"; printf '0\n' >"$converge_gate/captures"
set +e
(cd "$tmp/work" && \
  taskdag_epic_registry_record() { jq -ncS --arg root "$batch_root_31" '{legacyAdoption:{issueNumber:"91"},rootCommit:$root}'; } && \
  _xrepo_capture_parent_snapshot() { n=$(cat "$converge_gate/captures"); printf '%s\n' "$((n+1))" >"$converge_gate/captures"; printf 'delegation\n' >"$3"; } && \
  _xrepo_strict_snapshot_status() { [ "$(cat "$converge_gate/captures")" -eq 1 ] && printf '%s\n' "$adoption_snapshot" || printf '%s\n' "$native_snapshot"; } && \
  _xrepo_reconcile_issue_delegated_closes() { printf 'reconcile\n' >>"$converge_gate/calls"; } && \
  _xrepo_ensure_issue_epic() { printf 'ensure\n' >>"$converge_gate/calls"; } && \
  taskdag_emit_origin_epic_close() { printf 'close\n' >>"$converge_gate/calls"; } && \
  _xrepo_converge_completion_issue 91 acme/widgets)
adoption_race_rc=$?
set -e
assert_fixture "$([ "$adoption_race_rc" -eq 75 ] && [ "$(cat "$converge_gate/captures")" -eq 2 ] && [ "$(cat "$converge_gate/calls")" = reconcile ] && echo true || echo false)" \
  "post-reconcile adoption recapture race must fail closed before parent writers"

# Exercise the reconciler's actual queued batch loop, not only the immediate
# completion helper above. Extract the nested function verbatim and provide
# the same boundary seams its enclosing command supplies.
batch_converge="$tmp/batch-converge"; mkdir "$batch_converge"
sed -n '/^    _rc_converge_issues() {/,/^    # Durable completion receipts/p' \
  "$(dirname "$TD")/task-dag.d/cross-repo.sh" | sed '$d' >"$batch_converge/function"
# shellcheck disable=SC1090
source "$batch_converge/function"
dry=false; fatal=false; terminal_rc=0; deferred=0; repo=acme/widgets
retry_unvisited="$batch_converge/retry-unvisited"
retry_failed="$batch_converge/retry-failed"
: >"$retry_unvisited"; : >"$retry_failed"; : >"$batch_converge/calls"
_rc_convergence_time() { :; }
_rc_time() { :; }
_rc_fail() { printf 'fail:%s:%s\n' "$1" "$2" >>"$batch_converge/calls"; }
_rc_timeout() { assert_fixture false "batch convergence unexpectedly timed out"; }
_rc_api() {
  local number=${1##*/}
  jq -nc --argjson number "$number" '{number:$number,state:"open",title:"Queued convergence",body:"",html_url:("https://example.invalid/"+($number|tostring)),user:{login:"alice"}}' >"$tmp/body"
}
_xrepo_reconcile_issue_delegated_closes() { printf 'reconcile:%s\n' "$1" >>"$batch_converge/calls"; }
_xrepo_ensure_issue_epic() {
  printf 'ensure:%s\n' "$1" >>"$batch_converge/calls"
  if [ "${2:-}" = --with-ref ]; then printf '%s\trefs/heads/tasks/pending/%s\n' "$batch_root_31" "$1"; else printf '%s\n' "$batch_root_31"; fi
}
_xrepo_watchdog_fence() { printf 'fence\n' >>"$batch_converge/calls"; }
taskdag_emit_origin_epic_close() { printf 'close:%s:%s\n' "$1" "$2" >>"$batch_converge/calls"; }
taskdag_epic_registry_record() { jq -ncS --arg root "$batch_root_31" '{legacyAdoption:{issueNumber:"94"},rootCommit:$root}'; }

# Mixed native and malformed authority must reject each item before the
# delegated-close reconciler, object creation, or ref movement.
printf '%s\n' 91 92 >"$batch_converge/issues"
printf '0\n' >"$batch_converge/captures"
_rc_fresh_issue_status() {
  [ "$1" = 91 ] && printf '%s\n' "$native_snapshot" || printf '%s\n' "$malformed_snapshot"
}
before_objects=$(git -C "$tmp/work" count-objects -v); before_refs=$(git -C "$tmp/work" for-each-ref --format='%(refname) %(objectname)')
_rc_converge_issues "$batch_converge/issues"
after_objects=$(git -C "$tmp/work" count-objects -v); after_refs=$(git -C "$tmp/work" for-each-ref --format='%(refname) %(objectname)')
assert_fixture "$([ "$(cat "$batch_converge/calls")" = $'fail:convergence:91\nfail:convergence:92' ] && [ "$before_objects" = "$after_objects" ] && [ "$before_refs" = "$after_refs" ] && echo true || echo false)" \
  "queued native/malformed authority must cause zero delegated-close, object, or ref mutation"

# parent:null remains the legacy v1 route through both captures and the
# parent writer.
: >"$batch_converge/calls"; : >"$retry_failed"; printf '93\n' >"$batch_converge/issues"
_rc_fresh_issue_status() { printf '%s\n' "$v1_snapshot"; }
_rc_converge_issues "$batch_converge/issues"
assert_fixture "$([ "$(cat "$batch_converge/calls")" = $'reconcile:93\nensure:93\nfence\nclose:93:'"$batch_root_31" ] && echo true || echo false)" \
  "queued parent:null v1 authority must still reconcile and close"

# If a legacy adoption becomes native between the pre- and post-reconcile
# captures, the second capture gates the parent writer.
: >"$batch_converge/calls"; : >"$retry_failed"; printf '94\n' >"$batch_converge/issues"; printf '0\n' >"$batch_converge/captures"
batch_adoption_snapshot=$(jq -cS '.parent.projectedIssueNumber="94"' <<<"$adoption_snapshot")
_rc_fresh_issue_status() {
  local captures
  captures=$(cat "$batch_converge/captures")
  printf '%s\n' "$((captures+1))" >"$batch_converge/captures"
  [ "$captures" -eq 0 ] && printf '%s\n' "$batch_adoption_snapshot" || printf '%s\n' "$native_snapshot"
}
_rc_converge_issues "$batch_converge/issues"
assert_fixture "$([ "$(cat "$batch_converge/calls")" = $'reconcile:94\nfail:convergence:94' ] && echo true || echo false)" \
  "queued adoption-to-native transition must block the parent writer"

# Prepared child-map state, rather than a changed post-prepare observation,
# governs acceptance. A mismatching prepared root fails before fence/push.
batch_bad="$tmp/batch-prepared-mismatch"; cp -a "$batch" "$batch_bad"; rm -f "$batch_bad/applied" "$batch_bad/result"
(cd "$tmp/work" && \
  _xrepo_ensure_issue_epic() {
    local root; [ "$1" = 31 ] && root="$batch_root_31" || root="$batch_root_32"
    if [ "${2:-}" = --with-ref ]; then printf '%s\trefs/heads/tasks/pending/%s\n' "$root" "$1"; else printf '%s\n' "$root"; fi
  } && \
  taskdag_consumer_prepare() { TASKDAG_CONSUMER_READY=true; TASKDAG_CHILD_MAP_REFS="$clarification refs/heads/tasks/pending/31"; } && \
  _xrepo_watchdog_fence() { assert_fixture false "prepared child-map mismatch must fail before watchdog fence"; } && \
  taskdag_consumer_fenced_scheduling_push() { assert_fixture false "prepared child-map mismatch must fail before push"; } && \
  ! _xrepo_reconcile_apply_batch "$batch_bad" acme/widgets "$batch_bad/staged" "$batch_bad/applied" "$batch_bad/result")
assert_fixture "$([ ! -s "$batch_bad/applied" ] && echo true || echo false)" "prepared child-map mismatch must apply zero comments"

# The right root under an unrelated pending ref is not authority for this
# issue. Require the exact resolved locator, not merely an OID alias.
batch_alias="$tmp/batch-prepared-alias"; cp -a "$batch" "$batch_alias"; rm -f "$batch_alias/applied" "$batch_alias/result"
(cd "$tmp/work" && \
  _xrepo_ensure_issue_epic() {
    if [ "${2:-}" = --with-ref ]; then printf '%s\trefs/heads/tasks/pending/%s\n' "$batch_root_31" "$1"; else printf '%s\n' "$batch_root_31"; fi
  } && \
  taskdag_consumer_prepare() { TASKDAG_CONSUMER_READY=true; TASKDAG_CHILD_MAP_REFS="$batch_root_31 refs/heads/tasks/pending/999"; } && \
  _xrepo_watchdog_fence() { assert_fixture false "prepared wrong-ref alias must fail before watchdog fence"; } && \
  taskdag_consumer_fenced_scheduling_push() { assert_fixture false "prepared wrong-ref alias must fail before push"; } && \
  ! _xrepo_reconcile_apply_batch "$batch_alias" acme/widgets "$batch_alias/staged" "$batch_alias/applied" "$batch_alias/result")
assert_fixture "$([ ! -s "$batch_alias/applied" ] && echo true || echo false)" "prepared wrong-ref alias must apply zero comments"

typed_expected="refs/heads/tasks/pending/epic-v1/$(printf 'a%.0s' {1..64})"
typed_alias="refs/heads/tasks/pending/epic-v1/$(printf 'b%.0s' {1..64})"
batch_typed_alias="$tmp/batch-prepared-typed-alias"; cp -a "$batch" "$batch_typed_alias"; rm -f "$batch_typed_alias/applied" "$batch_typed_alias/result"
(cd "$tmp/work" && \
  _xrepo_ensure_issue_epic() {
    if [ "${2:-}" = --with-ref ]; then printf '%s\t%s\n' "$batch_root_31" "$typed_expected"; else printf '%s\n' "$batch_root_31"; fi
  } && \
  taskdag_consumer_prepare() { TASKDAG_CONSUMER_READY=true; TASKDAG_CHILD_MAP_REFS="$batch_root_31 $typed_alias"; } && \
  _xrepo_watchdog_fence() { assert_fixture false "prepared typed wrong-ref alias must fail before watchdog fence"; } && \
  taskdag_consumer_fenced_scheduling_push() { assert_fixture false "prepared typed wrong-ref alias must fail before push"; } && \
  ! _xrepo_reconcile_apply_batch "$batch_typed_alias" acme/widgets "$batch_typed_alias/staged" "$batch_typed_alias/applied" "$batch_typed_alias/result")
assert_fixture "$([ ! -s "$batch_typed_alias/applied" ] && echo true || echo false)" "prepared typed wrong-ref alias must apply zero comments"

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
