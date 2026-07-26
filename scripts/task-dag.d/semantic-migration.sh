# shellcheck shell=bash
# Strict, effect-free parser and writer guard for the committed semantic
# migration policy.  This module never reads the policy merely by being
# sourced, so command help remains innocuous.

TASKDAG_MIGRATION_EXIT=75
TASKDAG_MIGRATION_MODE_DRAIN="draining-legacy-writers"

taskdag_migration_policy_path() {
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    printf '%s/semantic-migration-policy.json\n' "$here"
}

taskdag_migration_status_json() {
    local policy
    policy="$(taskdag_migration_policy_path)"
    [ -f "$policy" ] || {
        echo "Error: semantic migration policy is missing: $policy" >&2
        return 1
    }
    jq -e '
      if type == "object"
         and keys == ["authorizedSemantics","disabledWriterClasses","mode","recognizedReadSchemas","schema"]
         and .schema == 1
         and .mode == "draining-legacy-writers"
         and .recognizedReadSchemas == ["legacy","canonical-v1"]
         and .authorizedSemantics == ["legacy-read-only","canonical-v1-completed-epic-close"]
         and .disabledWriterClasses == ["epic-close","materialise","completion-ingest","projection"]
      then .
      else error("invalid semantic migration policy")
      end' "$policy" 2>/dev/null || {
        echo "Error: semantic migration policy is malformed or unsupported: $policy" >&2
        return 1
    }
}

taskdag_migration_guard() {
    local writer_class="${1:-}" status
    case "$writer_class" in
        epic-close|completed-epic-close|materialise|completion-ingest|projection) ;;
        *) echo "Error: unknown semantic migration writer class: ${writer_class:-<empty>}" >&2; return 1 ;;
    esac
    status="$(taskdag_migration_status_json)" || return 1
    if jq -e --arg class "$writer_class" '.disabledWriterClasses | index($class) != null' \
        <<<"$status" >/dev/null; then
        cat >&2 <<EOF
MIGRATION REQUIRED
class: $writer_class
mode: $TASKDAG_MIGRATION_MODE_DRAIN
next action: inspect 'task-dag migration-status --json' and wait for canonical-v1 activation
EOF
        return "$TASKDAG_MIGRATION_EXIT"
    fi
    if [ "$writer_class" = completed-epic-close ] \
      && jq -e '.authorizedSemantics | index("canonical-v1-completed-epic-close") != null' <<<"$status" >/dev/null; then
        return 0
    fi
    echo "Error: semantic migration policy unexpectedly authorized guarded writer class: $writer_class" >&2
    return 1
}

taskdag_prepare_authorized_completed_epic_close() { # consumer-id
    local consumer=${1:-completed-epic-close} state
    taskdag_migration_guard completed-epic-close || return $?
    taskdag_consumer_prepare "$consumer" || return 3
    [ "$TASKDAG_CONSUMER_MODE" = canonical ] || return 3
    state=$(jq -er .record.state <<<"$TASKDAG_CONSUMER_ACTIVATION") || return 3
    [ "$state" = enabled ] || return 3
}
