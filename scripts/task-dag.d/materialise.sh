# shellcheck shell=bash
# Canonical immutable materialisation reservation protocol (schema 1).

# shellcheck source=materialise-intent.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/materialise-intent.sh"

TASKDAG_MATERIALISATION_REF="refs/heads/tasks/v1/materialisation"
TASKDAG_MATERIALISATION_MAX_SPEC=2097152
TASKDAG_MATERIALISATION_MAX_BODY=1048576
TASKDAG_MATERIALISATION_MAX_DECLARATIONS=100

_taskdag_materialise_error() { echo "Error: materialisation: $*" >&2; return 2; }

# jq normally discards duplicate object keys. Its streaming representation
# retains member order and container-close events. Reconstruct active member
# containers and reject a decoded key whenever it starts a second occurrence
# in the same object, before ordinary jq parsing can apply last-wins semantics.
_taskdag_materialise_no_duplicate_keys() {
    jq -c --stream . "$1" 2>/dev/null | jq -se '
      def prefix($a;$b): ($a|length) <= ($b|length) and
        all(range(0;($a|length)); $a[.] == $b[.]);
      reduce .[] as $event (
        {active:[[]],seen:[],duplicate:false};
        if ($event|length)==2 then
          $event[0] as $path |
          reduce range(0;($path|length)) as $i (.;
            if ($path[$i]|type)=="string" then
              ($path[0:$i]) as $parent | ($path[0:$i+1]) as $child |
              (($i==(($path|length)-1)) or ((any(.active[];.==$child))|not)) as $starts |
              if $starts then
                if any(.seen[];.==[$parent,$path[$i]]) then .duplicate=true
                else .seen += [[$parent,$path[$i]]]
                end |
                if $i < (($path|length)-1) then .active += [$child] else . end
              else . end
            else . end)
        else
          ($event[0][0:-1]) as $closed |
          .active |= map(select(. != $closed)) |
          .seen |= map(select((prefix($closed;.[0]) and (.[0] != $closed))|not)) |
          .seen |= map(select(.[0] != $closed))
        end
      ) | .duplicate|not' >/dev/null 2>&1
}

_taskdag_materialise_sha256_file() { sha256sum "$1" | awk '{print $1}'; }
_taskdag_materialise_sha256_text() { printf '%s' "$1" | sha256sum | awk '{print $1}'; }

_taskdag_materialise_reservation_violations() { # tip path state activation-authority
    local tip=$1 path=$2 state=$3 activation_authority=$4 sid dd op batch timestamp expected
    sid=${path#slots/}; sid=${sid%%/*}; dd=$(jq -r '.declarationDigest' <<<"$state"); op=$(jq -r '.operationId' <<<"$state"); batch=$(jq -r '.batchId' <<<"$state")
    if ! jq -e --arg sid "$sid" '.schema==1 and .state=="batch-reserved-before-create" and .slotId==$sid and .generation==0 and .fence==1 and .predecessorStateDigest==null and (.activation|keys==["digest","epoch","guardVersion"] and (.epoch|type=="number" and floor==. and .>=1) and (.digest|test("^[0-9a-f]{64}$")) and .guardVersion==1) and (.actor|type=="string" and length>0 and length<=256 and (test("[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]")|not)) and (.authoritativeTimestamp|type=="string" and length==20 and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and (.batchId|test("^[0-9a-f]{64}$")) and (.declarationDigest|test("^[0-9a-f]{64}$")) and (.operationId|test("^[0-9a-f]{64}$")) and (.originReadback|keys==["activationAuthorityTip","materialisationTip"] and (.activationAuthorityTip|test("^[0-9a-f]{40}$"))) and ((.originReadback.materialisationTip==null) or (.originReadback.materialisationTip|test("^[0-9a-f]{40}$"))) and keys==["activation","actor","authoritativeTimestamp","batchId","declarationDigest","fence","generation","operationId","originReadback","predecessorStateDigest","schema","slotId","state"]' >/dev/null <<<"$state"; then
        echo "✗ invalid slot state $path"
        return
    fi
    timestamp=$(jq -r .authoritativeTimestamp <<<"$state")
    taskdag_activation_validate_provenance "$activation_authority" "$(jq -c .activation <<<"$state")" || echo "✗ slot $sid has forged activation provenance"
    jq -ne --arg timestamp "$timestamp" '($timestamp|fromdateiso8601|todateiso8601)==$timestamp' >/dev/null 2>&1 || echo "✗ slot $sid has an impossible timestamp"
    expected=$(_taskdag_materialise_id operation "$sid" "$dd"); [ "$op" = "$expected" ] || echo "✗ slot $sid operation ID mismatch"
    git cat-file -e "$tip:declarations/$dd.json" 2>/dev/null || echo "✗ slot $sid lacks declaration"
    [ "$(git show "$tip:declarations/$dd.json" 2>/dev/null | jq -r .slotId)" = "$sid" ] || echo "✗ slot $sid does not match declaration"
    [ "$(git show "$tip:batches/$batch.json" 2>/dev/null | jq -c .activation)" = "$(jq -c .activation <<<"$state")" ] || echo "✗ slot $sid activation provenance does not match batch"
    git show "$tip:batches/$batch.json" 2>/dev/null | jq -e --arg dd "$dd" --arg sid "$sid" --arg op "$op" 'any(.members[];.declarationDigest==$dd and .slotId==$sid and .operationId==$op)' >/dev/null 2>&1 || echo "✗ slot $sid is absent from batch"
}

_taskdag_materialise_fresh_transition_violations() { # tip path state
    local tip=$1 path=$2 state=$3 sid generation prior_path prior prior_digest from to declaration expected_marker expected_body_sha producer_record body_file
    sid=${path#slots/}; sid=${sid%%/*}; generation=${path##*/}; generation=${generation%.json}; generation=$((10#$generation))
    jq -e --arg sid "$sid" --argjson generation "$generation" '
      .schema==1 and .slotId==$sid and .generation==$generation and .generation>=1 and .fence==(.generation+1) and
      (.declarationDigest|test("^[0-9a-f]{64}$")) and (.operationId|test("^[0-9a-f]{64}$")) and
      (.predecessorStateDigest|test("^[0-9a-f]{64}$")) and
      (.actor|type=="string" and length>0 and length<=256) and
      (.authoritativeTimestamp|type=="string" and length==20 and ((fromdateiso8601|todateiso8601)==.)) and
      (.originReadback|keys==["activationAuthorityTip","materialisationTip"] and (.activationAuthorityTip|test("^([0-9a-f]{40}|[0-9a-f]{64})$")) and (.materialisationTip|test("^([0-9a-f]{40}|[0-9a-f]{64})$"))) and
      if .state=="create-in-flight-or-uncertain" then
        (keys-["rearmAuthorizationDigest"])==["activation","actor","authoritativeTimestamp","createAttemptId","declarationDigest","fence","generation","operationId","originReadback","predecessorStateDigest","producerRecordDigest","provider","schema","slotId","state"] and
        ((has("rearmAuthorizationDigest")|not) or (.rearmAuthorizationDigest|test("^[0-9a-f]{64}$"))) and
        (.activation|keys==["digest","epoch","guardVersion"]) and (.createAttemptId|test("^[0-9a-f]{64}$")) and (.producerRecordDigest|test("^[0-9a-f]{64}$")) and
        (.provider|keys==["repository","repositoryId","timeFloor"] and (.timeFloor|type=="string" and ((fromdateiso8601|todateiso8601)==.)))
      elif .state=="issue-adopted" then
        keys==["activation","actor","adoptedIssue","authoritativeTimestamp","createAttemptId","declarationDigest","fence","generation","operationId","originReadback","predecessorStateDigest","providerReceipt","schema","slotId","state"] and
        (.adoptedIssue|keys==["issueNodeId","number","repositoryId"] and (.issueNodeId|type=="string" and length>0) and (.repositoryId|type=="string" and length>0) and (.number|type=="number" and floor==. and .>0)) and
        (.providerReceipt|keys==["creatorNodeId","exhausted","matchCount","matchedIdentity","observedAt","pagesFetched","paginationQuery","repositoryId"] and .exhausted==true and .matchCount==1 and (.pagesFetched|type=="number" and floor==. and .>=1) and
          (.repositoryId|type=="string" and length>0) and (.matchedIdentity|keys==["bodySha256","createdAt","declarationDigest","issueNodeId","number","operationId","title"] and (.issueNodeId|type=="string" and length>0)))
      elif .state=="marker-durable-delegation-pending" then
        keys==["activation","actor","adoptedIssue","authoritativeTimestamp","declarationDigest","fence","generation","markerCommit","markerRef","operationId","originReadback","predecessorStateDigest","schema","slotId","state"] and
        (.markerCommit|test("^([0-9a-f]{40}|[0-9a-f]{64})$")) and (.markerRef|startswith("refs/heads/gh/materialisation-markers/"))
      elif .state=="final" then
        keys==["activation","actor","adoptedIssue","authoritativeTimestamp","declarationDigest","delegationRef","edgeId","fence","generation","markerCommit","markerRef","operationId","originReadback","predecessorStateDigest","schema","slotId","state"] and
        (.edgeId|test("^[0-9a-f]{64}$")) and (.delegationRef|startswith("refs/heads/tasks/delegated/"))
      else false end
    ' >/dev/null <<<"$state" || { echo "✗ invalid fresh transition $path"; return; }
    prior_path="slots/$sid/states/$(printf '%016d' "$((generation-1))").json"
    prior=$(git show "$tip:$prior_path" 2>/dev/null) || { echo "✗ transition $path lacks predecessor state"; return; }
    prior_digest=$(git show "$tip:$prior_path" | sha256sum | awk '{print $1}')
    [ "$prior_digest" = "$(jq -r .predecessorStateDigest <<<"$state")" ] || echo "✗ transition $path predecessor digest mismatch"
    [ "$(jq -r .declarationDigest <<<"$prior")" = "$(jq -r .declarationDigest <<<"$state")" ] || echo "✗ transition $path changed declaration"
    [ "$(jq -r .operationId <<<"$prior")" = "$(jq -r .operationId <<<"$state")" ] || echo "✗ transition $path changed operation"
    declaration=$(git show "$tip:declarations/$(jq -r .declarationDigest <<<"$state").json" 2>/dev/null) || { echo "✗ transition $path lacks declaration"; return; }
    if [ "$(jq -r .state <<<"$state")" = create-in-flight-or-uncertain ]; then
      [ "$(jq -r .provider.repository <<<"$state" | tr '[:upper:]' '[:lower:]')" = "$(jq -r .peerRepo.name <<<"$declaration" | tr '[:upper:]' '[:lower:]')" ] || echo "✗ transition $path changed provider repository"
      [ "$(jq -r .provider.repositoryId <<<"$state")" = "$(jq -r .peerRepo.id <<<"$declaration")" ] || echo "✗ transition $path changed provider repository ID"
      if jq -e 'has("rearmAuthorizationDigest")' >/dev/null <<<"$state"; then
        [ "$(git show "$tip:slots/$sid/authorizations/$(printf '%016d' "$generation").json" 2>/dev/null | jq -r .authorizationDigest)" = "$(jq -r .rearmAuthorizationDigest <<<"$state")" ] \
          || echo "✗ transition $path lacks its exact rearm authorization"
      fi
    elif [ "$(jq -r .state <<<"$state")" = issue-adopted ]; then
      jq -e --arg dd "$(jq -r .declarationDigest <<<"$state")" --arg op "$(jq -r .operationId <<<"$state")" --arg title "$(jq -r .title <<<"$declaration")" '
        .providerReceipt.repositoryId==.adoptedIssue.repositoryId and
        .providerReceipt.matchedIdentity.issueNodeId==.adoptedIssue.issueNodeId and
        .providerReceipt.matchedIdentity.number==.adoptedIssue.number and
        .providerReceipt.matchedIdentity.declarationDigest==$dd and
        .providerReceipt.matchedIdentity.operationId==$op and
        .providerReceipt.matchedIdentity.title==$title' >/dev/null <<<"$state" || echo "✗ transition $path has inconsistent recovery evidence"
      [ "$(jq -r .createAttemptId <<<"$state")" = "$(jq -r .createAttemptId <<<"$prior")" ] \
        && [ "$(jq -r .adoptedIssue.repositoryId <<<"$state")" = "$(jq -r .provider.repositoryId <<<"$prior")" ] \
        && [ "$(jq -r .adoptedIssue.repositoryId <<<"$state")" = "$(jq -r .peerRepo.id <<<"$declaration")" ] \
        || echo "✗ transition $path changed create or provider identity"
      body_file=$(mktemp) || { echo "✗ transition $path could not validate recovery body"; return; }
      if ! git show "$tip:bodies/$(jq -r .bodySha256 <<<"$declaration").body" >"$body_file" 2>/dev/null; then
        rm -f "$body_file"
        echo "✗ transition $path lacks recovery body"
        return
      fi
      expected_body_sha=$({ cat "$body_file"; printf '\n\n<!-- task-dag-materialisation:v1 operation=%s declaration=%s -->\n' "$(jq -r .operationId <<<"$state")" "$(jq -r .declarationDigest <<<"$state")"; } | sha256sum | awk '{print $1}')
      rm -f "$body_file"
      [ "$(jq -r .providerReceipt.matchedIdentity.bodySha256 <<<"$state")" = "$expected_body_sha" ] || echo "✗ transition $path has recovery body digest mismatch"
      jq -e --arg floor "$(jq -r .provider.timeFloor <<<"$prior")" '
        (.providerReceipt.matchedIdentity.createdAt|fromdateiso8601|todateiso8601)==.providerReceipt.matchedIdentity.createdAt and
        .providerReceipt.matchedIdentity.createdAt >= $floor' >/dev/null <<<"$state" || echo "✗ transition $path predates its provider time floor"
      producer_record=$(git show "$TASKDAG_MATERIALISE_PRODUCER_REF:producer-enable.json" 2>/dev/null) || { echo "✗ transition $path lacks producer authority"; producer_record='{}'; }
      [ "$(printf '%s\n' "$producer_record" | sha256sum | awk '{print $1}')" = "$(jq -r .producerRecordDigest <<<"$prior")" ] \
        && [ "$(jq -r .appCreatorNodeId <<<"$producer_record")" = "$(jq -r .providerReceipt.creatorNodeId <<<"$state")" ] \
        || echo "✗ transition $path has recovery creator mismatch"
    elif [[ "$(jq -r .state <<<"$state")" =~ ^(marker-durable-delegation-pending|final)$ ]]; then
      expected_marker="refs/heads/gh/materialisation-markers/$(jq -r .operationId <<<"$state")"
      [ "$(jq -r .markerRef <<<"$state")" = "$expected_marker" ] || echo "✗ transition $path has operation-mismatched marker"
    fi
    from=$(jq -r .state <<<"$prior"); to=$(jq -r .state <<<"$state")
    case "$from:$to" in
      batch-reserved-before-create:create-in-flight-or-uncertain|create-in-flight-or-uncertain:issue-adopted|issue-adopted:marker-durable-delegation-pending|marker-durable-delegation-pending:final) ;;
      create-in-flight-or-uncertain:create-in-flight-or-uncertain)
        jq -e 'has("rearmAuthorizationDigest")' >/dev/null <<<"$state" || echo "✗ transition $path repeats create authority without rearm"
        ;;
      *) echo "✗ transition $path has invalid state edge $from -> $to" ;;
    esac
}

# Hash a domain-separated sequence of UTF-8 values.  Decimal byte lengths and
# separators make framing unambiguous, including absent versus present-empty.
_taskdag_materialise_id() {
    local LC_ALL=C domain=$1 value
    shift
    {
        printf 'task-dag-materialisation-id-v1\000%s\000' "$domain"
        for value in "$@"; do printf '%s:%s\000' "${#value}" "$value"; done
    } | sha256sum | awk '{print $1}'
}

_taskdag_materialise_validate_spec() {
    local spec=$1 size
    command -v jq >/dev/null 2>&1 || { _taskdag_materialise_error "jq is required"; return 2; }
    command -v sha256sum >/dev/null 2>&1 || { _taskdag_materialise_error "sha256sum is required"; return 2; }
    command -v iconv >/dev/null 2>&1 || { _taskdag_materialise_error "iconv is required"; return 2; }
    command -v realpath >/dev/null 2>&1 || { _taskdag_materialise_error "realpath is required"; return 2; }
    [ -f "$spec" ] || { _taskdag_materialise_error "--spec-file must name a regular file"; return 2; }
    size=$(wc -c <"$spec")
    [ "$size" -le "$TASKDAG_MATERIALISATION_MAX_SPEC" ] || { _taskdag_materialise_error "spec exceeds size limit"; return 2; }
    jq -se 'length==1' "$spec" >/dev/null 2>&1 || { _taskdag_materialise_error "spec must contain exactly one valid JSON value"; return 2; }
    _taskdag_materialise_no_duplicate_keys "$spec" || { _taskdag_materialise_error "duplicate JSON object key"; return 2; }
    jq -e --argjson max "$TASKDAG_MATERIALISATION_MAX_DECLARATIONS" '
      def bounded($n): type=="string" and (length>0) and (length <= $n);
      def safe: type=="string" and (test("[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]")|not);
      type=="object" and keys==["actor","authoritativeTimestamp","declarations","provenance","schema"] and
      .schema==1 and (.actor|bounded(256) and safe) and
      (.authoritativeTimestamp|type=="string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$") and length==20) and
      (.provenance|type=="array" and length<=100 and all(.[]; bounded(1024) and safe)) and
      (.declarations|type=="array" and length>0 and length<=$max and all(.[ ];
        type=="object" and
        ((keys-["delegationNote","slug"]) == ["bodyFile","parentIssue","peerRepo","provenance","sourceRepo","title"]) and
        ((keys|length)==6 or (keys|length)==7 or (keys|length)==8) and
        (.sourceRepo|type=="object" and keys==["id","name"] and (.id|bounded(256) and safe) and (.name|bounded(256) and safe)) and
        (.peerRepo|type=="object" and keys==["id","name"] and (.id|bounded(256) and safe) and (.name|bounded(256) and safe)) and
        (.parentIssue|type=="object" and keys==["id","number"] and (.id|bounded(256) and safe) and (.number|type=="number" and .>0 and floor==. and .<=9007199254740991)) and
        (.title|bounded(1024) and safe) and (.bodyFile|bounded(4096) and safe) and (.provenance|bounded(4096) and safe) and
        ((has("slug")|not) or (.slug|bounded(128) and safe)) and
        ((has("delegationNote")|not) or (.delegationNote|type=="string" and length<=4096 and safe))
      ))' "$spec" >/dev/null 2>&1 || { _taskdag_materialise_error "unsupported spec shape, type, or bound"; return 2; }
    jq -e '.authoritativeTimestamp as $timestamp | (($timestamp|fromdateiso8601|todateiso8601)==$timestamp)' "$spec" >/dev/null 2>&1 \
      || { _taskdag_materialise_error "authoritativeTimestamp is not a real canonical UTC second"; return 2; }
}

# Emit canonical normalized reservation input.  Body bytes are imported with
# --rawfile, preserving trailing newlines (never shell command substitution).
taskdag_materialise_prepare() {
    local source_spec=$1 test_hook=${2:-} spec_fd base tmp spec out staged field_file declarations decl body snapshot path body_len body_sha slot declaration operation body_fd actor timestamp provenance input_count processed=0 result
    [ -f "$source_spec" ] && [ ! -L "$source_spec" ] || { _taskdag_materialise_error "--spec-file must name a regular non-symlink file"; return 2; }
    base=$(cd "$(dirname "$source_spec")" && pwd)
    tmp=$(mktemp -d) || { _taskdag_materialise_error "cannot create private preparation directory"; return 2; }
    spec="$tmp/spec.json"
    exec {spec_fd}<"$source_spec" || { rm -rf "$tmp"; _taskdag_materialise_error "cannot open spec file"; return 2; }
    [ "$(realpath -e -- "/proc/self/fd/$spec_fd" 2>/dev/null)" = "$(realpath -e -- "$source_spec" 2>/dev/null)" ] \
      || { exec {spec_fd}<&-; rm -rf "$tmp"; _taskdag_materialise_error "spec file changed during secure open"; return 2; }
    cat <&$spec_fd >"$spec" || { exec {spec_fd}<&-; rm -rf "$tmp"; _taskdag_materialise_error "cannot snapshot spec file"; return 2; }
    exec {spec_fd}<&-
    [ "$test_hook" != replace-spec-after-snapshot ] || printf '{"schema":1}\n' >"$source_spec"
    _taskdag_materialise_validate_spec "$spec" || { rm -rf "$tmp"; return 2; }
    out="$tmp/prepared.json"
    staged="$tmp/declarations.jsonl"
    field_file="$tmp/identity-fields"
    jq -c '.declarations[]' "$spec" >"$staged" || { rm -rf "$tmp"; _taskdag_materialise_error "cannot stage declarations"; return 2; }
    input_count=$(jq -r '.declarations|length' "$spec") || { rm -rf "$tmp"; _taskdag_materialise_error "cannot count declarations"; return 2; }
    [ "$(wc -l <"$staged")" -eq "$input_count" ] || { rm -rf "$tmp"; _taskdag_materialise_error "staged declaration count mismatch"; return 2; }
    printf '[]' >"$out" || { rm -rf "$tmp"; _taskdag_materialise_error "cannot initialize preparation"; return 2; }
    while IFS= read -r decl; do
        processed=$((processed+1))
        if [ "$test_hook" = fail-second-declaration ] && [ "$processed" -eq 2 ]; then rm -rf "$tmp"; _taskdag_materialise_error "injected declaration transformation failure"; return 2; fi
        path=$(jq -r '.bodyFile' <<<"$decl") || { rm -rf "$tmp"; _taskdag_materialise_error "cannot read bodyFile"; return 2; }
        case "$path" in ''|/*|*\\*|*'//'*|./*|*'/./'*|*'/../'*|../*|*/..|..) rm -rf "$tmp"; _taskdag_materialise_error "bodyFile must be a normalized relative path beneath the spec directory"; return 2;; esac
        body="$base/$path"
        [ -f "$body" ] && [ ! -L "$body" ] && [ "$(realpath -e -- "$body" 2>/dev/null)" = "$body" ] || { rm -rf "$tmp"; _taskdag_materialise_error "bodyFile is not a regular non-symlink file beneath the spec directory"; return 2; }
        snapshot="$tmp/body.$RANDOM.$RANDOM"
        exec {body_fd}<"$body" || { rm -rf "$tmp"; _taskdag_materialise_error "cannot open bodyFile"; return 2; }
        [ "$(realpath -e -- "/proc/self/fd/$body_fd" 2>/dev/null)" = "$body" ] || { exec {body_fd}<&-; rm -rf "$tmp"; _taskdag_materialise_error "bodyFile changed during secure open"; return 2; }
        cat <&$body_fd >"$snapshot" || { exec {body_fd}<&-; rm -rf "$tmp"; _taskdag_materialise_error "cannot snapshot bodyFile"; return 2; }
        exec {body_fd}<&-
        [ "$test_hook" != replace-source-after-snapshot ] || printf 'replacement after immutable snapshot\n' >"$body"
        body_len=$(wc -c <"$snapshot") || { rm -rf "$tmp"; return 2; }
        [ "$body_len" -le "$TASKDAG_MATERIALISATION_MAX_BODY" ] || { rm -rf "$tmp"; _taskdag_materialise_error "body exceeds size limit"; return 2; }
        iconv -f UTF-8 -t UTF-8 "$snapshot" >/dev/null 2>&1 || { rm -rf "$tmp"; _taskdag_materialise_error "body must be valid UTF-8"; return 2; }
        jq -Rse 'test("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]")|not' "$snapshot" >/dev/null 2>&1 || { rm -rf "$tmp"; _taskdag_materialise_error "body must be valid UTF-8 without unsafe controls or bidi controls"; return 2; }
        ! grep -Fq '<!-- task-dag-materialisation:' "$snapshot" || { rm -rf "$tmp"; _taskdag_materialise_error "body contains the reserved materialisation sentinel"; return 2; }
        body_sha=$(_taskdag_materialise_sha256_file "$snapshot") || { rm -rf "$tmp"; return 2; }
        jq -r '[.sourceRepo.id,.parentIssue.id,(.parentIssue.number|tostring),.peerRepo.id,(if has("slug") then "present" else "absent" end),(.slug//"")][]' <<<"$decl" >"$field_file" || { rm -rf "$tmp"; _taskdag_materialise_error "cannot frame slot identity"; return 2; }
        mapfile -t _m_fields <"$field_file"
        slot=$(_taskdag_materialise_id slot "${_m_fields[@]}")
        jq -r --arg bh "$body_sha" --arg bl "$body_len" '[.sourceRepo.id,.sourceRepo.name,.parentIssue.id,(.parentIssue.number|tostring),.peerRepo.id,.peerRepo.name,.title,$bh,$bl,(if has("slug") then "present" else "absent" end),(.slug//""),(if has("delegationNote") then "present" else "absent" end),(.delegationNote//"")][]' <<<"$decl" >"$field_file" || { rm -rf "$tmp"; _taskdag_materialise_error "cannot frame declaration identity"; return 2; }
        mapfile -t _m_fields <"$field_file"
        declaration=$(_taskdag_materialise_id declaration "${_m_fields[@]}")
        operation=$(_taskdag_materialise_id operation "$slot" "$declaration")
        jq --argjson d "$decl" --rawfile body "$snapshot" --arg bodySha256 "$body_sha" --argjson bodyLength "$body_len" --arg slotId "$slot" --arg declarationDigest "$declaration" --arg operationId "$operation" \
          '. + [($d | .memberProvenance=[.provenance] | del(.bodyFile,.provenance) + {schema:1,bodySha256:$bodySha256,bodyLength:$bodyLength,slotId:$slotId,declarationDigest:$declarationDigest,operationId:$operationId,body:$body})]' "$out" >"$out.n" \
          || { rm -rf "$tmp"; _taskdag_materialise_error "cannot transform declaration $processed"; return 2; }
        mv "$out.n" "$out" || { rm -rf "$tmp"; _taskdag_materialise_error "cannot commit transformed declaration $processed"; return 2; }
    done <"$staged"
    [ "$processed" -eq "$input_count" ] || { rm -rf "$tmp"; _taskdag_materialise_error "prepared declaration count mismatch"; return 2; }
    jq -e 'group_by(.slotId) | all(.[]; (map(.declarationDigest)|unique|length)==1)' "$out" >/dev/null || { rm -rf "$tmp"; _taskdag_materialise_error "same slot has different declarations"; return 2; }
    declarations=$(jq -c 'group_by(.declarationDigest)|map(.[0] * {memberProvenance:(map(.memberProvenance[])|sort|unique)})|sort_by(.slotId)' "$out") || { rm -rf "$tmp"; return 2; }
    actor=$(jq -r .actor "$spec") || { rm -rf "$tmp"; return 2; }
    timestamp=$(jq -r .authoritativeTimestamp "$spec") || { rm -rf "$tmp"; return 2; }
    provenance=$(jq -c '.provenance|sort|unique' "$spec") || { rm -rf "$tmp"; return 2; }
    result=$(jq -ncS --arg actor "$actor" --arg authoritativeTimestamp "$timestamp" --argjson batchProvenance "$provenance" --argjson declarations "$declarations" --argjson inputDeclarationCount "$input_count" \
      '{actor:$actor,authoritativeTimestamp:$authoritativeTimestamp,batchProvenance:$batchProvenance,declarations:$declarations,inputDeclarationCount:$inputDeclarationCount}') \
      || { rm -rf "$tmp"; _taskdag_materialise_error "cannot serialize prepared request"; return 2; }
    rm -rf "$tmp"
    printf '%s\n' "$result"
}

_taskdag_materialise_batch_json() {
    local prepared=$1 activation=$2 members provenance batch activation_provenance
    members=$(jq -cS '[.declarations[]|{slotId,declarationDigest,operationId,provenance:.memberProvenance}]|sort_by(.slotId)' <<<"$prepared") || return 2
    provenance=$(jq -c '.batchProvenance' <<<"$prepared") || return 2
    activation_provenance=$(jq -cS '{epoch,digest,guardVersion}' <<<"$activation") || return 2
    batch=$(_taskdag_materialise_id batch "$(jq -c . <<<"$members")" "$(jq -c . <<<"$provenance")" "$activation_provenance")
    jq -ncS --arg batchId "$batch" --argjson members "$members" --argjson provenance "$provenance" --argjson activation "$activation_provenance" '{schema:1,activation:$activation,batchId:$batchId,members:$members,provenance:$provenance}'
}

_taskdag_validate_census_artifact() { # canonical census artifact file
    jq -e '
      type=="object" and .schema==1 and keys==["activationRecordDigest","issues","legacyCompletionRefs","liveDelegations","schema","slots"] and
      (.activationRecordDigest|test("^[0-9a-f]{64}$")) and
      (.issues|type=="array" and .==sort_by(.repository,.number) and all(.[];
        type=="object" and keys==["body","completionEvidence","createdAt","creator","declarations","id","liveDelegations","markers","number","repository","repositoryId","state","title"] and
        (.repository|type=="string" and length>0) and (.repositoryId|type=="string" and length>0) and (.id|type=="string" and length>0) and
        (.number|type=="number" and floor==. and .>0) and (.state=="OPEN" or .state=="CLOSED") and
        (.body|type=="string") and (.title|type=="string" and length>0) and (.creator|type=="string" and length>0) and
        (.createdAt|fromdateiso8601|todateiso8601)==.createdAt and
        (.markers|type=="array" and .==sort_by(.ref) and all(.[];keys==["oid","ref"] and (.oid|test("^[0-9a-f]{40}$")) and (.ref|type=="string"))) and
        (.completionEvidence|type=="array" and .==sort_by(.ref) and all(.[];
          if .disposition=="verified-child-close" then keys==["delegationRef","disposition","oid","ref"] and (.delegationRef|type=="string" and length>0)
          else keys==["disposition","oid","ref"] and (.disposition=="partial-implementation" or .disposition=="malformed-evidence") end and
          (.oid|test("^[0-9a-f]{40}$")) and (.ref|type=="string"))) and
        (.liveDelegations|type=="array" and .==sort_by(.ref) and all(.[];
          if .disposition=="verified-child-close" then
            keys==["declarationDigest","delegationCommit","disposition","materialisationOperationId","oid","parentIssue","parentIssueNodeId","parentRepo","parentRepoNodeId","peerClose","peerEpic","peerIssue","peerIssueNodeId","peerRepo","peerRepoNodeId","peerTip","ref"] and
            (.delegationCommit==.oid) and (.declarationDigest|test("^[0-9a-f]{64}$")) and (.materialisationOperationId|type=="string" and length>0) and
            all(.parentRepo,.peerRepo,.parentRepoNodeId,.parentIssueNodeId,.peerRepoNodeId,.peerIssueNodeId;type=="string" and length>0) and all(.peerTip,.peerClose,.peerEpic;test("^[0-9a-f]{40}$"))
          else keys==["disposition","oid","parentIssue","parentRepo","peerIssue","peerRepo","ref"] and
            (.disposition=="live-obligation" or .disposition=="blocked-repair") and all(.parentRepo,.peerRepo;type=="string" and length>0) end and
          (.parentIssue|type=="number" and floor==. and .>0) and (.peerIssue|type=="number" and floor==. and .>0) and
          (.oid|test("^[0-9a-f]{40}$")) and (.ref|type=="string"))) and
        (.declarations|type=="array" and .==sort_by(.slotId) and all(.[];
          (keys-["adoptedIssue","delegationNote","slug"])==["body","bodyLength","bodySha256","declarationDigest","disposition","operationId","parentIssue","peerRepo","schema","slotId","sourceRepo","title"] and
          .schema==1 and (.body|type=="string") and (.bodySha256|test("^[0-9a-f]{64}$")) and (.bodyLength|type=="number" and floor==. and .>=0) and
          (.slotId|test("^[0-9a-f]{64}$")) and (.declarationDigest|test("^[0-9a-f]{64}$")) and (.operationId|test("^[0-9a-f]{64}$")) and
          (.sourceRepo|keys==["id","name"] and all(.id,.name;type=="string" and length>0)) and
          (.peerRepo|keys==["id","name"] and all(.id,.name;type=="string" and length>0)) and
          (.parentIssue|keys==["id","number"] and (.id|type=="string" and length>0) and (.number|type=="number" and floor==. and .>0)) and
          (if .disposition=="issue-adopted" then (.adoptedIssue|keys==["issueNodeId","number","repositoryId"] and (.issueNodeId|type=="string" and length>0) and (.repositoryId|type=="string" and length>0) and (.number|type=="number" and floor==. and .>0))
           else (.disposition=="create-in-flight-or-uncertain" or .disposition=="blocked-repair") and (has("adoptedIssue")|not) end))))) and
      ((.issues|map(.id))|length==(unique|length)) and ((.issues|map([.repository,.number]))|length==(unique|length)) and
      (.slots == ([.issues[] as $i | $i.declarations[] | .+{issueNodeId:$i.id,repository:$i.repository,issueNumber:$i.number}]|sort_by(.slotId))) and
      (.legacyCompletionRefs == ([.issues[] as $i | $i.completionEvidence[] | .+{repository:$i.repository}]|sort_by(.repository,.ref))) and
      (.liveDelegations == ([.issues[] as $i | $i.liveDelegations[] | .+{repository:$i.repository}]|sort_by(.repository,.ref))) and
      ((.slots|map(.slotId))|length==(unique|length)) and
      ((.legacyCompletionRefs|map([.repository,.ref]))|length==(unique|length)) and
      ((.liveDelegations|map([.repository,.ref]))|length==(unique|length))' "$1" >/dev/null
}

_taskdag_materialisation_snapshot_violations() {
    local tip=$1 work=$2 activation_authority=$3 expected_repository=${4:-} parent="" count path mode type prepared state sid dd op batch body_sha body_len expected declaration_path timestamp generation prior prior_path census_digest census_path repository adopted_id activation_path activation_matches
    git rev-list --parents -1 "$tip" >"$work/snapshot-parents" 2>/dev/null \
      || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot read snapshot parents"; return 0; }
    count=$(awk '{print NF-1}' "$work/snapshot-parents")
    [ "$count" -le 1 ] || echo "✗ $TASKDAG_MATERIALISATION_REF commit is not linear"
    [ "$count" -eq 0 ] || parent=$(git rev-parse "$tip^" 2>/dev/null) || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot resolve snapshot parent"; return 0; }
    git ls-tree -r "$tip" >"$work/snapshot-tree" 2>/dev/null \
      || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot read snapshot tree"; return 0; }
    while read -r mode type _ path; do
        [ "$mode" = 100644 ] && [ "$type" = blob ] || { echo "✗ $TASKDAG_MATERIALISATION_REF has non-regular path $path"; continue; }
        [[ "$path" =~ ^(bodies/[0-9a-f]{64}\.body|declarations/[0-9a-f]{64}\.json|batches/[0-9a-f]{64}\.json|censuses/[0-9a-f]{64}\.json|import-batches/[0-9a-f]{64}\.json|slots/[0-9a-f]{64}/(states/[0-9]{16}\.json|authorizations/[0-9]{16}\.json))$ ]] || echo "✗ $TASKDAG_MATERIALISATION_REF has unexpected path $path"
    done <"$work/snapshot-tree"
    cut -f2 "$work/snapshot-tree" >"$work/snapshot-paths" \
      || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot enumerate snapshot paths"; return 0; }
    grep -E '^(declarations|batches|censuses|import-batches|slots)/' "$work/snapshot-paths" >"$work/snapshot-json-paths" || :
    while IFS= read -r path; do
        prepared=$(git show "$tip:$path" 2>/dev/null) || { echo "✗ unreadable $path"; continue; }
        jq -e . >/dev/null 2>&1 <<<"$prepared" || { echo "✗ invalid JSON at $path"; continue; }
        case "$path" in
          censuses/*)
            printf '%s\n' "$prepared" >"$work/census-artifact"
            _taskdag_validate_census_artifact "$work/census-artifact" || echo "✗ invalid census/import $path"
            census_digest=${path#censuses/}; census_digest=${census_digest%.json}
            [ "$(git show "$tip:$path" 2>/dev/null | sha256sum | awk '{print $1}')" = "$census_digest" ] || echo "✗ census path digest mismatch $path"
            activation_matches=0
            while IFS= read -r activation_path; do
              git show "$activation_authority:$activation_path" >"$work/activation-record" 2>/dev/null || continue
              if [ "$(jq -r .state "$work/activation-record" 2>/dev/null)" = enabled ] \
                && [ "$(_taskdag_activation_digest_file "$work/activation-record" 2>/dev/null)" = "$(jq -r .activationRecordDigest <<<"$prepared")" ]; then
                activation_matches=$((activation_matches+1))
              fi
            done < <(git ls-tree -r --name-only "$activation_authority" records 2>/dev/null)
            [ "$activation_matches" -eq 1 ] || echo "✗ census $path does not bind exactly one enabled activation record" ;;
          import-batches/*)
            jq -e 'keys==["censusDigest","repository","schema","slots"] and .schema==1 and (.repository|type=="string" and length>0) and (.censusDigest|test("^[0-9a-f]{64}$")) and (.slots|type=="array" and .==sort and length==(unique|length) and all(.[];test("^[0-9a-f]{64}$")))' >/dev/null <<<"$prepared" || echo "✗ invalid import batch $path"
            census_digest=${path#import-batches/}; census_digest=${census_digest%.json}; repository=$(jq -r .repository <<<"$prepared")
            [ -z "$expected_repository" ] || [ "$repository" = "$expected_repository" ] || echo "✗ import batch $path belongs to foreign repository $repository"
            [ "$(jq -r .censusDigest <<<"$prepared")" = "$census_digest" ] || echo "✗ import batch filename/census mismatch $path"
            census_path="censuses/$census_digest.json"; git cat-file -e "$tip:$census_path" 2>/dev/null || echo "✗ import batch lacks census $path"
            [ "$(jq -c '.slots' <<<"$prepared")" = "$(git show "$tip:$census_path" 2>/dev/null | jq -c --arg repo "$repository" '[.slots[]|select(.repository==$repo)|.slotId]|sort')" ] \
              || echo "✗ import batch $path does not equal its complete census partition"
            while IFS= read -r sid; do
              git cat-file -e "$tip:slots/$sid/states/0000000000000000.json" 2>/dev/null || { echo "✗ import batch $path lacks slot $sid"; continue; }
              git show "$tip:$census_path" 2>/dev/null | jq -e --arg sid "$sid" --arg repo "$repository" 'any(.slots[];.slotId==$sid and .repository==$repo)' >/dev/null \
                || echo "✗ import batch $path has foreign or absent census slot $sid"
            done < <(jq -r '.slots[]' <<<"$prepared") ;;
          slots/*/states/*)
            if [ "$(jq -r '.state // ""' <<<"$prepared")" = batch-reserved-before-create ]; then
              _taskdag_materialise_reservation_violations "$tip" "$path" "$prepared" "$activation_authority"
              continue
            fi
            if jq -e 'has("operationId") and has("authoritativeTimestamp") and .generation>=1' >/dev/null <<<"$prepared"; then
              _taskdag_materialise_fresh_transition_violations "$tip" "$path" "$prepared"
              continue
            fi
            sid=${path#slots/}; sid=${sid%%/*}; generation=${path##*/}; generation=${generation%.json}; generation=$((10#$generation))
            jq -e --arg sid "$sid" --argjson generation "$generation" '.schema==1 and .slotId==$sid and .generation==$generation and
              (.state=="issue-adopted" or .state=="create-in-flight-or-uncertain" or .state=="blocked-repair") and
              (.censusDigest|test("^[0-9a-f]{64}$")) and (.predecessorStateDigest==null or (.predecessorStateDigest|test("^[0-9a-f]{64}$")))' >/dev/null <<<"$prepared" \
              || echo "✗ invalid imported/transition state $path"
            if [ "$generation" -eq 0 ]; then
              jq -e '((keys-["adoptedIssue"])==["censusDigest","declarationDigest","generation","operationId","predecessorStateDigest","schema","slotId","state"]) and
                .predecessorStateDigest==null and (.declarationDigest|test("^[0-9a-f]{64}$")) and (.operationId|type=="string" and length>0) and
                ((.state=="issue-adopted" and (.adoptedIssue|keys==["issueNodeId","number","repositoryId"])) or (.state!="issue-adopted" and (has("adoptedIssue")|not)))' >/dev/null <<<"$prepared" \
                || echo "✗ invalid imported initial state $path"
              census_digest=$(jq -r .censusDigest <<<"$prepared"); census_path="censuses/$census_digest.json"; dd=$(jq -r .declarationDigest <<<"$prepared"); op=$(jq -r .operationId <<<"$prepared")
              git show "$tip:$census_path" 2>/dev/null | jq -e --arg sid "$sid" --arg dd "$dd" --arg op "$op" 'any(.slots[];.slotId==$sid and .declarationDigest==$dd and .operationId==$op)' >/dev/null \
                || echo "✗ imported state $path is absent or different in census"
              git show "$tip:declarations/$dd.json" 2>/dev/null | jq -e --arg sid "$sid" --arg dd "$dd" --arg op "$op" \
                '.slotId==$sid and .declarationDigest==$dd and .operationId==$op' >/dev/null || echo "✗ imported state $path lacks matching declaration"
              [ "$(git grep -l "\"$sid\"" "$tip" -- "import-batches/$census_digest.json" 2>/dev/null | wc -l)" -eq 1 ] || echo "✗ imported state $path lacks unique import batch"
              if [ "$(jq -r .state <<<"$prepared")" = issue-adopted ]; then
                adopted_id=$(jq -r .adoptedIssue.issueNodeId <<<"$prepared")
                git show "$tip:$census_path" 2>/dev/null | jq -e --arg sid "$sid" --argjson issue "$(jq -c .adoptedIssue <<<"$prepared")" '
                  (.slots[]|select(.slotId==$sid)) as $d | $issue.repositoryId==$d.peerRepo.id and
                  any(.issues[];.repository==$d.peerRepo.name and .id==$issue.issueNodeId and .repositoryId==$issue.repositoryId and .number==$issue.number)' >/dev/null \
                  || echo "✗ imported adopted state $path does not bind its exact peer issue"
                [ "$(git grep -l "\"issueNodeId\":\"$adopted_id\"" "$tip" -- 'slots/*/states/*.json' 2>/dev/null | wc -l)" -eq 1 ] \
                  || echo "✗ adopted issue $adopted_id is bound by multiple slots"
              fi
            else
              prior_path="slots/$sid/states/$(printf '%016d' "$((generation-1))").json"
              prior=$(git show "$tip:$prior_path" 2>/dev/null) || { echo "✗ transition $path lacks predecessor state"; continue; }
              [ "$(git show "$tip:$prior_path" 2>/dev/null | sha256sum | awk '{print $1}')" = "$(jq -r .predecessorStateDigest <<<"$prepared")" ] \
                || echo "✗ transition $path predecessor digest mismatch"
              [ "$(jq -r .censusDigest <<<"$prepared")" = "$(jq -r .censusDigest <<<"$prior")" ] || echo "✗ transition $path changed census"
              if [ "$(jq -r .state <<<"$prepared")" = issue-adopted ]; then
                jq -e 'keys==["actor","adoptedIssue","approval","censusDigest","evidence","generation","mode","predecessorStateDigest","schema","slotId","state","timestamp"] and .mode=="adopt"' >/dev/null <<<"$prepared" \
                  || echo "✗ invalid adopt transition $path"
                [[ "$(jq -r .state <<<"$prior")" =~ ^(blocked-repair|create-in-flight-or-uncertain)$ ]] || echo "✗ adopt transition $path has invalid predecessor state"
                census_digest=$(jq -r .censusDigest <<<"$prepared"); adopted_id=$(jq -r .adoptedIssue.issueNodeId <<<"$prepared")
                git show "$tip:censuses/$census_digest.json" 2>/dev/null | jq -e --arg sid "$sid" --argjson issue "$(jq -c .adoptedIssue <<<"$prepared")" '
                  (.slots[]|select(.slotId==$sid)) as $d | $issue.repositoryId==$d.peerRepo.id and
                  any(.issues[];.repository==$d.peerRepo.name and .id==$issue.issueNodeId and .repositoryId==$issue.repositoryId and .number==$issue.number)' >/dev/null \
                  || echo "✗ adopt transition $path does not bind its exact peer issue"
                [ "$(git grep -l "\"issueNodeId\":\"$adopted_id\"" "$tip" -- 'slots/*/states/*.json' 2>/dev/null | wc -l)" -eq 1 ] \
                  || echo "✗ adopted issue $adopted_id is bound by multiple slots"
              else
                jq -e 'keys==["actor","authorizationDigest","censusDigest","evidence","generation","mode","predecessorStateDigest","schema","slotId","state","timestamp"] and
                  .mode=="consume" and .state=="create-in-flight-or-uncertain"' >/dev/null <<<"$prepared" || echo "✗ invalid consume transition $path"
                [ "$(jq -r .state <<<"$prior")" = create-in-flight-or-uncertain ] || echo "✗ consume transition $path has invalid predecessor state"
                [ "$(git show "$tip:slots/$sid/authorizations/$(printf '%016d' "$generation").json" 2>/dev/null | jq -r .authorizationDigest)" = "$(jq -r .authorizationDigest <<<"$prepared")" ] \
                  || echo "✗ consume transition $path lacks matching authorization"
              fi
            fi ;;
          slots/*/authorizations/*)
            sid=${path#slots/}; sid=${sid%%/*}; generation=${path##*/}; generation=${generation%.json}; generation=$((10#$generation))
            jq -e --arg sid "$sid" --argjson generation "$generation" '.schema==1 and .state=="rearm-authorized" and .mode=="rearm" and .slotId==$sid and .generation==$generation and
              ((keys==["actor","approval","authorizationDigest","censusDigest","evidence","generation","mode","predecessorStateDigest","schema","slotId","state","timestamp"] and (.censusDigest|test("^[0-9a-f]{64}$"))) or
               (keys==["actor","approval","authorizationDigest","declarationDigest","evidence","generation","mode","operationId","predecessorStateDigest","schema","slotId","state","timestamp"] and (.declarationDigest|test("^[0-9a-f]{64}$")) and (.operationId|test("^[0-9a-f]{64}$")))) and
              (.authorizationDigest|test("^[0-9a-f]{64}$")) and (.predecessorStateDigest|test("^[0-9a-f]{64}$"))' >/dev/null <<<"$prepared" \
              || echo "✗ invalid rearm authorization $path"
            prior_path="slots/$sid/states/$(printf '%016d' "$((generation-1))").json"
            prior=$(git show "$tip:$prior_path" 2>/dev/null) || { echo "✗ authorization $path lacks predecessor state"; continue; }
            [ "$(git show "$tip:$prior_path" 2>/dev/null | sha256sum | awk '{print $1}')" = "$(jq -r .predecessorStateDigest <<<"$prepared")" ] \
              || echo "✗ authorization $path predecessor digest mismatch"
            [ "$(jq -r .state <<<"$prior")" = create-in-flight-or-uncertain ] || echo "✗ authorization $path has invalid predecessor state"
            if jq -e 'has("censusDigest")' >/dev/null <<<"$prepared"; then
              [ "$(jq -r .censusDigest <<<"$prior")" = "$(jq -r .censusDigest <<<"$prepared")" ] || echo "✗ authorization $path changed census"
            else
              [ "$(jq -r .declarationDigest <<<"$prior")" = "$(jq -r .declarationDigest <<<"$prepared")" ] || echo "✗ authorization $path changed declaration"
              [ "$(jq -r .operationId <<<"$prior")" = "$(jq -r .operationId <<<"$prepared")" ] || echo "✗ authorization $path changed operation"
            fi
            expected=$(_taskdag_materialise_sha256_text "$(jq -cS 'del(.authorizationDigest)' <<<"$prepared")")
            [ "$expected" = "$(jq -r .authorizationDigest <<<"$prepared")" ] || echo "✗ authorization $path digest mismatch"
            if git cat-file -e "$tip:slots/$sid/states/$(printf '%016d' "$generation").json" 2>/dev/null; then
              git show "$tip:slots/$sid/states/$(printf '%016d' "$generation").json" 2>/dev/null | jq -e --arg digest "$(jq -r .authorizationDigest <<<"$prepared")" \
                '.state=="create-in-flight-or-uncertain" and
                  ((.mode=="consume" and .authorizationDigest==$digest) or .rearmAuthorizationDigest==$digest)' >/dev/null \
                || echo "✗ authorization $path coexists with a non-consume state"
            fi ;;
          declarations/*)
            dd=${path#declarations/}; dd=${dd%.json}; body_sha=$(jq -r '.bodySha256' <<<"$prepared"); body_len=$(jq -r '.bodyLength' <<<"$prepared")
            if ! jq -e '
              def bounded($n): type=="string" and length>0 and length<=$n;
              def safe: type=="string" and (test("[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]")|not);
              .schema==1 and
              (keys-["delegationNote","slug"])==["bodyLength","bodySha256","declarationDigest","operationId","parentIssue","peerRepo","schema","slotId","sourceRepo","title"] and
              ((keys|length)==10 or (keys|length)==11 or (keys|length)==12) and
              (.sourceRepo|type=="object" and keys==["id","name"] and (.id|bounded(256) and safe) and (.name|bounded(256) and safe)) and
              (.peerRepo|type=="object" and keys==["id","name"] and (.id|bounded(256) and safe) and (.name|bounded(256) and safe)) and
              (.parentIssue|type=="object" and keys==["id","number"] and (.id|bounded(256) and safe) and (.number|type=="number" and .>0 and floor==. and .<=9007199254740991)) and
              (.title|bounded(1024) and safe) and
              (.bodySha256|test("^[0-9a-f]{64}$")) and (.bodyLength|type=="number" and .>=0 and floor==. and .<=1048576) and
              (.slotId|test("^[0-9a-f]{64}$")) and (.declarationDigest|test("^[0-9a-f]{64}$")) and (.operationId|test("^[0-9a-f]{64}$")) and
              ((has("slug")|not) or (.slug|bounded(128) and safe)) and
              ((has("delegationNote")|not) or (.delegationNote|type=="string" and length<=4096 and safe))
            ' >/dev/null <<<"$prepared"; then echo "✗ invalid declaration schema $path"; continue; fi
            git cat-file -e "$tip:bodies/$body_sha.body" 2>/dev/null || echo "✗ declaration $dd lacks body"
            [ "$(git cat-file -s "$tip:bodies/$body_sha.body" 2>/dev/null)" = "$body_len" ] || echo "✗ declaration $dd body length mismatch"
            [ "$(git show "$tip:bodies/$body_sha.body" 2>/dev/null | sha256sum | awk '{print $1}')" = "$body_sha" ] || echo "✗ declaration $dd body digest mismatch"
            jq -r '[.sourceRepo.id,.parentIssue.id,(.parentIssue.number|tostring),.peerRepo.id,(if has("slug") then "present" else "absent" end),(.slug//"")][]' <<<"$prepared" >"$work/snapshot-fields" 2>/dev/null \
              || { echo "✗ validator cannot frame stored slot identity $path"; continue; }
            mapfile -t _m_fields <"$work/snapshot-fields"
            [ "$(_taskdag_materialise_id slot "${_m_fields[@]}")" = "$(jq -r .slotId <<<"$prepared")" ] || echo "✗ declaration $dd slot ID mismatch"
            jq -r '[.sourceRepo.id,.sourceRepo.name,.parentIssue.id,(.parentIssue.number|tostring),.peerRepo.id,.peerRepo.name,.title,.bodySha256,(.bodyLength|tostring),(if has("slug") then "present" else "absent" end),(.slug//""),(if has("delegationNote") then "present" else "absent" end),(.delegationNote//"")][]' <<<"$prepared" >"$work/snapshot-fields" 2>/dev/null \
              || { echo "✗ validator cannot frame stored declaration identity $path"; continue; }
            mapfile -t _m_fields <"$work/snapshot-fields"
            [ "$(_taskdag_materialise_id declaration "${_m_fields[@]}")" = "$dd" ] && [ "$(jq -r .declarationDigest <<<"$prepared")" = "$dd" ] || echo "✗ declaration $dd digest mismatch"
            expected=$(_taskdag_materialise_id operation "$(jq -r .slotId <<<"$prepared")" "$dd")
            [ "$(jq -r .operationId <<<"$prepared")" = "$expected" ] || echo "✗ declaration $dd operation ID mismatch"
            sid=$(jq -r .slotId <<<"$prepared")
            if git cat-file -e "$tip:slots/$sid/states/0000000000000000.json" 2>/dev/null; then
              initial_state=$(git show "$tip:slots/$sid/states/0000000000000000.json" 2>/dev/null)
              [ "$(jq -r .declarationDigest <<<"$initial_state")" = "$dd" ] || echo "✗ declaration $dd lacks matching initial slot"
              if jq -e 'has("censusDigest")' >/dev/null <<<"$initial_state"; then
                git grep -q "\"$sid\"" "$tip" -- 'import-batches/*.json' 2>/dev/null || echo "✗ imported declaration $dd is not reachable from an import batch"
              else
                batch=$(jq -r '.batchId // ""' <<<"$initial_state")
                git show "$tip:batches/$batch.json" 2>/dev/null | jq -e --arg sid "$sid" --arg dd "$dd" 'any(.members[];.slotId==$sid and .declarationDigest==$dd)' >/dev/null \
                  || echo "✗ reserved declaration $dd is not reachable from its batch"
              fi
            else
              echo "✗ declaration $dd lacks matching slot initial state"
            fi ;;
          batches/*)
            if ! jq -e '
              def safe($n): type=="string" and length>0 and length<=$n and (test("[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]")|not);
              .schema==1 and keys==["activation","batchId","members","provenance","schema"] and
              (.activation|keys==["digest","epoch","guardVersion"] and (.epoch|type=="number" and floor==. and .>=1) and (.digest|test("^[0-9a-f]{64}$")) and .guardVersion==1) and (.batchId|test("^[0-9a-f]{64}$")) and
              (.members|type=="array" and length>0 and .==(.|sort_by(.slotId)) and (map(.slotId)|length==(unique|length)) and all(.[];
                type=="object" and keys==["declarationDigest","operationId","provenance","slotId"] and
                (.slotId|test("^[0-9a-f]{64}$")) and (.declarationDigest|test("^[0-9a-f]{64}$")) and (.operationId|test("^[0-9a-f]{64}$")) and
                (.provenance|type=="array" and length>0 and length<=100 and .==(.|sort|unique) and all(.[];safe(4096))))) and
              (.provenance|type=="array" and length<=100 and .==(.|sort|unique) and all(.[];safe(1024)))
            ' >/dev/null <<<"$prepared"; then echo "✗ invalid batch $path"; continue; fi
            taskdag_activation_validate_provenance "$activation_authority" "$(jq -c .activation <<<"$prepared")" \
              || echo "✗ batch $path has forged activation provenance"
            dd=${path#batches/}; dd=${dd%.json}; expected=$(_taskdag_materialise_id batch "$(jq -c .members <<<"$prepared")" "$(jq -c .provenance <<<"$prepared")" "$(jq -c .activation <<<"$prepared")")
            [ "$dd" = "$expected" ] && [ "$(jq -r .batchId <<<"$prepared")" = "$expected" ] || echo "✗ batch $dd ID mismatch"
            jq -c '.members[]' <<<"$prepared" >"$work/snapshot-members" 2>/dev/null \
              || { echo "✗ validator cannot enumerate stored batch members $path"; continue; }
            while IFS= read -r declaration_path; do
              sid=$(jq -r .slotId <<<"$declaration_path"); op=$(jq -r .operationId <<<"$declaration_path"); declaration_path=$(jq -r .declarationDigest <<<"$declaration_path")
              git cat-file -e "$tip:declarations/$declaration_path.json" 2>/dev/null || echo "✗ batch $dd lacks declaration $declaration_path"
              [ "$(git show "$tip:declarations/$declaration_path.json" 2>/dev/null | jq -r .slotId)" = "$sid" ] || echo "✗ batch $dd member slot/declaration mismatch"
              [ "$(git show "$tip:slots/$sid/states/0000000000000000.json" 2>/dev/null | jq -r .declarationDigest)" = "$declaration_path" ] || echo "✗ batch $dd declaration $declaration_path lacks matching slot state"
              [ "$(_taskdag_materialise_id operation "$sid" "$declaration_path")" = "$op" ] || echo "✗ batch $dd member operation mismatch"
            done <"$work/snapshot-members" ;;
        esac
    done <"$work/snapshot-json-paths"
    grep '^bodies/' "$work/snapshot-paths" >"$work/snapshot-body-paths" || :
    while IFS= read -r path; do
      body_sha=${path#bodies/}; body_sha=${body_sha%.body}
      [ "$(git show "$tip:$path" | sha256sum | awk '{print $1}')" = "$body_sha" ] || echo "✗ body path digest mismatch: $path"
      git show "$tip:$path" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 || echo "✗ body is not valid UTF-8: $path"
      git show "$tip:$path" | jq -Rse 'test("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]")|not' >/dev/null 2>&1 || echo "✗ body contains unsafe controls: $path"
      git grep -q "\"bodySha256\":\"$body_sha\"" "$tip" -- 'declarations/*.json' 2>/dev/null || echo "✗ unreferenced body $path"
    done <"$work/snapshot-body-paths"
    if [ -n "$parent" ]; then
      git ls-tree -r --name-only "$parent" >"$work/snapshot-parent-paths" 2>/dev/null \
        || { echo "✗ validator cannot enumerate snapshot parent paths"; return 0; }
      while IFS= read -r path; do git diff --quiet "$parent" "$tip" -- "$path" 2>/dev/null || echo "✗ append-only path changed or unreadable: $path"; done <"$work/snapshot-parent-paths"
    fi
}

# Validate every reachable generation, not merely the tip.  The first commit
# must be a root; every later commit has exactly one parent, names the previous
# generation, and only adds immutable files.
taskdag_materialisation_tree_violations() {
    local tip=$1 activation_authority=${2:-} expected_repository=${3:-} previous="" commit parents path json canonical expected_origin validation_tmp added batch_path batch_json member sid dd body_sha shallow
    if [ -z "$activation_authority" ] || ! taskdag_activation_validate_history "$activation_authority" >/dev/null; then
        echo "✗ $TASKDAG_MATERIALISATION_REF requires a valid activation authority"
        return 0
    fi
    validation_tmp=$(mktemp -d) || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot create private workspace"; return 0; }
    shallow=$(git rev-parse --is-shallow-repository 2>/dev/null) || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot inspect repository depth"; rm -rf "$validation_tmp"; return 0; }
    if [ "$shallow" = true ]; then
        echo "✗ $TASKDAG_MATERIALISATION_REF cannot be validated from a shallow repository"
        rm -rf "$validation_tmp"
        return 0
    fi
    if ! git rev-list --parents "$tip" >/dev/null 2>&1; then
        echo "✗ $TASKDAG_MATERIALISATION_REF ancestry is incomplete or unreadable"
        rm -rf "$validation_tmp"
        return 0
    fi
    git rev-list --reverse --first-parent "$tip" >"$validation_tmp/commits" 2>/dev/null \
      || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot enumerate history"; rm -rf "$validation_tmp"; return 0; }
    while IFS= read -r commit; do
        parents=$(git rev-list --parents -1 "$commit" 2>/dev/null) \
          || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot read parents for $commit"; rm -rf "$validation_tmp"; return 0; }
        if [ -z "$previous" ]; then
            [ "$(wc -w <<<"$parents")" -eq 1 ] || echo "✗ $TASKDAG_MATERIALISATION_REF initial commit is not a zero-parent root"
        else
            [ "$parents" = "$commit $previous" ] || echo "✗ $TASKDAG_MATERIALISATION_REF has malformed or non-linear ancestry at $commit"
            git ls-tree -r --name-only "$previous" >"$validation_tmp/previous-paths" 2>/dev/null \
              || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot list parent tree $previous"; rm -rf "$validation_tmp"; return 0; }
            while IFS= read -r path; do
                git diff --quiet "$previous" "$commit" -- "$path" 2>/dev/null || echo "✗ append-only path changed or unreadable: $path"
            done <"$validation_tmp/previous-paths"
        fi
        _taskdag_materialisation_snapshot_violations "$commit" "$validation_tmp" "$activation_authority" "$expected_repository"
        added="$validation_tmp/added"
        if [ -z "$previous" ]; then
            git ls-tree -r --name-only "$commit" >"$added" 2>/dev/null \
              || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot list root tree $commit"; rm -rf "$validation_tmp"; return 0; }
        else
            git diff-tree --no-commit-id --name-only --diff-filter=A -r "$previous" "$commit" >"$added" 2>/dev/null \
              || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot read generation delta $commit"; rm -rf "$validation_tmp"; return 0; }
        fi
        if grep -qE '^(censuses|import-batches)/' "$added"; then
            [ "$(grep -cE '^censuses/[0-9a-f]{64}\.json$' "$added")" -eq 1 ] \
              && [ "$(grep -cE '^import-batches/[0-9a-f]{64}\.json$' "$added")" -eq 1 ] \
              && ! grep -qEv '^(censuses/[0-9a-f]{64}\.json|import-batches/[0-9a-f]{64}\.json|bodies/[0-9a-f]{64}\.body|declarations/[0-9a-f]{64}\.json|slots/[0-9a-f]{64}/states/0000000000000000\.json)$' "$added" \
              || echo "✗ import generation $commit has an invalid delta"
        elif grep -qE '^slots/.+/(states/[0-9]{16}|authorizations/[0-9]{16})\.json$' "$added" \
          && ! grep -q '^batches/' "$added"; then
            [ "$(wc -l <"$added")" -eq 1 ] && [ "$(grep -cE '^slots/[0-9a-f]{64}/(states|authorizations)/[0-9]{16}\.json$' "$added")" -eq 1 ] \
              || echo "✗ transition generation $commit must add exactly one state or authorization"
        elif [ "$(grep -c '^batches/[0-9a-f]\{64\}\.json$' "$added")" -ne 1 ]; then
            echo "✗ $TASKDAG_MATERIALISATION_REF generation $commit must add exactly one batch"
        else
            batch_path=$(grep '^batches/' "$added")
            batch_json=$(git show "$commit:$batch_path" 2>/dev/null) \
              || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot read batch $batch_path"; rm -rf "$validation_tmp"; return 0; }
            jq -c '.members[]' <<<"$batch_json" >"$validation_tmp/members" 2>/dev/null \
              || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot enumerate batch members $batch_path"; rm -rf "$validation_tmp"; return 0; }
            grep '^declarations/' "$added" >"$validation_tmp/added-declarations" || :
            while IFS= read -r path; do
                dd=${path#declarations/}; dd=${dd%.json}
                jq -e --arg dd "$dd" 'any(.members[];.declarationDigest==$dd)' >/dev/null 2>&1 <<<"$batch_json" \
                  || echo "✗ generation $commit adds declaration $dd outside its batch"
            done <"$validation_tmp/added-declarations"
            grep '^slots/' "$added" >"$validation_tmp/added-slots" || :
            while IFS= read -r path; do
                sid=${path#slots/}; sid=${sid%%/*}
                jq -e --arg sid "$sid" 'any(.members[];.slotId==$sid)' >/dev/null 2>&1 <<<"$batch_json" \
                  || echo "✗ generation $commit adds slot $sid outside its batch"
            done <"$validation_tmp/added-slots"
            while IFS= read -r member; do
                sid=$(jq -r .slotId <<<"$member"); dd=$(jq -r .declarationDigest <<<"$member")
                if { [ -z "$previous" ] || ! git cat-file -e "$previous:declarations/$dd.json" 2>/dev/null; } \
                  && ! grep -qx "declarations/$dd.json" "$added"; then
                    echo "✗ generation $commit batch member $dd lacks an atomic declaration"
                fi
                if { [ -z "$previous" ] || ! git cat-file -e "$previous:slots/$sid/states/0000000000000000.json" 2>/dev/null; } \
                  && ! grep -qx "slots/$sid/states/0000000000000000.json" "$added"; then
                    echo "✗ generation $commit batch member $sid lacks an atomic slot"
                fi
            done <"$validation_tmp/members"
            grep '^bodies/' "$added" >"$validation_tmp/added-bodies" || :
            while IFS= read -r path; do
                body_sha=${path#bodies/}; body_sha=${body_sha%.body}
                while IFS= read -r member; do
                    dd=$(jq -r .declarationDigest <<<"$member")
                    [ "$(git show "$commit:declarations/$dd.json" 2>/dev/null | jq -r .bodySha256)" != "$body_sha" ] || continue 2
                done <"$validation_tmp/members"
                echo "✗ generation $commit adds body $body_sha outside its batch"
            done <"$validation_tmp/added-bodies"
        fi
        expected_origin=${previous:-null}
        if [ -z "$previous" ]; then
            git ls-tree -r --name-only "$commit" 'slots/*/states/0000000000000000.json' >"$validation_tmp/new-slots" 2>/dev/null \
              || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot list root slots"; rm -rf "$validation_tmp"; return 0; }
        else
            git diff-tree --no-commit-id --name-only --diff-filter=A -r "$previous" "$commit" -- 'slots/*/states/0000000000000000.json' >"$validation_tmp/new-slots" 2>/dev/null \
              || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot list new slots"; rm -rf "$validation_tmp"; return 0; }
        fi
        while IFS= read -r path; do
            [ -n "$path" ] || continue
            if [ "$expected_origin" = null ]; then
                git show "$commit:$path" | jq -e '.originReadback.materialisationTip==null' >/dev/null 2>&1 \
                  || echo "✗ initial slot $path has non-null origin readback"
            else
                git show "$commit:$path" | jq -e --arg old "$expected_origin" '.originReadback.materialisationTip==$old' >/dev/null 2>&1 \
                  || echo "✗ slot $path origin readback does not name its parent authority tip"
            fi
        done <"$validation_tmp/new-slots"
        git ls-tree -r --name-only "$commit" >"$validation_tmp/all-paths" 2>/dev/null \
          || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot list canonical paths"; rm -rf "$validation_tmp"; return 0; }
        while IFS= read -r path; do
            case "$path" in *.json)
                json="$validation_tmp/object.json"; canonical="$validation_tmp/canonical.json"
                git show "$commit:$path" >"$json" 2>/dev/null \
                  || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot read JSON $path"; rm -rf "$validation_tmp"; return 0; }
                jq -cS . "$json" >"$canonical" 2>/dev/null \
                  || { echo "✗ invalid JSON at $path"; continue; }
                cmp -s "$json" "$canonical" || echo "✗ non-canonical JSON at $path"
                ;;
            esac
        done <"$validation_tmp/all-paths"
        previous=$commit
    done <"$validation_tmp/commits"
    rm -rf "$validation_tmp"
}

# Online callers must acquire every immutable authority needed by the pure
# validator before deciding from a freshly fetched materialisation tip.
taskdag_materialisation_online_tree_violations() { # tip activation-authority expected-repository
    if git grep -q '"providerReceipt":' "$1" -- 'slots/*/states/*.json' 2>/dev/null; then
        if ! declare -F taskdag_materialise_fetch_producer_if_required >/dev/null \
          || ! taskdag_materialise_fetch_producer_if_required "$1"; then
            echo "✗ $TASKDAG_MATERIALISATION_REF cannot acquire producer authority"
            return 0
        fi
    fi
    taskdag_materialisation_tree_violations "$@"
}

# Private seam: tests source this module and call the core.  No CLI path tests
# an environment variable, so exported state cannot bypass migration drain.
taskdag_materialise_reserve_core() {
    local spec=$1 prepared batch_json batch_id actor timestamp old="" tmp index tree commit remote now slot dd op body_sha declaration state activation activation_provenance expected_repository
    activation=$(taskdag_activation_snapshot_token) || return 3
    expected_repository=$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]') || return 3
    [ -n "$expected_repository" ] || return 3
    prepared=$(taskdag_materialise_prepare "$spec") || return $?
    batch_json=$(_taskdag_materialise_batch_json "$prepared" "$activation") || return 2; batch_id=$(jq -r .batchId <<<"$batch_json")
    activation_provenance=$(jq -c '{epoch,digest,guardVersion}' <<<"$activation") || return 2
    actor=$(jq -r .actor <<<"$prepared"); timestamp=$(jq -r .authoritativeTimestamp <<<"$prepared")
    for _ in 1 2 3 4 5; do
      remote=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF") || return 2; old=${remote%%[[:space:]]*}; [ "$remote" != "$old" ] || old=""
      [ -z "$old" ] || { git fetch -q --no-tags origin "$TASKDAG_MATERIALISATION_REF" || return 2; old=$(git rev-parse FETCH_HEAD); [ -z "$(taskdag_materialisation_online_tree_violations "$old" "$(jq -r .authorityTip <<<"$activation")" "$expected_repository")" ] || return 3; }
      while IFS= read -r slot; do
        dd=$(jq -r --arg s "$slot" '.declarations[]|select(.slotId==$s)|.declarationDigest' <<<"$prepared")
        if [ -n "$old" ] && git cat-file -e "$old:slots/$slot/states/0000000000000000.json" 2>/dev/null; then
          [ "$(git show "$old:slots/$slot/states/0000000000000000.json" | jq -r .declarationDigest)" = "$dd" ] || return 3
        fi
      done < <(jq -r '.declarations[].slotId' <<<"$prepared")
      tmp=$(mktemp -d); index="$tmp/index"; GIT_INDEX_FILE="$index" git read-tree "${old:-$(git mktree </dev/null)}"
      while IFS= read -r declaration; do
        slot=$(jq -r .slotId <<<"$declaration"); dd=$(jq -r .declarationDigest <<<"$declaration"); op=$(jq -r .operationId <<<"$declaration"); body_sha=$(jq -r .bodySha256 <<<"$declaration")
        [ -n "$old" ] && git cat-file -e "$old:slots/$slot/states/0000000000000000.json" 2>/dev/null && continue
        mkdir -p "$tmp/bodies" "$tmp/declarations" "$tmp/slots/$slot/states"
        jq -rj .body <<<"$declaration" >"$tmp/bodies/$body_sha.body"
        jq -cS 'del(.body,.memberProvenance)' <<<"$declaration" >"$tmp/declarations/$dd.json"
        state=$(jq -ncS --arg slotId "$slot" --arg declarationDigest "$dd" --arg operationId "$op" --arg batchId "$batch_id" --arg actor "$actor" --arg authoritativeTimestamp "$timestamp" --arg tip "$old" --arg authorityTip "$(jq -r .authorityTip <<<"$activation")" --argjson activation "$activation_provenance" '{schema:1,state:"batch-reserved-before-create",slotId:$slotId,declarationDigest:$declarationDigest,operationId:$operationId,batchId:$batchId,generation:0,fence:1,activation:$activation,actor:$actor,authoritativeTimestamp:$authoritativeTimestamp,predecessorStateDigest:null,originReadback:{activationAuthorityTip:$authorityTip,materialisationTip:(if $tip=="" then null else $tip end)}}')
        printf '%s\n' "$state" >"$tmp/slots/$slot/states/0000000000000000.json"
        GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/bodies/$body_sha.body"),bodies/$body_sha.body"
        GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/declarations/$dd.json"),declarations/$dd.json"
        GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/slots/$slot/states/0000000000000000.json"),slots/$slot/states/0000000000000000.json"
      done < <(jq -c '.declarations[]' <<<"$prepared")
      mkdir -p "$tmp/batches"; printf '%s\n' "$batch_json" >"$tmp/batches/$batch_id.json"
      GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/batches/$batch_id.json"),batches/$batch_id.json"
      if [ "${TASKDAG_MATERIALISE_TEST_CORRUPT_CANDIDATE:-0}" = 1 ]; then
        GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(printf 'corrupt\n' | git hash-object -w --stdin),unexpected/path"
      fi
      tree=$(GIT_INDEX_FILE="$index" git write-tree); rm -rf "$tmp"
      if [ -n "$old" ] && [ "$tree" = "$(git rev-parse "$old^{tree}")" ]; then printf '%s\n' "$batch_json"; return 0; fi
      if [ -n "$old" ]; then commit=$(printf 'Reserve materialisation batch %s\n' "${batch_id:0:12}" | git commit-tree "$tree" -p "$old"); else commit=$(printf 'Reserve materialisation batch %s\n' "${batch_id:0:12}" | git commit-tree "$tree"); fi
      [ -z "$(taskdag_materialisation_online_tree_violations "$commit" "$(jq -r .authorityTip <<<"$activation")" "$expected_repository")" ] || return 3
      if [ "${TASKDAG_MATERIALISE_TEST_CRASH_BEFORE_CAS:-0}" = 1 ]; then return 86; fi
      if taskdag_activation_fenced_push "$activation" materialisation reserve-batch "$actor" "$timestamp" "$TASKDAG_MATERIALISATION_REF" "$old" "$commit"; then
        # Deterministic fixture seam for a transport that reports failure after
        # the server accepted the CAS.  The next iteration must prove the
        # complete durable request from origin rather than write or POST again.
        if [ "${TASKDAG_MATERIALISE_TEST_AMBIGUOUS_SUCCESS:-0}" = 1 ]; then continue; fi
        now=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk '{print $1}'); git fetch -q --no-tags origin "$TASKDAG_MATERIALISATION_REF" || return 2; now=$(git rev-parse FETCH_HEAD)
        [ -z "$(taskdag_materialisation_online_tree_violations "$now" "$(jq -r .authorityTip <<<"$activation")" "$expected_repository")" ] || return 3
        [ "$(git show "$now:batches/$batch_id.json" 2>/dev/null)" = "$batch_json" ] || return 3
        while IFS= read -r declaration; do
          slot=$(jq -r .slotId <<<"$declaration"); dd=$(jq -r .declarationDigest <<<"$declaration"); body_sha=$(jq -r .bodySha256 <<<"$declaration")
          [ "$(git show "$now:slots/$slot/states/0000000000000000.json" | jq -r .declarationDigest)" = "$dd" ] || return 3
          git show "$now:declarations/$dd.json" | cmp - <(jq -cS 'del(.body,.memberProvenance)' <<<"$declaration") || return 3
          [ "$(git show "$now:bodies/$body_sha.body" | sha256sum | awk '{print $1}')" = "$body_sha" ] || return 3
        done < <(jq -c '.declarations[]' <<<"$prepared")
        printf '%s\n' "$batch_json"; return 0
      fi
    done
    return 3
}

cmd_materialise_batch() {
    local spec=""
    case "${1:-}" in -h|--help) echo "Usage: task-dag materialise-batch --spec-file FILE"; return 0;; esac
    [ "$#" -eq 2 ] && [ "$1" = --spec-file ] && spec=$2 || { echo "Usage: task-dag materialise-batch --spec-file FILE" >&2; return 2; }
    taskdag_materialise_prepare "$spec" >/dev/null || return $?
    taskdag_migration_guard materialise
}

cmd_materialise_child() {
    local spec="" prepared
    case "${1:-}" in -h|--help) echo "Usage: task-dag materialise-child --spec-file FILE"; return 0;; esac
    [ "$#" -eq 2 ] && [ "$1" = --spec-file ] && spec=$2 || { echo "Usage: task-dag materialise-child --spec-file FILE" >&2; return 2; }
    prepared=$(taskdag_materialise_prepare "$spec") || return $?
    [ "$(jq -r .inputDeclarationCount <<<"$prepared")" -eq 1 ] || { _taskdag_materialise_error "materialise-child requires exactly one declaration"; return 2; }
    taskdag_migration_guard materialise
}

# Offline migration input deliberately names every frozen repository and issue
# page.  Census never discovers peers or contacts GitHub, which makes review
# bytes reproducible and makes an omitted/inaccessible peer a hard failure.
_taskdag_delegated_close_message() { # evidence-json
    local evidence=$1
    jq -r '"Record delegated close\n\nTask-Dag-Delegated-Close: v1\nParent-Repo: \(.parentRepo)\nParent-Issue: #\(.parentIssue)\nPeer-Repo: \(.peerRepo)\nPeer-Issue: #\(.peerIssue)\nParent-Repo-Node-Id: \(.parentRepoNodeId)\nParent-Issue-Node-Id: \(.parentIssueNodeId)\nPeer-Repo-Node-Id: \(.peerRepoNodeId)\nPeer-Issue-Node-Id: \(.peerIssueNodeId)\nMaterialisation-Operation-Id: \(.materialisationOperationId)\nDeclaration-Digest: \(.declarationDigest)\nPeer-Tip: \(.peerTip)\nPeer-Close: \(.peerClose)\nPeer-Epic: \(.peerEpic)"' <<<"$evidence"
}

_taskdag_import_commit_tree() {
    GIT_AUTHOR_NAME=task-dag GIT_AUTHOR_EMAIL=task-dag@invalid \
    GIT_COMMITTER_NAME=task-dag GIT_COMMITTER_EMAIL=task-dag@invalid \
    GIT_AUTHOR_DATE='Thu, 01 Jan 1970 00:00:00 +0000' \
    GIT_COMMITTER_DATE='Thu, 01 Jan 1970 00:00:00 +0000' git commit-tree "$@"
}

_taskdag_snapshot_regular_file() { # source destination
    local source=$1 destination=$2 fd
    [ -f "$source" ] && [ ! -L "$source" ] || return 1
    exec {fd}<"$source" || return 1
    [ "$(realpath -e "/proc/self/fd/$fd" 2>/dev/null)" = "$(realpath -e "$source" 2>/dev/null)" ] \
      || { exec {fd}<&-; return 1; }
    cat <&$fd >"$destination" || { exec {fd}<&-; return 1; }
    exec {fd}<&-
}

_taskdag_verify_delegated_close_evidence() { # spec evidence-json [create-in-current-repo]
    local spec=$1 evidence=$2 create_here=${3:-false} parent_path peer_path delegation candidate empty parent_git_dir
    parent_path=$(jq -r --arg r "$(jq -r .parentRepo <<<"$evidence")" '.repositories[]|select(.repository==$r)|.path' "$spec")
    peer_path=$(jq -r --arg r "$(jq -r .peerRepo <<<"$evidence")" '.repositories[]|select(.repository==$r)|.path' "$spec")
    [ -n "$parent_path" ] && [ -n "$peer_path" ] || return 3
    delegation=$(jq -r .delegationCommit <<<"$evidence")
    [ "$delegation" = "$(jq -r .oid <<<"$evidence")" ] || return 3
    parent_git_dir=$(git -C "$parent_path" rev-parse --absolute-git-dir) || return 3
    GIT_DIR="$parent_git_dir" _xrepo_validate_delegation "$delegation" \
      "$(jq -r .parentRepo <<<"$evidence")" "$(jq -r .parentIssue <<<"$evidence")" \
      "$(jq -r .peerRepo <<<"$evidence")" "$(jq -r .peerIssue <<<"$evidence")" || return 3
    for pair in \
      "Parent-Repo-Node-Id:parentRepoNodeId" "Parent-Issue-Node-Id:parentIssueNodeId" \
      "Peer-Repo-Node-Id:peerRepoNodeId" "Peer-Issue-Node-Id:peerIssueNodeId" \
      "Materialisation-Operation-Id:materialisationOperationId" "Declaration-Digest:declarationDigest"; do
      [ "$(GIT_DIR="$parent_git_dir" _xrepo_exact_trailer "$delegation" "${pair%%:*}")" = "$(jq -r ".${pair#*:}" <<<"$evidence")" ] || return 3
    done
    if [ "$create_here" = true ]; then
      git fetch -q --no-tags "$parent_path" "$delegation" || return 3
      empty=$(_xrepo_empty_tree) || return 3
      candidate=$(_taskdag_delegated_close_message "$evidence" | _taskdag_import_commit_tree "$empty" -p "$delegation") || return 3
    else
      empty=$(GIT_DIR="$parent_git_dir" _xrepo_empty_tree) || return 3
      candidate=$(_taskdag_delegated_close_message "$evidence" | GIT_DIR="$parent_git_dir" _taskdag_import_commit_tree "$empty" -p "$delegation") || return 3
    fi
    (
      # shellcheck disable=SC2329 # invoked indirectly by strict validator
      taskdag_peer_worktree_for() { printf '%s\n' "$peer_path"; }
      export -f taskdag_peer_worktree_for
      if [ "$create_here" = true ]; then
        _xrepo_validate_delegated_close_v1 "$candidate" "$delegation" \
          "$(jq -r .parentRepo <<<"$evidence")" "$(jq -r .parentIssue <<<"$evidence")" \
          "$(jq -r .peerRepo <<<"$evidence")" "$(jq -r .peerIssue <<<"$evidence")"
      else
        GIT_DIR="$parent_git_dir" _xrepo_validate_delegated_close_v1 "$candidate" "$delegation" \
          "$(jq -r .parentRepo <<<"$evidence")" "$(jq -r .parentIssue <<<"$evidence")" \
          "$(jq -r .peerRepo <<<"$evidence")" "$(jq -r .peerIssue <<<"$evidence")"
      fi
    ) || return 3
    printf '%s\n' "$candidate"
}

# Copy every mutable census input and repository ref namespace before parsing
# any of it.  Repositories are cloned into private bare snapshots so both HEAD
# and the relevant ref manifest come from one filesystem view.
_taskdag_census_snapshot() { # source-spec workspace; prints snapped spec path
    local source=$1 work=$2 fd snap base activation file repo path clone source_ref expected actual_repo n=0
    umask 077
    mkdir -p "$work" && chmod 700 "$work" || return 2
    [ -f "$source" ] && [ ! -L "$source" ] || return 2
    exec {fd}<"$source" || return 2
    [ "$(realpath -e "/proc/self/fd/$fd")" = "$(realpath -e "$source")" ] || { exec {fd}<&-; return 2; }
    snap="$work/spec.source"; cat <&$fd >"$snap" || { exec {fd}<&-; return 2; }; exec {fd}<&-
    _taskdag_materialise_no_duplicate_keys "$snap" || return 2
    base=$(dirname "$(realpath -e "$source")")
    activation=$(jq -r .activationRecord "$snap") || return 2
    [[ "$activation" = /* ]] || activation="$base/$activation"
    [ -f "$activation" ] && [ ! -L "$activation" ] || return 2
    exec {fd}<"$activation" || return 2
    [ "$(realpath -e "/proc/self/fd/$fd")" = "$(realpath -e "$activation")" ] || { exec {fd}<&-; return 2; }
    cat <&$fd >"$work/activation.json" || { exec {fd}<&-; return 2; }; exec {fd}<&-
    jq --arg p "$work/activation.json" '.activationRecord=$p' "$snap" >"$work/spec.1" || return 2
    mv "$work/spec.1" "$snap"
    while IFS=$'\t' read -r repo path; do
      [[ "$path" = /* ]] || path="$base/$path"
      [ -d "$path" ] && [ ! -L "$path" ] || return 3
      actual_repo=$(cd "$path" && _xrepo_current_repo_offline 2>/dev/null | tr '[:upper:]' '[:lower:]') || return 3
      [ "$actual_repo" = "$repo" ] || return 3
      source_ref=$(jq -r --arg r "$repo" '.sourceTips[]|select(.repository==$r)|.ref' "$work/activation.json")
      expected=$(jq -r --arg r "$repo" '.sourceTips[]|select(.repository==$r)|.commit' "$work/activation.json")
      [ -n "$source_ref" ] && [ "$(git -C "$path" rev-parse "$source_ref^{commit}" 2>/dev/null)" = "$expected" ] || return 3
      clone="$work/repo.$n.git"; git clone -q --bare --no-local "$path" "$clone" || return 3
      git -C "$clone" config taskdag.snapshot-repository "$repo"
      [ "$(git -C "$clone" rev-parse "$source_ref^{commit}" 2>/dev/null)" = "$expected" ] || return 3
      jq --arg r "$repo" --arg p "$clone" '(.repositories[]|select(.repository==$r).path)=$p' "$snap" >"$work/spec.1" || return 2
      mv "$work/spec.1" "$snap"; n=$((n+1))
    done < <(jq -r '.repositories[]|[.repository,.path]|@tsv' "$snap")
    n=0
    while IFS=$'\t' read -r repo page file; do
      [[ "$file" = /* ]] || file="$base/$file"
      [ -f "$file" ] && [ ! -L "$file" ] || return 3
      exec {fd}<"$file" || return 3
      [ "$(realpath -e "/proc/self/fd/$fd")" = "$(realpath -e "$file")" ] || { exec {fd}<&-; return 3; }
      cat <&$fd >"$work/page.$n.json" || { exec {fd}<&-; return 3; }; exec {fd}<&-
      jq --arg r "$repo" --argjson pg "$page" --arg p "$work/page.$n.json" '(.issuePages[]|select(.repository==$r and .page==$pg).file)=$p' "$snap" >"$work/spec.1" || return 2
      mv "$work/spec.1" "$snap"; n=$((n+1))
    done < <(jq -r '.issuePages[]|[.repository,(.page|tostring),.file]|@tsv' "$snap")
    printf '%s\n' "$snap"
}

_taskdag_census_build() { # spec output
    local spec=$1 out=$2 activation repos pages repo path expected actual tmp evidence registry_id parent_repo parent_issue ref peer_repo peer_issue delegation_ref completion_identity delegation_identity commit groups group title body_file slug note slug_present note_present body_path body_len body_sha
    _taskdag_materialise_no_duplicate_keys "$spec" || return 2
    jq -e 'type=="object" and keys==["activationRecord","issuePages","repositories","schema"] and .schema==1 and
      (.activationRecord|type=="string" and length>0) and
      (.repositories|type=="array" and .==sort_by(.repository) and (map(.repository)|length==(unique|length)) and all(.[];type=="object" and keys==["path","repository","tip"] and (.path|type=="string" and length>0) and (.repository|type=="string") and (.tip|test("^[0-9a-f]{40}$")))) and
      (.issuePages|type=="array" and .==sort_by(.repository,.page) and all(.[];type=="object" and keys==["file","hasNextPage","page","repository"] and (.page|type=="number" and floor==. and .>=1) and (.hasNextPage|type=="boolean") and (.file|type=="string" and length>0)))' "$spec" >/dev/null || return 2
    activation=$(jq -r .activationRecord "$spec"); [ -f "$activation" ] && _taskdag_materialise_no_duplicate_keys "$activation" || return 2
    jq -e '.schema==1 and (.sourceTips|type=="array") and (.registrySnapshot.repositories|type=="array")' "$activation" >/dev/null || return 2
    repos=$(jq -c '.repositories|map({repository,tip})' "$spec"); [ "$repos" = "$(jq -c '.sourceTips|map({repository,tip:.commit})' "$activation")" ] || return 3
    [ "$(jq -c '.repositories|map(.repository)' "$spec")" = "$(jq -c '.registrySnapshot.repositories|map(.repository)' "$activation")" ] || return 3
    tmp=$(mktemp -d) || return 2
    : >"$tmp/refs"; : >"$tmp/issues"; : >"$tmp/historical-declarations"
    while IFS=$'\t' read -r repo path expected; do
      [ -d "$path" ] && _taskdag_activation_full_checkout "$path" || return 3
      actual=$(git -C "$path" rev-parse HEAD 2>/dev/null) || return 3; [ "$actual" = "$expected" ] || return 3
      git -C "$path" for-each-ref --format='%(refname)%09%(objectname)' refs/heads/tasks refs/heads/gh | jq -Rn --arg repo "$repo" '[inputs|split("\t")|{repository:$repo,ref:.[0],oid:.[1]}][]' >>"$tmp/refs" || return 3
      while IFS= read -r commit; do
        [ -n "$commit" ] || continue
        groups=$(git -C "$path" log -1 --format='%B' "$commit" | taskdag_materialise_groups_json_from_message) || return 3
        while IFS= read -r group; do
          [ -n "$group" ] || continue
          parent_issue=$(taskdag_materialise_parent_number "$(jq -r .parent <<<"$group")") || return 3
          peer_repo=$(jq -r .peer <<<"$group"); title=$(jq -r .title <<<"$group"); body_file=$(jq -r .bodyFile <<<"$group")
          slug=$(jq -r .slug <<<"$group"); note=$(jq -r .note <<<"$group"); slug_present=$(jq -r .slugPresent <<<"$group"); note_present=$(jq -r .notePresent <<<"$group")
          [[ "$peer_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] && [ -n "$title" ] && [ -n "$body_file" ] || return 3
          [[ "$body_file" != /* && "$body_file" != *$'\n'* && ! "$body_file" =~ (^|/)\.\.?(/|$) ]] || return 3
          [ "$slug_present" = false ] || [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || return 3
          body_path="$tmp/historical-body-$commit-$(wc -l <"$tmp/historical-declarations")"
          git -C "$path" cat-file blob "$commit:$body_file" >"$body_path" 2>/dev/null || return 3
          body_len=$(wc -c <"$body_path"); [ "$body_len" -le "$TASKDAG_MATERIALISATION_MAX_BODY" ] || return 3
          body_sha=$(_taskdag_materialise_sha256_file "$body_path") || return 3
          jq -ncS --arg repository "$repo" --argjson parentIssue "$parent_issue" --arg peerRepo "$peer_repo" --arg title "$title" \
            --arg bodySha256 "$body_sha" --argjson bodyLength "$body_len" --arg slug "$slug" --arg note "$note" --argjson slugPresent "$slug_present" --argjson notePresent "$note_present" \
            '{repository:$repository,parentIssue:$parentIssue,peerRepo:$peerRepo,title:$title,bodySha256:$bodySha256,bodyLength:$bodyLength}
             + (if $slugPresent then {slug:$slug} else {} end)
             + (if $notePresent then {delegationNote:$note} else {} end)' >>"$tmp/historical-declarations" || return 3
          rm -f "$body_path"
        done < <(jq -c '.[]' <<<"$groups")
      done < <(git -C "$path" rev-list --reverse "$expected")
    done < <(jq -r '.repositories[]|[.repository,.path,.tip]|@tsv' "$spec")
    while IFS=$'\t' read -r repo page has file; do
      [ -f "$file" ] && _taskdag_materialise_no_duplicate_keys "$file" || return 3
      jq -e --arg repo "$repo" 'type=="object" and keys==["issues","schema"] and .schema==1 and (.issues|type=="array" and all(.[];
        type=="object" and keys==["body","completionEvidence","createdAt","creator","declarations","id","liveDelegations","markers","number","repositoryId","state","title"] and
        (.id|type=="string" and length>0) and (.repositoryId|type=="string" and length>0) and (.number|type=="number" and floor==. and .>0) and
        (.state=="OPEN" or .state=="CLOSED") and (.body|type=="string") and (.title|type=="string" and length>0) and
        (.creator|type=="string" and length>0) and (.createdAt|fromdateiso8601|todateiso8601)==.createdAt and
        (.markers|type=="array" and .==sort_by(.ref) and all(.[];keys==["oid","ref"] and (.oid|test("^[0-9a-f]{40}$")))) and
        (.liveDelegations|type=="array" and .==sort_by(.ref) and all(.[];
          if .disposition=="verified-child-close" then
            keys==["declarationDigest","delegationCommit","disposition","materialisationOperationId","oid","parentIssue","parentIssueNodeId","parentRepo","parentRepoNodeId","peerClose","peerEpic","peerIssue","peerIssueNodeId","peerRepo","peerRepoNodeId","peerTip","ref"] and
            (.oid|test("^[0-9a-f]{40}$")) and (.delegationCommit==.oid) and (.declarationDigest|test("^[0-9a-f]{64}$")) and
            (.materialisationOperationId|type=="string" and length>0) and
            (.parentIssue|type=="number" and floor==. and .>0) and (.peerIssue|type=="number" and floor==. and .>0) and
            all(.parentRepo,.peerRepo,.parentRepoNodeId,.parentIssueNodeId,.peerRepoNodeId,.peerIssueNodeId;type=="string" and length>0) and
            all(.peerTip,.peerClose,.peerEpic;test("^[0-9a-f]{40}$"))
          else keys==["disposition","oid","parentIssue","parentRepo","peerIssue","peerRepo","ref"] and (.oid|test("^[0-9a-f]{40}$")) and
            (.parentIssue|type=="number" and floor==. and .>0) and (.peerIssue|type=="number" and floor==. and .>0) and
            all(.parentRepo,.peerRepo;type=="string" and length>0) and (.disposition=="live-obligation" or .disposition=="blocked-repair") end)) and
        (.completionEvidence|type=="array" and .==sort_by(.ref) and all(.[];
          if .disposition=="verified-child-close" then keys==["delegationRef","disposition","oid","ref"] and (.delegationRef|type=="string" and length>0)
          else keys==["disposition","oid","ref"] and (.disposition=="partial-implementation" or .disposition=="malformed-evidence") end and
          (.oid|test("^[0-9a-f]{40}$")))) and
        (.declarations|type=="array" and .==sort_by(.slotId) and all(.[];
          (keys-["adoptedIssue","delegationNote","slug"])==["body","bodyLength","bodySha256","declarationDigest","disposition","operationId","parentIssue","peerRepo","schema","slotId","sourceRepo","title"] and
          .schema==1 and (.body|type=="string") and (.bodySha256|test("^[0-9a-f]{64}$")) and (.bodyLength|type=="number" and floor==. and .>=0) and
          (.slotId|test("^[0-9a-f]{64}$")) and (.declarationDigest|test("^[0-9a-f]{64}$")) and (.operationId|test("^[0-9a-f]{64}$")) and
          (.sourceRepo|keys==["id","name"]) and (.peerRepo|keys==["id","name"]) and (.parentIssue|keys==["id","number"]) and
          (if .disposition=="issue-adopted" then
             (.adoptedIssue|keys==["issueNodeId","number","repositoryId"] and (.issueNodeId|type=="string" and length>0) and (.repositoryId|type=="string" and length>0) and (.number|type=="number" and floor==. and .>0))
           else (.disposition=="create-in-flight-or-uncertain" or .disposition=="blocked-repair") and (has("adoptedIssue")|not) end)))))' "$file" >/dev/null || return 3
      jq -c --arg repo "$repo" '.issues[]+{repository:$repo}' "$file" >>"$tmp/issues"
      if [ "$has" = false ]; then [ "$(jq --arg r "$repo" '[.issuePages[]|select(.repository==$r)]|length' "$spec")" = "$page" ] || return 3; else [ "$(jq --arg r "$repo" --argjson p "$((page+1))" '[.issuePages[]|select(.repository==$r and .page==$p)]|length' "$spec")" = 1 ] || return 3; fi
    done < <(jq -r '.issuePages[]|[.repository,(.page|tostring),(.hasNextPage|tostring),.file]|@tsv' "$spec")
    pages=$(jq -c '[.issuePages[].repository]|sort|unique' "$spec"); [ "$pages" = "$(jq -c '[.repositories[].repository]|sort|unique' "$spec")" ] || return 3
    while IFS=$'\t' read -r repo registry_id; do
      jq -e --arg repo "$repo" --arg id "$registry_id" '
        all(.[] | select(.repository==$repo); . as $issue |
          $issue.repositoryId==$id and
          all($issue.declarations[]?;.sourceRepo.id==$id and .sourceRepo.name==$repo and .parentIssue.id==$issue.id and .parentIssue.number==$issue.number) and
          all($issue.liveDelegations[]?;.parentRepo==$repo and .parentIssue==$issue.number and
            (if .disposition=="verified-child-close" then .parentRepoNodeId==$id and .parentIssueNodeId==$issue.id else true end)))' --slurp "$tmp/issues" >/dev/null || return 3
    done < <(jq -r '.registrySnapshot.repositories[]|[.repository,.repositoryId]|@tsv' "$activation")
    # Every parsed peer, including a non-verified obligation, is registry-known.
    jq -se --argjson registry "$(jq -c '.registrySnapshot.repositories' "$activation")" '
      all(.[];
        all(.declarations[]?; .peerRepo as $peer | any($registry[];.repositoryId==$peer.id and .repository==$peer.name) and
          (if .disposition=="issue-adopted" then .adoptedIssue.repositoryId==$peer.id else true end)) and
        all(.liveDelegations[]?; . as $delegation | $delegation.peerRepo as $peer | any($registry[];.repository==$peer and
          (if $delegation.disposition=="verified-child-close" then .repositoryId==$delegation.peerRepoNodeId else true end))))' "$tmp/issues" >/dev/null || return 3
    jq -se '(group_by(.id)|all(.[];length==1)) and (group_by([.repository,.number])|all(.[];length==1)) and
      ([.[].declarations[]?.slotId]|length==(unique|length)) and
      ([.[].declarations[]?|select(.disposition=="issue-adopted")|.adoptedIssue.issueNodeId]|length==(unique|length))' "$tmp/issues" >/dev/null || return 3
    # Caller classification may add disposition/adoption evidence, but it may
    # neither omit nor invent a legacy declaration. Reconstruct every trailer
    # from the complete frozen source history with the canonical parser and
    # bind its declaring commit's exact body bytes to the classified input.
    jq -sS '[.[] as $issue | $issue.declarations[] | {repository:$issue.repository,parentIssue:.parentIssue.number,peerRepo:.peerRepo.name,title,bodySha256,bodyLength}
      + (if has("slug") then {slug} else {} end)
      + (if has("delegationNote") then {delegationNote} else {} end)]
      | sort_by(.repository,.parentIssue,.peerRepo,(.slug//""),.title,.bodySha256,.bodyLength,(.delegationNote//""))' "$tmp/issues" >"$tmp/classified-declarations" || return 3
    jq -sS 'sort_by(.repository,.parentIssue,.peerRepo,(.slug//""),.title,.bodySha256,.bodyLength,(.delegationNote//""))' "$tmp/historical-declarations" >"$tmp/reconstructed-declarations" || return 3
    cmp -s "$tmp/classified-declarations" "$tmp/reconstructed-declarations" || {
      echo "Error: classified declarations do not exhaust frozen historical declarations" >&2
      diff -u "$tmp/reconstructed-declarations" "$tmp/classified-declarations" >&2 || true
      return 3
    }
    # Adopted issues must be exact members of the fully paginated peer issue set.
    jq -se '. as $issues | all(.[];.declarations[]? as $d |
      if $d.disposition=="issue-adopted" then any($issues[];.repository==$d.peerRepo.name and .id==$d.adoptedIssue.issueNodeId and .repositoryId==$d.adoptedIssue.repositoryId and .number==$d.adoptedIssue.number)
      else true end)' "$tmp/issues" >/dev/null || return 3
    # Ref paths are semantic identity, not opaque evidence labels. Bind every
    # path to its containing parent issue and registry-known peer.
    while IFS=$'\t' read -r parent_repo parent_issue evidence; do
      ref=$(jq -r .ref <<<"$evidence"); peer_repo=$(jq -r .peerRepo <<<"$evidence"); peer_issue=$(jq -r .peerIssue <<<"$evidence")
      [ "$ref" = "refs/heads/tasks/delegated/$parent_issue/$peer_repo/$peer_issue" ] \
        && [ "$(jq -r .parentRepo <<<"$evidence")" = "$parent_repo" ] || return 3
    done < <(jq -r '. as $issue|.liveDelegations[]?|[$issue.repository,($issue.number|tostring),(.|tojson)]|@tsv' "$tmp/issues")
    while IFS=$'\t' read -r parent_issue ref; do
      [[ "$ref" =~ ^refs/heads/tasks/completions/${parent_issue}/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[1-9][0-9]*/[A-Za-z0-9._-]+$ ]] || return 3
      peer_repo=${ref#refs/heads/tasks/completions/$parent_issue/}; peer_repo=${peer_repo%/*/*}
      jq -e --arg peer "$peer_repo" 'any(.registrySnapshot.repositories[];.repository==$peer)' "$activation" >/dev/null || return 3
    done < <(jq -r '. as $issue|.completionEvidence[]?|[($issue.number|tostring),.ref]|@tsv' "$tmp/issues")
    while IFS=$'\t' read -r ref delegation_ref; do
      completion_identity=${ref#refs/heads/tasks/completions/}; completion_identity=${completion_identity%/*}
      delegation_identity=${delegation_ref#refs/heads/tasks/delegated/}
      [ "$completion_identity" = "$delegation_identity" ] || return 3
    done < <(jq -r '.completionEvidence[]?|select(.disposition=="verified-child-close")|[.ref,.delegationRef]|@tsv' "$tmp/issues")
    while IFS=$'\t' read -r parent_issue ref; do
      [[ "$ref" =~ ^refs/heads/gh/child-epics/${parent_issue}/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ \
         || "$ref" =~ ^refs/heads/gh/child-epic-slots/${parent_issue}/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || return 3
      peer_repo=${ref#refs/heads/gh/child-epics/$parent_issue/}
      [ "$peer_repo" != "$ref" ] || { peer_repo=${ref#refs/heads/gh/child-epic-slots/$parent_issue/}; peer_repo=${peer_repo%/*}; }
      jq -e --arg peer "$peer_repo" 'any(.registrySnapshot.repositories[];.repository==$peer)' "$activation" >/dev/null || return 3
    done < <(jq -r '. as $issue|.markers[]?|[($issue.number|tostring),.ref]|@tsv' "$tmp/issues")
    while IFS= read -r evidence; do
      [ "$(jq -r .parentRepo <<<"$evidence")" = "$(jq -r .repository <<<"$evidence")" ] || return 3
      _taskdag_verify_delegated_close_evidence "$spec" "$evidence" >/dev/null || return 3
    done < <(jq -c 'select(.liveDelegations) | . as $i | .liveDelegations[] | select(.disposition=="verified-child-close") | .+{repository:$i.repository}' "$tmp/issues")
    # Every verified legacy completion must map to exactly one fully verified
    # live delegation in the same parent repository.
    jq -se 'all(.[]; . as $issue | all($issue.completionEvidence[]?; . as $completion |
      if $completion.disposition=="verified-child-close" then
        ([ $issue.liveDelegations[] | select(.ref==$completion.delegationRef and .disposition=="verified-child-close") ] | length)==1
      else true end))' "$tmp/issues" >/dev/null || return 3
    # Evidence files must exhaust every relevant frozen ref.  This catches a
    # locally curated inventory that silently omitted an awkward marker or
    # completion ref while still allowing unrelated scheduling refs to exist.
    jq -s '[.[] as $i|$i.markers[]?,$i.completionEvidence[]?,$i.liveDelegations[]?|{repository:$i.repository,ref,oid}]|sort_by(.repository,.ref,.oid)' "$tmp/issues" >"$tmp/evidence-refs"
    jq -s '[.[]|select(.ref|test("^refs/heads/(gh/child-epic(s|\u002dslots)?/|tasks/(completions|delegated)/)"))|{repository,ref,oid}]|sort_by(.repository,.ref,.oid)' "$tmp/refs" >"$tmp/frozen-evidence-refs"
    cmp -s "$tmp/evidence-refs" "$tmp/frozen-evidence-refs" || return 3
    jq -ncS --arg activationDigest "$(_taskdag_materialise_sha256_file "$activation")" --slurpfile issues "$tmp/issues" --slurpfile refs "$tmp/refs" '
      def r($p): [$refs[]|select(.ref|test($p))];
      {schema:1,activationRecordDigest:$activationDigest,issues:($issues|sort_by(.repository,.number)),
       slots:([$issues[] as $i|$i.declarations[]|.+{issueNodeId:$i.id,repository:$i.repository,issueNumber:$i.number}]|sort_by(.slotId)),
       legacyCompletionRefs:(r("^refs/heads/tasks/completions/")|map(. as $r|$r+([ $issues[]|select(.repository==$r.repository)|.completionEvidence[]|select(.ref==$r.ref and .oid==$r.oid) ][0]))|sort_by(.repository,.ref)),
       liveDelegations:(r("^refs/heads/tasks/delegated/")|map(. as $r|$r+([ $issues[]|select(.repository==$r.repository)|.liveDelegations[]|select(.ref==$r.ref and .oid==$r.oid) ][0]))|sort_by(.repository,.ref))}' >"$out"
    local rc=$?; if [ "$rc" -eq 0 ]; then _taskdag_validate_census_artifact "$out"; rc=$?; fi; rm -rf "$tmp"; return "$rc"
}

cmd_materialise_census() {
    local rc tmp snapped
    case "${1:-}" in -h|--help) echo 'Usage: task-dag materialise-census --spec-file FILE --artifact FILE --digest-file FILE'; return 0;; esac
    [ "$#" -eq 6 ] && [ "$1" = --spec-file ] && [ "$3" = --artifact ] && [ "$5" = --digest-file ] || return 2
    tmp=$(mktemp -d) || return 2
    snapped=$(_taskdag_census_snapshot "$2" "$tmp") || { rc=$?; rm -rf "$tmp"; rm -f "$4" "$6"; return "$rc"; }
    _taskdag_census_build "$snapped" "$tmp/artifact" || { rc=$?; rm -rf "$tmp"; rm -f "$4" "$6"; return "$rc"; }
    cp "$tmp/artifact" "$4" && _taskdag_materialise_sha256_file "$tmp/artifact" >"$6"; rc=$?; rm -rf "$tmp"; return "$rc"
}

cmd_materialise_import() {
    local spec artifact digest tmp token old tree commit index updates actor timestamp slot dd op body_sha state path evidence close_ref close_commit readback expected snapped current_repo current_repo_id declaration rc requested_refs=()
    case "${1:-}" in -h|--help) echo 'Usage: task-dag materialise-import --spec-file FILE --artifact FILE --digest-file FILE'; return 0;; esac
    [ "$#" -eq 6 ] && [ "$1" = --spec-file ] && [ "$3" = --artifact ] && [ "$5" = --digest-file ] || return 2; spec=$2; artifact=$4; digest=$6
    tmp=$(mktemp -d) || return 2
    snapped=$(_taskdag_census_snapshot "$spec" "$tmp/snapshot") || { rc=$?; rm -rf "$tmp"; return "$rc"; }
    for path in "$artifact" "$digest"; do [ -f "$path" ] && [ ! -L "$path" ] || { rm -rf "$tmp"; return 3; }; done
    if ! _taskdag_snapshot_regular_file "$artifact" "$tmp/reviewed-artifact" \
      || ! _taskdag_snapshot_regular_file "$digest" "$tmp/reviewed-digest"; then rm -rf "$tmp"; return 2; fi
    artifact="$tmp/reviewed-artifact"; digest="$tmp/reviewed-digest"; spec=$snapped
    [ "$(cat "$digest" 2>/dev/null)" = "$(_taskdag_materialise_sha256_file "$artifact")" ] || { rm -rf "$tmp"; return 3; }
    _taskdag_census_build "$spec" "$tmp/census" || { rc=$?; rm -rf "$tmp"; return "$rc"; }; cmp -s "$artifact" "$tmp/census" || { rm -rf "$tmp"; return 3; }
    jq -e 'keys==["activationRecordDigest","issues","legacyCompletionRefs","liveDelegations","schema","slots"] and
      (all(.slots[];.disposition=="issue-adopted" or .disposition=="create-in-flight-or-uncertain" or .disposition=="blocked-repair")) and
      (all(.legacyCompletionRefs[];.disposition!="malformed-evidence"))' "$artifact" >/dev/null || { rm -rf "$tmp"; return 3; }
    current_repo=$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]') || { rm -rf "$tmp"; return 3; }
    current_repo_id=$(jq -r --arg r "$current_repo" '.registrySnapshot.repositories[]|select(.repository==$r)|.repositoryId' "$(jq -r .activationRecord "$spec")")
    [ -n "$current_repo_id" ] || { rm -rf "$tmp"; return 3; }
    token=$(taskdag_activation_snapshot_token) || { rm -rf "$tmp"; return 3; }
    [ "$(jq -r .digest <<<"$token")" = "$(jq -r .activationRecordDigest "$artifact")" ] || { rm -rf "$tmp"; return 3; }
    old=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk '{print $1}')
    if [ -n "$old" ]; then
      git fetch -q --no-tags origin "$old" || { rm -rf "$tmp"; return 3; }
      [ -z "$(taskdag_materialisation_online_tree_violations "$old" "$(jq -r .authorityTip <<<"$token")" "$current_repo")" ] || { rm -rf "$tmp"; return 3; }
      if git cat-file -e "$old:censuses/$(cat "$digest").json" 2>/dev/null; then
        updates=$(jq -ncS --arg ref "$TASKDAG_MATERIALISATION_REF" --arg new "$old" '[{ref:$ref,new:$new}]')
        while IFS= read -r evidence; do
          close_ref="refs/heads/tasks/delegated-close/v1/$(jq -r .parentIssue <<<"$evidence")/$(jq -r .peerRepo <<<"$evidence")/$(jq -r .peerIssue <<<"$evidence")"
          close_commit=$(_taskdag_verify_delegated_close_evidence "$spec" "$evidence" true) || { rm -rf "$tmp"; return 3; }
          updates=$(jq -cS --arg ref "$close_ref" --arg new "$close_commit" '.+[{ref:$ref,new:$new}]|sort_by(.ref)' <<<"$updates")
        done < <(jq -c --arg repo "$current_repo" '.liveDelegations[]|select(.repository==$repo and .disposition=="verified-child-close")' "$artifact")
        mapfile -t requested_refs < <(jq -r '.[].ref' <<<"$updates")
        readback=$(git ls-remote --refs origin "${requested_refs[@]}") || { rm -rf "$tmp"; return 3; }
        while IFS= read -r expected; do
          [ "$(awk -v r="$(jq -r .ref <<<"$expected")" '$2==r{print $1}' <<<"$readback")" = "$(jq -r .new <<<"$expected")" ] || { rm -rf "$tmp"; return 3; }
        done < <(jq -c '.[]' <<<"$updates")
        rm -rf "$tmp"; return 0
      fi
    fi
    index="$tmp/index"; GIT_INDEX_FILE="$index" git read-tree "${old:-$(git mktree </dev/null)}"; mkdir -p "$tmp/censuses"; cp "$artifact" "$tmp/censuses/$(cat "$digest").json"
    GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/censuses/$(cat "$digest").json"),censuses/$(cat "$digest").json"
    while IFS= read -r declaration; do
      slot=$(jq -r .slotId <<<"$declaration"); dd=$(jq -r .declarationDigest <<<"$declaration"); op=$(jq -r .operationId <<<"$declaration"); body_sha=$(jq -rj .body <<<"$declaration" | sha256sum | awk '{print $1}')
      git cat-file -e "$old:slots/$slot/state.json" 2>/dev/null && { rm -rf "$tmp"; return 3; }
      GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(jq -rj .body <<<"$declaration"|git hash-object -w --stdin),bodies/$body_sha.body"
      [ "$body_sha" = "$(jq -r .bodySha256 <<<"$declaration")" ] && [ "$(jq -rj .body <<<"$declaration" | wc -c)" = "$(jq -r .bodyLength <<<"$declaration")" ] || { rm -rf "$tmp"; return 3; }
      GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(jq -cS 'del(.body,.disposition,.adoptedIssue,.issueNodeId,.repository,.issueNumber)' <<<"$declaration"|git hash-object -w --stdin),declarations/$dd.json"
      state=$(jq -ncS --arg slotId "$slot" --arg declarationDigest "$dd" --arg operationId "$op" --arg state "$(jq -r .disposition <<<"$declaration")" --arg censusDigest "$(cat "$digest")" --argjson adoptedIssue "$(jq -c '.adoptedIssue // null' <<<"$declaration")" '{schema:1,state:$state,slotId:$slotId,declarationDigest:$declarationDigest,operationId:$operationId,generation:0,predecessorStateDigest:null,censusDigest:$censusDigest} + if $state=="issue-adopted" then {adoptedIssue:$adoptedIssue} else {} end')
      GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(printf '%s\n' "$state"|git hash-object -w --stdin),slots/$slot/states/0000000000000000.json"
    done < <(jq -c --arg repo "$current_repo" '.slots[]|select(.repository==$repo)' "$artifact")
    GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(jq -ncS --arg censusDigest "$(cat "$digest")" --arg repository "$current_repo" --argjson slots "$(jq -c --arg repo "$current_repo" '[.slots[]|select(.repository==$repo)|.slotId]|sort' "$artifact")" '{schema:1,censusDigest:$censusDigest,repository:$repository,slots:$slots}'|git hash-object -w --stdin),import-batches/$(cat "$digest").json"
    tree=$(GIT_INDEX_FILE="$index" git write-tree)
    [ -z "$old" ] && commit=$(printf 'Import reviewed materialisation census\n' | _taskdag_import_commit_tree "$tree") || commit=$(printf 'Import reviewed materialisation census\n' | _taskdag_import_commit_tree "$tree" -p "$old")
    updates=$(jq -ncS --arg ref "$TASKDAG_MATERIALISATION_REF" --arg old "$old" --arg new "$commit" '[{ref:$ref,old:$old,new:$new}]')
    while IFS= read -r evidence; do
      close_ref="refs/heads/tasks/delegated-close/v1/$(jq -r .parentIssue <<<"$evidence")/$(jq -r .peerRepo <<<"$evidence")/$(jq -r .peerIssue <<<"$evidence")"
      close_commit=$(_taskdag_verify_delegated_close_evidence "$spec" "$evidence" true) || { rm -rf "$tmp"; return 3; }
      updates=$(jq -cS --arg ref "$close_ref" --arg new "$close_commit" '.+[{ref:$ref,old:"",new:$new}]|sort_by(.ref)' <<<"$updates") || { rm -rf "$tmp"; return 2; }
    done < <(jq -c --arg repo "$current_repo" '.liveDelegations[]|select(.repository==$repo and .disposition=="verified-child-close")' "$artifact")
    jq -e '(map(.ref)|length==(unique|length))' <<<"$updates" >/dev/null || { rm -rf "$tmp"; return 3; }
    [ -z "$(taskdag_materialisation_online_tree_violations "$commit" "$(jq -r .authorityTip <<<"$token")" "$current_repo")" ] || { rm -rf "$tmp"; return 3; }
    actor=census-import; timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    taskdag_activation_fenced_multi_push "$token" materialisation census-import "$actor" "$timestamp" "$updates"; rc=$?
    if [ "$rc" -eq 0 ]; then
      readback=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk '{print $1}')
      [ "$readback" = "$commit" ] && git fetch -q --no-tags origin "$readback" &&
        [ -z "$(taskdag_materialisation_online_tree_violations "$readback" "$(jq -r .authorityTip <<<"$token")" "$current_repo")" ] || rc=3
    fi
    rm -rf "$tmp"; return "$rc"
}

_taskdag_materialise_transition() { # strict authorization spec, mode
    local spec=$1 mode=$2 old token slot generation prior prior_digest prior_state record path tmp index tree commit updates authorization authorization_digest census_digest census_path readback current_repo rc
    _taskdag_materialise_no_duplicate_keys "$spec" || return 2
    jq -e --arg mode "$mode" '
      def common: .schema==1 and .mode==$mode and (.slotId|test("^[0-9a-f]{64}$")) and (.priorStateDigest|test("^[0-9a-f]{64}$")) and
        (.generation|type=="number" and floor==. and .>=1) and (.evidence|type=="array" and length>0 and .==sort and length==(unique|length)) and
        (.actor|type=="string" and length>0) and (.timestamp|fromdateiso8601|todateiso8601)==.timestamp;
      type=="object" and common and
      (if $mode=="adopt" then keys==["actor","adoptedIssue","approval","censusDigest","evidence","generation","mode","priorStateDigest","schema","slotId","timestamp"] and
         (.censusDigest|test("^[0-9a-f]{64}$")) and (.approval|type=="string" and length>0) and (.adoptedIssue|keys==["issueNodeId","number","repositoryId"] and (.issueNodeId|type=="string" and length>0) and (.repositoryId|type=="string" and length>0) and (.number|type=="number" and floor==. and .>0))
       elif $mode=="rearm" then
         ((keys==["actor","approval","censusDigest","evidence","generation","mode","priorStateDigest","schema","slotId","timestamp"] and (.censusDigest|test("^[0-9a-f]{64}$"))) or
          (keys==["actor","approval","declarationDigest","evidence","generation","mode","operationId","priorStateDigest","schema","slotId","timestamp"] and (.declarationDigest|test("^[0-9a-f]{64}$")) and (.operationId|test("^[0-9a-f]{64}$")))) and
         (.approval|type=="string" and length>0)
       else keys==["actor","authorizationDigest","censusDigest","evidence","generation","mode","priorStateDigest","schema","slotId","timestamp"] and (.censusDigest|test("^[0-9a-f]{64}$")) and (.authorizationDigest|test("^[0-9a-f]{64}$")) end)' "$spec" >/dev/null || return 2
    old=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk '{print $1}'); [ -n "$old" ] || return 3; git fetch -q origin "$TASKDAG_MATERIALISATION_REF" || return 2; old=$(git rev-parse FETCH_HEAD)
    token=$(taskdag_activation_snapshot_token) || return 3
    current_repo=$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]') || return 3
    [ -z "$(taskdag_materialisation_online_tree_violations "$old" "$(jq -r .authorityTip <<<"$token")" "$current_repo")" ] || return 3
    slot=$(jq -r .slotId "$spec"); generation=$(jq -r .generation "$spec"); census_digest=$(jq -r '.censusDigest // ""' "$spec")
    if [ -n "$census_digest" ]; then
      census_path="censuses/$census_digest.json"
      git cat-file -e "$old:$census_path" 2>/dev/null || return 3
      [ "$(git show "$old:$census_path" | jq -r .activationRecordDigest)" = "$(jq -r .digest <<<"$token")" ] || return 3
      git show "$old:$census_path" | jq -e --arg slot "$slot" 'any(.slots[];.slotId==$slot)' >/dev/null || return 3
    fi
    if [ "$mode" = adopt ]; then
      git show "$old:$census_path" | jq -e --argjson issue "$(jq -c .adoptedIssue "$spec")" \
        --arg slot "$slot" '
          (.slots[]|select(.slotId==$slot)) as $declaration |
          $issue.repositoryId==$declaration.peerRepo.id and
          any(.issues[];.repository==$declaration.peerRepo.name and .id==$issue.issueNodeId and
            .repositoryId==$issue.repositoryId and .number==$issue.number)' >/dev/null || return 3
      git grep -n "\"issueNodeId\":\"$(jq -r .adoptedIssue.issueNodeId "$spec")\"" "$old" -- 'slots/*/states/*.json' 2>/dev/null \
        | grep -v "^$old:slots/$slot/" | grep -q . && return 3
    fi
    case "$mode" in rearm) path="slots/$slot/authorizations/$(printf '%016d' "$generation").json";; *) path="slots/$slot/states/$(printf '%016d' "$generation").json";; esac
    prior="slots/$slot/states/$(printf '%016d' "$((generation-1))").json"
    prior_digest=$(git show "$old:$prior" | sha256sum | awk '{print $1}') || return 3; [ "$prior_digest" = "$(jq -r .priorStateDigest "$spec")" ] || return 3
    prior_state=$(git show "$old:$prior" | jq -r .state) || return 3
    if [ -n "$census_digest" ]; then
      [ "$(git show "$old:$prior" | jq -r .censusDigest)" = "$census_digest" ] || return 3
    else
      [ "$mode" = rearm ] || return 3
      [ "$(git show "$old:$prior" | jq -r .declarationDigest)" = "$(jq -r .declarationDigest "$spec")" ] || return 3
      [ "$(git show "$old:$prior" | jq -r .operationId)" = "$(jq -r .operationId "$spec")" ] || return 3
    fi
    case "$mode" in
      adopt) [ "$prior_state" = blocked-repair ] || [ "$prior_state" = create-in-flight-or-uncertain ] || return 3; record=$(jq -cS '.+{state:"issue-adopted",predecessorStateDigest:.priorStateDigest}|del(.priorStateDigest)' "$spec");;
      rearm) [ "$prior_state" = create-in-flight-or-uncertain ] || return 3; authorization=$(jq -cS '.+{state:"rearm-authorized",predecessorStateDigest:.priorStateDigest}|del(.priorStateDigest)' "$spec"); authorization_digest=$(_taskdag_materialise_sha256_text "$authorization"); record=$(jq -cS --arg authorizationDigest "$authorization_digest" '.+{authorizationDigest:$authorizationDigest}' <<<"$authorization");;
      consume) [ "$prior_state" = create-in-flight-or-uncertain ] || return 3; authorization_digest=$(jq -r .authorizationDigest "$spec"); authorization="slots/$slot/authorizations/$(printf '%016d' "$generation").json"; [ "$(git show "$old:$authorization" | jq -r .authorizationDigest)" = "$authorization_digest" ] || return 3; record=$(jq -cS '.+{state:"create-in-flight-or-uncertain",predecessorStateDigest:.priorStateDigest}|del(.priorStateDigest)' "$spec");;
      *) return 2;;
    esac
    if git cat-file -e "$old:$path" 2>/dev/null; then
      [ "$(git show "$old:$path")" = "$record" ] && return 0
      return 3
    fi
    case "$mode" in
      rearm) git cat-file -e "$old:slots/$slot/states/$(printf '%016d' "$generation").json" 2>/dev/null && return 3;;
      adopt) git cat-file -e "$old:slots/$slot/authorizations/$(printf '%016d' "$generation").json" 2>/dev/null && return 3;;
    esac
    tmp=$(mktemp -d); index="$tmp/index"; GIT_INDEX_FILE="$index" git read-tree "$old"; GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(printf '%s\n' "$record"|git hash-object -w --stdin),$path"; tree=$(GIT_INDEX_FILE="$index" git write-tree); commit=$(printf 'Append materialisation %s transition\n' "$mode"|git commit-tree "$tree" -p "$old")
    [ -z "$(taskdag_materialisation_online_tree_violations "$commit" "$(jq -r .authorityTip <<<"$token")" "$current_repo")" ] || { rm -rf "$tmp"; return 3; }
    updates=$(jq -ncS --arg ref "$TASKDAG_MATERIALISATION_REF" --arg old "$old" --arg new "$commit" '[{ref:$ref,old:$old,new:$new}]')
    taskdag_activation_fenced_multi_push "$token" materialisation "$mode" "$(jq -r .actor "$spec")" "$(jq -r .timestamp "$spec")" "$updates"; rc=$?
    if [ "$rc" -eq 0 ]; then
      readback=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk '{print $1}')
      [ "$readback" = "$commit" ] && git fetch -q --no-tags origin "$readback" &&
        [ -z "$(taskdag_materialisation_online_tree_violations "$readback" "$(jq -r .authorityTip <<<"$token")" "$current_repo")" ] || rc=3
    fi
    rm -rf "$tmp"; return "$rc"
}
_taskdag_materialise_transition_command() { # spec mode
    local source=$1 mode=$2 tmp rc
    tmp=$(mktemp -d) || return 2
    _taskdag_snapshot_regular_file "$source" "$tmp/spec" || { rm -rf "$tmp"; return 2; }
    _taskdag_materialise_transition "$tmp/spec" "$mode"; rc=$?
    rm -rf "$tmp"; return "$rc"
}
cmd_materialise_adopt() { case "${1:-}" in -h|--help) echo 'Usage: task-dag materialise-adopt --spec-file FILE'; return 0;; esac; [ "$#" -eq 2 ] && [ "$1" = --spec-file ] || return 2; _taskdag_materialise_transition_command "$2" adopt; }
cmd_materialise_rearm() { case "${1:-}" in -h|--help) echo 'Usage: task-dag materialise-rearm --spec-file FILE'; return 0;; esac; [ "$#" -eq 2 ] && [ "$1" = --spec-file ] || return 2; _taskdag_materialise_transition_command "$2" rearm; }
