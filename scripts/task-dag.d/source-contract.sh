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
