#!/usr/bin/env bash
# Pure Epic-ID v1 identity, descriptor, message, and dual-read ref codec.
# This fixture intentionally exercises no writer and creates no refs.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
LIB_DIR="$(dirname "$TD")/task-dag.d"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
taskdag_json_file_is_single_strict() {
    python3 - "$1" <<'PY'
import json, sys

def object_pairs(values):
    keys = [key for key, _ in values]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key")
    return dict(values)

with open(sys.argv[1], encoding="utf-8") as source:
    decoder = json.JSONDecoder(object_pairs_hook=object_pairs)
    text = source.read()
    _, end = decoder.raw_decode(text)
    if text[end:].strip():
        raise ValueError("trailing JSON")
PY
}
source "$LIB_DIR/git-objects.sh"
source "$LIB_DIR/task-model.sh"

operation_id=$(printf 'a%.0s' {1..64})
operation_epic=$(taskdag_epic_id_for_operation R_source "$operation_id")
provider_epic=$(taskdag_epic_id_for_provider github R_target I_issue)

if [ "$operation_epic" = epic-v1:a453373770d0520fe9b2557c6779a47fe17a5ecf0f2c38af5a826e9531b0eb54 ] \
    && [ "$provider_epic" = epic-v1:74bd3176c4ba5de0c6afca69c0ddd68b264d6eb0549461cbd866d7443b3322ab ]; then
    ok "golden operation and provider Epic-IDs"
else
    bad "Epic-ID golden values changed: operation=$operation_epic provider=$provider_epic"
fi

if [ "$(_taskdag_epic_id_v1 frame ab c)" != "$(_taskdag_epic_id_v1 frame a bc)" ] \
    && [ "$(_taskdag_epic_id_v1 operation R I)" != "$(_taskdag_epic_id_v1 provider R I)" ]; then
    ok "length framing and domain separation prevent ambiguous identity"
else
    bad "Epic-ID framing or domain separation collided"
fi

if ! taskdag_epic_id_for_operation '' "$operation_id" >/dev/null \
    && ! taskdag_epic_id_for_operation R_source short >/dev/null \
    && ! taskdag_epic_id_for_provider GitHub R_target I_issue >/dev/null \
    && ! taskdag_epic_id_for_provider github $'bad\nrepo' I_issue >/dev/null; then
    ok "identity inputs reject empty, malformed, and control-bearing values"
else
    bad "invalid Epic-ID input was accepted"
fi

legacy_ref=$(taskdag_parse_epic_root_ref refs/heads/tasks/pending/80)
epic_ref=$(taskdag_epic_root_ref "$operation_epic")
typed_ref=$(taskdag_parse_epic_root_ref "$epic_ref")
if [ "$legacy_ref" = '{"dialect":"legacy-issue-v0","epicId":null,"issueNumber":"80","ref":"refs/heads/tasks/pending/80","schema":1}' ] \
    && [ "$epic_ref" = "refs/heads/tasks/pending/epic-v1/${operation_epic#epic-v1:}" ] \
    && [ "$(jq -r '.dialect+":"+.epicId' <<<"$typed_ref")" = "epic-v1:$operation_epic" ]; then
    ok "dual-read root ref codec preserves legacy and typed identities"
else
    bad "root ref codec output changed"
fi
if ! taskdag_parse_epic_root_ref refs/heads/tasks/pending/0 >/dev/null \
    && ! taskdag_parse_epic_root_ref refs/heads/tasks/pending/80/extra >/dev/null \
    && ! taskdag_parse_epic_root_ref refs/heads/tasks/pending/epic-v1/abc >/dev/null \
    && ! taskdag_epic_root_ref "${operation_epic}x" >/dev/null; then
    ok "root ref codec rejects malformed and ambiguous paths"
else
    bad "malformed root ref was accepted"
fi

operation_descriptor=$(jq -nc --arg epicId "$operation_epic" --arg operationId "$operation_id" '
  {schema:1,epicId:$epicId,
   origin:{kind:"operation",repositoryId:"R_source",operationId:$operationId},
   projection:{provider:"github",repository:"owner/repo",repositoryId:"R_target",issueId:null,issueNumber:null,issueUrl:null},
   task:{title:"Canonical task-first epic",author:"worker",description:"body line one\nbody line two",status:"pending",type:"epic"}}')
operation_canonical=$(printf '%s\n' "$operation_descriptor" | taskdag_canonicalize_epic_root_descriptor)
if [ "$operation_canonical" = "$(jq -cS . <<<"$operation_descriptor")" ]; then
    ok "operation-origin descriptor is strict and canonical"
else
    bad "operation-origin descriptor failed canonicalization"
fi

printf '%s\n' "$operation_descriptor" | taskdag_serialize_epic_root_message >"$ROOT/operation-message"
cat >"$ROOT/operation-message.expected" <<EOF
Task: Canonical task-first epic

Epic-Root-Format: 1
Epic-ID: $operation_epic
Epic-Origin-Kind: operation
Epic-Origin-Repository-ID: R_source
Epic-Origin-Operation-ID: $operation_id
Author: worker
Status: pending
Type: epic
Projection-Provider: github
Projection-Repository: owner/repo
Projection-Repository-ID: R_target

body line one
body line two
EOF
if cmp -s "$ROOT/operation-message.expected" "$ROOT/operation-message"; then
    ok "task-first root message bytes are canonical"
else
    bad "task-first root message bytes changed"
fi

provider_descriptor=$(jq -nc --arg epicId "$provider_epic" '
  {schema:1,epicId:$epicId,
   origin:{kind:"provider",provider:"github",repositoryId:"R_target",issueId:"I_issue"},
   projection:{provider:"github",repository:"owner/repo",repositoryId:"R_target",issueId:"I_issue",issueNumber:"80",issueUrl:"https://github.com/owner/repo/issues/80"},
   task:{title:"Human issue epic",author:"operator",description:"",status:"pending",type:"epic"}}')
printf '%s\n' "$provider_descriptor" | taskdag_serialize_epic_root_message >"$ROOT/provider-message"
cat >"$ROOT/provider-message.expected" <<EOF
Task: Human issue epic

Epic-Root-Format: 1
Epic-ID: $provider_epic
Epic-Origin-Kind: provider
Epic-Origin-Provider: github
Epic-Origin-Repository-ID: R_target
Epic-Origin-Issue-ID: I_issue
Author: operator
Status: pending
Type: epic
Projection-Provider: github
Projection-Repository: owner/repo
Projection-Repository-ID: R_target
Projection-Issue-ID: I_issue
Projection-Issue-Number: 80
Projection-URL: https://github.com/owner/repo/issues/80
EOF
if printf '%s\n' "$provider_descriptor" | taskdag_canonicalize_epic_root_descriptor >/dev/null \
    && cmp -s "$ROOT/provider-message.expected" "$ROOT/provider-message"; then
    ok "provider-origin root binds the same immutable projection tuple"
else
    bad "provider-origin descriptor or message binding failed"
fi

numeric_strict=true
for numeric in 80 80.0 8e1; do
    alternate=$(jq -c --argjson numeric "$numeric" '.projection.issueNumber=$numeric' <<<"$provider_descriptor")
    printf '%s\n' "$alternate" | taskdag_canonicalize_epic_root_descriptor >/dev/null 2>&1 \
        && numeric_strict=false
done
large_issue=900719925474099312345678901234567890
large_descriptor=$(jq -c --arg issue "$large_issue" '.projection.issueNumber=$issue' <<<"$provider_descriptor")
large_canonical=$(printf '%s\n' "$large_descriptor" | taskdag_canonicalize_epic_root_descriptor)
if [ "$numeric_strict" = true ] \
    && [ "$(jq -r .projection.issueNumber <<<"$large_canonical")" = "$large_issue" ]; then
    ok "issue number is one lossless positive-decimal string"
else
    bad "issue-number descriptor accepted a numeric alias or lost precision"
fi

invalid_ok=true
jq '.epicId=("epic-v1:"+("0"*64))' <<<"$operation_descriptor" \
    | taskdag_canonicalize_epic_root_descriptor >/dev/null 2>&1 && invalid_ok=false
jq '.projection.issueId="I_partial"' <<<"$operation_descriptor" \
    | taskdag_canonicalize_epic_root_descriptor >/dev/null 2>&1 && invalid_ok=false
jq '.projection.repositoryId="R_other"' <<<"$provider_descriptor" \
    | taskdag_canonicalize_epic_root_descriptor >/dev/null 2>&1 && invalid_ok=false
jq '.task.description="Epic-ID: spoof"' <<<"$operation_descriptor" \
    | taskdag_canonicalize_epic_root_descriptor >/dev/null 2>&1 && invalid_ok=false
for field in title author; do
    jq --arg field "$field" '.task[$field]="A\u0000B"' <<<"$operation_descriptor" \
        | taskdag_canonicalize_epic_root_descriptor >/dev/null 2>&1 && invalid_ok=false
done
jq '.task.description="safe\rEpic-ID: spoof"' <<<"$operation_descriptor" \
    | taskdag_canonicalize_epic_root_descriptor >/dev/null 2>&1 && invalid_ok=false
jq '.projection.issueUrl="https://github.com/owner/repo/issues/80\u0000ignored"' <<<"$provider_descriptor" \
    | taskdag_canonicalize_epic_root_descriptor >/dev/null 2>&1 && invalid_ok=false
printf '%s\n' "${operation_descriptor%\}}"',"schema":1}' \
    | taskdag_canonicalize_epic_root_descriptor >/dev/null 2>&1 && invalid_ok=false
if [ "$invalid_ok" = true ]; then
    ok "descriptor rejects mismatches, partial binding, controls, spoofed headers, and duplicate keys"
else
    bad "invalid Epic-ID descriptor was accepted"
fi

taskdag_serialize_task_message Legacy '#80' actor https://github.com/owner/repo/issues/80 pending epic body \
    >"$ROOT/legacy-message"
cat >"$ROOT/legacy-message.expected" <<'EOF'
Task: Legacy

Issue: #80
Author: actor
URL: https://github.com/owner/repo/issues/80
Status: pending
Type: epic

body
EOF
if cmp -s "$ROOT/legacy-message.expected" "$ROOT/legacy-message"; then
    ok "legacy root message bytes remain unchanged"
else
    bad "legacy root serialization changed"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
