# shellcheck shell=bash
# Pure Materialise-Child-Epic parsing and immutable identity helpers.
#
# This dependency-minimal module performs no Git, network, filesystem mutation,
# command dispatch, or process-global initialization. It is shared by the
# runtime, census capture, close barrier, and legacy materialisation workflow.

for prerequisite in awk jq sed sha256sum tr; do
    if ! command -v "$prerequisite" >/dev/null 2>&1; then
        echo "Error: materialise-parsing.sh requires command $prerequisite" >&2
        return 2 2>/dev/null || exit 2
    fi
done
unset prerequisite

taskdag_extract_materialise_trailers_from_message() {
    local line key val key_lc in_group=0 in_fence=false fence_char="" fence_len=0 marker rest
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        if [[ "$line" =~ ^[[:space:]]{0,3}(\`{3,}|~{3,}) ]]; then
            marker=${BASH_REMATCH[1]}
            if [ "$in_fence" = false ]; then
                in_fence=true; fence_char=${marker:0:1}; fence_len=${#marker}
                continue
            fi
            rest=${line#*"$marker"}
            if [ "${marker:0:1}" = "$fence_char" ] && [ "${#marker}" -ge "$fence_len" ] \
              && [[ "$rest" =~ ^[[:space:]]*$ ]]; then
                in_fence=false; fence_char=""; fence_len=0
            fi
            continue
        fi
        [ "$in_fence" = false ] || continue
        [[ "$line" =~ ^[A-Za-z0-9-]+: ]] || continue
        key="${line%%:*}"
        val="${line#*:}"
        val="${val#"${val%%[![:space:]]*}"}"
        key_lc="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
        case "$key_lc" in
            materialise-child-epic|materialize-child-epic)
                in_group=1
                printf '%s: %s\n' "$key" "$val"
                ;;
            child-epic-title|child-epic-body-file|parent-issue|child-epic-slug|delegation-note)
                [ "$in_group" = 1 ] && printf '%s: %s\n' "$key" "$val"
                ;;
        esac
    done
    return 0
}

# Compatibility name used by the materialisation workflow and its tests.
extract_materialise_trailers_from_message() {
    taskdag_extract_materialise_trailers_from_message
}

# Normalize the shared Parent-Issue grammar. Both materialisation and closure
# use this exact helper so a value can never be rejected by one while silently
# ignored by the other. Optional '#', surrounding whitespace, and leading
# zeroes are accepted; zero/non-decimal values are rejected.
taskdag_materialise_parent_number() {
    local value="$1" normalized
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value="${value#\#}"
    [[ "$value" =~ ^[0-9]+$ ]] || return 1
    normalized=$(printf '%s' "$value" | sed 's/^0*//')
    [ -n "$normalized" ] || return 1
    printf '%s\n' "$normalized"
}

# Read a complete commit message on stdin and emit a compact JSON array of
# materialisation groups. Duplicate fields retain the workflow's existing
# last-wins behavior. Values are encoded by jq, never by shell interpolation.
taskdag_materialise_groups_json_from_message() {
    local trailers line key val key_lc open=false
    local peer="" title="" body_file="" parent="" slug="" note="" slug_present=false note_present=false companion_seen=false
    local -a groups=()
    trailers=$(taskdag_extract_materialise_trailers_from_message) || return 1

    _taskdag_mi_flush_group() {
        [ "$open" = true ] || return 0
        # A lone marker-like line in prose never described an actionable
        # legacy request. Preserve any companion field so partially-authored
        # declarations still reach strict validation and fail closed.
        if [ "$companion_seen" = false ]; then
            return 0
        fi
        groups+=("$(jq -nc \
            --arg peer "$peer" --arg title "$title" --arg bodyFile "$body_file" \
            --arg parent "$parent" --arg slug "$slug" --arg note "$note" \
            --argjson slugPresent "$slug_present" --argjson notePresent "$note_present" \
            '{peer:$peer,title:$title,bodyFile:$bodyFile,parent:$parent,slug:$slug,note:$note,slugPresent:$slugPresent,notePresent:$notePresent}')")
    }

    while IFS= read -r line; do
        [ -n "$line" ] || continue
        key="${line%%:*}"
        val="${line#*:}"
        val="${val#"${val%%[![:space:]]*}"}"
        key_lc="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
        case "$key_lc" in
            materialise-child-epic|materialize-child-epic)
                _taskdag_mi_flush_group || return 1
                open=true peer="$val" title="" body_file="" parent="" slug="" note="" slug_present=false note_present=false companion_seen=false
                ;;
            child-epic-title) title="$val"; companion_seen=true ;;
            child-epic-body-file) body_file="$val"; companion_seen=true ;;
            parent-issue) parent="$val"; companion_seen=true ;;
            child-epic-slug) slug="$val"; slug_present=true; companion_seen=true ;;
            delegation-note) note="$val"; note_present=true; companion_seen=true ;;
        esac
    done <<< "$trailers"
    _taskdag_mi_flush_group || return 1
    unset -f _taskdag_mi_flush_group

    if [ "${#groups[@]}" -eq 0 ]; then
        printf '[]\n'
    else
        printf '%s\n' "${groups[@]}" | jq -sc .
    fi
}

# Hash a domain-separated sequence of UTF-8 values. Decimal byte lengths and
# separators make framing unambiguous, including absent versus present-empty.
_taskdag_materialise_id() {
    local LC_ALL=C domain=$1 value
    shift
    {
        printf 'task-dag-materialisation-id-v1\000%s\000' "$domain"
        for value in "$@"; do printf '%s:%s\000' "${#value}" "$value"; done
    } | sha256sum | awk '{print $1}'
}

# A v1 declaration always retains its declared slot and operation identity.
# Schema-3 imports use a second, collision-scoped identity only for authority
# storage. Keeping this in one helper prevents live producers from silently
# rotating their IDs while allowing frozen declarations that reused a slot to
# coexist.
_taskdag_materialise_authority_slot_id() { # declared-slot declaration-digest collision(true|false)
    if [ "$3" = true ]; then
        _taskdag_materialise_id legacy-collision-slot-v1 "$1" "$2"
    else
        printf '%s\n' "$1"
    fi
}

_taskdag_materialise_slot_state_path() { printf 'slots/%s/states/%016d.json\n' "$1" "$2"; }
_taskdag_materialise_slot_authorization_path() { printf 'slots/%s/authorizations/%016d.json\n' "$1" "$2"; }
_taskdag_materialise_terminal_guard_path() { printf 'replay-guards/%s/%s.json\n' "$1" "$2"; }

# Extract identities only through these helpers. A schema-1 record has one
# identity; schema 3 deliberately retains the v1 declaration identity while
# placing mutable authority below the collision-scoped identity.
_taskdag_materialise_declared_slot() { jq -er 'if has("declaredSlotId") then .declaredSlotId else .slotId end' <<<"$1"; }
_taskdag_materialise_authority_slot() { jq -er 'if has("authoritySlotId") then .authoritySlotId else .slotId end' <<<"$1"; }
