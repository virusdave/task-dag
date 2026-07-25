#!/usr/bin/env bash
# Canonical JSON scalar and array emitters used by the task-dag CLI.

__taskdag_json_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
__taskdag_json_expected_entrypoint="${__taskdag_json_dir%/task-dag.d}/task-dag"
if [ -z "${TASKDAG_SCRIPT_DIR:-}" ] || [ -z "${TASKDAG_ENTRYPOINT:-}" ] \
    || [ ! "$TASKDAG_ENTRYPOINT" -ef "$__taskdag_json_expected_entrypoint" ]; then
    echo "Error: json.sh requires source-contract.sh to be loaded first" >&2
    unset __taskdag_json_dir __taskdag_json_expected_entrypoint
    return 2 2>/dev/null || exit 2
fi

__taskdag_json_caller="${BASH_SOURCE[1]:-}"
if [ -n "$__taskdag_json_caller" ]; then
    __taskdag_json_caller_dir="$(cd "$(dirname "$__taskdag_json_caller")" && pwd)"
    __taskdag_json_caller="$__taskdag_json_caller_dir/${__taskdag_json_caller##*/}"
fi
if [ -z "$__taskdag_json_caller" ] \
    || [ ! "$__taskdag_json_caller" -ef "$__taskdag_json_expected_entrypoint" ]; then
    echo "Error: json.sh must be loaded by the task-dag entrypoint" >&2
    unset __taskdag_json_dir __taskdag_json_expected_entrypoint \
        __taskdag_json_caller __taskdag_json_caller_dir
    return 2 2>/dev/null || exit 2
fi
unset __taskdag_json_dir __taskdag_json_expected_entrypoint \
    __taskdag_json_caller __taskdag_json_caller_dir

# Emit a JSON string literal (with surrounding quotes) for an arbitrary value,
# escaped per RFC 8259. Prefer jq when present (handles every control char),
# with a pure-Bash fallback for the values used by the blocked-meta overlay.
json_escape() {
    local s="$1"
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$s" | jq -Rs .
        return
    fi
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\t'/\\t}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\n'/\\n}"
    printf '"%s"' "$s"
}

json_str_or_null() {
    if [ -n "$1" ]; then json_escape "$1"; else printf 'null'; fi
}

json_int_or_null() {
    if [[ "${1:-}" =~ ^(0|[1-9][0-9]*)$ ]]; then printf '%s' "$1"; else printf 'null'; fi
}

json_number_or_null() {
    if [[ "${1:-}" =~ ^(0|[1-9][0-9]*)([.][0-9]+)?$ ]]; then printf '%s' "$1"; else printf 'null'; fi
}

# Read newline-separated raw values on stdin and emit a compact JSON array of
# escaped strings. Blank lines are omitted, so empty input emits [].
json_str_array() {
    awk 'NF' | { command -v jq >/dev/null 2>&1 \
        && jq -R . | jq -sc . \
        || { printf '['; local first=1 line; while IFS= read -r line; do
                 [ "$first" = 1 ] || printf ','; first=0; json_escape "$line";
             done; printf ']'; }; }
}

# Fail before mutation when a requested JSON result has no Bash fallback.
require_jq_for_json() {
    if ! command -v jq >/dev/null 2>&1; then
        echo "Error: jq is required for --json output" >&2
        return 1
    fi
}
