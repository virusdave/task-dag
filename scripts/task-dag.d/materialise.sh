# shellcheck shell=bash
# Canonical immutable materialisation reservation protocol (schema 1).

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

_taskdag_materialisation_snapshot_violations() {
    local tip=$1 work=$2 activation_authority=$3 parent="" count path mode type prepared state sid dd op batch body_sha body_len expected declaration_path timestamp
    git rev-list --parents -1 "$tip" >"$work/snapshot-parents" 2>/dev/null \
      || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot read snapshot parents"; return 0; }
    count=$(awk '{print NF-1}' "$work/snapshot-parents")
    [ "$count" -le 1 ] || echo "✗ $TASKDAG_MATERIALISATION_REF commit is not linear"
    [ "$count" -eq 0 ] || parent=$(git rev-parse "$tip^" 2>/dev/null) || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot resolve snapshot parent"; return 0; }
    git ls-tree -r "$tip" >"$work/snapshot-tree" 2>/dev/null \
      || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot read snapshot tree"; return 0; }
    while read -r mode type _ path; do
        [ "$mode" = 100644 ] && [ "$type" = blob ] || { echo "✗ $TASKDAG_MATERIALISATION_REF has non-regular path $path"; continue; }
        [[ "$path" =~ ^(bodies/[0-9a-f]{64}\.body|declarations/[0-9a-f]{64}\.json|batches/[0-9a-f]{64}\.json|slots/[0-9a-f]{64}/state\.json)$ ]] || echo "✗ $TASKDAG_MATERIALISATION_REF has unexpected path $path"
    done <"$work/snapshot-tree"
    cut -f2 "$work/snapshot-tree" >"$work/snapshot-paths" \
      || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot enumerate snapshot paths"; return 0; }
    grep -E '^(declarations|batches|slots)/' "$work/snapshot-paths" >"$work/snapshot-json-paths" || :
    while IFS= read -r path; do
        prepared=$(git show "$tip:$path" 2>/dev/null) || { echo "✗ unreadable $path"; continue; }
        jq -e . >/dev/null 2>&1 <<<"$prepared" || { echo "✗ invalid JSON at $path"; continue; }
        case "$path" in
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
            [ "$(git show "$tip:slots/$sid/state.json" 2>/dev/null | jq -r .declarationDigest)" = "$dd" ] || echo "✗ declaration $dd lacks matching slot"
            git grep -q "\"declarationDigest\":\"$dd\"" "$tip" -- 'batches/*.json' 2>/dev/null || echo "✗ declaration $dd is not reachable from a batch" ;;
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
              [ "$(git show "$tip:slots/$sid/state.json" 2>/dev/null | jq -r .declarationDigest)" = "$declaration_path" ] || echo "✗ batch $dd declaration $declaration_path lacks matching slot state"
              [ "$(_taskdag_materialise_id operation "$sid" "$declaration_path")" = "$op" ] || echo "✗ batch $dd member operation mismatch"
            done <"$work/snapshot-members" ;;
          slots/*)
            state=$prepared; sid=${path#slots/}; sid=${sid%/state.json}; dd=$(jq -r '.declarationDigest' <<<"$state"); op=$(jq -r '.operationId' <<<"$state"); batch=$(jq -r '.batchId' <<<"$state")
            if ! jq -e --arg sid "$sid" '.schema==1 and .state=="batch-reserved-before-create" and .slotId==$sid and .generation==0 and .fence==1 and .predecessorStateDigest==null and (.activation|keys==["digest","epoch","guardVersion"] and (.epoch|type=="number" and floor==. and .>=1) and (.digest|test("^[0-9a-f]{64}$")) and .guardVersion==1) and (.actor|type=="string" and length>0 and length<=256 and (test("[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]")|not)) and (.authoritativeTimestamp|type=="string" and length==20 and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and (.batchId|test("^[0-9a-f]{64}$")) and (.declarationDigest|test("^[0-9a-f]{64}$")) and (.operationId|test("^[0-9a-f]{64}$")) and (.originReadback|keys==["activationAuthorityTip","materialisationTip"] and (.activationAuthorityTip|test("^[0-9a-f]{40}$"))) and ((.originReadback.materialisationTip==null) or (.originReadback.materialisationTip|test("^[0-9a-f]{40}$"))) and keys==["activation","actor","authoritativeTimestamp","batchId","declarationDigest","fence","generation","operationId","originReadback","predecessorStateDigest","schema","slotId","state"]' >/dev/null <<<"$state"; then echo "✗ invalid slot state $path"; continue; fi
            timestamp=$(jq -r .authoritativeTimestamp <<<"$state")
            taskdag_activation_validate_provenance "$activation_authority" "$(jq -c .activation <<<"$state")" \
              || echo "✗ slot $sid has forged activation provenance"
            jq -ne --arg timestamp "$timestamp" '($timestamp|fromdateiso8601|todateiso8601)==$timestamp' >/dev/null 2>&1 || echo "✗ slot $sid has an impossible timestamp"
            expected=$(_taskdag_materialise_id operation "$sid" "$dd"); [ "$op" = "$expected" ] || echo "✗ slot $sid operation ID mismatch"
            git cat-file -e "$tip:declarations/$dd.json" 2>/dev/null || echo "✗ slot $sid lacks declaration"
            [ "$(git show "$tip:declarations/$dd.json" 2>/dev/null | jq -r .slotId)" = "$sid" ] || echo "✗ slot $sid does not match declaration"
            [ "$(git show "$tip:batches/$batch.json" 2>/dev/null | jq -c .activation)" = "$(jq -c .activation <<<"$state")" ] || echo "✗ slot $sid activation provenance does not match batch"
            git show "$tip:batches/$batch.json" 2>/dev/null | jq -e --arg dd "$dd" --arg sid "$sid" --arg op "$op" 'any(.members[];.declarationDigest==$dd and .slotId==$sid and .operationId==$op)' >/dev/null 2>&1 || echo "✗ slot $sid is absent from batch" ;;
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
    local tip=$1 activation_authority=${2:-} previous="" commit parents path json canonical expected_origin validation_tmp added batch_path batch_json member sid dd body_sha shallow
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
        _taskdag_materialisation_snapshot_violations "$commit" "$validation_tmp" "$activation_authority"
        added="$validation_tmp/added"
        if [ -z "$previous" ]; then
            git ls-tree -r --name-only "$commit" >"$added" 2>/dev/null \
              || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot list root tree $commit"; rm -rf "$validation_tmp"; return 0; }
        else
            git diff-tree --no-commit-id --name-only --diff-filter=A -r "$previous" "$commit" >"$added" 2>/dev/null \
              || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot read generation delta $commit"; rm -rf "$validation_tmp"; return 0; }
        fi
        if [ "$(grep -c '^batches/[0-9a-f]\{64\}\.json$' "$added")" -ne 1 ]; then
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
                sid=${path#slots/}; sid=${sid%/state.json}
                jq -e --arg sid "$sid" 'any(.members[];.slotId==$sid)' >/dev/null 2>&1 <<<"$batch_json" \
                  || echo "✗ generation $commit adds slot $sid outside its batch"
            done <"$validation_tmp/added-slots"
            while IFS= read -r member; do
                sid=$(jq -r .slotId <<<"$member"); dd=$(jq -r .declarationDigest <<<"$member")
                if { [ -z "$previous" ] || ! git cat-file -e "$previous:declarations/$dd.json" 2>/dev/null; } \
                  && ! grep -qx "declarations/$dd.json" "$added"; then
                    echo "✗ generation $commit batch member $dd lacks an atomic declaration"
                fi
                if { [ -z "$previous" ] || ! git cat-file -e "$previous:slots/$sid/state.json" 2>/dev/null; } \
                  && ! grep -qx "slots/$sid/state.json" "$added"; then
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
            git ls-tree -r --name-only "$commit" 'slots/*/state.json' >"$validation_tmp/new-slots" 2>/dev/null \
              || { echo "✗ $TASKDAG_MATERIALISATION_REF validator cannot list root slots"; rm -rf "$validation_tmp"; return 0; }
        else
            git diff-tree --no-commit-id --name-only --diff-filter=A -r "$previous" "$commit" -- 'slots/*/state.json' >"$validation_tmp/new-slots" 2>/dev/null \
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

# Private seam: tests source this module and call the core.  No CLI path tests
# an environment variable, so exported state cannot bypass migration drain.
taskdag_materialise_reserve_core() {
    local spec=$1 prepared batch_json batch_id actor timestamp old="" tmp index tree commit remote now slot dd op body_sha declaration state activation activation_provenance
    activation=$(taskdag_activation_snapshot_token) || return 3
    prepared=$(taskdag_materialise_prepare "$spec") || return $?
    batch_json=$(_taskdag_materialise_batch_json "$prepared" "$activation") || return 2; batch_id=$(jq -r .batchId <<<"$batch_json")
    activation_provenance=$(jq -c '{epoch,digest,guardVersion}' <<<"$activation") || return 2
    actor=$(jq -r .actor <<<"$prepared"); timestamp=$(jq -r .authoritativeTimestamp <<<"$prepared")
    for _ in 1 2 3 4 5; do
      remote=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF") || return 2; old=${remote%%[[:space:]]*}; [ "$remote" != "$old" ] || old=""
      [ -z "$old" ] || { git fetch -q --no-tags origin "$TASKDAG_MATERIALISATION_REF" || return 2; old=$(git rev-parse FETCH_HEAD); [ -z "$(taskdag_materialisation_tree_violations "$old" "$(jq -r .authorityTip <<<"$activation")")" ] || return 3; }
      while IFS= read -r slot; do
        dd=$(jq -r --arg s "$slot" '.declarations[]|select(.slotId==$s)|.declarationDigest' <<<"$prepared")
        if [ -n "$old" ] && git cat-file -e "$old:slots/$slot/state.json" 2>/dev/null; then
          [ "$(git show "$old:slots/$slot/state.json" | jq -r .declarationDigest)" = "$dd" ] || return 3
        fi
      done < <(jq -r '.declarations[].slotId' <<<"$prepared")
      tmp=$(mktemp -d); index="$tmp/index"; GIT_INDEX_FILE="$index" git read-tree "${old:-$(git mktree </dev/null)}"
      while IFS= read -r declaration; do
        slot=$(jq -r .slotId <<<"$declaration"); dd=$(jq -r .declarationDigest <<<"$declaration"); op=$(jq -r .operationId <<<"$declaration"); body_sha=$(jq -r .bodySha256 <<<"$declaration")
        [ -n "$old" ] && git cat-file -e "$old:slots/$slot/state.json" 2>/dev/null && continue
        mkdir -p "$tmp/bodies" "$tmp/declarations" "$tmp/slots/$slot"
        jq -rj .body <<<"$declaration" >"$tmp/bodies/$body_sha.body"
        jq -cS 'del(.body,.memberProvenance)' <<<"$declaration" >"$tmp/declarations/$dd.json"
        state=$(jq -ncS --arg slotId "$slot" --arg declarationDigest "$dd" --arg operationId "$op" --arg batchId "$batch_id" --arg actor "$actor" --arg authoritativeTimestamp "$timestamp" --arg tip "$old" --arg authorityTip "$(jq -r .authorityTip <<<"$activation")" --argjson activation "$activation_provenance" '{schema:1,state:"batch-reserved-before-create",slotId:$slotId,declarationDigest:$declarationDigest,operationId:$operationId,batchId:$batchId,generation:0,fence:1,activation:$activation,actor:$actor,authoritativeTimestamp:$authoritativeTimestamp,predecessorStateDigest:null,originReadback:{activationAuthorityTip:$authorityTip,materialisationTip:(if $tip=="" then null else $tip end)}}')
        printf '%s\n' "$state" >"$tmp/slots/$slot/state.json"
        GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/bodies/$body_sha.body"),bodies/$body_sha.body"
        GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/declarations/$dd.json"),declarations/$dd.json"
        GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/slots/$slot/state.json"),slots/$slot/state.json"
      done < <(jq -c '.declarations[]' <<<"$prepared")
      mkdir -p "$tmp/batches"; printf '%s\n' "$batch_json" >"$tmp/batches/$batch_id.json"
      GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/batches/$batch_id.json"),batches/$batch_id.json"
      if [ "${TASKDAG_MATERIALISE_TEST_CORRUPT_CANDIDATE:-0}" = 1 ]; then
        GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(printf 'corrupt\n' | git hash-object -w --stdin),unexpected/path"
      fi
      tree=$(GIT_INDEX_FILE="$index" git write-tree); rm -rf "$tmp"
      if [ -n "$old" ] && [ "$tree" = "$(git rev-parse "$old^{tree}")" ]; then printf '%s\n' "$batch_json"; return 0; fi
      if [ -n "$old" ]; then commit=$(printf 'Reserve materialisation batch %s\n' "${batch_id:0:12}" | git commit-tree "$tree" -p "$old"); else commit=$(printf 'Reserve materialisation batch %s\n' "${batch_id:0:12}" | git commit-tree "$tree"); fi
      [ -z "$(taskdag_materialisation_tree_violations "$commit" "$(jq -r .authorityTip <<<"$activation")")" ] || return 3
      if [ "${TASKDAG_MATERIALISE_TEST_CRASH_BEFORE_CAS:-0}" = 1 ]; then return 86; fi
      if taskdag_activation_fenced_push "$activation" materialisation reserve-batch "$actor" "$timestamp" "$TASKDAG_MATERIALISATION_REF" "$old" "$commit"; then
        # Deterministic fixture seam for a transport that reports failure after
        # the server accepted the CAS.  The next iteration must prove the
        # complete durable request from origin rather than write or POST again.
        if [ "${TASKDAG_MATERIALISE_TEST_AMBIGUOUS_SUCCESS:-0}" = 1 ]; then continue; fi
        now=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk '{print $1}'); git fetch -q --no-tags origin "$TASKDAG_MATERIALISATION_REF" || return 2; now=$(git rev-parse FETCH_HEAD)
        [ -z "$(taskdag_materialisation_tree_violations "$now" "$(jq -r .authorityTip <<<"$activation")")" ] || return 3
        [ "$(git show "$now:batches/$batch_id.json" 2>/dev/null)" = "$batch_json" ] || return 3
        while IFS= read -r declaration; do
          slot=$(jq -r .slotId <<<"$declaration"); dd=$(jq -r .declarationDigest <<<"$declaration"); body_sha=$(jq -r .bodySha256 <<<"$declaration")
          [ "$(git show "$now:slots/$slot/state.json" | jq -r .declarationDigest)" = "$dd" ] || return 3
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
