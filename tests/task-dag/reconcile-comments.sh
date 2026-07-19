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
touch "$tmp/watchdog-token"
taskdag_comment_watchdog_check_file() { [ "$1" = "$tmp/watchdog-token" ] && [ "$2" -eq 510 ]; }
_xrepo_watchdog_token_valid_for "$tmp/watchdog-token" 480
! _xrepo_watchdog_token_valid_for "$tmp/missing-token" 480
taskdag_comment_watchdog_check_file() { [ "$2" -le 300 ]; }
! _xrepo_watchdog_token_valid_for "$tmp/watchdog-token" 480
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
  'issue:' '  repo: acme/widgets' '  number: 10' '' 'delegated:' '  repo: acme/peer' \
  '  number: 1' '' 'source:' '  repo: acme/peer' '  commit: abcdef123456' \
  '  comment_id: manual-cleanup-peer-1' \
  | git -C "$tmp/work" commit-tree "$empty")
git -C "$tmp/work" push -q origin \
  "$clarification:refs/heads/gh/comments/10/98" \
  "$manual_cleanup:refs/heads/gh/comments/10/manual-cleanup-peer-1"
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
    header; printf '\r\n{"id":123}\n'
    ;;
  *issues/comments/99)
    header; printf '\r\n'; comment 99 10 2020-01-01T00:00:00Z 2020-01-01T00:00:00Z historical
    ;;
  *issues/comments*page=2*)
    header; printf '\r\n['
    comment 2 10 2025-01-02T00:00:00Z 2025-01-03T00:00:00Z work
    printf ','; comment 4 10 2025-01-02T00:00:00Z 2025-01-03T00:00:00Z '<!-- task-dag:status -->'
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
  *issues/10) header; printf '\r\n{"number":10,"title":"Issue ten","body":"","html_url":"https://github.com/acme/widgets/issues/10","user":{"login":"alice"}}\n' ;;
  *issues/11) header; printf '\r\n{"number":11,"title":"Pull request","body":"","html_url":"https://github.com/acme/widgets/pull/11","user":{"login":"alice"},"pull_request":{}}\n' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/gh"
export GH_LOG="$tmp/gh.log"
refs_before=$(git --git-dir="$tmp/origin.git" for-each-ref --format='%(objectname) %(refname)' | sort)
out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets \
    "$TD" reconcile-comments --mode complete \
    --ingestion-start-at 2025-01-01T00:00:00Z --allow-comment 10:99 --dry-run)
[ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ]
jq -e '.schema_version == 1 and .status == "success" and .dry_run == true and
       .pages == 2 and .requests == 6 and .returned == 6 and .unique == 5 and
       .pre_boundary == 1 and .pull_requests == 1 and .eligible == 3 and
       .missing == 3 and .dispositions == {human:2,completion:0,machine_skip:1} and
       .attempted == 0 and .deferred == 3 and .failures == 0 and
       .recent_success_at == null and .complete_success_at == null' <<<"$out" >/dev/null
grep -q 'since=2024-12-31T23:45:00Z' "$GH_LOG"
grep -Fxq 'repositories/123/issues/comments?sort=updated&direction=asc&per_page=100&since=2025-01-01T00%3A00%3A00Z&page=2' "$GH_LOG"
refs_after=$(git --git-dir="$tmp/origin.git" for-each-ref --format='%(objectname) %(refname)' | sort)
[ "$refs_after" = "$refs_before" ]

set +e
mismatch_out=$(cd "$tmp/work" && PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=acme/widgets GH_BAD_NUMERIC_LINK=1 \
    "$TD" reconcile-comments --mode complete \
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
    "$TD" reconcile-comments --mode complete \
    --ingestion-start-at 2025-01-01T00:00:00Z --dry-run)
bad_rc=$?
set -e
[ "$bad_rc" -ne 0 ]
jq -e '.status == "failed" and .failures == 1 and
       .failure_items == [{stage:"snapshot",issue:10,comment_id:97,message:"malformed comment receipt"}]' \
  <<<"$bad_out" >/dev/null
echo "reconcile-comments fixture: ok"
