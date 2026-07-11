# shellcheck shell=bash
# CI broken-master "repair chain" state persistence.
#
# Sourced by scripts/task-dag at startup. Adds:
#   - chain-read   — read a repo/branch's CI repair-chain state
#   - chain-write  — compare-and-set write of that state, race- and
#                    stale-run-safe
#
# This is item §1 ("Chain-state persistence") of the CI-driven
# broken-master auto-repair child epic (virusdave/task-dag#1, owning child
# of virusdave/top-level#26). The authoritative design is
# virusdave/top-level:docs/designs/ci-broken-master-auto-repair.md (§1 the
# fields, §4 the stale-run / out-of-order-CI race rules); this module is the
# durable store + the CAS primitive the classifier (§2) and the worker
# verifier (§7) build on. It is deliberately self-contained: no GitHub API,
# no business data — pure git refs on origin.
#
# ── Store layout ───────────────────────────────────────────────────────
# One ref per repo+branch, pushable (refs/heads/*) so origin is the single
# source of truth exactly like the claim subsystem:
#
#   refs/heads/tasks/ci-chains/<owner>/<repo>/<branch>
#
# <branch> is percent-encoded to a single, ref-safe path component so a
# slashed branch (release/v1) can never collide with a directory ref
# (release) — a git D/F conflict — and odd characters can't break the ref.
#
# The ref points at an empty-tree commit whose MESSAGE carries the design §1
# fields (Current-Head, Last-Green, First-Red, State, Repair-Mode,
# Repair-Issue, Repair-Attempt) plus the §3 escalation bookkeeping
# (Fail-Signature, Same-Sig-Count) and Updated-At. Each write's first parent is
# the prior chain commit, so `git log <ref>` is the chain's full audit
# history. This is the same "metadata lives in the commit message, state in
# the ref" convention the claim/cross-repo subsystems already use — no
# separate datastore.
#
# ── Race safety (two independent guards) ───────────────────────────────
#   1. Concurrency (two writers at once): the push is a single
#      `--force-with-lease=<ref>:<old>` compare-and-swap against origin,
#      with a post-push ls-remote readback — identical to cmd_claim. Two
#      simultaneous writers cannot both land; the loser gets exit 5.
#   2. Out-of-order CI (design §4): a write declares the commit it is
#      reacting to via --for-sha. If the stored Current-Head already
#      DESCENDS from (is newer than) that SHA, the incoming run is a
#      superseded/stale CI run and is REJECTED (exit 6) so we never mutate
#      chain state against a SHA the branch has already moved past. This
#      guard is FAIL-CLOSED: if ancestry cannot be proven (the stored
#      head's object is not present locally, e.g. a shallow CI checkout)
#      the write is refused (exit 6, reason stale-indeterminate) rather
#      than risk an older run clobbering newer state. --allow-stale is the
#      explicit operator override.
#
# Guarantee boundary: guard 2 establishes ordering by COMMIT ANCESTRY on a
# normally-advancing branch. It does NOT by itself order writes across a
# force-push / rewritten history (where the old and new tips are unrelated):
# resolving that needs an external monotonic ordering (CI run/event id or a
# remote-branch-tip check) the classifier (design §2) is expected to supply.
# This primitive owns the durable store + the linear out-of-order guard;
# cross-history supersession is layered on top by its caller.

# Canonical field order for chain-state commit messages / output.
#
# Fail-Signature / Same-Sig-Count are the tree-fix escalation bookkeeping
# (design §3 "repeated continue failures with the same signature"): the most
# recent failure signature seen on this chain, and the count of CONSECUTIVE
# same-signature continuation failures, so `tree-fix-outcome` can BLOCK + page
# after a small threshold instead of churning continue tasks forever. They are
# inherited/written like every other field (chain-write only persists fields
# listed here), and cleared whenever a chain closes green or a fresh chain opens.
_CICHAIN_FIELDS=(
    Current-Head Last-Green First-Red State Repair-Mode Repair-Issue
    Repair-Attempt Fail-Signature Same-Sig-Count
    Observed-Head Policy-Digest Aggregate Required-Evidence
    Head-First-Seen-At Observed-At Evidence-Key Decision-Key
    Registry-Commit Registry-Blob Enrollment-Mode
    Reconcile-Status Reconcile-Error
    Reconcile-Lease-Owner Reconcile-Lease-Until Reconcile-Fence
    Reconcile-Operation-ID
)

# `chain-write` is the legacy classifier writer. Authority, evidence,
# diagnostics, and lease fields are deliberately NOT writable through its
# generic --set surface; their owning commands update them through the typed
# internal CAS primitive below.
_CICHAIN_CLASSIFIER_WRITABLE_FIELDS=(
    Last-Green First-Red State Repair-Mode Repair-Issue Repair-Attempt
    Fail-Signature Same-Sig-Count
)

_cichain_classifier_field_writable() {
    local wanted="$1" field
    for field in "${_CICHAIN_CLASSIFIER_WRITABLE_FIELDS[@]}"; do
        [ "$field" = "$wanted" ] && return 0
    done
    return 1
}

_cichain_single_line() {
    case "$1" in
        *$'\n'* | *$'\r'*) return 1 ;;
        *) return 0 ;;
    esac
}

# Helper: percent-encode a string to a single ref-safe path component.
# Everything outside [A-Za-z0-9._-] becomes %XX so slashed/odd branch names
# can't create D/F ref conflicts or illegal refs.
_cichain_encode() {
    local s="$1" out="" i c
    for ((i = 0; i < ${#s}; i++)); do
        c="${s:i:1}"
        case "$c" in
            [A-Za-z0-9._-]) out+="$c" ;;
            *) out+="$(printf '%%%02X' "'$c")" ;;
        esac
    done
    printf '%s' "$out"
}

# Helper: build the full chain-state ref for <owner/repo> <branch>.
_cichain_ref() {
    local repo="$1" branch="$2"
    printf 'refs/heads/tasks/ci-chains/%s/%s' "$repo" "$(_cichain_encode "$branch")"
}

# Helper: ensure a committer identity exists for commit-tree (no-op if set).
_cichain_ensure_identity() {
    if [ -z "$(git config user.name 2>/dev/null)" ]; then
        git config user.name "github-actions[bot]"
    fi
    if [ -z "$(git config user.email 2>/dev/null)" ]; then
        git config user.email "github-actions[bot]@users.noreply.github.com"
    fi
}

# Helper: mirror a single chain ref from origin into the local ref so we
# both see the latest state AND have the commit object available locally
# (needed to parse fields and to build the next commit on top). Non-fatal
# when offline or when the ref does not yet exist on origin.
_cichain_fetch() {
    local ref="$1"
    git fetch --quiet origin "+${ref}:${ref}" 2>/dev/null || true
}

# Helper: read the SHA origin currently has at <ref>, bypassing local refs.
# Empty stdout = ref absent on origin. This is the CAS source of truth and
# the post-push readback, mirroring task_active_sha_on_remote — so it MUST
# distinguish "ref absent" (normal) from "cannot reach origin" (a transport
# failure we must NOT silently treat as absent). Returns:
#   0 + sha       ref present
#   0 + empty     ref absent
#   1             ls-remote transport/auth failure (origin unreachable)
_cichain_remote_sha() {
    local ref="$1" out
    out="$(git ls-remote origin "$ref" 2>/dev/null)" || return 1
    printf '%s' "$out" | awk '{print $1; exit}'
}

# Helper: extract a single field's value from a chain-state commit message.
_cichain_field() {
    local commit="$1" field="$2"
    git log -1 --format=%B "$commit" 2>/dev/null \
        | sed -n "s/^${field}: *//p" | head -1
}

_cichain_field_count() {
    local commit="$1" field="$2"
    git log -1 --format=%B "$commit" 2>/dev/null \
        | awk -v prefix="${field}:" 'index($0, prefix) == 1 { n++ } END { print n + 0 }'
}

_cichain_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Serialize a fully materialized chain state without moving a ref. Keeping the
# canonical message builder separate lets a multi-ref transaction (notably
# repair-retire) include a real chain advance in the same atomic push as its
# other effects instead of relying on an unenforced no-op refspec lease.
_cichain_build_state_commit() { # <repo> <branch> <old> <updated-at> <map-name>
    local repo="$1" branch="$2" old="$3" updated_at="$4" map_name="$5"
    local -n state="$map_name"
    local field msg

    if [ -z "$repo" ] || [ -z "$branch" ] \
        || ! _cichain_single_line "$repo" \
        || ! _cichain_single_line "$branch" \
        || ! _cichain_single_line "$updated_at"; then
        return 1
    fi
    for field in "${_CICHAIN_FIELDS[@]}"; do
        if [ -z "${state[$field]+present}" ] \
            || ! _cichain_single_line "${state[$field]}"; then
            return 1
        fi
    done

    _cichain_ensure_identity
    msg="CI-Chain: ${repo}@${branch}
"
    for field in "${_CICHAIN_FIELDS[@]}"; do
        msg="${msg}
${field}: ${state[$field]}"
    done
    msg="${msg}
Updated-At: ${updated_at}"

    if [ -n "$old" ]; then
        printf '%s' "$msg" | git commit-tree "$EMPTY_TREE" -p "$old"
    else
        printf '%s' "$msg" | git commit-tree "$EMPTY_TREE"
    fi
}

# Serialize and compare-and-set a fully materialized chain state. This is the
# one mutation primitive shared by classifier writes and metadata-only lease
# writes. Callers own all semantic validation and must provide every canonical
# field; this helper enforces the line-oriented storage boundary again before
# creating a commit.
#
# Result globals:
#   _CICHAIN_PUSH_COMMIT  new commit on success
#   _CICHAIN_PUSH_REASON  race-lost | push-failed | not-confirmed on failure
_cichain_push_state() { # <repo> <branch> <ref> <old> <updated-at> <map-name>
    local repo="$1" branch="$2" ref="$3" old="$4" updated_at="$5" map_name="$6"
    local new_commit lease push_output readback

    _CICHAIN_PUSH_COMMIT=""
    _CICHAIN_PUSH_REASON=""

    new_commit="$(_cichain_build_state_commit "$repo" "$branch" "$old" "$updated_at" "$map_name")" || {
        _CICHAIN_PUSH_REASON="push-failed"
        return 4
    }

    lease="--force-with-lease=${ref}:${old}"
    if ! push_output=$(git push --atomic origin "$lease" "${new_commit}:${ref}" 2>&1); then
        if printf '%s' "$push_output" | grep -qiE 'rejected|stale info|non-fast-forward|fetch first'; then
            _cichain_fetch "$ref"
            _CICHAIN_PUSH_REASON="race-lost"
            return 5
        fi
        _CICHAIN_PUSH_REASON="push-failed"
        return 4
    fi

    if ! readback="$(_cichain_remote_sha "$ref")"; then
        _CICHAIN_PUSH_REASON="not-confirmed"
        return 4
    fi
    if [ "$readback" != "$new_commit" ]; then
        _cichain_fetch "$ref"
        _CICHAIN_PUSH_REASON="race-lost"
        return 5
    fi

    git update-ref "$ref" "$new_commit" 2>/dev/null \
        || echo "Warning: origin updated but local mirror of $ref failed" >&2
    _CICHAIN_PUSH_COMMIT="$new_commit"
    return 0
}

# ---------------------------------------------------------------------------
# Command: chain-read <owner/repo> <branch> [--json] [--no-fetch]
# ---------------------------------------------------------------------------
# Exit codes:
#   0  state found and printed
#   1  argument error
#   3  no chain state exists for this repo/branch
cmd_chain_read() {
    local repo="" branch="" json=false do_fetch=true

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help | -h)
                cat <<EOF
Usage: task-dag chain-read <owner/repo> <branch> [--json] [--no-fetch]

Read the CI broken-master repair-chain state for a repo/branch. Origin is
the source of truth; the ref is fetched first unless --no-fetch.

Exit codes:
  0  state found
  1  argument error
  3  no chain state exists yet for this repo/branch
EOF
                return 0
                ;;
            -*)
                echo "Unknown option: $1" >&2
                return 1
                ;;
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

    local ref sha=""
    ref="$(_cichain_ref "$repo" "$branch")"
    # Origin is the source of truth: read the authoritative SHA from origin
    # (so a ref deleted on origin reports absent even if a stale local ref
    # lingers) and only then fetch its object. Fall back to the last-known
    # local ref only when origin is unreachable, so the command still works
    # offline without silently masquerading stale state as current.
    if [ "$do_fetch" = true ]; then
        if sha="$(_cichain_remote_sha "$ref")"; then
            [ -n "$sha" ] && _cichain_fetch "$ref"
        else
            echo "Warning: cannot reach origin; reading last-known local state for $repo@$branch" >&2
            sha="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
        fi
    else
        sha="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
    fi

    if [ -z "$sha" ]; then
        if [ "$json" = true ]; then
            printf '{"exists":false,"repo":%s,"branch":%s,"ref":%s}\n' \
                "$(json_escape "$repo")" "$(json_escape "$branch")" "$(json_escape "$ref")"
        else
            printf "${YELLOW}No CI chain state for %s@%s${RESET}\n" "$repo" "$branch" >&2
        fi
        return 3
    fi

    if [ "$json" = true ]; then
        printf '{"exists":true,"repo":%s,"branch":%s,"ref":%s,"commit":%s' \
            "$(json_escape "$repo")" "$(json_escape "$branch")" "$(json_escape "$ref")" "$(json_escape "$sha")"
        local f key
        for f in "${_CICHAIN_FIELDS[@]}"; do
            # JSON key: Current-Head -> currentHead
            key="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]' | sed -E 's/-([a-z])/\U\1/g')"
            printf ',"%s":%s' "$key" "$(json_escape "$(_cichain_field "$sha" "$f")")"
        done
        printf ',"updatedAt":%s}\n' "$(json_escape "$(_cichain_field "$sha" Updated-At)")"
    else
        printf "${BOLD}CI chain: %s@%s${RESET}\n" "$repo" "$branch"
        printf "  Ref:    %s\n" "$ref"
        printf "  Commit: %s\n" "$sha"
        local f
        for f in "${_CICHAIN_FIELDS[@]}"; do
            printf "  %-13s %s\n" "$f:" "$(_cichain_field "$sha" "$f")"
        done
        printf "  %-13s %s\n" "Updated-At:" "$(_cichain_field "$sha" Updated-At)"
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Command: chain-write <owner/repo> <branch> --for-sha=<commit> [options]
# ---------------------------------------------------------------------------
# Compare-and-set the chain state. --for-sha is the commit this write is
# reacting to and becomes the new Current-Head. Unspecified fields are
# inherited from the prior state.
#
# Options:
#   --for-sha=<commit>      REQUIRED. The commit this CI run is about.
#   --state=<v>             green | red | unknown ...
#   --last-green=<sha>      design §1 field overrides
#   --first-red=<sha>
#   --repair-mode=<v>       initial | continue ...
#   --repair-issue=<n>
#   --repair-attempt=<n>
#   --set Field=Value       generic override (repeatable)
#   --create                fail if the chain already exists
#   --allow-stale           bypass the out-of-order/superseded-SHA guard
#   --json / --no-fetch
#
# Exit codes:
#   0  write landed
#   1  argument error
#   4  git/push failed, origin unreachable, or write unconfirmable
#   5  lost the CAS race (concurrent writer) / --create but state exists
#   6  stale: --for-sha is superseded by, or unprovable against, a newer
#      stored Current-Head (fail-closed; --allow-stale overrides)
cmd_chain_write() {
    local repo="" branch="" for_sha=""
    local do_create=false allow_stale=false json=false do_fetch=true
    local expect_old="" have_expect=false
    declare -A overrides=()

    _cichain_add_override() { # key=value
        local kv="$1" k v
        k="${kv%%=*}"; v="${kv#*=}"
        if [ -z "$k" ] || [ "$k" = "$kv" ]; then
            echo "Error: --set expects Field=Value, got '$kv'" >&2
            return 1
        fi
        if ! _cichain_classifier_field_writable "$k"; then
            echo "Error: chain-write cannot mutate protected or derived field '$k'" >&2
            return 1
        fi
        overrides["$k"]="$v"
    }

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --for-sha=*) for_sha="${1#*=}"; shift ;;
            --state=*) overrides[State]="${1#*=}"; shift ;;
            --last-green=*) overrides[Last-Green]="${1#*=}"; shift ;;
            --first-red=*) overrides[First-Red]="${1#*=}"; shift ;;
            --repair-mode=*) overrides[Repair-Mode]="${1#*=}"; shift ;;
            --repair-issue=*) overrides[Repair-Issue]="${1#*=}"; shift ;;
            --repair-attempt=*) overrides[Repair-Attempt]="${1#*=}"; shift ;;
            --set=*) _cichain_add_override "${1#*=}" || return 1; shift ;;
            --set) shift; _cichain_add_override "${1:-}" || return 1; shift ;;
            --create) do_create=true; shift ;;
            --expect-old=*) expect_old="${1#*=}"; have_expect=true; shift ;;
            --allow-stale) allow_stale=true; shift ;;
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help | -h)
                cat <<EOF
Usage: task-dag chain-write <owner/repo> <branch> --for-sha=<commit> [options]

Compare-and-set the CI repair-chain state. Race-safe (atomic
--force-with-lease push + readback) and stale-run-safe (rejects a --for-sha
already superseded by a newer stored Current-Head).

Options:
  --for-sha=<commit>   REQUIRED; the commit this CI run is about -> Current-Head
  --state=<v>          green | red | unknown ...
  --last-green=<sha>   design §1 field overrides
  --first-red=<sha>
  --repair-mode=<v>    initial | continue ...
  --repair-issue=<n>
  --repair-attempt=<n>
  --set Field=Value    generic field override (repeatable)
  --create             fail (exit 5) if the chain already exists
  --expect-old=<sha>   compare-and-set baseline: fail (exit 5) unless the
                       chain ref currently equals <sha> ('' = expect absent).
                       Lets a caller that read state X bind its write to X so
                       a concurrent mutation in between cannot be clobbered.
  --allow-stale        bypass the out-of-order/superseded-SHA guard
  --json               machine-readable result
  --no-fetch           skip the pre-read fetch from origin

Exit codes:
  0 ok   1 args   4 git/push or origin-unreachable error
  5 lost CAS race / --create exists
  6 stale: --for-sha superseded by, or unprovable against, a newer head
EOF
                return 0
                ;;
            -*)
                echo "Unknown option: $1" >&2
                return 1
                ;;
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
    if ! _cichain_single_line "$repo" || ! _cichain_single_line "$branch"; then
        echo "Error: <owner/repo> and <branch> must each be a single line" >&2
        return 1
    fi
    if [ -z "$for_sha" ]; then
        echo "Error: --for-sha=<commit> is required" >&2
        return 1
    fi
    local override_field
    for override_field in "${!overrides[@]}"; do
        if ! _cichain_classifier_field_writable "$override_field" \
            || ! _cichain_single_line "${overrides[$override_field]}"; then
            echo "Error: invalid single-line chain-write value for '$override_field'" >&2
            return 1
        fi
    done

    # Resolve --for-sha to a full, immutable commit object up front. This
    # rejects junk (HEAD, a branch name, a typo, an abbreviated/ambiguous
    # SHA) that would otherwise be stored verbatim as Current-Head and
    # poison every later stale comparison. It also guarantees the object is
    # present locally so the ancestry guard below can actually run.
    local for_sha_full
    if ! for_sha_full="$(git rev-parse --verify --quiet "${for_sha}^{commit}" 2>/dev/null)"; then
        echo "Error: --for-sha must resolve to a commit object present locally (got '$for_sha')" >&2
        return 1
    fi
    for_sha="$for_sha_full"

    _cichain_ensure_identity

    local ref
    ref="$(_cichain_ref "$repo" "$branch")"

    # Origin is the CAS source of truth; the lease is keyed on this value.
    # Read it with a CHECKED ls-remote so an unreachable origin becomes a
    # clean exit 4 instead of being mistaken for "ref absent" (which would
    # wrongly look claimable for --create / lose the stale baseline).
    local old
    if ! old="$(_cichain_remote_sha "$ref")"; then
        echo "Error: cannot reach origin to read chain state for $repo@$branch" >&2
        return 4
    fi

    # Caller-supplied compare-and-set baseline. A caller (e.g. the classifier)
    # that read state at SHA X and decided an action on that basis binds its
    # write to X here, so a concurrent mutation between its read and this write
    # cannot be silently clobbered (fixes the read-decide-write TOCTOU). Empty
    # baseline means "expected absent".
    if [ "$have_expect" = true ] && [ "$old" != "$expect_old" ]; then
        if [ "$json" = true ]; then
            printf '{"ok":false,"reason":"expect-mismatch","ref":%s,"expectedOld":%s,"actualOld":%s}\n' \
                "$(json_escape "$ref")" "$(json_escape "$expect_old")" "$(json_escape "$old")"
        else
            printf "${YELLOW}Chain state for %s@%s moved since it was read (expected %s, found %s) — refusing CAS write.${RESET}\n" \
                "$repo" "$branch" "${expect_old:-<absent>}" "${old:-<absent>}" >&2
        fi
        return 5
    fi

    # Bring the prior chain commit's object local so we can read its fields
    # and build the next commit on top. If origin advertises a SHA we still
    # can't materialise, distinguish a concurrent move (race) from a genuine
    # fetch failure rather than charging ahead blind.
    if [ -n "$old" ]; then
        [ "$do_fetch" = true ] && _cichain_fetch "$ref"
        if ! git cat-file -e "${old}^{commit}" 2>/dev/null; then
            local recheck
            recheck="$(_cichain_remote_sha "$ref" 2>/dev/null || true)"
            if [ -n "$recheck" ] && [ "$recheck" != "$old" ]; then
                echo "Lost CAS race for $repo@$branch (origin moved while reading)." >&2
                return 5
            fi
            echo "Error: origin advertises $ref=$old but its object is unavailable locally" >&2
            return 4
        fi
    fi

    if [ "$do_create" = true ] && [ -n "$old" ]; then
        if [ "$json" = true ]; then
            printf '{"ok":false,"reason":"exists","ref":%s}\n' "$(json_escape "$ref")"
        else
            printf "${RED}Chain state already exists for %s@%s (--create refused).${RESET}\n" \
                "$repo" "$branch" >&2
        fi
        return 5
    fi

    # Seed field values from the prior state (inheritance), then stale-guard.
    declare -A vals=()
    local f
    if [ -n "$old" ]; then
        for f in "${_CICHAIN_FIELDS[@]}"; do
            vals["$f"]="$(_cichain_field "$old" "$f")"
        done

        # ── Out-of-order CI guard (design §4) ─────────────────────────
        # Reject if the incoming --for-sha is an ANCESTOR of the stored
        # Current-Head (i.e. the branch has already moved past it): this CI
        # run is superseded and must not clobber newer state.
        local stored_head="${vals[Current-Head]}"
        if [ -n "$stored_head" ] && [ "$stored_head" != "$for_sha" ] && [ "$allow_stale" = false ]; then
            # NB: bare `git merge-base --is-ancestor` returns 1 when not an
            # ancestor; under the script's `set -e` that would abort, so
            # capture the status via `|| anc_rc=$?`.
            local anc_rc=0
            git merge-base --is-ancestor "$for_sha" "$stored_head" 2>/dev/null || anc_rc=$?
            if [ "$anc_rc" -eq 0 ]; then
                # Proven stale: for_sha is an ancestor of the stored head.
                if [ "$json" = true ]; then
                    printf '{"ok":false,"reason":"stale","ref":%s,"forSha":%s,"storedHead":%s}\n' \
                        "$(json_escape "$ref")" "$(json_escape "$for_sha")" "$(json_escape "$stored_head")"
                else
                    printf "${YELLOW}Stale CI run: %s is superseded by stored Current-Head %s — refusing to write.${RESET}\n" \
                        "$for_sha" "$stored_head" >&2
                    echo "Pass --allow-stale only if you are certain this older run should overwrite newer state." >&2
                fi
                return 6
            elif [ "$anc_rc" -gt 1 ]; then
                # Ancestry UNDETERMINABLE (the stored head's object is not
                # present locally, e.g. a shallow CI checkout). We cannot
                # prove this run is fresh, and the invariant is "never mutate
                # against a superseded SHA" — so FAIL CLOSED rather than risk
                # an older run clobbering newer state. The caller can deepen
                # history and retry, or pass --allow-stale if it is certain.
                if [ "$json" = true ]; then
                    printf '{"ok":false,"reason":"stale-indeterminate","ref":%s,"forSha":%s,"storedHead":%s}\n' \
                        "$(json_escape "$ref")" "$(json_escape "$for_sha")" "$(json_escape "$stored_head")"
                else
                    printf "${RED}Cannot determine whether %s supersedes stored Current-Head %s (object missing locally) — refusing to write (fail-closed).${RESET}\n" \
                        "$for_sha" "$stored_head" >&2
                    echo "Deepen branch history and retry, or pass --allow-stale if you are certain." >&2
                fi
                return 6
            fi
        fi
    else
        vals[State]="unknown"
    fi

    # Apply explicit overrides, then the always-derived fields.
    local k
    for k in "${!overrides[@]}"; do
        vals["$k"]="${overrides[$k]}"
    done
    vals[Current-Head]="$for_sha"

    # Materialize every canonical field before entering the typed serializer.
    # This is what makes current writers preserve fields owned by later
    # reconciliation stages even though chain-write cannot mutate them.
    for f in "${_CICHAIN_FIELDS[@]}"; do
        [ -n "${vals[$f]+present}" ] || vals["$f"]=""
    done

    local push_rc=0
    _cichain_push_state "$repo" "$branch" "$ref" "$old" "$(_cichain_now)" vals || push_rc=$?
    if [ "$push_rc" -eq 0 ]; then
        if [ "$json" = true ]; then
            printf '{"ok":true,"ref":%s,"commit":%s,"currentHead":%s,"state":%s}\n' \
                "$(json_escape "$ref")" "$(json_escape "$_CICHAIN_PUSH_COMMIT")" "$(json_escape "${vals[Current-Head]:-}")" "$(json_escape "${vals[State]:-}")"
        else
            printf "${GREEN}✓ Chain state for %s@%s -> %s (Current-Head %s, State %s)${RESET}\n" \
                "$repo" "$branch" "$(git rev-parse --short "$_CICHAIN_PUSH_COMMIT")" \
                "${vals[Current-Head]:-}" "${vals[State]:-}"
        fi
        return 0
    fi

    if [ "$_CICHAIN_PUSH_REASON" = "race-lost" ]; then
        if [ "$json" = true ]; then
            printf '{"ok":false,"reason":"race-lost","ref":%s}\n' "$(json_escape "$ref")"
        else
            printf "${YELLOW}Lost chain-write CAS race for %s@%s (another writer won).${RESET}\n" \
                "$repo" "$branch" >&2
        fi
        return 5
    fi

    if [ "$json" = true ]; then
        printf '{"ok":false,"reason":%s,"ref":%s}\n' \
            "$(json_escape "$_CICHAIN_PUSH_REASON")" "$(json_escape "$ref")"
    else
        printf "${RED}Chain-write failed for %s@%s (%s).${RESET}\n" \
            "$repo" "$branch" "$_CICHAIN_PUSH_REASON" >&2
    fi
    return 4
}

_cichain_timestamp_epoch() {
    local value="$1" rendered epoch
    [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
        || return 1
    rendered="$(date -u -d "$value" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)" \
        || return 1
    [ "$rendered" = "$value" ] || return 1
    epoch="$(date -u -d "$value" +%s 2>/dev/null)" || return 1
    [[ "$epoch" =~ ^-?[0-9]+$ ]] || return 1
    printf '%s' "$epoch"
}

# ---------------------------------------------------------------------------
# Command: reconcile-lease <owner/repo> <branch> --owner=<id> --now=<UTC>
# ---------------------------------------------------------------------------
# Acquire or renew the five-minute reconciliation lease stored in the existing
# chain ref. `--now` is an explicit trust boundary: the future evidence
# collector supplies GitHub's already-skew-validated Date value, so host time
# never decides lease validity or persisted Updated-At.
cmd_reconcile_lease() {
    local repo="" branch="" owner="" now="" supplied_fence=""
    local have_fence=false json=false

    _reconcile_lease_report() { # <rc> <reason> [message]
        local rc="$1" reason="$2" message="${3:-}"
        if [ "$json" = true ]; then
            printf '{"ok":%s,"reason":%s,"rc":%s' \
                "$([ "$rc" -eq 0 ] && printf true || printf false)" \
                "$(json_escape "$reason")" "$rc"
            if [ "$rc" -eq 0 ]; then
                printf ',"repo":%s,"branch":%s,"owner":%s,"fence":%s,"leaseUntil":%s,"ref":%s,"commit":%s' \
                    "$(json_escape "$repo")" "$(json_escape "$branch")" \
                    "$(json_escape "$owner")" "$new_fence" \
                    "$(json_escape "$new_until")" "$(json_escape "$ref")" \
                    "$(json_escape "$_CICHAIN_PUSH_COMMIT")"
            fi
            printf '}\n'
        elif [ "$rc" -eq 0 ]; then
            printf "${GREEN}✓ Reconciliation lease %s for %s@%s (owner %s, fence %s, until %s)${RESET}\n" \
                "$reason" "$repo" "$branch" "$owner" "$new_fence" "$new_until"
        else
            printf "${RED}Reconciliation lease refused (%s): %s${RESET}\n" \
                "$reason" "$message" >&2
        fi
        return "$rc"
    }

    while [ $# -gt 0 ]; do
        case "$1" in
            --owner=*) owner="${1#*=}"; shift ;;
            --now=*) now="${1#*=}"; shift ;;
            --fence=*) supplied_fence="${1#*=}"; have_fence=true; shift ;;
            --json) json=true; shift ;;
            --help | -h)
                cat <<'EOF'
Usage: task-dag reconcile-lease <owner/repo> <branch> --owner=<pass-id> \
         --now=<YYYY-MM-DDTHH:MM:SSZ> [--fence=<n>] [--json]

Acquire or renew the five-minute fenced lease for one CI repair chain.
The caller must pass an authoritative, clock-skew-validated UTC time. A new
or expired lease increments the retained fence; --fence, when supplied, is a
compare precondition. Renewing a live lease requires its matching owner and
fence. The operation changes only Reconcile-Lease-* / Reconcile-Fence and
preserves every classifier and evidence field.

Owner: 1..128 characters matching [A-Za-z0-9][A-Za-z0-9._:@/-]*
Fence: canonical nonnegative decimal, at most 999999999999999999

Exit codes / JSON reasons:
  0  acquired | renewed
  1  invalid-argument
  4  push-failed | not-confirmed
  5  race-lost
  7  lease-held | fence-mismatch
  8  stored-invalid
  9  fence-exhausted
EOF
                return 0
                ;;
            -*)
                _reconcile_lease_report 1 invalid-argument "unknown option '$1'"
                return $?
                ;;
            *)
                if [ -z "$repo" ]; then repo="$1"
                elif [ -z "$branch" ]; then branch="$1"
                else
                    _reconcile_lease_report 1 invalid-argument "unexpected argument '$1'"
                    return $?
                fi
                shift
                ;;
        esac
    done

    if [ -z "$repo" ] || [ -z "$branch" ] || [ -z "$owner" ] || [ -z "$now" ] \
        || ! _cichain_single_line "$repo" || ! _cichain_single_line "$branch" \
        || ! [[ "$owner" =~ ^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$ ]]; then
        _reconcile_lease_report 1 invalid-argument "repo, branch, owner, and canonical --now are required"
        return $?
    fi
    if [ "$have_fence" = true ] \
        && { ! [[ "$supplied_fence" =~ ^(0|[1-9][0-9]*)$ ]] \
            || [ "${#supplied_fence}" -gt 18 ] \
            || [ "$supplied_fence" -gt 999999999999999999 ]; }; then
        _reconcile_lease_report 1 invalid-argument "--fence must be canonical and between 0 and 999999999999999999"
        return $?
    fi

    local now_epoch new_until new_until_epoch
    if ! now_epoch="$(_cichain_timestamp_epoch "$now")"; then
        _reconcile_lease_report 1 invalid-argument "--now must be an exact canonical UTC timestamp"
        return $?
    fi
    new_until="$(date -u -d "@$((now_epoch + 300))" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || true)"
    if [ -z "$new_until" ] || ! new_until_epoch="$(_cichain_timestamp_epoch "$new_until")" \
        || [ "$new_until_epoch" -ne $((now_epoch + 300)) ]; then
        _reconcile_lease_report 1 invalid-argument "--now plus the five-minute lease cannot be represented canonically"
        return $?
    fi

    local ref old
    ref="$(_cichain_ref "$repo" "$branch")"
    if ! old="$(_cichain_remote_sha "$ref")"; then
        _reconcile_lease_report 4 push-failed "cannot reach origin to read the chain"
        return $?
    fi
    if [ -n "$old" ]; then
        _cichain_fetch "$ref"
        if ! git cat-file -e "${old}^{commit}" 2>/dev/null; then
            _reconcile_lease_report 4 push-failed "origin chain object is unavailable locally"
            return $?
        fi
    fi

    declare -A vals=()
    local field
    for field in "${_CICHAIN_FIELDS[@]}"; do
        vals["$field"]=""
        [ -n "$old" ] && vals["$field"]="$(_cichain_field "$old" "$field")"
    done

    local stored_owner="${vals[Reconcile-Lease-Owner]}"
    local stored_until="${vals[Reconcile-Lease-Until]}"
    local prior_fence="${vals[Reconcile-Fence]}"
    local count
    if [ -n "$old" ]; then
        for field in Reconcile-Lease-Owner Reconcile-Lease-Until Reconcile-Fence; do
            count="$(_cichain_field_count "$old" "$field")"
            if [ "$count" -gt 1 ]; then
                _reconcile_lease_report 8 stored-invalid "stored lease field '$field' is duplicated"
                return $?
            fi
        done
    fi

    [ -n "$prior_fence" ] || prior_fence=0
    if ! [[ "$prior_fence" =~ ^(0|[1-9][0-9]*)$ ]] \
        || [ "${#prior_fence}" -gt 18 ] \
        || [ "$prior_fence" -gt 999999999999999999 ]; then
        _reconcile_lease_report 8 stored-invalid "stored reconciliation fence is malformed"
        return $?
    fi
    if { [ -n "$stored_owner" ] && [ -z "$stored_until" ]; } \
        || { [ -z "$stored_owner" ] && [ -n "$stored_until" ]; }; then
        _reconcile_lease_report 8 stored-invalid "stored lease owner/deadline tuple is partial"
        return $?
    fi

    local active=false stored_until_epoch=""
    if [ -n "$stored_owner" ]; then
        if ! [[ "$stored_owner" =~ ^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$ ]] \
            || [ "$prior_fence" = 0 ] \
            || ! stored_until_epoch="$(_cichain_timestamp_epoch "$stored_until")"; then
            _reconcile_lease_report 8 stored-invalid "stored active lease tuple is malformed"
            return $?
        fi
        [ "$now_epoch" -lt "$stored_until_epoch" ] && active=true
    fi

    local action new_fence
    if [ "$active" = true ]; then
        if [ "$stored_owner" != "$owner" ]; then
            _reconcile_lease_report 7 lease-held "a different owner holds the live lease"
            return $?
        fi
        if [ "$have_fence" != true ] || [ "$supplied_fence" != "$prior_fence" ]; then
            _reconcile_lease_report 7 fence-mismatch "live renewal requires the matching fence"
            return $?
        fi
        action=renewed
        new_fence="$prior_fence"
    else
        if [ "$have_fence" = true ] && [ "$supplied_fence" != "$prior_fence" ]; then
            _reconcile_lease_report 7 fence-mismatch "acquisition fence precondition does not match"
            return $?
        fi
        if [ "$prior_fence" = 999999999999999999 ]; then
            _reconcile_lease_report 9 fence-exhausted "stored fence cannot be incremented safely"
            return $?
        fi
        action=acquired
        new_fence=$((10#$prior_fence + 1))
    fi

    vals[Reconcile-Lease-Owner]="$owner"
    vals[Reconcile-Lease-Until]="$new_until"
    vals[Reconcile-Fence]="$new_fence"

    local push_rc=0
    _cichain_push_state "$repo" "$branch" "$ref" "$old" "$now" vals || push_rc=$?
    if [ "$push_rc" -ne 0 ]; then
        _reconcile_lease_report "$push_rc" "$_CICHAIN_PUSH_REASON" "chain compare-and-set failed"
        return $?
    fi

    _reconcile_lease_report 0 "$action"
}
