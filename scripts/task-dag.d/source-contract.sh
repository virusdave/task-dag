# shellcheck shell=bash
# Runtime-owned source contract. This module is loaded first and only by the
# canonical task-dag entrypoint; all later modules consume these globals.

__taskdag_contract_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
__taskdag_expected_entrypoint="${__taskdag_contract_dir%/task-dag.d}/task-dag"
__taskdag_contract_caller="${BASH_SOURCE[1]:-}"
if [ -n "$__taskdag_contract_caller" ]; then
    __taskdag_contract_caller_dir="$(cd "$(dirname "$__taskdag_contract_caller")" && pwd)"
    __taskdag_contract_caller="$__taskdag_contract_caller_dir/${__taskdag_contract_caller##*/}"
fi

if [ -z "$__taskdag_contract_caller" ] \
    || [ ! "$__taskdag_contract_caller" -ef "$__taskdag_expected_entrypoint" ]; then
    echo "Error: source-contract.sh must be loaded by the task-dag entrypoint" >&2
    unset __taskdag_contract_dir __taskdag_expected_entrypoint \
        __taskdag_contract_caller __taskdag_contract_caller_dir
    return 2 2>/dev/null || exit 2
fi

TASKDAG_SCRIPT_DIR="${__taskdag_contract_dir%/task-dag.d}"
TASKDAG_ENTRYPOINT="$__taskdag_expected_entrypoint"
VERSION="0.1.0"
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
unset __taskdag_contract_dir __taskdag_expected_entrypoint \
    __taskdag_contract_caller __taskdag_contract_caller_dir

# Opt-in structured phase timing for diagnosing production command latency.
# Keep normal command output unchanged; timing records are JSONL on stderr.
taskdag_timing_start() { # variable phase
    [ "${TASKDAG_TIMING:-0}" = 1 ] || return 0
    local variable=$1 phase=$2 now=${EPOCHREALTIME/./}
    printf -v "$variable" '%s' "$now"
    jq -ncS --arg phase "$phase" --argjson wallMicros "$now" --argjson pid "$$" \
      '{event:"start",phase:$phase,pid:$pid,schema:1,wallMicros:$wallMicros}' >&2
}

taskdag_timing_finish() { # variable phase outcome
    [ "${TASKDAG_TIMING:-0}" = 1 ] || return 0
    local variable=$1 phase=$2 outcome=$3 now=${EPOCHREALTIME/./} start
    start=${!variable:-}
    [ -n "$start" ] || return 0
    jq -ncS --arg phase "$phase" --arg outcome "$outcome" --argjson wallMicros "$now" \
      --argjson durationMicros "$((now - start))" --argjson pid "$$" \
      '{durationMicros:$durationMicros,event:"finish",outcome:$outcome,phase:$phase,pid:$pid,schema:1,wallMicros:$wallMicros}' >&2
}

# Colors for output (if supported).
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    BOLD='\033[1m'
    RESET='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' BOLD='' RESET=''
fi
