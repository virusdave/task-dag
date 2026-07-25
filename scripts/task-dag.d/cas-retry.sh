# shellcheck shell=bash
# Shared bounded retry timing for direct compare-and-swap writers.

# Environment-overridable deterministic seams used by focused contention
# tests. The defaults start near one second, rise quadratically toward a
# ten-second cap, add fresh bounded jitter, and stop after a finite budget.
: "${TASKDAG_CAS_BASE_MS:=1000}"
: "${TASKDAG_CAS_CAP_MS:=10000}"
: "${TASKDAG_CAS_JITTER_MS:=250}"
: "${TASKDAG_CAS_MAX_ATTEMPTS:=8}"

taskdag_cas_ramp_ms() {
    local attempt="$1" ramp
    [[ "$attempt" =~ ^[1-9][0-9]*$ ]] || { echo "Error: taskdag_cas_ramp_ms needs a positive attempt" >&2; return 1; }
    ramp=$(( TASKDAG_CAS_BASE_MS * attempt * attempt ))
    [ "$ramp" -gt "$TASKDAG_CAS_CAP_MS" ] && ramp="$TASKDAG_CAS_CAP_MS"
    printf '%s\n' "$ramp"
}

taskdag_cas_jitter_ms() {
    if [ "$TASKDAG_CAS_JITTER_MS" -le 0 ]; then printf '0\n'; return 0; fi
    printf '%s\n' "$(( RANDOM % (TASKDAG_CAS_JITTER_MS + 1) ))"
}

taskdag_cas_backoff_ms() {
    local ramp jitter
    ramp=$(taskdag_cas_ramp_ms "$1") || return 1
    jitter=$(taskdag_cas_jitter_ms) || return 1
    printf '%s\n' "$(( ramp + jitter ))"
}

taskdag_cas_sleep() {
    local ms secs remaining
    ms=$(taskdag_cas_backoff_ms "$1") || return 1
    secs=$(awk -v ms="$ms" 'BEGIN{printf "%.3f", ms/1000}')
    if [[ "${TASKDAG_RECONCILE_DEADLINE:-}" =~ ^[0-9]+$ ]]; then
        remaining=$((TASKDAG_RECONCILE_DEADLINE - $(date +%s)))
        [ "$remaining" -gt 0 ] || return 124
        timeout --signal=TERM "${remaining}s" sleep "$secs"
        return $?
    fi
    sleep "$secs"
}
