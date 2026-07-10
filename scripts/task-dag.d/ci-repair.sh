# shellcheck shell=bash
# task-dag extension: CI-driven broken-master auto-repair (virusdave/task-dag#1,
# dev-loop epic virusdave/top-level#26 phase 2). Authoritative design:
# virusdave/top-level:docs/designs/ci-broken-master-auto-repair.md.
#
# This module is sourced by scripts/task-dag (see the task-dag.d loader). It
# hosts the CLI surface for the auto-repair subsystem; commands are registered
# in main()'s case statement in the parent script.
#
# Implemented so far:
#   * parse-tree-fix  — parse Tree-Fix / Tree-Fix-Chain / Tree-Fix-Mode commit
#                       trailers (design section 3) via `git interpret-trailers`.
# (Chain-state, classifier core, ticket/escalation, worker verifier, and the
#  reusable workflow are the other leaves of #1.)

# ---------------------------------------------------------------------------
# repair-reconcile evidence internals
#
# These private helpers implement the read-only authority + evidence half of
# the future `repair-reconcile` command.  They intentionally are not registered
# as a public command yet: the public contract also includes an atomic chain
# decision and fenced projection convergence.  Keeping collection private lets
# Actions hints and the host reconciler share one strict implementation without
# advertising a dangerously incomplete reconciler.
#
# `_ci_repair_collect_evidence <owner/repo> <branch>` writes one compact JSON
# outcome to stdout and has no projection or git-ref side effects.  Outcomes:
#   off             authoritative registry says this slot is not enrolled
#   observation     strict policy + check evidence produced a classification
#   policy-invalid  repository-owned policy/identity is invalid
#   evidence-error  transient/authority/stored-state evidence is unsafe
# Exit 0 is off/observation; exit 2 is policy-invalid/evidence-error.
# ---------------------------------------------------------------------------

_CI_REPAIR_TOP_LEVEL_REPO="virusdave/top-level"
_CI_REPAIR_REGISTRY_PATH="scripts/ephemeral_checkout.d/repos.conf"
_CI_REPAIR_POLICY_PATH=".github/ci-repair-policy.json"
_CI_REPAIR_MAX_BODY_BYTES=1048576
_CI_REPAIR_MAX_POLICY_BYTES=65536
_CI_REPAIR_MAX_REGISTRY_BYTES=262144
_CI_REPAIR_MAX_CHECKS=64
_CI_REPAIR_MAX_RUNS=1000
_CI_REPAIR_MAX_PAGES=10

_ci_repair_error() { # <outcome> <bounded-code> [authority-json]
    local outcome="$1" code="$2" authority="${3:-null}"
    jq -cn --arg outcome "$outcome" --arg code "$code" \
        --argjson authority "$authority" \
        '{outcome:$outcome,error:$code,authority:$authority}'
    return 2
}

_ci_repair_sha256() {
    sha256sum | awk '{print "sha256:" $1}'
}

_ci_repair_base64url() {
    base64 -w0 | tr '+/' '-_' | tr -d '='
}

# Fetch one GitHub API page while retaining its response metadata.  Globals:
# _CI_HTTP_BODY_FILE, _CI_HTTP_DATE, _CI_HTTP_DATE_EPOCH.  Every response Date
# is checked against host time at receipt; host time never becomes observation
# or lease authority.
_ci_repair_http_get() { # <endpoint> <scratch-dir> <sequence>
    local endpoint="$1" scratch="$2" seq="$3"
    local envelope="$scratch/http.$seq" headers="$scratch/headers.$seq"
    local body="$scratch/body.$seq" split status date_count date_value
    local capture_limit=$((_CI_REPAIR_MAX_BODY_BYTES + 32769))
    local -a pipeline_status=()

    {
        gh api --include "$endpoint" 2>/dev/null | head -c "$capture_limit" >"$envelope"
        pipeline_status=("${PIPESTATUS[@]}")
    }
    [ "$(wc -c <"$envelope")" -le "$((_CI_REPAIR_MAX_BODY_BYTES + 32768))" ] \
        || return 21

    split="$(awk '{ line=$0; sub(/\r$/, "", line); if (line == "") { print NR; exit } }' "$envelope")"
    [[ "$split" =~ ^[1-9][0-9]*$ ]] || return 20
    head -n "$((split - 1))" "$envelope" >"$headers" || return 22
    tail -n "+$((split + 1))" "$envelope" >"$body" || return 22
    [ "$(wc -c <"$body")" -le "$_CI_REPAIR_MAX_BODY_BYTES" ] || return 21

    status="$(head -1 "$headers" | tr -d '\r' | awk '{print $2}')"
    _CI_HTTP_STATUS="$status"
    date_count="$(awk 'BEGIN{IGNORECASE=1} /^date:[[:space:]]/ {n++} END{print n+0}' "$headers")"
    [ "$date_count" -eq 1 ] || return 24
    date_value="$(awk 'BEGIN{IGNORECASE=1} /^date:[[:space:]]/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print}' "$headers")"

    local date_epoch host_epoch skew
    date_epoch="$(date -u -d "$date_value" +%s 2>/dev/null)" || return 24
    host_epoch="$(date -u +%s)" || return 24
    skew=$((host_epoch - date_epoch)); [ "$skew" -lt 0 ] && skew=$((-skew))
    [ "$skew" -le 300 ] || return 25

    _CI_HTTP_BODY_FILE="$body"
    _CI_HTTP_DATE="$(date -u -d "@$date_epoch" +'%Y-%m-%dT%H:%M:%SZ')" || return 24
    _CI_HTTP_DATE_EPOCH="$date_epoch"
    [ "$status" = 200 ] || return 23
    [ "${pipeline_status[0]:-1}" -eq 0 ] || return 20
    return 0
}

_ci_repair_http_error_code() {
    case "$1" in
        20) printf api-failure ;;
        21) printf response-too-large ;;
        22) printf malformed-http-response ;;
        23) printf api-status ;;
        24) printf missing-or-invalid-date ;;
        25) printf clock-skew ;;
        *) printf api-failure ;;
    esac
}

_ci_repair_note_date() {
    if [ "$_CI_HTTP_DATE_EPOCH" -gt "${_CI_REPAIR_OBSERVED_EPOCH:-0}" ]; then
        _CI_REPAIR_OBSERVED_EPOCH="$_CI_HTTP_DATE_EPOCH"
        _CI_REPAIR_OBSERVED_AT="$_CI_HTTP_DATE"
    fi
}

_ci_repair_repo_from_url() {
    local url="$1" path
    case "$url" in
        git@*:*/*) path="${url#*:}" ;;
        https://github.com/*/*|ssh://git@github.com/*/*) path="${url#*github.com/}" ;;
        *) return 1 ;;
    esac
    path="${path%.git}"
    [[ "$path" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    printf '%s' "$path"
}

_ci_repair_urlencode_component() {
    local LC_ALL=C value="$1" out="" i char
    for ((i = 0; i < ${#value}; i++)); do
        char="${value:i:1}"
        case "$char" in
            [A-Za-z0-9._~-]) out+="$char" ;;
            *) out+="$(printf '%%%02X' "'$char")" ;;
        esac
    done
    printf '%s' "$out"
}

_ci_repair_decode_content() { # <api-json> <output-file> <max-bytes>
    local input="$1" output="$2" maximum="$3" encoded
    jq -e '.type == "file" and .encoding == "base64"
           and (.sha | type == "string" and test("^[0-9a-f]{40,64}$"))
           and (.content | type == "string")' "$input" >/dev/null 2>&1 \
        || return 1
    encoded="$(jq -r '.content' "$input")" || return 1
    printf '%s' "$encoded" | tr -d '\n' | base64 -d >"$output" 2>/dev/null \
        || return 1
    [ "$(wc -c <"$output")" -le "$maximum" ] || return 2
    # Bash cannot represent NUL; reject it before any shell parsing.
    [ "$(wc -c <"$output")" -eq "$(tr -d '\000' <"$output" | wc -c)" ] || return 1
}

# Resolve one immutable registry snapshot and strictly validate the complete
# file. Globals: _CI_REGISTRY_COMMIT, _CI_REGISTRY_BLOB, _CI_REGISTRY_MODE,
# _CI_REGISTRY_BRANCH, _CI_REGISTRY_AUTHORITY.
_ci_repair_registry_snapshot() { # <repo> <requested-branch> <scratch>
    local wanted_repo="$1" wanted_branch="$2" scratch="$3" rc=0
    local endpoint registry="$scratch/repos.conf" line trimmed name url mode branch extra identity
    local row_mode="off" row_branch="" found=false
    declare -A names=() identities=()

    endpoint="repos/${_CI_REPAIR_TOP_LEVEL_REPO}/git/ref/heads/master"
    _ci_repair_http_get "$endpoint" "$scratch" registry-ref || rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    _ci_repair_note_date
    _CI_REGISTRY_COMMIT="$(jq -er 'select(.object.type == "commit") | .object.sha
        | select(type == "string" and test("^[0-9a-f]{40,64}$"))' "$_CI_HTTP_BODY_FILE" 2>/dev/null)" \
        || return 30

    endpoint="repos/${_CI_REPAIR_TOP_LEVEL_REPO}/contents/${_CI_REPAIR_REGISTRY_PATH}?ref=${_CI_REGISTRY_COMMIT}"
    _ci_repair_http_get "$endpoint" "$scratch" registry-content || rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    _ci_repair_note_date
    _ci_repair_decode_content "$_CI_HTTP_BODY_FILE" "$registry" "$_CI_REPAIR_MAX_REGISTRY_BYTES" \
        || return 31
    _CI_REGISTRY_BLOB="$(jq -er '.sha | select(type == "string" and test("^[0-9a-f]{40,64}$"))' \
        "$_CI_HTTP_BODY_FILE")" || return 31

    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in *$'\r'*) return 32 ;; esac
        trimmed="${line#"${line%%[![:space:]]*}"}"
        [ -n "$trimmed" ] || continue
        [[ "$trimmed" == \#* ]] && continue
        name=""; url=""; mode=""; branch=""; extra=""
        read -r name url mode branch extra <<<"$trimmed"
        [ -n "$name" ] && [ -n "$url" ] && [ -z "$extra" ] || return 32
        [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || return 32
        [ -z "${names[$name]+set}" ] || return 33
        names[$name]=1
        identity="$(_ci_repair_repo_from_url "$url")" || return 32
        [ -z "${identities[$identity]+set}" ] || return 34
        identities[$identity]=1
        if [ -z "$mode" ] && [ -z "$branch" ]; then
            mode=off
        else
            [ -n "$mode" ] && [ -n "$branch" ] || return 32
            case "$mode" in off|observe|enforce) ;; *) return 32 ;; esac
            git check-ref-format "refs/heads/$branch" >/dev/null 2>&1 || return 32
        fi
        if [ "$identity" = "$wanted_repo" ]; then
            found=true
            if [ "$mode" != off ] && [ "$branch" = "$wanted_branch" ]; then
                row_mode="$mode"; row_branch="$branch"
            fi
        fi
    done <"$registry"

    _CI_REGISTRY_MODE="$row_mode"
    _CI_REGISTRY_BRANCH="$row_branch"
    _CI_REGISTRY_AUTHORITY="$(jq -cn --arg commit "$_CI_REGISTRY_COMMIT" \
        --arg blob "$_CI_REGISTRY_BLOB" --arg mode "$row_mode" \
        --arg branch "$row_branch" --argjson found "$found" \
        '{commit:$commit,blob:$blob,mode:$mode,branch:$branch,repositoryFound:$found}')" \
        || return 35
}

_ci_repair_read_stored_authority() { # <repo> <branch>
    local repo="$1" branch="$2" ref old="" f count first_epoch observed_epoch
    ref="$(_cichain_ref "$repo" "$branch")"
    old="$(_cichain_remote_sha "$ref")" || return 40
    _CI_REPAIR_CHAIN_COMMIT="$old"
    _CI_REPAIR_STORED_REGISTRY_COMMIT=""
    _CI_REPAIR_STORED_REGISTRY_BLOB=""
    _CI_REPAIR_STORED_MODE=""
    _CI_REPAIR_STORED_HEAD=""
    _CI_REPAIR_STORED_FIRST_SEEN=""
    _CI_REPAIR_STORED_OBSERVED_AT=""
    [ -n "$old" ] || return 0
    git fetch --quiet --no-write-fetch-head origin "$ref" 2>/dev/null || return 40
    git cat-file -e "${old}^{commit}" 2>/dev/null || return 40
    for f in Registry-Commit Registry-Blob Enrollment-Mode Observed-Head Head-First-Seen-At Observed-At; do
        count="$(_cichain_field_count "$old" "$f")" || return 41
        [ "$count" -le 1 ] || return 41
    done
    _CI_REPAIR_STORED_REGISTRY_COMMIT="$(_cichain_field "$old" Registry-Commit)" || return 41
    _CI_REPAIR_STORED_REGISTRY_BLOB="$(_cichain_field "$old" Registry-Blob)" || return 41
    _CI_REPAIR_STORED_MODE="$(_cichain_field "$old" Enrollment-Mode)" || return 41
    _CI_REPAIR_STORED_HEAD="$(_cichain_field "$old" Observed-Head)" || return 41
    _CI_REPAIR_STORED_FIRST_SEEN="$(_cichain_field "$old" Head-First-Seen-At)" || return 41
    _CI_REPAIR_STORED_OBSERVED_AT="$(_cichain_field "$old" Observed-At)" || return 41

    if [ -z "$_CI_REPAIR_STORED_HEAD$_CI_REPAIR_STORED_FIRST_SEEN$_CI_REPAIR_STORED_OBSERVED_AT" ]; then
        : # all-empty legacy observation tuple
    else
        [[ "$_CI_REPAIR_STORED_HEAD" =~ ^[0-9a-f]{40,64}$ ]] \
            && [ -n "$_CI_REPAIR_STORED_FIRST_SEEN" ] \
            && [ -n "$_CI_REPAIR_STORED_OBSERVED_AT" ] || return 41
        first_epoch="$(_cichain_timestamp_epoch "$_CI_REPAIR_STORED_FIRST_SEEN")" || return 41
        observed_epoch="$(_cichain_timestamp_epoch "$_CI_REPAIR_STORED_OBSERVED_AT")" || return 41
        [ "$first_epoch" -le "$observed_epoch" ] || return 41
    fi

    if [ -z "$_CI_REPAIR_STORED_REGISTRY_COMMIT$_CI_REPAIR_STORED_REGISTRY_BLOB$_CI_REPAIR_STORED_MODE" ]; then
        return 0
    fi
    [[ "$_CI_REPAIR_STORED_REGISTRY_COMMIT" =~ ^[0-9a-f]{40,64}$ ]] \
        && [[ "$_CI_REPAIR_STORED_REGISTRY_BLOB" =~ ^[0-9a-f]{40,64}$ ]] \
        || return 41
    case "$_CI_REPAIR_STORED_MODE" in off|observe|enforce) ;; *) return 41 ;; esac
}

_ci_repair_validate_registry_descent() { # <scratch>
    local scratch="$1" rc=0 status
    [ -n "$_CI_REPAIR_STORED_REGISTRY_COMMIT" ] || return 0
    [ "$_CI_REPAIR_STORED_REGISTRY_COMMIT" = "$_CI_REGISTRY_COMMIT" ] && return 0
    _ci_repair_http_get \
        "repos/${_CI_REPAIR_TOP_LEVEL_REPO}/compare/${_CI_REPAIR_STORED_REGISTRY_COMMIT}...${_CI_REGISTRY_COMMIT}" \
        "$scratch" registry-compare || rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    _ci_repair_note_date
    status="$(jq -er '.status | select(type == "string")' "$_CI_HTTP_BODY_FILE" 2>/dev/null)" \
        || return 42
    case "$status" in ahead|identical) return 0 ;; behind|diverged) return 43 ;; *) return 42 ;; esac
}

# jq normally accepts duplicate JSON object keys (last one wins).  Streaming
# exposes every occurrence, allowing strict boundary validation before normal
# schema checks.
_ci_repair_json_has_duplicate_paths() { # <file>
    jq --stream -c 'select(length == 2) | .[0]' "$1" 2>/dev/null \
        | LC_ALL=C sort | uniq -d | grep -q .
}

_ci_repair_validate_policy() { # <policy-file>
    local policy="$1"
    iconv -f UTF-8 -t UTF-8 "$policy" >/dev/null 2>&1 || return 1
    _ci_repair_json_has_duplicate_paths "$policy" && return 1
    jq -e --argjson max "$_CI_REPAIR_MAX_CHECKS" '
      type == "object"
      and (keys == ["missingGateGraceSeconds","requiredChecks","version"])
      and .version == 1
      and (.missingGateGraceSeconds | type == "number" and floor == . and . >= 0 and . <= 86400)
      and (.requiredChecks | type == "array" and length > 0 and length <= $max)
      and (all(.requiredChecks[];
        type == "object"
        and (keys == ["acceptedConclusions","appId","appSlug","name"])
        and (.name | type == "string" and length > 0 and length <= 200 and test("^[^\\r\\n]+$"))
        and (.appId | type == "number" and floor == . and . > 0 and . <= 9007199254740991)
        and (.appSlug | type == "string" and test("^[a-z0-9][a-z0-9-]{0,99}$"))
        and (.acceptedConclusions | type == "array" and length > 0 and length <= 16)
        and (all(.acceptedConclusions[];
          type == "string" and IN("success","failure","neutral","cancelled","skipped","timed_out","action_required","startup_failure","stale")))
        and ((.acceptedConclusions | unique | length) == (.acceptedConclusions | length))))
      and ((.requiredChecks | map(.name) | unique | length) == (.requiredChecks | length))
    ' "$policy" >/dev/null 2>&1
}

_ci_repair_validate_run_page() { # <page-file> <head-sha>
    local page="$1" head="$2" value created started completed timestamps="${1}.timestamps"
    jq -e --arg head "$head" '
      type == "object" and (.total_count | type == "number" and floor == . and . >= 0)
      and (.check_runs | type == "array")
      and all(.check_runs[];
        type == "object"
        and (.id | type == "number" and floor == . and . > 0 and . <= 9007199254740991)
        and .head_sha == $head
        and (.name | type == "string" and length > 0 and length <= 200)
        and (.app | type == "object" and (.id | type == "number" and floor == . and . > 0)
             and (.slug | type == "string"))
        and (.status | IN("queued","in_progress","completed","waiting","requested","pending"))
        and ((.conclusion == null) or (.conclusion | type == "string" and
             IN("success","failure","neutral","cancelled","skipped","timed_out","action_required","startup_failure","stale")))
        and (if .status == "completed" then .conclusion != null else .conclusion == null end)
        and (if .status == "completed" then .completed_at != null else .completed_at == null end)
        and (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
        and ((.started_at == null) or (.started_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
        and ((.completed_at == null) or (.completed_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))))
    ' "$page" >/dev/null 2>&1 || return 1
    jq -r '.check_runs[] | [.created_at, (.started_at // "null"), (.completed_at // "null")] | @tsv' \
        "$page" >"$timestamps" || return 1
    while IFS=$'\t' read -r created started completed; do
        _cichain_timestamp_epoch "$created" >/dev/null || return 1
        if [ "$started" != null ]; then
            _cichain_timestamp_epoch "$started" >/dev/null || return 1
            [ "$(_cichain_timestamp_epoch "$created")" -le "$(_cichain_timestamp_epoch "$started")" ] || return 1
        fi
        if [ "$completed" != null ]; then
            _cichain_timestamp_epoch "$completed" >/dev/null || return 1
            value="${started/null/$created}"
            [ "$(_cichain_timestamp_epoch "$value")" -le "$(_cichain_timestamp_epoch "$completed")" ] || return 1
        fi
    done <"$timestamps"
}

_ci_repair_collect_check_runs() { # <repo> <head> <scratch>
    local repo="$1" head="$2" scratch="$3" page=1 rc=0 count total="" all="$scratch/runs.jsonl"
    : >"$all" || return 64
    while [ "$page" -le "$_CI_REPAIR_MAX_PAGES" ]; do
        _ci_repair_http_get \
            "repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100&page=${page}" \
            "$scratch" "checks.$page" || rc=$?
        [ "$rc" -eq 0 ] || return "$rc"
        _ci_repair_note_date
        _ci_repair_validate_run_page "$_CI_HTTP_BODY_FILE" "$head" || return 60
        if [ -z "$total" ]; then total="$(jq -r .total_count "$_CI_HTTP_BODY_FILE")"
        elif [ "$total" != "$(jq -r .total_count "$_CI_HTTP_BODY_FILE")" ]; then return 61
        fi
        jq -c '.check_runs[]' "$_CI_HTTP_BODY_FILE" >>"$all" || return 64
        count="$(jq '.check_runs | length' "$_CI_HTTP_BODY_FILE")" || return 64
        [ "$(wc -l <"$all")" -le "$_CI_REPAIR_MAX_RUNS" ] || return 62
        [ "$count" -eq 100 ] || break
        page=$((page + 1))
    done
    [ "$page" -le "$_CI_REPAIR_MAX_PAGES" ] || return 63

    jq -s '.' "$all" >"$scratch/runs.json" || return 64
    # Identical repeated IDs across pages are harmless; conflicting records
    # are a pagination consistency failure.
    jq -e 'group_by(.id) | all(.[]; (map(tojson) | unique | length) == 1)' \
        "$scratch/runs.json" >/dev/null || return 61
    jq 'unique_by(.id)' "$scratch/runs.json" >"$scratch/runs.unique.json" || return 64
    [ "$(jq 'length' "$scratch/runs.unique.json")" -eq "$total" ] || return 61
    _CI_REPAIR_RUNS_FILE="$scratch/runs.unique.json"
}

_ci_repair_build_evidence() { # <policy> <runs> <output>
    local policy="$1" runs="$2" output="$3"
    jq -n --slurpfile policy "$policy" --slurpfile runs "$runs" '
      $policy[0].requiredChecks as $checks | $runs[0] as $all |
      [ $checks[] as $check |
        ($all | map(select(.name == $check.name))) as $named |
        ($named | map(select(.app.id == $check.appId and .app.slug == $check.appSlug))) as $matching |
        if ($named | length) > 0 and ($matching | length) == 0 then
          {error:"identity-mismatch",name:$check.name}
        elif ($matching | length) == 0 then
          {name:$check.name,runId:null,appId:$check.appId,appSlug:$check.appSlug,
           status:"absent",conclusion:null,createdAt:null,startedAt:null,completedAt:null,
           acceptedConclusions:$check.acceptedConclusions}
        else
          ($matching | max_by([(.started_at // .created_at),.created_at,.id])) as $run |
          {name:$check.name,runId:($run.id|tostring),appId:$run.app.id,appSlug:$run.app.slug,
           status:$run.status,conclusion:$run.conclusion,createdAt:$run.created_at,
           startedAt:$run.started_at,completedAt:$run.completed_at,
           acceptedConclusions:$check.acceptedConclusions}
        end
      ] | sort_by([.name,.appId,.appSlug])
    ' >"$output" || return 1
}

_ci_repair_collect_evidence_impl() { # <repo> <branch> <scratch>
    local repo="$1" branch="$2" scratch="$3" rc=0 code authority=null
    local policy="$scratch/policy.json" evidence="$scratch/evidence.json"
    local endpoint head policy_digest evidence_json evidence_b64 evidence_key decision_key
    local first_seen first_epoch deadline_epoch deadline aggregate reason grace

    [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
        && git check-ref-format "refs/heads/$branch" >/dev/null 2>&1 \
        || { _ci_repair_error evidence-error invalid-target; return 2; }

    _CI_REPAIR_OBSERVED_EPOCH=0; _CI_REPAIR_OBSERVED_AT=""
    _ci_repair_registry_snapshot "$repo" "$branch" "$scratch" || rc=$?
    if [ "$rc" -ne 0 ]; then
        code="$(_ci_repair_http_error_code "$rc")"
        [ "$rc" -eq 30 ] && code=malformed-registry-ref
        [ "$rc" -eq 31 ] && code=malformed-registry-content
        case "$rc" in 32) code=malformed-registry ;; 33) code=duplicate-registry-name ;; 34) code=duplicate-registry-repository ;; 35) code=canonicalization-failed ;; esac
        _ci_repair_error evidence-error "$code"; return 2
    fi
    authority="$_CI_REGISTRY_AUTHORITY"

    _ci_repair_read_stored_authority "$repo" "$branch" || rc=$?
    if [ "$rc" -ne 0 ]; then
        [ "$rc" -eq 41 ] && code=stored-authority-invalid || code=chain-read-failed
        _ci_repair_error evidence-error "$code" "$authority"; return 2
    fi
    _ci_repair_validate_registry_descent "$scratch" || rc=$?
    if [ "$rc" -ne 0 ]; then
        code="$(_ci_repair_http_error_code "$rc")"
        [ "$rc" -eq 42 ] && code=registry-compare-invalid
        [ "$rc" -eq 43 ] && code=registry-rollback
        _ci_repair_error evidence-error "$code" "$authority"; return 2
    fi
    if [ "$_CI_REGISTRY_MODE" = off ]; then
        jq -cn --argjson authority "$authority" '{outcome:"off",authority:$authority}' \
            || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }
        return 0
    fi

    endpoint="repos/${repo}/git/ref/heads/$(_ci_repair_urlencode_component "$branch")"
    _ci_repair_http_get "$endpoint" "$scratch" target-ref || rc=$?
    if [ "$rc" -ne 0 ]; then _ci_repair_error evidence-error "$(_ci_repair_http_error_code "$rc")" "$authority"; return 2; fi
    _ci_repair_note_date
    head="$(jq -er 'select(.object.type == "commit") | .object.sha
        | select(type == "string" and test("^[0-9a-f]{40,64}$"))' "$_CI_HTTP_BODY_FILE" 2>/dev/null)" \
        || { _ci_repair_error evidence-error malformed-target-ref "$authority"; return 2; }

    endpoint="repos/${repo}/contents/${_CI_REPAIR_POLICY_PATH}?ref=${head}"
    _ci_repair_http_get "$endpoint" "$scratch" policy || rc=$?
    if [ "$rc" -ne 0 ]; then
        [ "$rc" -eq 23 ] && [ "${_CI_HTTP_STATUS:-}" = 404 ] \
            && code=policy-missing || code="$(_ci_repair_http_error_code "$rc")"
        if [ "$code" = policy-missing ]; then _ci_repair_error policy-invalid "$code" "$authority"; else _ci_repair_error evidence-error "$code" "$authority"; fi
        return 2
    fi
    _ci_repair_note_date
    _ci_repair_decode_content "$_CI_HTTP_BODY_FILE" "$policy" "$_CI_REPAIR_MAX_POLICY_BYTES" || rc=$?
    if [ "$rc" -ne 0 ] || ! _ci_repair_validate_policy "$policy"; then
        _ci_repair_error policy-invalid malformed-policy "$authority"; return 2
    fi
    policy_digest="$(_ci_repair_sha256 <"$policy")" || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }

    _ci_repair_collect_check_runs "$repo" "$head" "$scratch" || rc=$?
    if [ "$rc" -ne 0 ]; then
        code="$(_ci_repair_http_error_code "$rc")"
        case "$rc" in 60) code=malformed-check-run ;; 61) code=inconsistent-pagination ;; 62) code=too-many-check-runs ;; 63) code=too-many-pages ;; 64) code=canonicalization-failed ;; esac
        _ci_repair_error evidence-error "$code" "$authority"; return 2
    fi
    _ci_repair_build_evidence "$policy" "$_CI_REPAIR_RUNS_FILE" "$evidence" \
        || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }
    local predicate_rc=0
    jq -e 'any(.[]; has("error"))' "$evidence" >/dev/null || predicate_rc=$?
    if [ "$predicate_rc" -eq 0 ]; then
        _ci_repair_error policy-invalid identity-mismatch "$authority"; return 2
    elif [ "$predicate_rc" -gt 1 ]; then
        _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2
    fi

    # Stored monotonic timestamps are part of durable grace.  A malformed or
    # regressed same-head record fails closed instead of silently extending it.
    if [ "$_CI_REPAIR_STORED_HEAD" = "$head" ]; then
        [ -n "$_CI_REPAIR_STORED_FIRST_SEEN" ] || { _ci_repair_error evidence-error stored-first-seen-invalid "$authority"; return 2; }
        first_epoch="$(_cichain_timestamp_epoch "$_CI_REPAIR_STORED_FIRST_SEEN")" \
            || { _ci_repair_error evidence-error stored-first-seen-invalid "$authority"; return 2; }
        first_seen="$_CI_REPAIR_STORED_FIRST_SEEN"
        if [ -n "$_CI_REPAIR_STORED_OBSERVED_AT" ]; then
            local stored_observed_epoch
            stored_observed_epoch="$(_cichain_timestamp_epoch "$_CI_REPAIR_STORED_OBSERVED_AT")" \
                || { _ci_repair_error evidence-error stored-observed-at-invalid "$authority"; return 2; }
            [ "$_CI_REPAIR_OBSERVED_EPOCH" -ge "$stored_observed_epoch" ] \
                || { _ci_repair_error evidence-error clock-regression "$authority"; return 2; }
        fi
        [ "$_CI_REPAIR_OBSERVED_EPOCH" -ge "$first_epoch" ] \
            || { _ci_repair_error evidence-error clock-regression "$authority"; return 2; }
    else
        first_seen="$_CI_REPAIR_OBSERVED_AT"; first_epoch="$_CI_REPAIR_OBSERVED_EPOCH"
    fi
    grace="$(jq -er '.missingGateGraceSeconds | select(type == "number" and floor == .)' "$policy")" \
        || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }
    deadline_epoch=$((first_epoch + grace))
    deadline="$(date -u -d "@$deadline_epoch" +'%Y-%m-%dT%H:%M:%SZ')" \
        || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }

    local evidence_state
    evidence_state="$(jq -er '
      if any(.[]; . as $e | .status == "completed" and
           ($e.acceptedConclusions | index($e.conclusion)) == null) then "nonaccepted"
      elif all(.[]; . as $e | .status == "completed" and
           ($e.acceptedConclusions | index($e.conclusion)) != null) then "all-accepted"
      else "incomplete" end' "$evidence")" \
        || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }
    if [ "$evidence_state" = nonaccepted ]; then
        aggregate=red; reason=nonaccepted
    elif [ "$evidence_state" = all-accepted ]; then
        aggregate=green; reason=all-accepted
    elif [ "$_CI_REPAIR_OBSERVED_EPOCH" -ge "$deadline_epoch" ]; then
        aggregate=red; reason=grace-expired
    else
        aggregate=unknown; reason=grace-pending
    fi

    # acceptedConclusions is policy input used only for classification; it is
    # omitted from the persisted source-evidence schema.
    evidence_json="$(jq -cS 'map(del(.acceptedConclusions))' "$evidence")" \
        || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }
    [ "${#evidence_json}" -le 131072 ] \
        || { _ci_repair_error evidence-error evidence-too-large "$authority"; return 2; }
    evidence_b64="$(printf '%s' "$evidence_json" | _ci_repair_base64url)" \
        || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }
    evidence_key="$(jq -cnS --arg version ci-repair-evidence-v1 --arg head "$head" \
        --arg policyDigest "$policy_digest" --argjson evidence "$evidence_json" \
        '{version:$version,head:$head,policyDigest:$policyDigest,evidence:$evidence}' \
        | _ci_repair_sha256)" \
        || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }
    decision_key="$(jq -cnS --arg version ci-repair-decision-v1 --arg evidenceKey "$evidence_key" \
        --arg firstSeen "$first_seen" --arg deadline "$deadline" --arg aggregate "$aggregate" \
        --arg reason "$reason" --arg mode "$_CI_REGISTRY_MODE" \
        '{version:$version,evidenceKey:$evidenceKey,firstSeen:$firstSeen,deadline:$deadline,
          aggregate:$aggregate,reason:$reason,enrollmentMode:$mode}' | _ci_repair_sha256)" \
        || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }

    jq -cn --argjson authority "$authority" --arg head "$head" \
        --arg observedAt "$_CI_REPAIR_OBSERVED_AT" --arg firstSeen "$first_seen" \
        --arg deadline "$deadline" --arg policyDigest "$policy_digest" \
        --arg evidence "$evidence_b64" --arg evidenceKey "$evidence_key" \
        --arg decisionKey "$decision_key" --arg aggregate "$aggregate" --arg reason "$reason" \
        '{outcome:"observation",authority:$authority,head:$head,observedAt:$observedAt,
          headFirstSeenAt:$firstSeen,deadline:$deadline,policyDigest:$policyDigest,
          requiredEvidence:$evidence,evidenceKey:$evidenceKey,decisionKey:$decisionKey,
          aggregate:$aggregate,reason:$reason}' \
        || { _ci_repair_error evidence-error canonicalization-failed "$authority"; return 2; }
}

_ci_repair_collect_evidence() {
    if [ "$#" -ne 2 ]; then
        _ci_repair_error evidence-error caller-authority-rejected
        return 2
    fi
    local scratch rc=0
    scratch="$(mktemp -d)" || { _ci_repair_error evidence-error scratch-failure; return 2; }
    _ci_repair_collect_evidence_impl "$1" "$2" "$scratch" || rc=$?
    rm -rf "$scratch"
    return "$rc"
}

# ---------------------------------------------------------------------------
# Repair-superseded audit validation
#
# `repair-retire` (implemented by a dependent task) records one immutable,
# non-scheduling audit ref for each retired repair issue. Strict validation is
# defined before the writer so malformed audits can never be legitimised by
# adding a broad namespace alone.
# ---------------------------------------------------------------------------
_REPAIR_SUPERSEDED_V1_PARENT_FIELDS=(
    Current-Head Last-Green First-Red State Repair-Mode Repair-Issue
    Repair-Attempt Fail-Signature Same-Sig-Count
    Observed-Head Policy-Digest Aggregate Required-Evidence
    Head-First-Seen-At Observed-At Evidence-Key Decision-Key
    Registry-Commit Registry-Blob Enrollment-Mode
    Reconcile-Status Reconcile-Error
    Reconcile-Lease-Owner Reconcile-Lease-Until Reconcile-Fence
)

taskdag_repair_superseded_violations() { # <commit> <full-ref>
    local sha="$1" ref="$2" identity="${ref##*/}" message subject tree parent
    local field line key count expected_identity parent_subject chain_ref chain_tip
    local retired_epoch lease_until_epoch updated_epoch parent_value subject_count
    local -A values=()
    local -a fields=(
        Repository Branch Issue First-Red Canonical-Issue Reason
        Registry-Commit Registry-Blob Decision-Key Reconcile-Fence Retired-At
    )

    if ! [[ "$ref" =~ ^refs/heads/tasks/repair-superseded/[0-9a-f]{64}$ ]]; then
        echo "✗ ${ref}: malformed repair-superseded ref; expected exactly one 64-lowercase-hex identity"
        return 0
    fi
    if [ "$(git cat-file -t "$sha" 2>/dev/null || true)" != commit ]; then
        echo "✗ ${ref}: repair-superseded audit target is not a commit"
        return 0
    fi
    tree="$(git rev-parse "${sha}^{tree}" 2>/dev/null || true)"
    if [ "$tree" != "$EMPTY_TREE" ]; then
        echo "✗ ${ref}: repair-superseded audit must use the empty tree"
    fi
    if [ "$(git rev-list --parents -n 1 "$sha" 2>/dev/null | awk '{ print NF - 1 }')" -ne 1 ]; then
        echo "✗ ${ref}: repair-superseded audit must have exactly one authorizing chain parent"
        return 0
    fi
    parent="$(git rev-parse "${sha}^" 2>/dev/null || true)"
    message="$(git log -1 --format=%B "$sha" 2>/dev/null)" || {
        echo "✗ ${ref}: repair-superseded audit message is unreadable"
        return 0
    }
    subject="$(printf '%s\n' "$message" | sed -n '1p')"
    subject_count="$(printf '%s\n' "$message" | awk '$0 == "Repair-Superseded: v1" { n++ } END { print n + 0 }')"
    if [ "$subject" != "Repair-Superseded: v1" ] || [ "$subject_count" -ne 1 ]; then
        echo "✗ ${ref}: audit subject must be 'Repair-Superseded: v1'"
    fi

    for field in "${fields[@]}"; do
        count="$(printf '%s\n' "$message" | awk -v prefix="${field}: " 'index($0, prefix) == 1 { n++ } END { print n + 0 }')"
        if [ "$count" -ne 1 ]; then
            echo "✗ ${ref}: audit requires exactly one ${field} field"
        fi
        values["$field"]="$(printf '%s\n' "$message" | sed -n "s/^${field}: //p" | head -1)"
    done

    # Reject unknown nonblank protocol lines. This makes the audit immutable
    # and prevents a future writer from smuggling a second interpretation into
    # a commit that an older strict validator would otherwise accept.
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        [ "$line" = "Repair-Superseded: v1" ] && continue
        if ! [[ "$line" =~ ^([A-Za-z-]+):\ (.*)$ ]]; then
            echo "✗ ${ref}: unexpected audit protocol line '$line'"
            continue
        fi
        key="${BASH_REMATCH[1]}"
        case " $key " in
            " Repository "|" Branch "|" Issue "|" First-Red "|" Canonical-Issue "|" Reason "|" Registry-Commit "|" Registry-Blob "|" Decision-Key "|" Reconcile-Fence "|" Retired-At ") ;;
            *) echo "✗ ${ref}: unexpected audit protocol line '$line'" ;;
        esac
    done <<< "$message"

    [[ "${values[Repository]}" =~ ^[a-z0-9._-]+/[a-z0-9._-]+$ ]] \
        || echo "✗ ${ref}: Repository must be canonical lowercase owner/repo"
    [ -n "${values[Branch]}" ] && _cichain_single_line "${values[Branch]}" \
        || echo "✗ ${ref}: Branch must be nonempty and single-line"
    [[ "${values[Issue]}" =~ ^#[1-9][0-9]*$ ]] \
        || echo "✗ ${ref}: Issue must be # followed by canonical positive decimal"
    [[ "${values[First-Red]}" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] \
        || echo "✗ ${ref}: First-Red must be a full lowercase commit id"
    if [ "${values[Canonical-Issue]}" != none ] \
        && ! [[ "${values[Canonical-Issue]}" =~ ^#[1-9][0-9]*$ ]]; then
        echo "✗ ${ref}: Canonical-Issue must be none or # followed by canonical positive decimal"
    fi
    case "${values[Reason]}" in
        duplicate|stale-chain|green|downgrade|non-fast-forward) ;;
        *) echo "✗ ${ref}: Reason is not a recognised repair-retirement reason" ;;
    esac
    [[ "${values[Registry-Commit]}" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] \
        || echo "✗ ${ref}: Registry-Commit must be a full lowercase object id"
    [[ "${values[Registry-Blob]}" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] \
        || echo "✗ ${ref}: Registry-Blob must be a full lowercase object id"
    [[ "${values[Decision-Key]}" =~ ^sha256:[0-9a-f]{64}$ ]] \
        || echo "✗ ${ref}: Decision-Key must be sha256:<64-lowercase-hex>"
    if ! [[ "${values[Reconcile-Fence]}" =~ ^[1-9][0-9]{0,17}$ ]] \
        || [ "${values[Reconcile-Fence]}" -gt 999999999999999999 ]; then
        echo "✗ ${ref}: Reconcile-Fence must be a canonical positive bounded integer"
    fi
    retired_epoch="$(_cichain_timestamp_epoch "${values[Retired-At]}" 2>/dev/null || true)"
    [ -n "$retired_epoch" ] || echo "✗ ${ref}: Retired-At must be canonical UTC"

    expected_identity="$(printf 'repair-superseded-v1\0%s\0%s\0%s\0%s' \
        "${values[Repository]}" "${values[Branch]}" "${values[First-Red]}" \
        "${values[Issue]#\#}" | sha256sum | awk '{ print $1 }')"
    [ "$identity" = "$expected_identity" ] \
        || echo "✗ ${ref}: ref identity does not match the semantic audit tuple"

    if [ "$(git cat-file -t "$parent" 2>/dev/null || true)" != commit ] \
        || [ "$(git rev-parse "${parent}^{tree}" 2>/dev/null || true)" != "$EMPTY_TREE" ]; then
        echo "✗ ${ref}: authorizing parent must be an empty-tree CI-chain commit"
        return 0
    fi
    parent_subject="$(git log -1 --format=%s "$parent" 2>/dev/null || true)"
    if [ "$parent_subject" != "CI-Chain: ${values[Repository]}@${values[Branch]}" ]; then
        echo "✗ ${ref}: authorizing parent is not the audited repository/branch CI chain"
    fi
    chain_ref="$(_cichain_ref "${values[Repository]}" "${values[Branch]}")"
    chain_tip="$(git rev-parse --verify --quiet "$chain_ref" 2>/dev/null || true)"
    if [ -z "$chain_tip" ] || ! git rev-list --first-parent "$chain_tip" 2>/dev/null \
        | awk -v wanted="$parent" '$0 == wanted { found=1 } END { exit !found }'; then
        echo "✗ ${ref}: authorizing parent is not in the canonical CI-chain ref history"
    fi
    # V1 audits are immutable, so their parent schema is frozen too. A future
    # chain field must not retroactively invalidate historical V1 audits;
    # requiring a larger parent protocol needs a new audit version.
    for field in "${_REPAIR_SUPERSEDED_V1_PARENT_FIELDS[@]}"; do
        [ "$(_cichain_field_count "$parent" "$field")" -eq 1 ] \
            || echo "✗ ${ref}: authorizing parent requires exactly one canonical ${field} field"
    done
    if [ "$(_cichain_field_count "$parent" Updated-At)" -ne 1 ]; then
        echo "✗ ${ref}: authorizing parent requires exactly one Updated-At field"
    fi
    for field in First-Red Registry-Commit Registry-Blob Decision-Key Reconcile-Fence; do
        if [ "$(_cichain_field_count "$parent" "$field")" -ne 1 ]; then
            echo "✗ ${ref}: authorizing parent requires exactly one ${field} field"
            continue
        fi
        parent_value="$(_cichain_field "$parent" "$field")"
        [ "$parent_value" = "${values[$field]}" ] \
            || echo "✗ ${ref}: ${field} disagrees with the authorizing chain parent"
    done
    for field in Reconcile-Lease-Owner Reconcile-Lease-Until; do
        [ "$(_cichain_field_count "$parent" "$field")" -eq 1 ] \
            || echo "✗ ${ref}: authorizing parent requires exactly one ${field} field"
    done
    parent_value="$(_cichain_field "$parent" Reconcile-Lease-Owner)"
    [[ "$parent_value" =~ ^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$ ]] \
        || echo "✗ ${ref}: authorizing parent has an invalid reconciliation owner"
    lease_until_epoch="$(_cichain_timestamp_epoch "$(_cichain_field "$parent" Reconcile-Lease-Until)" 2>/dev/null || true)"
    updated_epoch="$(_cichain_timestamp_epoch "$(_cichain_field "$parent" Updated-At)" 2>/dev/null || true)"
    [ -n "$updated_epoch" ] || echo "✗ ${ref}: authorizing parent has an invalid Updated-At"
    if [ -z "$lease_until_epoch" ]; then
        echo "✗ ${ref}: authorizing parent has an invalid reconciliation deadline"
    elif [ -n "$retired_epoch" ] && [ -n "$updated_epoch" ] \
        && [ "$retired_epoch" -lt "$updated_epoch" ]; then
        echo "✗ ${ref}: Retired-At predates the authorizing lease state"
    elif [ -n "$retired_epoch" ] && [ "$retired_epoch" -ge "$lease_until_epoch" ]; then
        echo "✗ ${ref}: Retired-At is not within the authorizing lease"
    fi
    return 0
}

# ---------------------------------------------------------------------------
# parse-tree-fix
#
# A repair worker marks its fix commit with trailers the classifier interprets:
#
#   Tree-Fix: owner/repo#123          # the repair ticket
#   Tree-Fix-Chain: <first-red-full-sha>
#   Tree-Fix-Mode: initial            # or: continue
#
# This parser extracts and validates them. It is pure and side-effect-free:
# it reads a commit message (from a commit-ish, default HEAD, or from --stdin)
# and writes only to stdout/stderr; it mutates no refs.
#
# Trailers are parsed with `git interpret-trailers --parse` (NOT freeform grep),
# so it honours the same trailer grammar `git` itself uses.
#
# Exit codes:
#   0  parsed successfully (whether or not the commit is a tree-fix; check the
#      treeFix flag / output)
#   2  malformed tree-fix commit (a Tree-Fix trailer is present but the trio is
#      incomplete, a value is invalid, or a trailer is duplicated)
#   1  usage / resolution error
# ---------------------------------------------------------------------------
cmd_parse_tree_fix() {
    local commitish="" use_stdin=false as_json=false

    while [ $# -gt 0 ]; do
        case "$1" in
            --stdin) use_stdin=true; shift ;;
            --json) as_json=true; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag parse-tree-fix [<commit-ish>] [--stdin] [--json]

Parse the Tree-Fix / Tree-Fix-Chain / Tree-Fix-Mode trailers of a commit
message (broken-master auto-repair, design section 3), using
`git interpret-trailers`. Pure: reads a message, mutates nothing.

Sources (pick one):
  <commit-ish>   read the message of this commit (default: HEAD)
  --stdin        read the raw commit message from stdin instead

Options:
  --json         emit machine-readable JSON

Output (human): "not a tree-fix commit", or the three trailer lines.
Output (--json): {"treeFix":false} or
                 {"treeFix":true,"ticket":"owner/repo#N","chain":"<sha>","mode":"initial|continue"}

Exit: 0 parsed (tree-fix or not); 2 malformed tree-fix; 1 usage/resolve error.
EOF
                return 0
                ;;
            -*)
                echo "Unknown option: $1" >&2
                return 1
                ;;
            *)
                if [ -z "$commitish" ]; then
                    commitish="$1"
                else
                    echo "Error: unexpected extra argument '$1'" >&2
                    return 1
                fi
                shift
                ;;
        esac
    done

    # Obtain the commit message.
    local message
    if [ "$use_stdin" = true ]; then
        if [ -n "$commitish" ]; then
            echo "Error: pass either <commit-ish> or --stdin, not both" >&2
            return 1
        fi
        message="$(cat)"
    else
        local sha
        sha="$(resolve_sha "${commitish:-HEAD}")" || return 1
        message="$(git log -1 --format='%B' "$sha")"
    fi

    # Extract only the trailer block. `--parse` emits one "Key: value" line per
    # recognised trailer (folding multi-line values), and nothing else.
    local trailers
    trailers="$(printf '%s\n' "$message" | git interpret-trailers --parse 2>/dev/null)"

    # Count + collect each key (case-insensitive on the token, as git does).
    local key
    local -A count=()
    local fix="" chain="" mode=""
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        key="${line%%:*}"
        local val="${line#*: }"
        case "$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" in
            tree-fix)       count[fix]=$(( ${count[fix]:-0} + 1 ));       fix="$val" ;;
            tree-fix-chain) count[chain]=$(( ${count[chain]:-0} + 1 ));   chain="$val" ;;
            tree-fix-mode)  count[mode]=$(( ${count[mode]:-0} + 1 ));     mode="$val" ;;
        esac
    done <<< "$trailers"

    # No Tree-Fix trailer at all: this is simply not a tree-fix commit.
    if [ "${count[fix]:-0}" -eq 0 ]; then
        # A stray chain/mode without a Tree-Fix is malformed, not "absent".
        if [ "${count[chain]:-0}" -gt 0 ] || [ "${count[mode]:-0}" -gt 0 ]; then
            echo "Error: Tree-Fix-Chain/Tree-Fix-Mode present without a Tree-Fix trailer" >&2
            return 2
        fi
        if [ "$as_json" = true ]; then
            echo '{"treeFix":false}'
        else
            echo "not a tree-fix commit"
        fi
        return 0
    fi

    # A tree-fix commit MUST carry exactly one of each of the three trailers.
    if [ "${count[fix]:-0}" -gt 1 ] || [ "${count[chain]:-0}" -gt 1 ] || [ "${count[mode]:-0}" -gt 1 ]; then
        echo "Error: duplicate Tree-Fix* trailer(s) (fix=${count[fix]:-0} chain=${count[chain]:-0} mode=${count[mode]:-0})" >&2
        return 2
    fi
    if [ "${count[chain]:-0}" -ne 1 ] || [ "${count[mode]:-0}" -ne 1 ]; then
        echo "Error: a Tree-Fix commit must carry Tree-Fix, Tree-Fix-Chain and Tree-Fix-Mode" >&2
        return 2
    fi

    # Validate each value's shape.
    if ! printf '%s' "$fix" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+$'; then
        echo "Error: Tree-Fix must be 'owner/repo#N' (got '$fix')" >&2
        return 2
    fi
    if ! printf '%s' "$chain" | grep -Eq '^[0-9a-f]{40,64}$'; then
        echo "Error: Tree-Fix-Chain must be a full commit SHA (got '$chain')" >&2
        return 2
    fi
    if [ "$mode" != "initial" ] && [ "$mode" != "continue" ]; then
        echo "Error: Tree-Fix-Mode must be 'initial' or 'continue' (got '$mode')" >&2
        return 2
    fi

    if [ "$as_json" = true ]; then
        printf '{"treeFix":true,"ticket":%s,"chain":%s,"mode":%s}\n' \
            "$(json_escape "$fix")" "$(json_escape "$chain")" "$(json_escape "$mode")"
    else
        printf 'Tree-Fix: %s\nTree-Fix-Chain: %s\nTree-Fix-Mode: %s\n' "$fix" "$chain" "$mode"
    fi
    return 0
}

# ---------------------------------------------------------------------------
# classify  (CI broken-master auto-repair, design §2 + §4)
#
# The classifier CORE: given a CI result for one commit on <owner/repo>@<branch>,
# classify the aggregate required-gate result as green/red/unknown and drive the
# repair-chain state machine on top of the chain-read/chain-write primitives:
#
#   * RED, no chain open      -> OPEN one chain anchored at First-Red=<for-sha>
#                                (Repair-Mode=initial, Repair-Attempt=1). The
#                                caller should now file exactly ONE repair
#                                ticket (action=open).
#   * RED, chain already open -> CONTINUATION: advance Current-Head to <for-sha>
#                                (First-Red unchanged). One chain per red streak.
#   * GREEN, and <for-sha> is the CURRENT branch HEAD -> CLOSE the open chain
#                                (State=green, Last-Green=<for-sha>, clear the
#                                repair fields). The caller closes the ticket
#                                (action=close).
#   * GREEN, but NOT current  -> do nothing: a newer commit may yet be red, so
#                                we "close green only when current" (design §4).
#   * UNKNOWN                  -> leave chain state untouched (a transient
#                                unknown must not close an open red chain).
#
# Design §4 race/stale handling. We act RELATIVE TO THE CURRENT origin/<branch>
# HEAD and IGNORE SUPERSEDED SHAs:
#   - currency is established against the live branch tip (origin ls-remote, or
#     --current-head for offline/deterministic callers). We act ONLY when
#     <for-sha> IS that tip; any other SHA is a run the branch has already
#     moved on from and is treated as superseded;
#   - if the tip cannot be established we FAIL CLOSED (exit 4) rather than
#     mutate chain state off an unknown HEAD (override: --allow-stale);
#   - a RED that is not current is a superseded/out-of-order CI run and is
#     IGNORED (exit 6) unless --allow-stale;
#   - a GREEN that is not current never closes (or records on) a chain;
#   - every mutating write is CAS-bound to the chain state this command read
#     (chain-write --expect-old) AND rides chain-write's own ancestry stale
#     guard, so a concurrent classifier or an out-of-order run can never
#     clobber newer chain state (it loses the CAS and returns 5).
#
# This command owns ONLY the classification + chain open/update/close decision.
# Filing/closing the actual GitHub repair ticket and the tree-fix continue-mode
# escalation are separate leaves of #1; this command reports the required ticket
# action (open|close|none) so its caller can perform it idempotently.
#
# Usage:
#   task-dag classify <owner/repo> <branch> --for-sha=<commit>
#       (--result=green|red|unknown | --gate=<conclusion> [--gate=...])
#       [--current-head=<sha>] [--repair-issue=<n>] [--allow-stale]
#       [--dry-run] [--json] [--no-fetch]
#
# Exit codes:
#   0  classified; the resulting action was applied (or a valid no-op)
#   1  argument error
#   4  git/origin error (unreachable, or a write could not be confirmed)
#   5  lost the chain-write CAS race (a concurrent writer won)
#   6  superseded/stale: ignored relative to the current branch HEAD
# ---------------------------------------------------------------------------

# Aggregate individual required-gate conclusions into green/red/unknown.
# Red dominates (any failing required gate => red); otherwise any gate that is
# neither clearly-passing nor clearly-failing (pending/empty/stale/...) makes
# the aggregate unknown; only an all-passing set is green.
_ci_aggregate_gates() {
    local c lc any_unknown=false saw=false
    for c in "$@"; do
        saw=true
        lc="$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')"
        case "$lc" in
            failure|cancelled|timed_out|action_required|startup_failure)
                printf 'red'; return 0 ;;
            success|skipped|neutral) ;;
            *) any_unknown=true ;;
        esac
    done
    if [ "$saw" = false ] || [ "$any_unknown" = true ]; then
        printf 'unknown'
    else
        printf 'green'
    fi
}

cmd_classify() {
    local repo="" branch="" for_sha="" result="" current_head="" repair_issue=""
    local allow_stale=false dry_run=false json=false do_fetch=true
    local -a gates=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --for-sha=*) for_sha="${1#*=}"; shift ;;
            --result=*) result="${1#*=}"; shift ;;
            --gate=*) gates+=("${1#*=}"); shift ;;
            --gate)
                shift
                [ $# -gt 0 ] || { echo "Error: --gate requires a value" >&2; return 1; }
                gates+=("$1"); shift ;;
            --current-head=*) current_head="${1#*=}"; shift ;;
            --repair-issue=*) repair_issue="${1#*=}"; shift ;;
            --allow-stale) allow_stale=true; shift ;;
            --dry-run) dry_run=true; shift ;;
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help | -h)
                cat <<EOF
Usage: task-dag classify <owner/repo> <branch> --for-sha=<commit> \\
         (--result=green|red|unknown | --gate=<conclusion> [--gate=...]) [options]

CI broken-master auto-repair classifier core (design §2 + §4). Classifies a
commit's aggregate required-gate result and drives the repair-chain state
machine (open one chain per red streak anchored at First-Red, advance
Current-Head on continuation reds, close on green only when current). Acts
relative to the current origin/<branch> HEAD and ignores superseded SHAs.

Result (pick one):
  --result=<v>         green | red | unknown (precomputed aggregate)
  --gate=<conclusion>  a required-gate conclusion (repeatable); aggregated as
                       red (any failure) > unknown (any pending/other) > green

Options:
  --for-sha=<commit>   REQUIRED; the commit this CI run is about
  --current-head=<sha> the live branch tip (default: origin ls-remote)
  --repair-issue=<n>   record the repair ticket number on a freshly-opened chain
  --allow-stale        act even when --for-sha is superseded by the branch tip
  --dry-run            compute + report the action without writing chain state
  --json               machine-readable result
  --no-fetch           skip fetching the prior chain ref / branch tip object

Reported action: open | continue | close | noop-green-noncurrent |
                 noop-unknown | noop-green-nochain | noop-blocked
Ticket hint:     open (file ONE repair ticket) | close (close it) | none

Exit: 0 applied/no-op  1 args  4 git/origin  5 CAS race  6 superseded/stale.
EOF
                return 0
                ;;
            -*) echo "Unknown option: $1" >&2; return 1 ;;
            *)
                if [ -z "$repo" ]; then repo="$1"
                elif [ -z "$branch" ]; then branch="$1"
                else echo "Unexpected argument: $1" >&2; return 1
                fi
                shift
                ;;
        esac
    done

    if [ -z "$repo" ] || [ -z "$branch" ]; then
        echo "Error: <owner/repo> and <branch> are required" >&2
        return 1
    fi
    if [ -z "$for_sha" ]; then
        echo "Error: --for-sha=<commit> is required" >&2
        return 1
    fi
    if [ -z "$result" ] && [ "${#gates[@]}" -eq 0 ]; then
        echo "Error: pass --result=<v> or at least one --gate=<conclusion>" >&2
        return 1
    fi
    if [ -n "$result" ] && [ "${#gates[@]}" -gt 0 ]; then
        echo "Error: pass either --result or --gate(s), not both" >&2
        return 1
    fi

    # --for-sha must be a full, immutable commit SHA that is present locally.
    # This command is driven by CI event SHAs, so we reject anything else
    # (abbreviated SHAs, HEAD, branch/tag names, remote-only or junk values):
    # an ambiguous/mutable ref must never be the basis for a currency or chain
    # decision, nor be stored as Current-Head.
    if ! printf '%s' "$for_sha" | grep -Eq '^[0-9a-f]{40,64}$'; then
        echo "Error: --for-sha must be a full commit SHA (got '$for_sha')" >&2
        return 1
    fi
    local for_sha_full
    if ! for_sha_full="$(git rev-parse --verify --quiet "${for_sha}^{commit}" 2>/dev/null)"; then
        echo "Error: --for-sha must resolve to a commit object present locally (got '$for_sha')" >&2
        return 1
    fi
    for_sha="$for_sha_full"

    # Aggregate the classification.
    if [ -z "$result" ]; then
        result="$(_ci_aggregate_gates "${gates[@]}")"
    fi
    case "$result" in
        green | red | unknown) ;;
        *) echo "Error: --result must be green|red|unknown (got '$result')" >&2; return 1 ;;
    esac

    # ── Currency (design §4): act relative to the current branch HEAD ──────
    # Establish the LIVE branch tip so we can tell a current run from a stale,
    # superseded one. Prefer an explicit --current-head (offline/deterministic
    # callers + tests); otherwise read it from origin. We act ONLY on the
    # commit that is the current tip: any other --for-sha is, by definition, a
    # run the branch has already moved on from (out-of-order / superseded), so
    # it is ignored unless --allow-stale. This is the fail-closed reading of
    # "act relative to the current origin/<branch> HEAD; ignore superseded
    # SHAs": we never mutate chain state off a tip we could not establish.
    local tip="" tip_known=false
    if [ -n "$current_head" ]; then
        tip="$(git rev-parse --verify --quiet "${current_head}^{commit}" 2>/dev/null || true)"
        if [ -z "$tip" ]; then
            if printf '%s' "$current_head" | grep -Eq '^[0-9a-f]{40,64}$'; then
                tip="$current_head"
            else
                echo "Error: --current-head must resolve to a commit or be a full SHA (got '$current_head')" >&2
                return 1
            fi
        fi
        tip_known=true
    else
        local lsr
        if lsr="$(git ls-remote origin "refs/heads/${branch}" 2>/dev/null)"; then
            tip="$(printf '%s' "$lsr" | awk '{print $1; exit}')"
            [ -n "$tip" ] && tip_known=true
        fi
    fi

    # is_current: for_sha IS the live branch tip. If the tip is indeterminate
    # (origin unreachable, branch absent) we cannot prove currency: fail closed
    # (refuse to act) unless the operator forces it with --allow-stale. Note
    # is_current stays the pure currency fact; --allow-stale is applied in the
    # decision below so it can force a non-current write through deliberately.
    local is_current=false
    if [ "$tip_known" = true ]; then
        [ "$tip" = "$for_sha" ] && is_current=true
    elif [ "$allow_stale" = false ]; then
        echo "Error: cannot determine the live HEAD of $repo@$branch; pass --current-head or --allow-stale" >&2
        return 4
    fi

    # ── Prior chain state ─────────────────────────────────────────────────
    local ref old=""
    ref="$(_cichain_ref "$repo" "$branch")"
    if [ "$do_fetch" = true ]; then
        if old="$(_cichain_remote_sha "$ref")"; then
            [ -n "$old" ] && _cichain_fetch "$ref"
        else
            old="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
        fi
    else
        old="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
    fi
    # The read→decide→write CAS invariant requires that we actually READ the
    # prior chain commit. If origin advertises a chain SHA we could not
    # materialise (a transient fetch failure on a shallow/cold checkout), its
    # fields parse as empty and an open red chain would look like "none open" —
    # we'd wrongly decide 'open', re-anchor First-Red, and emit a duplicate
    # ticket hint. Fail closed instead (deepen history / fetch and retry).
    if [ -n "$old" ] && ! git cat-file -e "${old}^{commit}" 2>/dev/null; then
        echo "Error: chain state $ref=$old is unavailable locally; cannot classify safely (fetch/deepen and retry)" >&2
        return 4
    fi
    # chain_open: an active red streak accepting plain continuations.
    # chain_blocked: a chain parked by the tree-fix escalation threshold
    # (design §3) — still ACTIVE (a green must close it) but NOT repairable, so
    # a fresh red must NOT silently open a second chain over it.
    local prior_state="" prior_first_red="" chain_open=false chain_blocked=false
    if [ -n "$old" ]; then
        prior_state="$(_cichain_field "$old" State)"
        prior_first_red="$(_cichain_field "$old" First-Red)"
        [ "$prior_state" = "red" ] && chain_open=true
        [ "$prior_state" = "blocked" ] && chain_blocked=true
    fi

    # ── Decide the action ─────────────────────────────────────────────────
    # Every mutating decision is CAS-bound to the chain SHA we just read
    # (--expect-old="$old"): if a concurrent classifier moves the chain between
    # our read and our write, chain-write returns 5 and we surface it (the
    # caller retries from fresh state) rather than clobbering it. This is what
    # keeps "one chain per red streak / one repair ticket" true under races.
    local action="" ticket="none"
    local -a write_args=()
    case "$result" in
        red)
            if [ "$is_current" = false ] && [ "$allow_stale" = false ]; then
                # Superseded / out-of-order run: the branch already moved past
                # this SHA. Ignore it (design §4) unless --allow-stale.
                action="noop-stale"
            elif [ "$chain_open" = true ]; then
                # Continuation red: advance Current-Head, keep the chain + its
                # First-Red. One chain per red streak.
                action="continue"
                write_args=(--state=red)
            elif [ "$chain_blocked" = true ]; then
                # The chain was parked by the tree-fix escalation threshold:
                # a human is already paged. A further red must NOT reopen a new
                # chain (that would un-block it); stand down.
                action="noop-blocked"
            else
                # Fresh red streak: open ONE chain anchored at First-Red here.
                action="open"
                ticket="open"
                write_args=(--state=red --first-red="$for_sha"
                            --repair-mode=initial --repair-attempt=1)
                [ -n "$repair_issue" ] && write_args+=(--repair-issue="$repair_issue")
            fi
            ;;
        green)
            if [ "$is_current" = false ] && [ "$allow_stale" = false ]; then
                # Green but not current: a newer commit may be red; never close
                # or record off a stale green. "Close green only when current."
                action="noop-green-noncurrent"
            elif [ "$chain_open" = true ] || [ "$chain_blocked" = true ]; then
                # Close the chain: green AND current (design §4). Green recovers
                # an escalation-BLOCKED chain too, clearing the repair fields.
                action="close"
                ticket="close"
                write_args=(--state=green --last-green="$for_sha"
                            --set First-Red= --set Repair-Mode=
                            --set Repair-Issue= --set Repair-Attempt=
                            --set Fail-Signature= --set Same-Sig-Count=)
            else
                # No open chain, current green: record the green watermark.
                action="noop-green-nochain"
                write_args=(--state=green --last-green="$for_sha")
            fi
            ;;
        unknown)
            # Unknown classification: never opens, advances, or closes a chain.
            action="noop-unknown"
            ;;
    esac

    # ── Report ────────────────────────────────────────────────────────────
    # NB: the ticket hint (open|close) is valid ONLY when applied=true (the
    # chain transition actually landed). A failed/aborted write reports
    # ticket=none + applied=false so a ticket leaf that parses JSON can never
    # file/close off a write that did not happen.
    _classify_report() { # <rc> <applied:true|false>
        local rc="$1" applied="$2" tk="$ticket"
        [ "$applied" = true ] || tk="none"
        if [ "$json" = true ]; then
            printf '{"result":%s,"action":%s,"ticket":%s,"current":%s,"applied":%s,"ref":%s,"forSha":%s,"firstRed":%s,"priorState":%s,"rc":%s}\n' \
                "$(json_escape "$result")" "$(json_escape "$action")" "$(json_escape "$tk")" "$is_current" "$applied" \
                "$(json_escape "$ref")" "$(json_escape "$for_sha")" \
                "$(json_escape "${prior_first_red:-}")" "$(json_escape "${prior_state:-}")" "$rc"
        else
            printf "${BOLD}classify %s@%s${RESET} result=%s action=%s ticket=%s (current=%s applied=%s rc=%s)\n" \
                "$repo" "$branch" "$result" "$action" "$tk" "$is_current" "$applied" "$rc"
        fi
    }

    if [ "$action" = "noop-stale" ]; then
        [ "$json" = false ] && printf "${YELLOW}Superseded CI run: %s is not the current %s HEAD — ignoring (design §4).${RESET}\n" "$for_sha" "$branch" >&2
        _classify_report 6 false
        return 6
    fi

    # Pure no-ops (nothing to persist): unknown, and green-but-not-current.
    if [ "${#write_args[@]}" -eq 0 ]; then
        _classify_report 0 false
        return 0
    fi

    if [ "$dry_run" = true ]; then
        [ "$json" = false ] && printf "${BLUE}(dry-run: would chain-write %s)${RESET}\n" "${write_args[*]}" >&2
        _classify_report 0 false
        return 0
    fi

    # ── Apply via the CAS/stale-safe primitive ────────────────────────────
    # --expect-old binds this write to the state we read; --allow-stale (when
    # set) additionally bypasses chain-write's own ancestry stale guard.
    local -a extra=(--expect-old="$old")
    [ "$allow_stale" = true ] && extra+=(--allow-stale)
    local wrc=0 wout
    wout="$(cmd_chain_write "$repo" "$branch" --for-sha="$for_sha" --json \
        "${extra[@]}" "${write_args[@]}" 2>&1)" || wrc=$?

    if [ "$wrc" -ne 0 ]; then
        # Map chain-write's exit codes through unchanged (5 race/expect-mismatch,
        # 6 stale, 4 git). applied=false => ticket hint suppressed.
        if [ "$json" = false ]; then
            printf "${RED}classify: chain-write failed (rc=%s) for %s@%s action=%s${RESET}\n" \
                "$wrc" "$repo" "$branch" "$action" >&2
            printf '%s\n' "$wout" >&2
        else
            _classify_report "$wrc" false
        fi
        return "$wrc"
    fi

    _classify_report 0 true
    return 0
}

# ---------------------------------------------------------------------------
# tree-fix-outcome  (CI broken-master auto-repair, design §3)
#
# The TREE-FIX-AWARE outcome handler. The classifier dispatch is EXCLUSIVE: an
# ordinary master commit goes to `classify` (§2); a commit carrying the Tree-Fix
# / Tree-Fix-Chain / Tree-Fix-Mode trailers (a worker's repair attempt) goes
# HERE instead, so the chain head is advanced exactly once per commit and the
# idempotency guard below ("already the chain head") is unambiguous. This command
# applies the design §3 escalation table:
#
#   | tree-fix outcome              | action                                  |
#   |-------------------------------|-----------------------------------------|
#   | master now GREEN              | close the chain + clear repair fields;  |
#   |                               | caller closes the repair ticket.        |
#   | RED, parent still in the chain| SAME chain; Repair-Mode=continue,       |
#   | (continuation)                | Repair-Attempt++; caller files a new    |
#   |                               | CONTINUE-mode repair task (no first-red |
#   |                               | back-off). State stays red.             |
#   | RED, parent was GREEN         | NEW regression: open a fresh initial    |
#   | (no open chain)               | chain anchored at the tree-fix commit.  |
#   | repeated continue failures    | after a small threshold, State=blocked  |
#   | with the SAME signature       | + page once; stop churning continue     |
#   |                               | tasks (a human takes over).             |
#
# Like `classify`, this command is PURE: it only drives the durable chain state
# (CAS-bound, currency- and stale-safe) and REPORTS hints. It never touches
# GitHub or pages directly — it reports ticketAction (open|close|update|block|
# none), taskAction (initial|continue|none) and page (true|false) so the
# GitHub-side caller (`repair-ticket`) files the one ticket / continue task and
# the operator-pager acts on them idempotently (same separation as classify).
#
# The design's ESCALATED state is represented as State=red + Repair-Mode=continue
# + Repair-Attempt++ (NOT a distinct State value), so the existing classify /
# repair-ticket / verify-target consumers keep treating the chain as an open,
# repairable red streak. Only the threshold BLOCK persists State=blocked, which
# those consumers now understand as "active but not repairable" (a green still
# closes it; a fresh red does not reopen it).
#
# Same-signature thresholding (design §3) needs to know whether successive
# failures are "the same". The CLI cannot read CI logs, so the caller passes the
# failure signature (e.g. a hash of the failing required-gate / test set) via
# --signature; we persist it (Fail-Signature) plus the consecutive same-signature
# count (Same-Sig-Count) on the chain and BLOCK when the count reaches
# --threshold (default 3).
#
# Usage:
#   task-dag tree-fix-outcome <owner/repo> <branch> --for-sha=<commit>
#       (--result=green|red|unknown | --gate=<conclusion> [--gate=...])
#       --signature=<sig>        (REQUIRED when the result is red)
#       [--threshold=<n>] [--current-head=<sha>] [--allow-stale]
#       [--dry-run] [--json] [--no-fetch]
#
# Exit codes:
#   0  handled; the resulting action was applied (or a valid no-op)
#   1  argument error / <for-sha> is not a tree-fix commit
#   2  malformed Tree-Fix* trailers on <for-sha>
#   4  git/origin error
#   5  lost the chain-write CAS race
#   6  superseded/stale: ignored relative to the current branch HEAD / chain
# ---------------------------------------------------------------------------
cmd_tree_fix_outcome() {
    local repo="" branch="" for_sha="" result="" current_head="" signature=""
    local threshold=3 allow_stale=false dry_run=false json=false do_fetch=true
    local -a gates=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --for-sha=*) for_sha="${1#*=}"; shift ;;
            --result=*) result="${1#*=}"; shift ;;
            --gate=*) gates+=("${1#*=}"); shift ;;
            --gate)
                shift
                [ $# -gt 0 ] || { echo "Error: --gate requires a value" >&2; return 1; }
                gates+=("$1"); shift ;;
            --signature=*) signature="${1#*=}"; shift ;;
            --threshold=*) threshold="${1#*=}"; shift ;;
            --current-head=*) current_head="${1#*=}"; shift ;;
            --allow-stale) allow_stale=true; shift ;;
            --dry-run) dry_run=true; shift ;;
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help | -h)
                cat <<EOF
Usage: task-dag tree-fix-outcome <owner/repo> <branch> --for-sha=<commit> \\
         (--result=green|red|unknown | --gate=<conclusion> [--gate=...]) \\
         --signature=<sig> [options]

CI broken-master auto-repair tree-fix outcome handler (design §3). Interprets
the result of a commit carrying Tree-Fix* trailers and drives the §3 escalation:
green closes the chain; a continuation red escalates to Repair-Mode=continue
(Repair-Attempt++) and asks the caller to file a continue-mode repair task; a
red whose parent was green opens a fresh initial chain; repeated same-signature
continue failures BLOCK the chain + page after --threshold. Pure: drives chain
state + reports hints, never touches GitHub.

Result (pick one):
  --result=<v>         green | red | unknown (precomputed aggregate)
  --gate=<conclusion>  a required-gate conclusion (repeatable); aggregated as
                       red (any failure) > unknown (any pending/other) > green

Options:
  --for-sha=<commit>   REQUIRED; the tree-fix commit this CI run is about
  --signature=<sig>    REQUIRED when the result is red; identifies the failure
                       so repeated SAME-signature continue failures can block
  --threshold=<n>      same-signature continue failures before BLOCK (def 3)
  --current-head=<sha> the live branch tip (default: origin ls-remote)
  --allow-stale        act even when --for-sha is superseded by the branch tip
  --dry-run            compute + report without writing chain state
  --json               machine-readable result
  --no-fetch           skip fetching the prior chain ref / branch tip object

Reported action: close | continue | block | open-regression | noop-blocked |
                 noop-already-open | noop-already-processed | noop-green-nochain |
                 noop-green-noncurrent | noop-green-otherchain | noop-stale |
                 noop-stale-otherchain | noop-unknown
Ticket hint:     open | close | update | block | none
Task hint:       initial | continue | none

Exit: 0 applied/no-op  1 args/not-tree-fix  2 malformed trailers
      4 git/origin  5 CAS race  6 superseded/stale.
EOF
                return 0
                ;;
            -*) echo "Unknown option: $1" >&2; return 1 ;;
            *)
                if [ -z "$repo" ]; then repo="$1"
                elif [ -z "$branch" ]; then branch="$1"
                else echo "Unexpected argument: $1" >&2; return 1
                fi
                shift
                ;;
        esac
    done

    if [ -z "$repo" ] || [ -z "$branch" ]; then
        echo "Error: <owner/repo> and <branch> are required" >&2
        return 1
    fi
    if [ -z "$for_sha" ]; then
        echo "Error: --for-sha=<commit> is required" >&2
        return 1
    fi
    if [ -z "$result" ] && [ "${#gates[@]}" -eq 0 ]; then
        echo "Error: pass --result=<v> or at least one --gate=<conclusion>" >&2
        return 1
    fi
    if [ -n "$result" ] && [ "${#gates[@]}" -gt 0 ]; then
        echo "Error: pass either --result or --gate(s), not both" >&2
        return 1
    fi
    if ! printf '%s' "$threshold" | grep -Eq '^[0-9]+$' || [ "$threshold" -lt 1 ]; then
        echo "Error: --threshold must be a positive integer (got '$threshold')" >&2
        return 1
    fi

    # Resolve --for-sha to a full local commit object (same contract as classify).
    local for_sha_full
    if ! for_sha_full="$(git rev-parse --verify --quiet "${for_sha}^{commit}" 2>/dev/null)"; then
        echo "Error: --for-sha must resolve to a commit object present locally (got '$for_sha')" >&2
        return 1
    fi
    for_sha="$for_sha_full"

    # Aggregate the classification.
    if [ -z "$result" ]; then
        result="$(_ci_aggregate_gates "${gates[@]}")"
    fi
    case "$result" in
        green | red | unknown) ;;
        *) echo "Error: --result must be green|red|unknown (got '$result')" >&2; return 1 ;;
    esac
    if [ "$result" = "red" ]; then
        case "$signature" in
            "" )
                echo "Error: --signature is required for a red tree-fix outcome (same-signature thresholding)" >&2
                return 1 ;;
            *$'\n'* | *$'\r'* )
                # The signature is persisted into a single-line chain-state
                # commit field; a newline would corrupt the message format.
                echo "Error: --signature must be a single-line value" >&2
                return 1 ;;
        esac
    fi

    # ── This MUST be a tree-fix commit (design §3 applies only to those) ───
    local tf_json tf_rc=0
    tf_json="$(cmd_parse_tree_fix "$for_sha" --json 2>/dev/null)" || tf_rc=$?
    if [ "$tf_rc" -eq 2 ]; then
        echo "Error: $for_sha carries malformed Tree-Fix* trailers; cannot interpret its outcome" >&2
        return 2
    fi
    if ! printf '%s' "$tf_json" | grep -q '"treeFix":true'; then
        echo "Error: $for_sha is not a tree-fix commit (no Tree-Fix trailers); use 'classify' for ordinary commits" >&2
        return 1
    fi
    local tf_chain tf_mode
    tf_chain="$(printf '%s' "$tf_json" | sed -E 's/.*"chain":"([^"]*)".*/\1/;t;d')"
    tf_mode="$(printf '%s' "$tf_json" | sed -E 's/.*"mode":"([^"]*)".*/\1/;t;d')"

    # ── Currency (design §4): act relative to the current branch HEAD ──────
    # (identical model to classify: act only on the live tip; fail closed if it
    # cannot be established; superseded SHAs are ignored unless --allow-stale.)
    local tip="" tip_known=false
    if [ -n "$current_head" ]; then
        tip="$(git rev-parse --verify --quiet "${current_head}^{commit}" 2>/dev/null || true)"
        if [ -z "$tip" ]; then
            if printf '%s' "$current_head" | grep -Eq '^[0-9a-f]{40,64}$'; then
                tip="$current_head"
            else
                echo "Error: --current-head must resolve to a commit or be a full SHA (got '$current_head')" >&2
                return 1
            fi
        fi
        tip_known=true
    else
        local lsr
        if lsr="$(git ls-remote origin "refs/heads/${branch}" 2>/dev/null)"; then
            tip="$(printf '%s' "$lsr" | awk '{print $1; exit}')"
            [ -n "$tip" ] && tip_known=true
        fi
    fi
    local is_current=false
    if [ "$tip_known" = true ]; then
        [ "$tip" = "$for_sha" ] && is_current=true
    elif [ "$allow_stale" = false ]; then
        echo "Error: cannot determine the live HEAD of $repo@$branch; pass --current-head or --allow-stale" >&2
        return 4
    fi

    # ── Prior chain state ─────────────────────────────────────────────────
    local ref old=""
    ref="$(_cichain_ref "$repo" "$branch")"
    if [ "$do_fetch" = true ]; then
        if old="$(_cichain_remote_sha "$ref")"; then
            [ -n "$old" ] && _cichain_fetch "$ref"
        else
            old="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
        fi
    else
        old="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
    fi
    local p_head="" p_state="" p_first_red="" p_attempt="" p_sig="" p_count=""
    if [ -n "$old" ]; then
        p_head="$(_cichain_field "$old" Current-Head)"
        p_state="$(_cichain_field "$old" State)"
        p_first_red="$(_cichain_field "$old" First-Red)"
        p_attempt="$(_cichain_field "$old" Repair-Attempt)"
        p_sig="$(_cichain_field "$old" Fail-Signature)"
        p_count="$(_cichain_field "$old" Same-Sig-Count)"
    fi
    # Sanitise the persisted counters before any arithmetic (set -e would abort
    # on a non-numeric `$(( ))`); a malformed field is treated as unset.
    printf '%s' "$p_attempt" | grep -Eq '^[0-9]+$' || p_attempt=""
    printf '%s' "$p_count" | grep -Eq '^[0-9]+$' || p_count=""
    local chain_active=false ours=false
    { [ "$p_state" = "red" ] || [ "$p_state" = "blocked" ]; } && chain_active=true
    [ -n "$p_first_red" ] && [ "$p_first_red" = "$tf_chain" ] && ours=true

    # ── Decide the action ─────────────────────────────────────────────────
    local action="" ticket="none" task="none" page=false
    local new_attempt="$p_attempt" new_sig="$p_sig" new_count="$p_count"
    local -a write_args=()
    case "$result" in
        unknown)
            # A transient unknown must never open/close/escalate a chain.
            action="noop-unknown"
            ;;
        green)
            if [ "$is_current" = false ] && [ "$allow_stale" = false ]; then
                action="noop-green-noncurrent"
            elif [ "$chain_active" = true ] && [ "$ours" = true ]; then
                # The fix worked: close OUR chain + clear repair/signature fields.
                action="close"; ticket="close"
                write_args=(--state=green --last-green="$for_sha"
                            --set First-Red= --set Repair-Mode=
                            --set Repair-Issue= --set Repair-Attempt=
                            --set Fail-Signature= --set Same-Sig-Count=)
            elif [ "$chain_active" = true ]; then
                # Green, current, but a DIFFERENT chain is open: never close
                # someone else's streak (stale/race).
                action="noop-green-otherchain"
            else
                # Nothing open: record the green watermark (idempotent).
                action="noop-green-nochain"
                write_args=(--state=green --last-green="$for_sha")
            fi
            ;;
        red)
            if [ "$is_current" = false ] && [ "$allow_stale" = false ]; then
                action="noop-stale"
            elif [ "$p_state" = "blocked" ] && [ "$ours" = true ]; then
                # Already parked by the threshold; a human is paged. Stand down.
                action="noop-blocked"
            elif [ "$p_state" = "red" ] && [ "$ours" = true ] && [ "$p_head" = "$for_sha" ]; then
                # This exact tree-fix outcome is already the chain head: a
                # re-delivered/duplicate CI run. Do NOT increment the attempt /
                # same-signature count again (that would inflate the counters
                # and could falsely trip the block threshold without any new
                # repair attempt). Idempotent no-op.
                action="noop-already-processed"
            elif [ "$p_state" = "red" ] && [ "$ours" = true ]; then
                # ── Continuation of OUR red chain: escalate or block ───────
                if [ -n "$p_sig" ] && [ "$signature" = "$p_sig" ]; then
                    new_count=$(( ${p_count:-0} + 1 ))
                else
                    new_count=1
                fi
                new_sig="$signature"
                new_attempt=$(( ${p_attempt:-1} + 1 ))
                if [ "$new_count" -ge "$threshold" ]; then
                    # Repeated same-signature failures: BLOCK + page once,
                    # instead of churning continue tasks forever (design §3).
                    action="block"; ticket="block"; task="none"; page=true
                    write_args=(--state=blocked --repair-mode=continue
                                --repair-attempt="$new_attempt"
                                --set "Fail-Signature=$new_sig"
                                --set "Same-Sig-Count=$new_count")
                else
                    # Escalate the SAME chain to continue-mode (no first-red
                    # back-off). State stays red so the existing consumers keep
                    # treating it as an open, repairable streak.
                    action="continue"; ticket="update"; task="continue"
                    write_args=(--state=red --repair-mode=continue
                                --repair-attempt="$new_attempt"
                                --set "Fail-Signature=$new_sig"
                                --set "Same-Sig-Count=$new_count")
                fi
            elif [ "$chain_active" = false ]; then
                # No open chain (parent was green / chain already closed): this
                # is a NEW regression, not "more failures remain". Open a fresh
                # initial-mode chain anchored at the tree-fix commit.
                action="open-regression"; ticket="open"; task="initial"
                new_attempt=1; new_sig=""; new_count=""
                write_args=(--state=red --first-red="$for_sha"
                            --repair-mode=initial --repair-attempt=1
                            --set Fail-Signature= --set Same-Sig-Count=)
            elif [ "$p_state" = "red" ] && [ "$p_first_red" = "$for_sha" ]; then
                # A concurrent run already opened this regression as the chain
                # anchor; idempotent no-op (don't double-open).
                action="noop-already-open"
            else
                # A DIFFERENT chain is active and this fix did not target it:
                # refuse to clobber it / open a second chain (stale/race).
                action="noop-stale-otherchain"
            fi
            ;;
    esac

    # ── Report ────────────────────────────────────────────────────────────
    _tfo_report() { # <rc> <applied:true|false>
        local rc="$1" applied="$2" tk="$ticket" tsk="$task" pg="$page"
        if [ "$applied" != true ]; then tk="none"; tsk="none"; pg=false; fi
        if [ "$json" = true ]; then
            printf '{"result":%s,"action":%s,"ticket":%s,"task":%s,"page":%s,"current":%s,"applied":%s,"ref":%s,"forSha":%s,"chain":%s,"mode":%s,"firstRed":%s,"priorState":%s,"repairAttempt":%s,"failSignature":%s,"sameSigCount":%s,"threshold":%s,"rc":%s}\n' \
                "$(json_escape "$result")" "$(json_escape "$action")" "$(json_escape "$tk")" "$(json_escape "$tsk")" "$pg" "$is_current" "$applied" \
                "$(json_escape "$ref")" "$(json_escape "$for_sha")" "$(json_escape "$tf_chain")" \
                "$(json_escape "$tf_mode")" "$(json_escape "${p_first_red:-}")" \
                "$(json_escape "${p_state:-}")" "$(json_escape "${new_attempt:-}")" \
                "$(json_escape "${new_sig:-}")" "$(json_escape "${new_count:-}")" \
                "$threshold" "$rc"
        else
            printf "${BOLD}tree-fix-outcome %s@%s${RESET} result=%s action=%s ticket=%s task=%s page=%s (current=%s applied=%s rc=%s)\n" \
                "$repo" "$branch" "$result" "$action" "$tk" "$tsk" "$pg" "$is_current" "$applied" "$rc"
        fi
    }

    # Stale red relative to the live HEAD: ignore (design §4).
    if [ "$action" = "noop-stale" ]; then
        [ "$json" = false ] && printf "${YELLOW}Superseded CI run: %s is not the current %s HEAD — ignoring (design §4).${RESET}\n" "$for_sha" "$branch" >&2
        _tfo_report 6 false
        return 6
    fi
    if [ "$action" = "noop-stale-otherchain" ]; then
        [ "$json" = false ] && printf "${YELLOW}Tree-fix targets chain %s but %s@%s has a different active chain (first-red %s) — refusing to clobber it.${RESET}\n" "$tf_chain" "$repo" "$branch" "$p_first_red" >&2
        _tfo_report 6 false
        return 6
    fi

    # Pure no-ops (nothing to persist).
    if [ "${#write_args[@]}" -eq 0 ]; then
        _tfo_report 0 false
        return 0
    fi

    if [ "$dry_run" = true ]; then
        [ "$json" = false ] && printf "${BLUE}(dry-run: would chain-write %s)${RESET}\n" "${write_args[*]}" >&2
        _tfo_report 0 false
        return 0
    fi

    # ── Apply via the CAS/stale-safe primitive ────────────────────────────
    local -a extra=(--expect-old="$old")
    [ "$allow_stale" = true ] && extra+=(--allow-stale)
    local wrc=0 wout
    wout="$(cmd_chain_write "$repo" "$branch" --for-sha="$for_sha" --json \
        "${extra[@]}" "${write_args[@]}" 2>&1)" || wrc=$?
    if [ "$wrc" -ne 0 ]; then
        if [ "$json" = false ]; then
            printf "${RED}tree-fix-outcome: chain-write failed (rc=%s) for %s@%s action=%s${RESET}\n" \
                "$wrc" "$repo" "$branch" "$action" >&2
            printf '%s\n' "$wout" >&2
        else
            _tfo_report "$wrc" false
        fi
        return "$wrc"
    fi

    _tfo_report 0 true
    return 0
}

# ---------------------------------------------------------------------------
# verify-target  (CI broken-master auto-repair, design §6 + §7)
#
# The WORKER VERIFIER: a read-only, fail-closed preflight a repair worker runs
# BEFORE it spends effort fixing a broken master. It answers exactly one
# question — "is my target still the current, first-red, unclaimed chain head?"
# — so a worker never hand-implements the §6 currency contract and never burns
# work on a chain that has since closed, escalated, or been claimed by a peer.
#
# It is PURE: it reads the authoritative chain-state ref on origin (and, when
# asked, the authoritative claim ref) and mutates nothing. Origin is the source
# of truth; if origin cannot be reached it FAILS CLOSED (a worker must not act
# on a stale local view of whether its target is still live).
#
# A repair worker's "target" is the chain it was dispatched to fix, identified
# by the chain anchor First-Red (the same value its eventual fix commit records
# as `Tree-Fix-Chain:`). The gate passes only when ALL of these hold:
#
#   * a chain exists for <owner/repo>@<branch>;
#   * State == red             (the chain is still OPEN — not closed green);
#   * First-Red == --target-sha (it is the SAME chain, still anchored here —
#                                not a fresh chain opened after a close);
#   * Repair-Issue  == --repair-issue   (if given: same repair ticket);
#   * Repair-Mode   == --mode           (if given: initial vs continue);
#   * Repair-Attempt== --attempt        (if given: not superseded by a retry);
#   * no active claim exists for --task  (if given: nobody else owns it).
#
# Any failure means the worker MUST NOT proceed: its target is no longer the
# current first-red unclaimed chain head.
#
# Usage:
#   task-dag verify-target <owner/repo> <branch> --target-sha=<sha>
#       [--repair-issue=<n>] [--mode=initial|continue] [--attempt=<n>]
#       [--task=<task-sha>] [--json] [--no-fetch]
#
# Exit codes:
#   0  verified — the target is the current first-red unclaimed chain head
#   1  argument error
#   3  no chain state exists for this repo/branch (nothing to repair)
#   4  origin unreachable / git error — fail closed
#   5  the repair task is already claimed by another worker
#   6  not the current first-red head (closed, escalated, or wrong chain)
# ---------------------------------------------------------------------------
cmd_verify_target() {
    local repo="" branch="" target="" repair_issue="" mode="" attempt="" task=""
    local json=false do_fetch=true

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --target-sha=*) target="${1#*=}"; shift ;;
            --repair-issue=*) repair_issue="${1#*=}"; shift ;;
            --mode=*) mode="${1#*=}"; shift ;;
            --attempt=*) attempt="${1#*=}"; shift ;;
            --task=*) task="${1#*=}"; shift ;;
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help | -h)
                cat <<EOF
Usage: task-dag verify-target <owner/repo> <branch> --target-sha=<sha> [options]

CI broken-master auto-repair WORKER VERIFIER (design §6 + §7). A read-only,
fail-closed preflight a repair worker runs before fixing a broken master: it
confirms its target is still the current, first-red, unclaimed chain head.
Origin is the source of truth; mutates nothing; fails closed if unreachable.

Required:
  --target-sha=<sha>   the chain anchor (First-Red) the worker is repairing

Options (each, when given, must match the live chain state):
  --repair-issue=<n>   the repair ticket recorded on the chain
  --mode=<m>           expected Repair-Mode: initial | continue
  --attempt=<n>        expected Repair-Attempt (catches a superseding retry)
  --task=<task-sha>    repair task SHA; fail if another worker holds its claim
  --json               machine-readable result
  --no-fetch           read the last-known LOCAL chain ref (no origin round-trip)

Passes (exit 0) only when: a chain exists, State=red, First-Red=target, and
every supplied --repair-issue/--mode/--attempt matches and --task is unclaimed.

Exit: 0 verified  1 args  3 no chain  4 origin/git (fail closed)
      5 claimed by another worker  6 not the current first-red head.
EOF
                return 0
                ;;
            -*) echo "Unknown option: $1" >&2; return 1 ;;
            *)
                if [ -z "$repo" ]; then repo="$1"
                elif [ -z "$branch" ]; then branch="$1"
                else echo "Unexpected argument: $1" >&2; return 1
                fi
                shift
                ;;
        esac
    done

    if [ -z "$repo" ] || [ -z "$branch" ]; then
        echo "Error: <owner/repo> and <branch> are required" >&2
        return 1
    fi
    if [ -z "$target" ]; then
        echo "Error: --target-sha=<sha> is required" >&2
        return 1
    fi
    if [ -n "$mode" ] && [ "$mode" != "initial" ] && [ "$mode" != "continue" ]; then
        echo "Error: --mode must be 'initial' or 'continue' (got '$mode')" >&2
        return 1
    fi

    # Normalise the target to a full commit SHA when the object is present
    # locally (same contract as classify/chain-write); otherwise accept a bare
    # full SHA literally so a worker on a shallow checkout can still verify.
    local target_full
    if target_full="$(git rev-parse --verify --quiet "${target}^{commit}" 2>/dev/null)"; then
        target="$target_full"
    elif ! printf '%s' "$target" | grep -Eq '^[0-9a-f]{40,64}$'; then
        echo "Error: --target-sha must resolve to a commit object or be a full SHA (got '$target')" >&2
        return 1
    fi

    # ── Read the authoritative chain state ────────────────────────────────
    # Origin is the source of truth. Fail closed if it cannot be reached:
    # a worker must never decide it is still the live target from stale local
    # state. --no-fetch is the explicit "read my last-known local ref" override.
    local ref sha=""
    ref="$(_cichain_ref "$repo" "$branch")"
    if [ "$do_fetch" = true ]; then
        if sha="$(_cichain_remote_sha "$ref")"; then
            [ -n "$sha" ] && _cichain_fetch "$ref"
        else
            if [ "$json" = true ]; then
                printf '{"ok":false,"reason":"origin-error","repo":%s,"branch":%s,"ref":%s,"rc":4}\n' \
                    "$(json_escape "$repo")" "$(json_escape "$branch")" "$(json_escape "$ref")"
            else
                printf "${RED}verify-target: cannot reach origin for %s@%s — failing closed.${RESET}\n" "$repo" "$branch" >&2
            fi
            return 4
        fi
    else
        sha="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
    fi

    # Fields (empty when the chain is absent).
    local state="" first_red="" current_head="" last_green=""
    local r_issue="" r_mode="" r_attempt=""
    if [ -n "$sha" ]; then
        state="$(_cichain_field "$sha" State)"
        first_red="$(_cichain_field "$sha" First-Red)"
        current_head="$(_cichain_field "$sha" Current-Head)"
        last_green="$(_cichain_field "$sha" Last-Green)"
        r_issue="$(_cichain_field "$sha" Repair-Issue)"
        r_mode="$(_cichain_field "$sha" Repair-Mode)"
        r_attempt="$(_cichain_field "$sha" Repair-Attempt)"
    fi

    # ── Claim state (optional) ────────────────────────────────────────────
    # Claims live at refs/heads/tasks/active/<short> on origin (origin is
    # authoritative; local refs may lag). A present claim means another worker
    # already owns the repair task.
    local claimed=false claim_short=""
    if [ -n "$task" ]; then
        claim_short="${task:0:7}"
        if [ "$(task_is_claimed_on_remote "$claim_short")" = "yes" ]; then
            claimed=true
        fi
    fi

    # ── Verdict ───────────────────────────────────────────────────────────
    local ok=false reason="" rc=0
    if [ -z "$sha" ]; then
        reason="no-chain"; rc=3
    elif [ "$state" != "red" ]; then
        reason="not-red"; rc=6
    elif [ "$first_red" != "$target" ]; then
        reason="not-first-red"; rc=6
    elif [ -n "$repair_issue" ] && [ "$r_issue" != "$repair_issue" ]; then
        reason="repair-issue-mismatch"; rc=6
    elif [ -n "$mode" ] && [ "$r_mode" != "$mode" ]; then
        reason="repair-mode-mismatch"; rc=6
    elif [ -n "$attempt" ] && [ "$r_attempt" != "$attempt" ]; then
        reason="repair-attempt-mismatch"; rc=6
    elif [ "$claimed" = true ]; then
        reason="claimed"; rc=5
    else
        ok=true; reason="current-first-red-unclaimed"; rc=0
    fi

    if [ "$json" = true ]; then
        printf '{"ok":%s,"reason":%s,"repo":%s,"branch":%s,"ref":%s,"targetSha":%s,"chainCommit":%s,"state":%s,"firstRed":%s,"currentHead":%s,"lastGreen":%s,"repairIssue":%s,"repairMode":%s,"repairAttempt":%s,"claimed":%s,"rc":%s}\n' \
            "$ok" "$(json_escape "$reason")" \
            "$(json_escape "$repo")" "$(json_escape "$branch")" "$(json_escape "$ref")" \
            "$(json_escape "$target")" "$(json_escape "${sha:-}")" \
            "$(json_escape "$state")" "$(json_escape "$first_red")" \
            "$(json_escape "$current_head")" "$(json_escape "$last_green")" \
            "$(json_escape "$r_issue")" "$(json_escape "$r_mode")" "$(json_escape "$r_attempt")" \
            "$claimed" "$rc"
    else
        if [ "$ok" = true ]; then
            printf "${GREEN}✓ verify-target %s@%s${RESET} target=%s is the current first-red unclaimed chain head (mode=%s attempt=%s issue=%s)\n" \
                "$repo" "$branch" "$target" "$r_mode" "$r_attempt" "$r_issue"
        else
            printf "${YELLOW}✗ verify-target %s@%s${RESET} target=%s NOT the current first-red unclaimed chain head: %s (state=%s firstRed=%s claimed=%s rc=%s)\n" \
                "$repo" "$branch" "$target" "$reason" "${state:-none}" "${first_red:-none}" "$claimed" "$rc" >&2
        fi
    fi
    return "$rc"
}

# ---------------------------------------------------------------------------
# repair-ticket  (CI broken-master auto-repair, design §4 item: idempotent
# repair ticket — scope item #4 of virusdave/task-dag#1)
#
# Reconcile the GitHub repair TICKET with the current CI repair-chain state
# for <owner/repo>@<branch>, so that there is EXACTLY ONE open
# `ci-broken-master` + `priority:high` ticket per open red chain. Creating
# that issue is the ingestion point: the existing issue-to-task sync mints it
# as a pickable task. This command is the side of the subsystem that touches
# GitHub; `classify` (§2) only drives the durable chain state and reports a
# ticket hint (open|close), it never calls GitHub itself.
#
# It is fully IDEMPOTENT and self-contained — safe to run repeatedly and
# concurrently. The chain ref (origin) is the source of truth for desired
# state; GitHub (queried by label + a hidden chain marker) is the authority
# for which ticket already exists. The chain's Repair-Issue field is only a
# best-effort cache + a compare-and-set CREATE LEASE; it is never trusted on
# its own (classify clears it on green, and a cached write can fail), so a
# lost cache write can never duplicate or strand a ticket.
#
# Dedup / binding. A ticket is bound to a chain by TWO hidden HTML-comment
# markers in its body:
#   <!-- ci-repair-slot:v1 repo=<owner/repo> branch=<encoded> -->  (the slot)
#   <!-- ci-repair-first-red:<full-sha> -->                        (the chain)
# The slot marker is stable across red streaks (so green can close whatever
# is open for this repo/branch); the first-red marker identifies the specific
# red streak (so a fresh red opens a NEW ticket instead of silently reusing a
# prior streak's ticket that failed to close).
#
# Behaviour, driven by the chain State:
#   red:
#     - close any open slot ticket from a PRIOR first-red (stale streak);
#     - 0 current-streak tickets  -> acquire a CAS create-lease on the chain
#       (Repair-Issue=creating@<ts>, --expect-old) so only ONE concurrent
#       runner creates; the winner files the issue (both labels + markers)
#       and caches Repair-Issue=<n>;
#     - 1 current-streak ticket   -> refresh its body (NOT a comment, to avoid
#       the comment->task ingestion loop) and cache its number;
#     - >1 current-streak tickets -> keep the oldest, close the extras.
#   green / anything-not-red:
#     - close every open slot ticket (any first-red) and clear the cache.
#
# Loop safety. The ONLY thing that should mint a pickable task is the initial
# issue creation. Updates edit the body (issues:edited is create-only in the
# sync). Every comment this command posts (duplicate/stale/green closes)
# begins with the `<!-- task-dag:status -->` marker so the comment sync skips
# it instead of minting a new task.
#
# Usage:
#   task-dag repair-ticket <owner/repo> <branch>
#       [--title=<t>] [--lease-ttl=<secs>] [--dry-run] [--json] [--no-fetch]
#
# Exit codes:
#   0  reconciled (created/updated/closed/no-op)
#   1  argument error
#   4  origin/gh error (could not establish state or a mutation failed)
#   5  lost the create-lease CAS race (another runner is creating) — benign;
#      rerun reconciles
# ---------------------------------------------------------------------------

# Default time after which a stuck "creating@<ts>" lease may be stolen.
_RT_LEASE_TTL_DEFAULT=300

# Build the deterministic, automation-owned issue body.
_rt_ticket_body() { # <repo> <branch> <slot> <frmark> <first_red> <cur_head> <mode> <attempt>
    local repo="$1" branch="$2" slot="$3" frmark="$4" first_red="$5"
    local cur_head="$6" mode="$7" attempt="$8"
    cat <<EOF
$slot
$frmark

# CI repair needed for \`${repo}@${branch}\`

The required CI gate suite is **red** on \`${branch}\`. File a fix; this
ticket is the single pickable repair task for this red streak.

- First red: \`${first_red}\`
- Current head: \`${cur_head}\`
- Repair mode: \`${mode:-initial}\`
- Repair attempt: \`${attempt:-1}\`

When landing the fix, stamp the fix commit with these trailers so the
classifier can interpret the outcome (design §3):

\`\`\`text
Tree-Fix: ${repo}#<this-ticket-number>
Tree-Fix-Chain: ${first_red}
Tree-Fix-Mode: ${mode:-initial}
\`\`\`

<sub>Maintained automatically by \`task-dag repair-ticket\`; edits to this
body are overwritten on the next reconcile.</sub>
EOF
}

cmd_repair_ticket() {
    local rt_exit=0
    local repo="" branch="" title="" lease_ttl="$_RT_LEASE_TTL_DEFAULT"
    local dry_run=false json=false do_fetch=true

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --title=*) title="${1#*=}"; shift ;;
            --lease-ttl=*) lease_ttl="${1#*=}"; shift ;;
            --dry-run) dry_run=true; shift ;;
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help | -h)
                cat <<EOF
Usage: task-dag repair-ticket <owner/repo> <branch> [options]

Reconcile the GitHub repair ticket with the CI repair-chain state so there is
EXACTLY ONE open ci-broken-master + priority:high ticket per open red chain
(scope #4 of #1). Idempotent + concurrency-safe. The chain ref is the desired
state; GitHub (label + hidden chain marker) is the authority for what exists;
Repair-Issue is a best-effort cache + CAS create-lease.

Options:
  --title=<t>        override the generated issue title
  --lease-ttl=<s>    seconds before a stuck create-lease may be stolen (def $_RT_LEASE_TTL_DEFAULT)
  --dry-run          print intended GitHub mutations, change nothing
  --json             machine-readable result on stdout (logs go to stderr)
  --no-fetch         read last-known local chain state (offline/test)

Exit: 0 reconciled  1 args  4 origin/gh error  5 lost create-lease race.
EOF
                return 0
                ;;
            -*) echo "Unknown option: $1" >&2; return 1 ;;
            *)
                if [ -z "$repo" ]; then repo="$1"
                elif [ -z "$branch" ]; then branch="$1"
                else echo "Unexpected argument: $1" >&2; return 1
                fi
                shift
                ;;
        esac
    done

    if [ -z "$repo" ] || [ -z "$branch" ]; then
        echo "Error: <owner/repo> and <branch> are required" >&2
        return 1
    fi
    if ! printf '%s' "$lease_ttl" | grep -Eq '^[0-9]+$'; then
        echo "Error: --lease-ttl must be a non-negative integer (got '$lease_ttl')" >&2
        return 1
    fi

    # A small mutation wrapper honouring --dry-run. Read-only `gh issue list`
    # is NOT routed through here (it always runs). Returns gh's own status.
    local _rt_dry="$dry_run"
    _rt_gh() {
        if [ "$_rt_dry" = true ]; then
            echo "(dry-run) gh $*" >&2
            return 0
        fi
        gh "$@"
    }

    # ── Current chain state (origin is the source of truth) ───────────────
    local ref sha=""
    ref="$(_cichain_ref "$repo" "$branch")"
    if [ "$do_fetch" = true ]; then
        if sha="$(_cichain_remote_sha "$ref")"; then
            [ -n "$sha" ] && _cichain_fetch "$ref"
        else
            # A mutating reconcile must not act off stale local state when it
            # cannot confirm origin: fail closed.
            echo "Error: cannot reach origin to read chain state for $repo@$branch" >&2
            return 4
        fi
    else
        sha="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
    fi

    # No chain ref at all: nothing has ever gone red here -> nothing to do.
    if [ -z "$sha" ]; then
        if [ "$json" = true ]; then
            printf '{"action":"noop-nochain","repo":%s,"branch":%s,"ref":%s}\n' \
                "$(json_escape "$repo")" "$(json_escape "$branch")" "$(json_escape "$ref")"
        else
            printf "${YELLOW}No CI chain state for %s@%s — no repair ticket to reconcile.${RESET}\n" "$repo" "$branch" >&2
        fi
        return 0
    fi

    local state first_red cur_head mode attempt cache_issue
    state="$(_cichain_field "$sha" State)"
    first_red="$(_cichain_field "$sha" First-Red)"
    cur_head="$(_cichain_field "$sha" Current-Head)"
    mode="$(_cichain_field "$sha" Repair-Mode)"
    attempt="$(_cichain_field "$sha" Repair-Attempt)"
    cache_issue="$(_cichain_field "$sha" Repair-Issue)"

    # ── Markers (slot = repo/branch lineage; first-red = this red streak) ──
    local enc slot frmark
    enc="$(_cichain_encode "$branch")"
    slot="<!-- ci-repair-slot:v1 repo=${repo} branch=${enc} -->"
    frmark="<!-- ci-repair-first-red:${first_red} -->"

    # ── Enumerate the open slot tickets on GitHub (authority for what is) ──
    # Output lines "<number>\t<true|false>" (whether the body carries the
    # CURRENT first-red marker), oldest-first. body=null is treated as "".
    local listing list_rc=0
    listing="$(gh issue list --repo "$repo" --state open \
        --label ci-broken-master --label priority:high \
        --limit 1000 --json number,body,createdAt 2>/dev/null \
        | jq -r --arg slot "$slot" --arg fr "$frmark" '
            [ .[] | select((.body // "") | contains($slot)) ]
            | sort_by(.createdAt, .number)
            | .[] | "\(.number)\t\((.body // "") | contains($fr))"')" || list_rc=$?
    if [ "$list_rc" -ne 0 ]; then
        echo "Error: failed to list repair tickets for $repo (gh/jq error)" >&2
        return 4
    fi

    local -a current=() stale=()
    local n flag
    while IFS=$'\t' read -r n flag; do
        [ -n "$n" ] || continue
        if [ "$flag" = "true" ]; then current+=("$n"); else stale+=("$n"); fi
    done <<< "$listing"

    local action="" ticket_number=""

    # Close one issue with a task-dag:status-markered comment (loop-safe).
    _rt_close() { # <number> <reason>
        local num="$1" reason="$2" body
        body="$(printf '<!-- task-dag:status -->\n%s' "$reason")"
        _rt_gh issue close "$num" --repo "$repo" --comment "$body" >/dev/null 2>&1 \
            || echo "Warning: failed to close repair ticket #$num on $repo" >&2
    }

    # Ensure EXACTLY ONE actionable continue-mode repair task exists for the
    # current attempt (design §3: "one repair issue per chain plus new
    # actionable tasks per failed attempt"). The comment is INTENTIONALLY
    # ingestable: its first non-blank line is prose (no leading "<!--") and the
    # dedup marker is NOT a `task-dag:` marker, so the comment->task sync mints
    # it as a fresh pickable continue task — unlike the body refresh (an edit,
    # which the sync ignores) and unlike status comments (which it skips).
    #
    # Concurrency: the dedup (read comments, post if the per-(first-red,attempt)
    # marker is absent) is idempotent for SERIAL reruns. It relies on the
    # classifier's per-repo/branch Actions concurrency group (design §4,
    # cancel-in-progress:false) serialising repair-ticket runs for one chain; it
    # is not independently safe against two truly-parallel runners. It FAILS
    # CLOSED if the comment lookup errors (rc 4), so a transient GitHub failure
    # can never be mistaken for "no task yet" and post a duplicate.
    _rt_ensure_continue_task() { # <ticket> <first_red> <cur_head> <attempt>
        local tnum="$1" fr="$2" head="$3" att="$4"
        local cmark="<!-- ci-repair-continue:v1 first-red=${fr} attempt=${att} -->"
        if [ "$_rt_dry" = true ]; then
            echo "(dry-run) would ensure continue-mode task comment on #$tnum (attempt $att)" >&2
            return 0
        fi
        local existing view_rc=0
        existing="$(gh issue view "$tnum" --repo "$repo" --json comments \
            --jq '.comments[].body' 2>/dev/null)" || view_rc=$?
        if [ "$view_rc" -ne 0 ]; then
            echo "Error: failed to read comments for repair ticket #$tnum on $repo (failing closed, not posting)" >&2
            return 4
        fi
        if printf '%s' "$existing" | grep -qF "$cmark"; then
            return 0
        fi
        local cbody ctf
        cbody="$(cat <<EOF
Repair attempt ${att} for \`${repo}@${branch}\`: the previous tree-fix did **not** turn \`${branch}\` green — additional failures remain. Repair the **current red \`${branch}\` tip** (do NOT apply the first-red back-off heuristic).

${cmark}

- First red: \`${fr}\`
- Current head: \`${head}\`
- Repair mode: \`continue\`
- Repair attempt: \`${att}\`
- Repair ticket: #${tnum}

Before working, confirm this chain is still yours:
\`task-dag verify-target ${repo} ${branch} --target-sha=${fr} --mode=continue --attempt=${att}\`

Stamp the fix commit with these trailers so the classifier interprets the outcome:

\`\`\`text
Tree-Fix: ${repo}#${tnum}
Tree-Fix-Chain: ${fr}
Tree-Fix-Mode: continue
\`\`\`
EOF
)"
        ctf="$(mktemp)"
        printf '%s' "$cbody" > "$ctf"
        local post_rc=0
        gh issue comment "$tnum" --repo "$repo" --body-file "$ctf" >/dev/null 2>&1 || post_rc=$?
        rm -f "$ctf"
        if [ "$post_rc" -ne 0 ]; then
            echo "Warning: failed to post continue-mode task comment on #$tnum (will retry next reconcile)" >&2
            return 4
        fi
    }

    if [ "$state" = "red" ]; then
        # Stale prior-streak tickets must be closed so a fresh streak is not
        # silently mistaken for a continuation (and so "one per chain" holds).
        local s
        for s in "${stale[@]}"; do
            _rt_close "$s" "Superseded: a newer red streak (first-red ${first_red}) is now open for \`${repo}@${branch}\`; closing this stale repair ticket."
            action="closed-stale${action:+,$action}"
        done

        local body
        body="$(_rt_ticket_body "$repo" "$branch" "$slot" "$frmark" "$first_red" "$cur_head" "$mode" "$attempt")"
        local def_title="CI broken: ${repo}@${branch} (first-red ${first_red:0:12})"
        [ -n "$title" ] && def_title="$title"

        if [ "${#current[@]}" -eq 0 ]; then
            # ── Create path, guarded by a CAS create-lease ────────────────
            # If a recent "creating@<ts>" lease is held by another runner,
            # stand down (it will create); only steal a lease older than TTL.
            local now lease_ts age
            now="$(date +%s)"
            if printf '%s' "$cache_issue" | grep -Eq '^creating@[0-9]+$'; then
                lease_ts="${cache_issue#creating@}"
                age=$(( now - lease_ts ))
                if [ "$age" -lt "$lease_ttl" ]; then
                    if [ "$json" = true ]; then
                        printf '{"action":"create-in-progress","repo":%s,"branch":%s,"leaseAge":%s}\n' \
                            "$(json_escape "$repo")" "$(json_escape "$branch")" "$age"
                    else
                        printf "${YELLOW}Repair ticket creation already in progress for %s@%s (lease age %ss < TTL %ss); standing down.${RESET}\n" \
                            "$repo" "$branch" "$age" "$lease_ttl" >&2
                    fi
                    return 0
                fi
            fi

            if [ "$dry_run" = true ]; then
                echo "(dry-run) would acquire create-lease + gh issue create on $repo with title: $def_title" >&2
                action="created${action:+,$action}"
            else
                # Acquire the lease: CAS Repair-Issue=creating@<now> bound to
                # the chain commit we read. A loser (rc 5) means a concurrent
                # runner won the lease — benign, rerun reconciles.
                local lease_rc=0
                cmd_chain_write "$repo" "$branch" --for-sha="$cur_head" \
                    --expect-old="$sha" --set "Repair-Issue=creating@${now}" \
                    >/dev/null 2>&1 || lease_rc=$?
                if [ "$lease_rc" -ne 0 ]; then
                    if [ "$json" = true ]; then
                        printf '{"action":"lease-lost","repo":%s,"branch":%s,"rc":%s}\n' \
                            "$(json_escape "$repo")" "$(json_escape "$branch")" "$lease_rc"
                    else
                        printf "${YELLOW}Lost the repair-ticket create-lease for %s@%s (another runner is creating); rerun reconciles.${RESET}\n" \
                            "$repo" "$branch" >&2
                    fi
                    return 5
                fi

                # We own the lease. File the issue.
                local lease_sha created_url
                lease_sha="$(_cichain_remote_sha "$ref" 2>/dev/null || true)"
                if ! created_url="$(gh issue create --repo "$repo" \
                        --title "$def_title" --body "$body" \
                        --label ci-broken-master --label priority:high 2>&1)"; then
                    echo "Error: gh issue create failed for $repo: $created_url" >&2
                    return 4
                fi
                ticket_number="$(printf '%s' "$created_url" | grep -oE '[0-9]+$' | tail -1)"

                # Cache the number (best-effort, CAS-bound to the lease commit).
                # If the cache write loses (chain moved), reconcile: only undo
                # the creation if the chain is no longer this red streak.
                local cache_rc=0
                cmd_chain_write "$repo" "$branch" --for-sha="$cur_head" \
                    --expect-old="$lease_sha" --set "Repair-Issue=${ticket_number}" \
                    >/dev/null 2>&1 || cache_rc=$?
                if [ "$cache_rc" -ne 0 ]; then
                    local now_sha now_state now_fr
                    now_sha="$(_cichain_remote_sha "$ref" 2>/dev/null || true)"
                    [ -n "$now_sha" ] && _cichain_fetch "$ref"
                    now_state="$(_cichain_field "$now_sha" State)"
                    now_fr="$(_cichain_field "$now_sha" First-Red)"
                    if [ "$now_state" != "red" ] || [ "$now_fr" != "$first_red" ]; then
                        _rt_close "$ticket_number" "CI chain for \`${repo}@${branch}\` changed during ticket creation; this repair ticket is no longer current and is closed automatically."
                        action="created-then-closed${action:+,$action}"
                        ticket_number=""
                    else
                        echo "Warning: created ticket #$ticket_number but could not cache its number (chain raced); next reconcile will cache it." >&2
                        action="created${action:+,$action}"
                    fi
                else
                    action="created${action:+,$action}"
                fi
            fi
        else
            # ── One-or-more current-streak tickets: keep oldest, refresh ──
            ticket_number="${current[0]}"
            local extra
            for extra in "${current[@]:1}"; do
                _rt_close "$extra" "Duplicate of #${ticket_number} for the same red streak (first-red ${first_red}); closing to keep exactly one repair ticket per chain."
                action="closed-dup${action:+,$action}"
            done
            # Refresh the canonical ticket's body (edit, NOT a comment).
            if [ "$dry_run" = true ]; then
                echo "(dry-run) would gh issue edit #$ticket_number on $repo (refresh body)" >&2
            else
                local bf
                bf="$(mktemp)"
                printf '%s' "$body" > "$bf"
                gh issue edit "$ticket_number" --repo "$repo" --body-file "$bf" >/dev/null 2>&1 \
                    || echo "Warning: failed to refresh repair ticket #$ticket_number body" >&2
                rm -f "$bf"
                # Re-cache the number if the chain still records something else.
                if [ "$cache_issue" != "$ticket_number" ]; then
                    cmd_chain_write "$repo" "$branch" --for-sha="$cur_head" \
                        --expect-old="$sha" --set "Repair-Issue=${ticket_number}" \
                        >/dev/null 2>&1 || true
                fi
            fi
            action="updated${action:+,$action}"
        fi

        # Escalated chains (Repair-Mode=continue, attempt >= 2) get one fresh
        # actionable continue-mode task per attempt; an initial chain (attempt
        # 1) needs none — the repair ticket itself is the initial task. A
        # failure here is non-fatal to the ticket reconcile but is surfaced so
        # the workflow reruns (idempotent) until the task is filed.
        if [ -n "$ticket_number" ] && [ "$mode" = "continue" ] \
           && printf '%s' "$attempt" | grep -Eq '^[0-9]+$' && [ "$attempt" -ge 2 ]; then
            _rt_ensure_continue_task "$ticket_number" "$first_red" "$cur_head" "$attempt" \
                || rt_exit=4
        fi
    elif [ "$state" = "blocked" ]; then
        # ── Escalation threshold tripped (design §3): the chain is parked ──
        # awaiting a human. Stop the pickable repair task churning: close the
        # auto-repair ticket(s) with a status-markered comment explaining a
        # human has been paged. A later green reopens nothing (classify/
        # tree-fix-outcome clear State on recovery).
        local all=("${current[@]}" "${stale[@]}") c
        if [ "${#all[@]}" -eq 0 ]; then
            action="noop-blocked-no-ticket"
        else
            for c in "${all[@]}"; do
                _rt_close "$c" "CI repair for \`${repo}@${branch}\` (first-red ${first_red}) is **BLOCKED**: repeated same-signature tree-fix attempts failed (attempt ${attempt:-?}), so the auto-repair chain was parked and a human was paged. This auto-filed repair task is closed to stop churn; resolve the break manually, then a green \`${branch}\` will clear the chain."
            done
            action="closed-blocked"
        fi
        # Clear the stale ticket cache either way (no pickable ticket on a
        # parked chain).
        if [ "$dry_run" = false ] && [ -n "$cache_issue" ]; then
            cmd_chain_write "$repo" "$branch" --for-sha="$cur_head" \
                --expect-old="$sha" --set "Repair-Issue=" >/dev/null 2>&1 || true
        fi
    else
        # ── Not red (green/unknown/closed): close every open slot ticket ──
        local all=("${current[@]}" "${stale[@]}") c
        if [ "${#all[@]}" -eq 0 ]; then
            action="noop-no-open-ticket"
        else
            for c in "${all[@]}"; do
                _rt_close "$c" "CI is green again on \`${repo}@${branch}\`; the broken-master repair chain is closed, so this repair ticket is resolved automatically."
            done
            action="closed"
            # Clear the cache if it still points anywhere (best-effort).
            if [ "$dry_run" = false ] && [ -n "$cache_issue" ]; then
                cmd_chain_write "$repo" "$branch" --for-sha="$cur_head" \
                    --expect-old="$sha" --set "Repair-Issue=" >/dev/null 2>&1 || true
            fi
        fi
    fi

    if [ "$json" = true ]; then
        printf '{"action":%s,"state":%s,"repo":%s,"branch":%s,"firstRed":%s,"ticket":%s,"dryRun":%s}\n' \
            "$(json_escape "$action")" "$(json_escape "$state")" \
            "$(json_escape "$repo")" "$(json_escape "$branch")" \
            "$(json_escape "$first_red")" "$(json_escape "$ticket_number")" "$dry_run"
    else
        printf "${BOLD}repair-ticket %s@%s${RESET} state=%s action=%s ticket=%s\n" \
            "$repo" "$branch" "$state" "$action" "${ticket_number:-<none>}"
    fi
    return "$rt_exit"
}
