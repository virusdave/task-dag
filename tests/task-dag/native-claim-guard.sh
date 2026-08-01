#!/usr/bin/env bash
set -euo pipefail

TD=$(realpath "${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}")
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed >seed; git add seed; git commit -qm seed; git push -q origin HEAD:master
BASE=$(git rev-parse HEAD); echo work >work; git add work; git commit -qm work; TIP=$(git rev-parse HEAD)
ID="v2-$(printf a%.0s {1..64})"; TOKEN=token; DIGEST=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
REGISTRY=$(git rev-parse --git-path task-dag/native-claims); mkdir -p "$REGISTRY"
entry() { jq -nc --arg id "$ID" --arg token "$TOKEN" '{taskId:$id,owner:"owner",host:"host",sessionId:"session",claimToken:$token}'; }
active() {
  local extras=${1:-'{}'}
  jq -nc --arg id "$ID" --arg oid "$BASE" --arg token "$TOKEN" --argjson extras "$extras" \
    '{attemptId:("b"*64),claimToken:$token,claimedAt:1,expiresAt:2,formatVersion:2,host:"host",logicalId:("c"*64),owner:"owner",sessionId:"session",taskId:$id,taskOid:$oid}+$extras'
}
publish_active() { local json=$1 oid; oid=$(printf '%s\n' "$json" | git commit-tree "$(git rev-parse HEAD^{tree})"); git push -q --force origin "$oid:refs/heads/tasks/active/$ID"; }
guard() { "$TD" guard-pre-push origin "file://$ROOT/origin.git" <<<"refs/heads/master $TIP refs/heads/master $BASE" >/dev/null 2>&1; }
expect_ok() { local label=$1; shift; if "$@"; then echo "PASS: $label"; else echo "FAIL: $label"; exit 1; fi; }
expect_fail() { local label=$1; shift; if "$@"; then echo "FAIL: $label"; exit 1; else echo "PASS: $label"; fi; }

entry >"$REGISTRY/$ID.$DIGEST"; publish_active "$(active)"
expect_fail "matching native claim blocks" guard

# Replacing the source while cp is running must fail the snapshot closed.
mkdir "$ROOT/cp-bin"; REAL_CP=$(command -v cp); export REAL_CP REGISTRY ID DIGEST
cat >"$ROOT/cp-bin/cp" <<'SH'
#!/usr/bin/env bash
"$REAL_CP" "$@"
if [ "${2:-}" = "$REGISTRY/$ID.$DIGEST" ]; then
  "$REAL_CP" "$REGISTRY/$ID.$DIGEST" "$REGISTRY/replacement"
  mv "$REGISTRY/replacement" "$REGISTRY/$ID.$DIGEST"
fi
SH
chmod +x "$ROOT/cp-bin/cp"
expect_fail "replacement during copy fails closed" env PATH="$ROOT/cp-bin:$PATH" bash -c '"$0" guard-pre-push origin "$1" <<<"refs/heads/master $2 refs/heads/master $3" >/dev/null 2>&1' "$TD" "file://$ROOT/origin.git" "$TIP" "$BASE"

# A stale captured inode may be removed, but an atomic same-content replacement must survive.
publish_active "$(active '{"owner":"other"}')"
mkdir "$ROOT/bin"; REAL_GIT=$(command -v git); export REAL_GIT REGISTRY ID DIGEST
cat >"$ROOT/bin/git" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = ls-remote ] && [ ! -e "$REGISTRY/replaced" ]; then
  cp "$REGISTRY/$ID.$DIGEST" "$REGISTRY/new" && mv "$REGISTRY/new" "$REGISTRY/$ID.$DIGEST" && : >"$REGISTRY/replaced"
fi
exec "$REAL_GIT" "$@"
SH
chmod +x "$ROOT/bin/git"
PATH="$ROOT/bin:$PATH" expect_ok "same-content atomic replacement survives cleanup" guard
[ -f "$REGISTRY/$ID.$DIGEST" ] || { echo "FAIL: replacement was deleted"; exit 1; }
rm -f "$REGISTRY/replaced" "$REGISTRY/$ID.$DIGEST"

# Every direct child is inspected; sibling staging is deliberately outside the registry.
mkdir "$REGISTRY/not-regular"
expect_fail "non-regular registry child fails closed" guard
rm -rf "$REGISTRY/not-regular"; mkdir -p "$(git rev-parse --git-path task-dag/native-claim-staging)"; touch "$(git rev-parse --git-path task-dag/native-claim-staging)/ignored.tmp"
expect_ok "sibling staging temp is ignored" guard

entry >"$REGISTRY/$ID.$DIGEST"; publish_active "$(active '{"unexpected":true}')"
expect_fail "malformed active record fails closed" guard
publish_active "$(active '{"operationId":"renew","reclaimRequired":true}')"
expect_fail "renewed matching record blocks" guard
publish_active "$(active '{"operationId":"renew","reclaimRequired":false}')"
expect_fail "boolean reclaimRequired variant blocks" guard
publish_active "$(active '{"operationId":"create","semanticId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}')"
expect_fail "create-claim active shape blocks" guard
publish_active "$(active '{"semanticId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}')"
expect_fail "semantic-only active shape blocks" guard

for bad in 'owner| ' 'host|bad' 'sessionId|éééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééé'; do
  field=${bad%%|*}; value=${bad#*|}; entry | jq --arg field "$field" --arg value "$value" '.[$field]=$value' >"$REGISTRY/$ID.$DIGEST"
  expect_fail "malformed bounded registry string fails closed" guard
done
printf '{"taskId":"%s","owner":"\377","host":"host","sessionId":"session","claimToken":"token"}' "$ID" >"$REGISTRY/$ID.$DIGEST"
expect_fail "malformed UTF-8 registry byte fails closed" guard

# No advertised active ref is a stale registry entry: remove it without cat-file.
entry >"$REGISTRY/$ID.$DIGEST"; git push -q origin ":refs/heads/tasks/active/$ID"
cat >"$ROOT/bin/git" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" != cat-file ] || { echo unexpected-cat-file >&2; exit 99; }
exec "$REAL_GIT" "$@"
SH
chmod +x "$ROOT/bin/git"
expect_ok "only-stale absent remote ref is removed" env PATH="$ROOT/bin:$PATH" bash -c '"$0" guard-pre-push origin "$1" <<<"refs/heads/master $2 refs/heads/master $3" >/dev/null 2>&1' "$TD" "file://$ROOT/origin.git" "$TIP" "$BASE"
[ ! -e "$REGISTRY/$ID.$DIGEST" ] || { echo "FAIL: stale registry entry remains"; exit 1; }

printf '%5000s' x >"$REGISTRY/$ID.$DIGEST"
expect_fail "oversized registry entry fails closed" guard
rm -f "$REGISTRY/$ID.$DIGEST"; entry >"$REGISTRY/bad"; expect_fail "malformed registry name fails closed" guard

# A canonical native transition includes the journal and bypasses unrelated live claims.
expect_ok "native completion journal is allowed while another claim exists" bash -c \
  '"$0" guard-pre-push origin "$1" >/dev/null 2>&1 <<EOF
refs/heads/master '$TIP' refs/heads/master '$BASE'
refs/heads/tasks/system/transitions '$TIP' refs/heads/tasks/system/transitions '$BASE'
EOF' "$TD" "file://$ROOT/origin.git"

# The tracked hook must prefer this worktree's CLI over a permissive PATH
# installation, including when Git invokes it from a subdirectory.
rm -rf "$REGISTRY"; mkdir -p "$REGISTRY"; entry >"$REGISTRY/$ID.$DIGEST"; publish_active "$(active)"
mkdir -p scripts .githooks sub "$ROOT/path-bin"
cp "$TD" scripts/task-dag
cp -R "$(dirname "$TD")/task-dag.d" scripts/task-dag.d
cp "$(dirname "$TD")/../.githooks/pre-push" .githooks/pre-push
chmod +x scripts/task-dag .githooks/pre-push
cat >"$ROOT/path-bin/task-dag" <<'SH'
#!/usr/bin/env bash
if [ "${2:-}" = --help ]; then exit 0; fi
cat >/dev/null
exit 0
SH
chmod +x "$ROOT/path-bin/task-dag"
expect_fail "hook prefers rejecting worktree CLI from a subdirectory" env PATH="$ROOT/path-bin:$PATH" bash -c \
  'cd "$1/sub"; unset TASK_DAG_BIN; ../.githooks/pre-push origin "$2" <<<"refs/heads/master $3 refs/heads/master $4" >/dev/null 2>&1' \
  _ "$ROOT/wc" "file://$ROOT/origin.git" "$TIP" "$BASE"
echo "native-claim-guard: PASS"
