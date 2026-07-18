# shellcheck shell=bash
# Cross-repo task-DAG driver subcommands.
#
# Sourced by scripts/task-dag at startup. Adds:
#   - delegate           — declare a peer-repo delegated child of an epic
#   - ingest-comment     — ingest a top-level issue comment into the DAG
#   - ingest-completion  — record a peer-repo Satisfies: trailer as completing
#                          a delegated child
#   - close-epic         — emit the additive close commit when all delegated
#                          children are satisfied
#
# All four commands are idempotent and never rewrite or delete prior refs.
# Refs live under refs/heads/* so they are pushable. See
# docs/task_dag/CROSS_REPO_DRIVER_DESIGN.md.

# Resolve this module's directory once, at source time (cwd is still the
# invocation dir and BASH_SOURCE is the path task-dag sourced us with), so
# later lookups (e.g. phase-gates.conf) are immune to subsequent `cd`s.
_XREPO_MODULE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Helper: structured logger; cross-repo subcommands print one line per
# significant action so the verification recipe can grep for it.
_xrepo_log() {
    echo "[task-dag] $*" >&2
}

_xrepo_die() {
    echo "[task-dag] error: $*" >&2
    return 2
}

_xrepo_watchdog_fence() {
    [ -z "${_XREPO_WATCHDOG_TOKEN_FILE:-}" ] || taskdag_comment_watchdog_check_file "$_XREPO_WATCHDOG_TOKEN_FILE" 30
}

# Helper: trim leading/trailing whitespace.
_xrepo_trim() {
    local s="$1"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    printf '%s' "$s"
}

# Helper: return 0 iff the file's last byte is a newline (empty file: false).
# Used to preserve an issue body's trailing-newline state byte-for-byte when
# splicing/appending the delegated_to block.
_xrepo_file_ends_with_newline() {
    [ -s "$1" ] || return 1
    [ -z "$(tail -c1 "$1")" ]
}

# Helper: assert a command is available (gh, jq, etc.).
_xrepo_need_cmd() {
    local c="$1"
    command -v "$c" >/dev/null 2>&1 || {
        _xrepo_die "required command not found: $c"
        return 2
    }
}

# Helper: full empty-tree SHA (cached to avoid repeated hash-object calls).
_xrepo_empty_tree() {
    if [ -z "${_XREPO_EMPTY_TREE:-}" ]; then
        _XREPO_EMPTY_TREE="$(git hash-object -t tree /dev/null)"
    fi
    printf '%s' "$_XREPO_EMPTY_TREE"
}

# Helper: ensure git committer identity is set (no-op if already set).
_xrepo_ensure_git_identity() {
    if [ -z "$(git config user.name 2>/dev/null)" ]; then
        git config user.name "github-actions[bot]"
    fi
    if [ -z "$(git config user.email 2>/dev/null)" ]; then
        git config user.email "github-actions[bot]@users.noreply.github.com"
    fi
}

# Helper: get the current repo's owner/repo string. Tries `gh repo view`
# first, falls back to parsing the origin URL.
_xrepo_current_repo() {
    if [ -n "${GITHUB_REPOSITORY:-}" ]; then
        printf '%s' "$GITHUB_REPOSITORY"
        return 0
    fi
    local configured
    configured="$(git config --get taskdag.current-repo 2>/dev/null || true)"
    if [ -n "$configured" ]; then
        printf '%s' "$configured"
        return 0
    fi
    if command -v gh >/dev/null 2>&1; then
        local r
        r="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
        if [ -n "$r" ]; then
            printf '%s' "$r"
            return 0
        fi
    fi
    local url
    url="$(git config --get remote.origin.url)"
    # git@host:owner/repo.git OR https://host/owner/repo.git
    url="${url%.git}"
    url="${url##*:}"
    url="${url##*/}"
    # Last path component is repo; we need owner too. Re-parse.
    local raw
    raw="$(git config --get remote.origin.url)"
    raw="${raw%.git}"
    case "$raw" in
        *@*:*) printf '%s' "${raw#*:}" ;;
        *://*) printf '%s' "${raw#*://*/}" ;;
        *) raw="${raw%/}"; raw="${raw%.git}"; printf '%s/%s' "$(basename "$(dirname "$raw")")" "$(basename "$raw")" ;;
    esac
}

# Network-free repository resolver for validators and other offline paths.
_xrepo_current_repo_offline() {
    if [ -n "${GITHUB_REPOSITORY:-}" ]; then
        printf '%s' "$GITHUB_REPOSITORY"
        return 0
    fi
    local configured raw
    configured="$(git config --get taskdag.current-repo 2>/dev/null || true)"
    if [ -n "$configured" ]; then
        printf '%s' "$configured"
        return 0
    fi
    raw="$(git config --get remote.origin.url 2>/dev/null || true)"
    raw="${raw%.git}"
    case "$raw" in
        *@*:*) printf '%s' "${raw#*:}" ;;
        *://*) printf '%s' "${raw#*://*/}" ;;
        *) raw="${raw%/}"; printf '%s/%s' "$(basename "$(dirname "$raw")")" "$(basename "$raw")" ;;
    esac
}

# Helper: resolve an issue's epic ref, BACKFILLING it if it is missing.
# Echoes the epic commit SHA on stdout.
#
# Every cross-repo path that needs an issue's epic (its DAG root and the
# parent anchor for child nodes) should call this instead of looking the
# ref up directly and dying when it is absent. An epic ref can legitimately
# be missing: the issue's first-sighting issue-to-task run may never have
# created one — e.g. the repo's task-dag.yml was broken / mid-migration
# when the issue was opened, or the issue predates task-dag. That left a
# permanent gap where every later operation that needed the epic
# (ingest-comment, delegate, …) died and silently dropped the work
# (virusdave/top-level#28).
#
# When the epic is missing we recreate it exactly as create-task-commit.sh
# does on first sighting — an empty-tree commit anchored to HEAD, with the
# refs tasks/pending/<N> + gh/issues/<N>, pushed atomically and
# race-tolerantly — and annotate the commit body (Backfilled: true) so the
# data is self-documenting. We deliberately do NOT apply any issue-state
# policy here: whether a (possibly closed) issue should actually be worked
# is the dispatcher's job — github-worker gates every task it claims on the
# live GitHub issue state (closed → skipped + pruned). task-dag's only job
# is to keep the DAG consistent so nothing is silently lost.
#
# Backfill metadata is taken from the ISSUE_TITLE/ISSUE_AUTHOR/ISSUE_URL/
# ISSUE_BODY env exported by the issue/comment reusable workflows; when
# those are absent (e.g. the delegate path) it falls back to `gh issue
# view`. If neither yields a title, it dies rather than write a junk epic.
_xrepo_ensure_issue_epic() {
    local issue="$1"
    local gh_issues_ref="refs/heads/gh/issues/${issue}"
    local pending_ref="refs/heads/tasks/pending/${issue}"

    local epic_sha
    epic_sha="$(git rev-parse --verify "$gh_issues_ref" 2>/dev/null || true)"
    if [ -z "$epic_sha" ]; then
        git fetch origin "$gh_issues_ref":"$gh_issues_ref" >/dev/null 2>&1 || true
        epic_sha="$(git rev-parse --verify "$gh_issues_ref" 2>/dev/null || true)"
    fi
    if [ -z "$epic_sha" ]; then
        # Fallback to pending ref (older epics created before gh/issues/<N> existed).
        epic_sha="$(git rev-parse --verify "$pending_ref" 2>/dev/null || true)"
        if [ -z "$epic_sha" ]; then
            git fetch origin "$pending_ref":"$pending_ref" >/dev/null 2>&1 || true
            epic_sha="$(git rev-parse --verify "$pending_ref" 2>/dev/null || true)"
        fi
    fi
    if [ -n "$epic_sha" ]; then
        printf '%s' "$epic_sha"
        return 0
    fi

    # ---- Epic missing: backfill it. ----
    # Prepare before authoring or publishing anything: after activation,
    # disabled epochs must reject the backfill and enabled epochs must move
    # both epic refs together with the shared semantic generation.
    taskdag_consumer_prepare ensure-issue-epic || return 2

    local bf_title="${ISSUE_TITLE:-}" bf_author="${ISSUE_AUTHOR:-}"
    local bf_url="${ISSUE_URL:-}" bf_body="${ISSUE_BODY:-}"
    if [ -z "$bf_title" ] && command -v gh >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
        local repo_slug meta
        repo_slug="$(_xrepo_current_repo)"
        if [ -n "$repo_slug" ]; then
            meta="$(gh issue view "$issue" --repo "$repo_slug" --json title,body,url,author 2>/dev/null || true)"
            if [ -n "$meta" ]; then
                bf_title="$(printf '%s' "$meta"  | jq -r '.title // ""')"
                bf_url="$(printf '%s' "$meta"    | jq -r '.url // ""')"
                bf_author="$(printf '%s' "$meta" | jq -r '.author.login // ""')"
                bf_body="$(printf '%s' "$meta"   | jq -r '.body // ""')"
            fi
        fi
    fi
    [ -n "$bf_title" ] || {
        _xrepo_die "ensure-epic: cannot backfill epic for #${issue}: no ISSUE_TITLE env and gh lookup failed"
        return 2
    }
    [ -n "$bf_author" ] || bf_author="unknown"
    [ -n "$bf_url" ]    || bf_url="unknown"

    _xrepo_ensure_git_identity

    local bf_parent bf_tree bf_msg
    bf_parent="$(git rev-parse HEAD)"
    bf_tree="$(_xrepo_empty_tree)"
    bf_msg="$(mktemp)"
    {
        printf 'Task: %s\n\n' "$bf_title"
        printf 'Issue: #%s\n' "$issue"
        printf 'Author: %s\n' "$bf_author"
        printf 'URL: %s\n' "$bf_url"
        printf 'Status: pending\n'
        printf 'Type: epic\n'
        printf 'Backfilled: true\n'
        printf 'Backfill-Reason: epic ref was missing and was recreated on demand by task-dag; the first-sighting issue-to-task run never created it (workflow broken/mid-migration at open time, or issue predates task-dag). See virusdave/top-level#28.\n'
        printf '\n'
        printf '%s\n' "$bf_body"
    } > "$bf_msg"
    epic_sha="$(git commit-tree "$bf_tree" -p "$bf_parent" -F "$bf_msg")"
    rm -f "$bf_msg"

    local publish_rc=0
    if [ "$TASKDAG_CONSUMER_MODE" = canonical ]; then
        local updates
        updates=$(jq -ncS --arg pending "$pending_ref" --arg issue_ref "$gh_issues_ref" --arg epic "$epic_sha" \
            '[{ref:$pending,old:"",new:$epic},{ref:$issue_ref,old:"",new:$epic}] | sort_by(.ref)') || return 2
        _xrepo_watchdog_fence || return 2
        taskdag_consumer_fenced_scheduling_push ensure-issue-epic \
            "${TASK_DAG_CLAIMER:-comment-ingest}" "$updates" || publish_rc=$?
    else
        git update-ref "$pending_ref" "$epic_sha"
        git update-ref "$gh_issues_ref" "$epic_sha"
        _xrepo_watchdog_fence || return 2
        git push --atomic origin "$pending_ref" "$gh_issues_ref" 1>&2 || publish_rc=$?
    fi
    if [ "$publish_rc" -ne 0 ]; then
        # A concurrent first-seen run (issue-to-task or another ensure)
        # may have won the race; adopt whatever epic now exists on origin.
        local after_pending
        after_pending="$(git ls-remote origin "$pending_ref" | awk 'NR==1{print $1}')"
        if [ -n "$after_pending" ]; then
            git fetch origin "$pending_ref":"$pending_ref" >/dev/null 2>&1 || true
            _xrepo_log "ensure-epic: lost backfill race for #${issue}; adopting ${pending_ref} at ${after_pending}"
            printf '%s' "$after_pending"
            return 0
        fi
        _xrepo_die "ensure-epic: failed to backfill missing epic for #${issue}"
        return 2
    fi
    git update-ref "$pending_ref" "$epic_sha"
    git update-ref "$gh_issues_ref" "$epic_sha"
    _xrepo_log "ensure-epic: backfilled missing epic for #${issue} (${epic_sha}); pushed ${pending_ref} + ${gh_issues_ref} (was never created on first sighting)"
    printf '%s' "$epic_sha"
    return 0
}

# Helper: parse "owner/repo#issue" → exports XREPO_OWNER, XREPO_REPO, XREPO_ISSUE.
_xrepo_parse_repo_issue() {
    local spec="$1"
    if [[ ! "$spec" =~ ^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#([0-9]+)$ ]]; then
        _xrepo_die "expected <owner>/<repo>#<issue>, got: $spec"
        return 2
    fi
    XREPO_OWNER="${BASH_REMATCH[1]}"
    XREPO_REPO="${BASH_REMATCH[2]}"
    XREPO_ISSUE="${BASH_REMATCH[3]}"
}

# Helper: parse "owner/repo@sha" → exports XREPO_OWNER, XREPO_REPO, XREPO_SHA_PREFIX.
_xrepo_parse_repo_sha() {
    local spec="$1"
    if [[ ! "$spec" =~ ^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)@([A-Fa-f0-9]{7,40})$ ]]; then
        _xrepo_die "expected <owner>/<repo>@<sha>, got: $spec"
        return 2
    fi
    XREPO_OWNER="${BASH_REMATCH[1]}"
    XREPO_REPO="${BASH_REMATCH[2]}"
    XREPO_SHA_PREFIX="$(printf '%s' "${BASH_REMATCH[3]}" | tr '[:upper:]' '[:lower:]')"
}

# ─────────────────────────────────────────────────────────────────────
# cmd_delegate — declare a delegated child of an epic
# ─────────────────────────────────────────────────────────────────────

cmd_delegate() {
    local top_issue="" target=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --issue) [ "$#" -ge 2 ] || return 2; top_issue="$2"; shift 2 ;;
            --to)    [ "$#" -ge 2 ] || return 2; target="$2"; shift 2 ;;
            --note)  [ "$#" -ge 2 ] || return 2; shift 2 ;;
            *) _xrepo_die "delegate: unknown arg: $1"; return 2 ;;
        esac
    done
    [ -n "$top_issue" ] || { _xrepo_die "delegate: --issue is required"; return 2; }
    [ -n "$target" ] || { _xrepo_die "delegate: --to is required"; return 2; }
    [[ "$top_issue" =~ ^[1-9][0-9]*$ ]] || { _xrepo_die "delegate: --issue must be a positive integer"; return 2; }
    _xrepo_parse_repo_issue "$target" || return $?
    taskdag_migration_guard materialise
}

_taskdag_materialise_delegate_projection() {
    local top_issue="" target="" note="" parent_repo_node_id="" parent_issue_node_id=""
    local peer_repo_node_id="" peer_issue_node_id="" materialisation_operation_id="" declaration_digest=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --issue) top_issue="$2"; shift 2 ;;
            --to)    target="$2";    shift 2 ;;
            --note)  note="$2";      shift 2 ;;
            --parent-repo-node-id) parent_repo_node_id="$2"; shift 2 ;;
            --parent-issue-node-id) parent_issue_node_id="$2"; shift 2 ;;
            --peer-repo-node-id) peer_repo_node_id="$2"; shift 2 ;;
            --peer-issue-node-id) peer_issue_node_id="$2"; shift 2 ;;
            --materialisation-operation-id) materialisation_operation_id="$2"; shift 2 ;;
            --declaration-digest) declaration_digest="$2"; shift 2 ;;
            *) _xrepo_die "delegate: unknown arg: $1"; return 2 ;;
        esac
    done
    [ -n "$top_issue" ] || { _xrepo_die "delegate: --issue is required"; return 2; }
    [ -n "$target"    ] || { _xrepo_die "delegate: --to is required";    return 2; }
    [[ "$top_issue" =~ ^[1-9][0-9]*$ ]] || { _xrepo_die "delegate: --issue must be a positive integer"; return 2; }
    _xrepo_parse_repo_issue "$target" || return $?
    _xrepo_need_cmd gh
    _xrepo_need_cmd jq

    local top_repo
    top_repo="$(_xrepo_current_repo)"
    [ -n "$top_repo" ] || { _xrepo_die "delegate: cannot determine current repo"; return 2; }

    local delegated_ref="refs/heads/tasks/delegated/${top_issue}/${XREPO_OWNER}/${XREPO_REPO}/${XREPO_ISSUE}"

    # Resolve the parent epic, backfilling it (from `gh issue view`) if its
    # first-sighting issue-to-task run never created it — same root cause as
    # the missing-epic comment failure (virusdave/top-level#28). Without
    # this, delegating a child of such an issue would die "no epic ref".
    local epic_sha
    epic_sha="$(_xrepo_ensure_issue_epic "$top_issue")" || return $?

    _xrepo_ensure_git_identity

    # Read current issue body, update or insert delegated_to block.
    local body_file
    body_file="$(mktemp)"
    gh issue view "$top_issue" --repo "$top_repo" --json body -q .body > "$body_file"

    local updated_body_file
    updated_body_file="$(mktemp)"

    _xrepo_upsert_delegated_block \
        "$body_file" \
        "$updated_body_file" \
        "${XREPO_OWNER}/${XREPO_REPO}" \
        "${XREPO_ISSUE}" \
        "$note" || {
        rm -f "$body_file" "$updated_body_file"
        return 2
    }

    if cmp -s "$body_file" "$updated_body_file"; then
        _xrepo_log "delegate: issue body already lists ${XREPO_OWNER}/${XREPO_REPO}#${XREPO_ISSUE}"
    else
        gh issue edit "$top_issue" --repo "$top_repo" --body-file "$updated_body_file" >/dev/null
        _xrepo_log "updated issue body for ${top_repo}#${top_issue}"
    fi
    rm -f "$body_file" "$updated_body_file"

    # Idempotency: ensure the legacy delegated ref is durable ON ORIGIN (origin
    # is authoritative — legacy close-epic gates on it), then ALWAYS fall
    # through to the dual-write edge below so an existing legacy delegation
    # still backfills the graph edge on a re-run (`dep add` is idempotent by
    # edge-id). Origin-first ordering means a prior run that created the local
    # ref but failed to push it is repaired here (the local-only branch pushes
    # it) instead of silently writing the edge against a non-durable legacy
    # state.
    if git ls-remote origin "$delegated_ref" | grep -q .; then
        # Origin has it — adopt locally (a no-op if already equal).
        git fetch origin "$delegated_ref":"$delegated_ref" >/dev/null 2>&1
        _xrepo_log "delegate already present on origin: ${delegated_ref}"
    elif git rev-parse --verify "$delegated_ref" >/dev/null 2>&1; then
        # Local-only ref (a prior push failed): make it durable on origin now.
        git push origin "$delegated_ref"
        _xrepo_log "delegate: pushed pre-existing local delegated ref ${delegated_ref}"
    else
        # Create empty-tree delegated metadata commit parented to current epic.
        local empty_tree
        empty_tree="$(_xrepo_empty_tree)"

        local msg_file
        msg_file="$(mktemp)"
        {
            printf 'kind: delegated\n'
            printf 'role: system\n'
            printf 'intent: delegated-child\n'
            printf '\n'
            printf 'issue:\n'
            printf '  repo: %s\n' "$top_repo"
            printf '  number: %s\n' "$top_issue"
            printf '\n'
            printf 'delegated:\n'
            printf '  repo: %s/%s\n' "$XREPO_OWNER" "$XREPO_REPO"
            printf '  number: %s\n' "$XREPO_ISSUE"
            if [ -n "$note" ]; then
                printf '  note: %s\n' "$note"
            fi
            printf '\n'
            printf 'Parent-Repo-Node-Id: %s\n' "$parent_repo_node_id"
            printf 'Parent-Issue-Node-Id: %s\n' "$parent_issue_node_id"
            printf 'Peer-Repo-Node-Id: %s\n' "$peer_repo_node_id"
            printf 'Peer-Issue-Node-Id: %s\n' "$peer_issue_node_id"
            printf 'Materialisation-Operation-Id: %s\n' "$materialisation_operation_id"
            printf 'Declaration-Digest: %s\n' "$declaration_digest"
        } > "$msg_file"

        local delegation_sha
        delegation_sha="$(git commit-tree "$empty_tree" -p "$epic_sha" -F "$msg_file")"
        rm -f "$msg_file"

        git update-ref "$delegated_ref" "$delegation_sha"
        git push origin "$delegated_ref"
        _xrepo_log "created delegated task ${delegation_sha}"
        _xrepo_log "pushed ${delegated_ref}"
    fi

    # DUAL-WRITE (issue #13 north-star): a delegation is a `requires` edge —
    # the parent epic REQUIRES the delegated child issue to complete. Mint it
    # in this repo's graph index tasks/v1/graph (from = the epic task-root
    # commit, which the reconcile predicate treats as the EPIC node; to = the
    # child issue). The legacy delegated ref (above) still drives behavior;
    # the edge is the machine-readable dependency the reconciler will use.
    # Edge AFTER the legacy path so a failed edge leaves the safer legacy
    # state; idempotent by edge-id so a re-run converges — EXCEPT for an edge
    # deliberately `dep drop`ped (tombstoned, terminal): delegate will not
    # resurrect it (issue #13 anti-zombie-resurrection), only backfill a
    # genuinely-absent (never-created / legacy-gap) edge. delegate is
    # inherently cross-repo, so the child issue's done() only becomes
    # derivable once the reconciler backstop delivers it (a later sibling).
    #
    # FAIL CLOSED: only write the edge once the legacy delegated ref is proven
    # durable on origin. Otherwise a failed legacy push would leave a durable
    # edge asserting a delegation that legacy close-epic cannot see — a
    # second-source-of-truth split. A re-run converges (origin-first branch
    # above adopts/pushes the ref, then the edge is written).
    if ! git ls-remote --exit-code origin "$delegated_ref" >/dev/null 2>&1; then
        _xrepo_log "WARNING: legacy delegated ref is not durable on origin (push may have failed); skipping the dependency edge write — re-run 'task-dag delegate' to converge"
        return 5
    fi
    if declare -F _cmd_dep_add >/dev/null 2>&1; then
        local from_node="task:${top_repo}@${epic_sha}"
        local to_node="issue:${XREPO_OWNER}/${XREPO_REPO}#${XREPO_ISSUE}"
        if ! _cmd_dep_add --from "$from_node" --to "$to_node" --relation requires \
                --reason "delegate: ${top_repo}#${top_issue} requires child ${XREPO_OWNER}/${XREPO_REPO}#${XREPO_ISSUE}"; then
            _xrepo_log "WARNING: legacy delegation recorded, but the dependency edge write failed; re-run 'task-dag delegate' to converge (idempotent)"
            return 5
        fi
    fi
}

# Helper: parse ONE legacy python-rendered `delegated_to:` YAML block body
# (read on stdin) into a compact JSON array of {repo,issue[,note]} objects.
#
# This is a ONE-TIME compatibility reader for the EXACT shape the old
# embedded-python renderer produced:
#     delegated_to:
#       - repo: owner/repo
#         issue: 123
#         note: optional text
# It is intentionally strict — it fails closed (rc 3) on anything that is
# not that exact shape — because the ONLY writer of this block is
# `_xrepo_upsert_delegated_block`, which after the first update rewrites the
# block into the canonical jq-rendered JSON form. Each entry is assembled
# with `jq` (never hand-built), so an arbitrary `note` cannot inject JSON.
_xrepo_legacy_delegated_to_json() {
    local line started=0
    local cur_seen=0 cur_repo="" cur_issue="" cur_note=""
    local seen_repo=0 seen_issue=0 seen_note=0
    local -a objs=()
    # Emit the current entry (if one has started). Fails closed (rc 3) on a
    # started-but-incomplete entry so a corrupt legacy block is never
    # silently truncated: `repo` is mandatory and `issue` must be a decimal.
    _xrepo_ldj_flush() {
        [ "$cur_seen" -eq 1 ] || return 0
        [ "$seen_repo" -eq 1 ] || return 3
        [[ "$cur_issue" =~ ^(0|[1-9][0-9]*)$ ]] || return 3
        local obj
        if [ "$seen_note" -eq 1 ]; then
            obj=$(jq -nc --arg r "$cur_repo" --arg i "$cur_issue" --arg n "$cur_note" \
                '{repo:$r, issue:($i|tonumber), note:$n}') || return 3
        else
            obj=$(jq -nc --arg r "$cur_repo" --arg i "$cur_issue" \
                '{repo:$r, issue:($i|tonumber)}') || return 3
        fi
        objs+=("$obj")
    }
    # Parse one `key: value` field into the current entry. Rejects unknown
    # keys and duplicate keys within one entry (fail closed).
    _xrepo_ldj_kv() {
        local kv="$1" k v
        case "$kv" in
            *:*) k="${kv%%:*}"; v="${kv#*:}" ;;
            *) return 3 ;;
        esac
        k="$(_xrepo_trim "$k")"; v="$(_xrepo_trim "$v")"
        case "$k" in
            repo)  [ "$seen_repo"  -eq 0 ] || return 3; cur_repo="$v";  seen_repo=1 ;;
            issue) [ "$seen_issue" -eq 0 ] || return 3; cur_issue="$v"; seen_issue=1 ;;
            note)  [ "$seen_note"  -eq 0 ] || return 3; cur_note="$v";  seen_note=1 ;;
            *) return 3 ;;
        esac
        cur_seen=1
    }
    while IFS= read -r line || [ -n "$line" ]; do
        if [ "$started" -eq 0 ]; then
            [ "$(_xrepo_trim "$line")" = "delegated_to:" ] && started=1
            continue
        fi
        [ -n "$(_xrepo_trim "$line")" ] || continue
        case "$line" in
            "  - "*)
                _xrepo_ldj_flush || return 3
                cur_seen=0; cur_repo=""; cur_issue=""; cur_note=""
                seen_repo=0; seen_issue=0; seen_note=0
                _xrepo_ldj_kv "$(_xrepo_trim "${line#"  - "}")" || return 3
                ;;
            "    "*)
                # a sub-field must belong to an already-started list entry
                [ "$cur_seen" -eq 1 ] || return 3
                _xrepo_ldj_kv "$(_xrepo_trim "$line")" || return 3
                ;;
            *)
                return 3
                ;;
        esac
    done
    _xrepo_ldj_flush || return 3
    [ "$started" -eq 1 ] || return 3
    if [ "${#objs[@]}" -eq 0 ]; then
        printf '[]'
    else
        printf '%s\n' "${objs[@]}" | jq -sc '.'
    fi
}

# Helper: idempotently update/insert the ```yaml ... delegated_to ... ```
# block that lists an epic's cross-repo delegated children.
#
# The block payload is stored as JSON *inside* the ```yaml fence — JSON is a
# strict subset of YAML 1.2, so the fence stays labelled `yaml` and remains a
# valid parse, while jq (already required by `delegate`) does all parsing,
# upserting, sorting and rendering. This is the ONLY reader/writer of the
# block, so its internal byte-layout is not contractual — only that it is
# deterministic and a valid parse. The issue body OUTSIDE the fence is
# preserved byte-for-byte. A one-time compatibility path
# (`_xrepo_legacy_delegated_to_json`) reads the old python-rendered YAML
# shape so existing issue bodies keep their entries; the first update
# rewrites the block into the canonical jq JSON form.
#
# An arbitrary `note` (newlines, colons, quotes, backslashes, or a line that
# looks like `  - repo: evil`) cannot inject a new entry or a fake fence: it
# is stored as a JSON string, and jq escapes newlines to \n on output, so a
# note can never emit a line that is a bare ``` fence or a legacy entry line.
#
# Args: input-body-file output-body-file repo issue note
_xrepo_upsert_delegated_block() {
    local in="$1" out="$2" repo="$3" issue="$4" note="$5"

    _xrepo_need_cmd jq || return 2

    # Locate the first ```yaml ... ``` fenced block whose content mentions
    # delegated_to. This is text-region location (find fence line numbers),
    # not YAML parsing. awk reads a file (no upstream pipe), so an early
    # `exit` is safe here (cannot SIGPIPE a producer). An unclosed yaml
    # fence that already contains delegated_to is a corrupt body: awk exits
    # non-zero so we fail closed rather than append a second (split-brain)
    # block. `found` is set before the successful exit so the END rule does
    # not misfire after that exit.
    local locinfo openln="" closeln=""
    if ! locinfo="$(awk '
        BEGIN { open = 0; found = 0 }
        {
            if (open == 0) {
                if ($0 ~ /^```yaml[[:space:]]*$/) { open = NR; has = 0 }
            } else if ($0 ~ /^```[[:space:]]*$/) {
                if (has) { print open, NR; found = 1; exit }
                open = 0
            } else if (index($0, "delegated_to") > 0) {
                has = 1
            }
        }
        END { if (!found && open != 0 && has) exit 3 }
    ' "$in")"; then
        _xrepo_die "delegated_to: unclosed yaml fence containing delegated_to"
        return 2
    fi

    # Compute the entries JSON array from the existing block (if any).
    local entries_json="[]"
    if [ -n "$locinfo" ]; then
        openln="${locinfo%% *}"
        closeln="${locinfo##* }"
        local inner
        inner="$(sed -n "$((openln + 1)),$((closeln - 1))p" "$in")"
        # New (JSON) form: a JSON object with a .delegated_to array.
        if ! entries_json="$(printf '%s\n' "$inner" | jq -c '
                if type == "object" and (.delegated_to | type == "array")
                then .delegated_to else empty end
            ' 2>/dev/null)" || [ -z "$entries_json" ]; then
            # Legacy (python-rendered YAML) form: one-time compat read.
            entries_json="$(printf '%s\n' "$inner" | _xrepo_legacy_delegated_to_json)" || {
                _xrepo_die "delegated_to: cannot parse existing block"
                return 2
            }
        fi
    fi

    # Upsert (repo,issue), drop any stale duplicate, sort by (repo,issue),
    # omit an empty note, and render deterministically. Entry field types are
    # validated so a malformed pre-existing entry fails loudly rather than
    # sorting mixed types. `issue` is passed as a string and normalised via
    # tonumber so a non-canonical decimal (e.g. 001) is accepted like the old
    # python int() and rendered canonically.
    local block_payload
    block_payload="$(jq -n \
        --argjson entries "$entries_json" \
        --arg repo "$repo" \
        --arg issue "$issue" \
        --arg note "$note" '
        ($entries
            | map(
                if (.repo | type) != "string" then error("non-string repo") else . end
                | if (.issue | type) != "number" then error("non-number issue") else . end
                | if (has("note")) and ((.note | type) != "string") then error("non-string note") else . end
              )
            | map(select(.repo != $repo or .issue != ($issue | tonumber)))
        )
        + [ {repo: $repo, issue: ($issue | tonumber)}
            + (if $note == "" then {} else {note: $note} end) ]
        | sort_by(.repo, .issue)
        | {delegated_to: .}
    ')" || {
        _xrepo_die "delegated_to: failed to render block"
        return 2
    }

    local rendered_block
    rendered_block="$(printf '```yaml\n%s\n```' "$block_payload")"

    if [ -n "$locinfo" ]; then
        # Splice the new block in place of the old one, preserving the body
        # outside the fence byte-for-byte (stream with head/tail, never via
        # command substitution which would strip trailing newlines).
        local total_lines
        total_lines="$(awk 'END { print NR }' "$in")"
        {
            if [ "$openln" -gt 1 ]; then
                head -n "$((openln - 1))" "$in"
            fi
            printf '%s' "$rendered_block"
            if [ "$closeln" -lt "$total_lines" ]; then
                printf '\n'
                tail -n +"$((closeln + 1))" "$in"
            elif _xrepo_file_ends_with_newline "$in"; then
                printf '\n'
            fi
        } > "$out"
    else
        # No existing block: append after the body, matching the historical
        # layout (a blank line, then the block, then a trailing newline).
        {
            cat "$in"
            if _xrepo_file_ends_with_newline "$in"; then
                printf '\n'
            else
                printf '\n\n'
            fi
            printf '%s\n' "$rendered_block"
        } > "$out"
    fi
}

# ─────────────────────────────────────────────────────────────────────
# Helper: return 0 if a delegation ref exists on authoritative origin for
# the given epic + peer repo + candidate peer issue. Used to validate a
# comment-supplied --peer-issue before trusting it (Strategy 0).
_xrepo_delegation_exists() {
    local top_issue="$1" owner="$2" repo="$3" peer_issue="$4"
    local ref="refs/heads/tasks/delegated/${top_issue}/${owner}/${repo}/${peer_issue}"
    local sha rc=0
    sha="$(_xrepo_remote_sha "$ref")" || rc=$?
    [ "$rc" -ne 3 ] || return 2
    [ -n "$sha" ]
}

_xrepo_validate_delegation() {
    local sha="$1" top_repo="$2" top_issue="$3" peer_repo="$4" peer_issue="$5" msg
    [ "$(git cat-file -t "$sha" 2>/dev/null)" = commit ] || return 2
    [ "$(git rev-parse "$sha^{tree}" 2>/dev/null)" = "$(_xrepo_empty_tree)" ] || return 2
    msg="$(git log -1 --format=%B "$sha")"
    [ "$(grep -cx 'kind: delegated' <<<"$msg")" = 1 ] || return 2
    [ "$(grep -cx 'role: system' <<<"$msg")" = 1 ] || return 2
    [ "$(grep -cx 'intent: delegated-child' <<<"$msg")" = 1 ] || return 2
    awk -v tr="$top_repo" -v ti="$top_issue" -v pr="$peer_repo" -v pi="$peer_issue" '
        /^issue:$/ { section="issue"; next }
        /^delegated:$/ { section="delegated"; next }
        /^[^ ]/ { section="" }
        section=="issue" && /^  repo: / { ir=substr($0,9) }
        section=="issue" && /^  number: / { inum=substr($0,11) }
        section=="delegated" && /^  repo: / { dr=substr($0,9) }
        section=="delegated" && /^  number: / { dn=substr($0,11) }
        END { exit !(tolower(ir)==tolower(tr) && inum==ti && tolower(dr)==tolower(pr) && dn==pi) }
    ' <<<"$msg"
}

_xrepo_validate_completion_fact() {
    local sha="$1" delegation_sha="$2" top_repo="$3" top_issue="$4"
    local peer_repo="$5" peer_issue="$6" peer_commit="$7" msg
    [ "$(git cat-file -t "$sha" 2>/dev/null)" = commit ] || return 2
    [ "$(git rev-parse "$sha^{tree}" 2>/dev/null)" = "$(_xrepo_empty_tree)" ] || return 2
    [ "$(git rev-list --parents -n1 "$sha" | awk '{print NF-1}')" = 1 ] || return 2
    [ "$(git rev-parse "$sha^")" = "$delegation_sha" ] || return 2
    _xrepo_validate_delegation "$delegation_sha" "$top_repo" "$top_issue" "$peer_repo" "$peer_issue" || return 2
    msg="$(git log -1 --format=%B "$sha")"
    [ "$(grep -cx 'kind: completion' <<<"$msg")" = 1 ] || return 2
    [ "$(grep -cx 'role: system' <<<"$msg")" = 1 ] || return 2
    [ "$(grep -cx 'intent: cross-repo-satisfied' <<<"$msg")" = 1 ] || return 2
    awk -v tr="$top_repo" -v ti="$top_issue" -v pr="$peer_repo" \
        -v pi="$peer_issue" -v pc="$peer_commit" '
        /^issue:$/ { section="issue"; next }
        /^delegated:$/ { section="delegated"; next }
        /^source:$/ { section="source"; next }
        /^[^ ]/ { section="" }
        section=="issue" && /^  repo: / { ir=substr($0,9) }
        section=="issue" && /^  number: / { inum=substr($0,11) }
        section=="delegated" && /^  repo: / { dr=substr($0,9) }
        section=="delegated" && /^  number: / { dn=substr($0,11) }
        section=="source" && /^  repo: / { sr=substr($0,9) }
        section=="source" && /^  commit: / { sc=substr($0,11) }
        END { exit !(tolower(ir)==tolower(tr) && inum==ti && tolower(dr)==tolower(pr) && dn==pi && tolower(sr)==tolower(pr) && sc==pc) }
    ' <<<"$msg"
}

# Parent-authoritative delegated-close/v1 read predicate. There is
# intentionally no writer while completion-ingest is migration-drained.
# The record is create-only evidence, parented by the exact delegation, and
# binds immutable GitHub identities plus the exact peer close witness.
_xrepo_validate_delegated_close_v1() {
    local sha="$1" delegation_sha="$2" top_repo="$3" top_issue="$4"
    local peer_repo="$5" peer_issue="$6" peer_tip peer_close peer_root wt parents first second extra tree first_tree close_issue
    local gh_root pending_root
    local key record_value delegation_value
    [ "$(git cat-file -t "$sha" 2>/dev/null)" = commit ] || return 2
    [ "$(git rev-parse "$sha^{tree}" 2>/dev/null)" = "$(_xrepo_empty_tree)" ] || return 2
    [ "$(git show -s --format='%P' "$sha")" = "$delegation_sha" ] || return 2
    [ "$(_xrepo_exact_trailer "$sha" Task-Dag-Delegated-Close)" = v1 ] || return 2
    [ "$(_xrepo_exact_trailer "$sha" Parent-Repo)" = "$top_repo" ] || return 2
    [ "$(_xrepo_exact_trailer "$sha" Parent-Issue)" = "#${top_issue}" ] || return 2
    [ "$(_xrepo_exact_trailer "$sha" Peer-Repo)" = "$peer_repo" ] || return 2
    [ "$(_xrepo_exact_trailer "$sha" Peer-Issue)" = "#${peer_issue}" ] || return 2
    for key in Parent-Repo-Node-Id Parent-Issue-Node-Id Peer-Repo-Node-Id Peer-Issue-Node-Id Materialisation-Operation-Id Declaration-Digest; do
        record_value=$(_xrepo_exact_trailer "$sha" "$key") || return 2
        delegation_value=$(_xrepo_exact_trailer "$delegation_sha" "$key") || return 2
        [ -n "$record_value" ] && [ "$record_value" = "$delegation_value" ] || return 2
    done
    record_value=$(_xrepo_exact_trailer "$sha" Declaration-Digest) || return 2
    [[ "$record_value" =~ ^[0-9a-f]{64}$ ]] || return 2
    peer_tip=$(_xrepo_exact_trailer "$sha" Peer-Tip) || return 2
    peer_close=$(_xrepo_exact_trailer "$sha" Peer-Close) || return 2
    peer_root=$(_xrepo_exact_trailer "$sha" Peer-Epic) || return 2
    [[ "$peer_tip" =~ ^[0-9a-f]{40}$ && "$peer_close" =~ ^[0-9a-f]{40}$ && "$peer_root" =~ ^[0-9a-f]{40}$ ]] || return 2
    wt=$(taskdag_peer_worktree_for "$peer_repo") || return 2
    env -u GIT_DIR git -C "$wt" rev-list --first-parent "$peer_tip" 2>/dev/null \
        | awk -v close_oid="$peer_close" '$0 == close_oid { found=1 } END { exit !found }' || return 2
    gh_root=$(env -u GIT_DIR git -C "$wt" rev-parse -q --verify "refs/heads/gh/issues/${peer_issue}^{commit}" 2>/dev/null || true)
    pending_root=$(env -u GIT_DIR git -C "$wt" rev-parse -q --verify "refs/heads/tasks/pending/${peer_issue}^{commit}" 2>/dev/null || true)
    [ -z "$gh_root" ] || [ -z "$pending_root" ] || [ "$gh_root" = "$pending_root" ] || return 2
    [ "${gh_root:-$pending_root}" = "$peer_root" ] || return 2
    parents=$(env -u GIT_DIR git -C "$wt" show -s --format='%P' "$peer_close" 2>/dev/null) || return 2
    read -r first second extra <<<"$parents"
    [ -n "$first" ] && [ "$second" = "$peer_root" ] && [ -z "${extra:-}" ] || return 2
    tree=$(env -u GIT_DIR git -C "$wt" rev-parse "$peer_close^{tree}" 2>/dev/null) || return 2
    first_tree=$(env -u GIT_DIR git -C "$wt" rev-parse "$first^{tree}" 2>/dev/null) || return 2
    [ "$tree" = "$first_tree" ] || return 2
    close_issue=$(env -u GIT_DIR git -C "$wt" show -s \
        --format='%(trailers:key=Closes-Epic,valueonly,separator=%x0A)' "$peer_close")
    [ "$close_issue" = "#${peer_issue}" ] || return 2
}

# Sole live delegated-close writer. Completion comments are hints only; this
# operation derives the oldest valid close from the peer's authoritative tip
# and create-only publishes parent-authoritative evidence.
_xrepo_reconcile_delegated_close() { # parent-issue peer-repo peer-issue delegation-sha
    local top_issue=$1 peer_repo=$2 peer_issue=$3 delegation=$4 top_repo wt tip root close="" candidate ref existing rc=0 updates evidence
    top_repo=$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]') || return 2
    wt=$(taskdag_peer_worktree_for "$peer_repo" 2>/dev/null) || return 0
    env -u GIT_DIR git -C "$wt" fetch -q --no-tags origin \
        '+refs/heads/master:refs/remotes/origin/master' \
        "+refs/heads/gh/issues/${peer_issue}:refs/heads/gh/issues/${peer_issue}" \
        "+refs/heads/tasks/pending/${peer_issue}:refs/heads/tasks/pending/${peer_issue}" || return 2
    tip=$(env -u GIT_DIR git -C "$wt" rev-parse refs/remotes/origin/master^{commit}) || return 2
    root=$(env -u GIT_DIR git -C "$wt" rev-parse -q --verify "refs/heads/gh/issues/${peer_issue}^{commit}" 2>/dev/null \
        || env -u GIT_DIR git -C "$wt" rev-parse -q --verify "refs/heads/tasks/pending/${peer_issue}^{commit}" 2>/dev/null) || return 2
    while IFS= read -r candidate; do
        local parents first second extra tree first_tree trailer
        parents=$(env -u GIT_DIR git -C "$wt" show -s --format='%P' "$candidate") || return 2
        read -r first second extra <<<"$parents"
        [ -n "$first" ] && [ "$second" = "$root" ] && [ -z "${extra:-}" ] || continue
        tree=$(env -u GIT_DIR git -C "$wt" rev-parse "$candidate^{tree}") || return 2
        first_tree=$(env -u GIT_DIR git -C "$wt" rev-parse "$first^{tree}") || return 2
        [ "$tree" = "$first_tree" ] || continue
        trailer=$(env -u GIT_DIR git -C "$wt" show -s --format='%(trailers:key=Closes-Epic,valueonly,separator=%x0A)' "$candidate") || return 2
        [ "$trailer" = "#${peer_issue}" ] || continue
        close=$candidate; break
    done < <(env -u GIT_DIR git -C "$wt" rev-list --first-parent --reverse "$tip")
    [ -n "$close" ] || return 0
    evidence=$(jq -ncS --arg parentRepo "$top_repo" --argjson parentIssue "$top_issue" --arg peerRepo "$peer_repo" --argjson peerIssue "$peer_issue" \
        --arg parentRepoNodeId "$(_xrepo_exact_trailer "$delegation" Parent-Repo-Node-Id)" \
        --arg parentIssueNodeId "$(_xrepo_exact_trailer "$delegation" Parent-Issue-Node-Id)" \
        --arg peerRepoNodeId "$(_xrepo_exact_trailer "$delegation" Peer-Repo-Node-Id)" \
        --arg peerIssueNodeId "$(_xrepo_exact_trailer "$delegation" Peer-Issue-Node-Id)" \
        --arg materialisationOperationId "$(_xrepo_exact_trailer "$delegation" Materialisation-Operation-Id)" \
        --arg declarationDigest "$(_xrepo_exact_trailer "$delegation" Declaration-Digest)" \
        --arg peerTip "$tip" --arg peerClose "$close" --arg peerEpic "$root" \
        '{parentRepo:$parentRepo,parentIssue:$parentIssue,peerRepo:$peerRepo,peerIssue:$peerIssue,parentRepoNodeId:$parentRepoNodeId,parentIssueNodeId:$parentIssueNodeId,peerRepoNodeId:$peerRepoNodeId,peerIssueNodeId:$peerIssueNodeId,materialisationOperationId:$materialisationOperationId,declarationDigest:$declarationDigest,peerTip:$peerTip,peerClose:$peerClose,peerEpic:$peerEpic}') || return 2
    candidate=$(_taskdag_delegated_close_message "$evidence" | git commit-tree "$(_xrepo_empty_tree)" -p "$delegation") || return 2
    _xrepo_validate_delegated_close_v1 "$candidate" "$delegation" "$top_repo" "$top_issue" "$peer_repo" "$peer_issue" || return 2
    ref="refs/heads/tasks/delegated-close/v1/${top_issue}/${peer_repo}/${peer_issue}"
    existing=$(_xrepo_remote_sha "$ref") || rc=$?; [ "$rc" -ne 3 ] || return 2
    if [ -n "$existing" ]; then
        git fetch -q --no-tags origin "$ref" || return 2
        _xrepo_validate_delegated_close_v1 "$existing" "$delegation" "$top_repo" "$top_issue" "$peer_repo" "$peer_issue"
        return
    fi
    _xrepo_watchdog_fence || return 2
    updates=$(jq -ncS --arg ref "$ref" --arg new "$candidate" '[{ref:$ref,old:"",new:$new}]') || return 2
    taskdag_consumer_fenced_scheduling_push reconcile-delegated-close "${TASK_DAG_CLAIMER:-comment-reconciler}" "$updates" || :
    existing=$(_xrepo_remote_sha "$ref") || return 2; [ -n "$existing" ] || return 2
    git fetch -q --no-tags origin "$ref" || return 2
    _xrepo_validate_delegated_close_v1 "$existing" "$delegation" "$top_repo" "$top_issue" "$peer_repo" "$peer_issue"
}

_xrepo_reconcile_issue_delegated_closes() { # issue
    local issue=$1 listing sha ref tail owner repo peer
    listing=$(git ls-remote --refs origin "refs/heads/tasks/delegated/${issue}/*") || return 2
    while IFS=$'\t' read -r sha ref; do
        [ -n "$ref" ] || continue
        tail=${ref#refs/heads/tasks/delegated/${issue}/}; owner=${tail%%/*}; tail=${tail#*/}; repo=${tail%%/*}; peer=${tail#*/}
        git fetch -q --no-tags origin "$ref" || return 2
        _xrepo_validate_delegation "$sha" "$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]')" "$issue" "${owner}/${repo}" "$peer" || return 2
        _xrepo_reconcile_delegated_close "$issue" "${owner}/${repo}" "$peer" "$sha" || return 2
    done < <(printf '%s\n' "$listing" | awk 'NF==2{print $1 "\t" $2}')
}

_xrepo_exact_trailer() {
    local commit="$1" key="$2" values
    values=$(git show -s --format="%(trailers:key=${key},valueonly,separator=%x0A)" "$commit" 2>/dev/null) || return 2
    [ "$(printf '%s\n' "$values" | sed '/^$/d' | wc -l | tr -d '[:space:]')" = 1 ] || return 2
    [ -n "$values" ] || return 2
    printf '%s\n' "$values"
}

# Validate one isolated delegated/close snapshot and report whether every
# delegated child for an issue has a matching strict close fact. The caller
# supplies a bare GIT_DIR populated from one verified origin advertisement, so
# this never falls back to stale refs in the working checkout.
_xrepo_strict_snapshot_status() {
    local git_dir="$1" top_repo="$2" top_issue="$3"
    local ref tail owner repo peer sha any=false missing=false
    while IFS=$'\t' read -r sha ref; do
        [ -n "$ref" ] || continue
        any=true
        tail="${ref#refs/heads/tasks/delegated/${top_issue}/}"
        owner="${tail%%/*}"; tail="${tail#*/}"
        repo="${tail%%/*}"; peer="${tail#*/}"
        [[ "$owner" =~ ^[A-Za-z0-9_.-]+$ && "$repo" =~ ^[A-Za-z0-9_.-]+$ && "$peer" =~ ^[1-9][0-9]*$ ]] || return 2
        GIT_DIR="$git_dir" _xrepo_validate_delegation "$sha" "$top_repo" "$top_issue" "${owner}/${repo}" "$peer" || return 2
        if ! GIT_DIR="$git_dir" _xrepo_child_satisfied "$top_issue" "${owner}/${repo}/${peer}"; then
            missing=true
        fi
    done < <(git --git-dir="$git_dir" for-each-ref --format='%(objectname)%09%(refname)' \
        "refs/heads/tasks/delegated/${top_issue}/")
    [ "$any" = true ] || return 2
    [ "$missing" = false ] || { printf 'waiting\n'; return 0; }
    printf 'ready\n'
}

# cmd_ingest_completion — record a peer-repo Satisfies: as completion
# ─────────────────────────────────────────────────────────────────────

cmd_ingest_completion() {
    if [ "${_XREPO_PREPARE_COMPLETION:-false}" != true ]; then
        _xrepo_die "ingest-completion is internal; direct invocation is rejected. Process every completion comment with ingest-comment so its durable receipt and completion fact are published atomically."
        return 2
    fi
    local top_issue="" comment_id="" comment_url="" from="" comment_phase="" comment_peer_issue=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --issue)        top_issue="$2";   shift 2 ;;
            --comment-id)   comment_id="$2";  shift 2 ;;
            --comment-url)  comment_url="$2"; shift 2 ;;
            --from)         from="$2";        shift 2 ;;
            # Optional phase carried by the completion comment itself
            # (emitted by the peer-side aggregator). Lets phase-gating
            # work without a cross-repo API call — see the resolution
            # block below.
            --phase)        comment_phase="$2"; shift 2 ;;
            # Optional peer-repo issue number carried by the completion
            # comment itself (emitted by the peer-side aggregator, which
            # CAN read its own commit). Authoritative when it names a real
            # delegated child — this is how multiple same-repo delegations
            # are disambiguated for a private cross-org peer whose commit
            # the top-level token cannot read. See Strategy 0 below.
            --peer-issue)   comment_peer_issue="$2"; shift 2 ;;
            *) _xrepo_die "ingest-completion: unknown arg: $1"; return 2 ;;
        esac
    done
    [ -n "$top_issue"   ] || { _xrepo_die "ingest-completion: --issue is required";       return 2; }
    [ -n "$comment_id"  ] || { _xrepo_die "ingest-completion: --comment-id is required";  return 2; }
    [ -n "$comment_url" ] || { _xrepo_die "ingest-completion: --comment-url is required"; return 2; }
    [ -n "$from"        ] || { _xrepo_die "ingest-completion: --from is required";        return 2; }
    [[ "$top_issue" =~ ^[1-9][0-9]*$ ]] || { _xrepo_die "ingest-completion: --issue must be a positive integer"; return 2; }
    [[ "$comment_id" =~ ^[1-9][0-9]*$ ]] || { _xrepo_die "ingest-completion: --comment-id must be a positive integer"; return 2; }
    [[ "$comment_url" =~ ^https:// ]] || { _xrepo_die "ingest-completion: --comment-url must be https"; return 2; }
    [ -z "$comment_phase" ] || [[ "$comment_phase" =~ ^[A-Za-z0-9]+$ ]] \
        || { _xrepo_die "ingest-completion: --phase must be alphanumeric"; return 2; }
    [ -z "$comment_peer_issue" ] || [[ "$comment_peer_issue" =~ ^[1-9][0-9]*$ ]] \
        || { _xrepo_die "ingest-completion: --peer-issue must be a positive integer"; return 2; }
    _xrepo_parse_repo_sha "$from" || return $?
    taskdag_migration_guard completion-ingest || return $?

    _xrepo_need_cmd gh
    _xrepo_need_cmd jq

    local top_repo
    top_repo="$(_xrepo_current_repo)"
    [ -n "$top_repo" ] || { _xrepo_die "ingest-completion: cannot determine current repo"; return 2; }

    _xrepo_ensure_git_identity

    # Idempotency: comment already mapped → re-point only if needed.
    local comment_ref="refs/heads/gh/comments/${top_issue}/${comment_id}"

    # Resolve the peer commit's full SHA + message via the GitHub API.
    #
    # This is BEST-EFFORT: the top-level workflow runs with a token
    # scoped to the top-level repo, which generally cannot read a
    # private peer repo in a different account/org. When the call fails
    # we must NOT abort — that would silently drop every cross-repo
    # completion (the bug this guards against). Instead we fall back to
    # the short SHA from the comment (a fine ref identifier) and take the
    # phase from the comment, which the peer-side aggregator embeds
    # precisely because it CAN read the peer commit. The peer issue is
    # still resolved locally below (URL/Issue trailer or single
    # delegation), so the API is not on the critical path.
    local peer_full_sha="" peer_message=""
    local peer_commit_json=""
    if declare -F _rc_api >/dev/null 2>&1; then
        if _rc_api "repos/${XREPO_OWNER}/${XREPO_REPO}/commits/${XREPO_SHA_PREFIX}" optional; then
            peer_commit_json=$(cat "${tmp:?reconciliation tempdir is required}/body")
        fi
    elif peer_commit_json="$(gh api "repos/${XREPO_OWNER}/${XREPO_REPO}/commits/${XREPO_SHA_PREFIX}" 2>/dev/null)"; then
        :
    fi
    if [ -n "$peer_commit_json" ]; then
        peer_full_sha="$(printf '%s' "$peer_commit_json" | jq -r .sha)"
        peer_message="$(printf '%s' "$peer_commit_json" | jq -r .commit.message)"
    fi
    if [ -z "$peer_full_sha" ] || [ "$peer_full_sha" = "null" ]; then
        _xrepo_log "ingest-completion: API resolve of ${XREPO_OWNER}/${XREPO_REPO}@${XREPO_SHA_PREFIX} unavailable; using comment-supplied data"
        peer_full_sha="$XREPO_SHA_PREFIX"
    fi

    # Determine the phase for phase-gated epics (see
    # scripts/task-dag.d/phase-gates.conf). The comment-supplied phase
    # (--phase, emitted by the aggregator) is authoritative; otherwise
    # fall back to the `Phase: P<n>` trailer of the resolved commit
    # message (only available when the API call above succeeded).
    local peer_phase="$comment_phase"
    if [ -z "$peer_phase" ]; then
        peer_phase="$(printf '%s\n' "$peer_message" \
            | git interpret-trailers --parse \
            | awk -F': ' '$1 == "Phase" { print $2 }' \
            | head -n1 \
            | tr -d '[:space:]')"
    fi

    # Determine the delegated child key.
    local peer_issue=""

    # Strategy 0: comment-supplied peer issue (authoritative when present
    # AND it names a real delegated child). The peer-side aggregator
    # resolves this from ITS OWN commit — which the top-level token often
    # cannot read for a private cross-org peer — and carries it in the
    # completion comment. This is the only reliable disambiguator when a
    # single peer repo has MULTIPLE delegated children under one epic
    # (Strategies 1–2 need the unreadable commit; Strategy 3 needs exactly
    # one delegation). A bogus/typo'd value that matches no delegation is
    # ignored (not fatal) so it can never wedge a completion — we fall
    # through to Strategies 1–3.
    if [ -n "$comment_peer_issue" ]; then
        local delegation_probe_rc=0
        _xrepo_delegation_exists "$top_issue" "$XREPO_OWNER" "$XREPO_REPO" "$comment_peer_issue" || delegation_probe_rc=$?
        if [ "$delegation_probe_rc" -eq 0 ]; then
            peer_issue="$comment_peer_issue"
        elif [ "$delegation_probe_rc" -eq 2 ]; then
            _xrepo_die "ingest-completion: cannot authoritatively read delegation for peer issue ${comment_peer_issue}"
            return 2
        else
            _xrepo_log "ingest-completion: comment-supplied peer-issue ${comment_peer_issue} has no delegation under #${top_issue} for ${XREPO_OWNER}/${XREPO_REPO}; ignoring it and falling back to commit/single-delegation resolution"
        fi
    fi

    # Strategy 1: parse URL: https://github.com/<owner>/<repo>/issues/<peer_issue>
    if [ -z "$peer_issue" ]; then
        peer_issue="$(printf '%s\n' "$peer_message" \
            | grep -Eo "https://github\.com/${XREPO_OWNER}/${XREPO_REPO}/issues/[0-9]+" \
            | head -n1 \
            | grep -Eo '[0-9]+$' || true)"
    fi

    # Strategy 2: parse Issue: #<peer_issue>
    if [ -z "$peer_issue" ]; then
        peer_issue="$(printf '%s\n' "$peer_message" \
            | git interpret-trailers --parse \
            | awk -F': ' '$1 == "Issue" { print $2 }' \
            | head -n1 \
            | tr -dc '0-9' || true)"
    fi

    # Strategy 3: if exactly one delegated ref for this repo under this
    # epic, use it.
    if [ -z "$peer_issue" ]; then
        # Enumerate delegated refs from authoritative origin only.
        # On a fresh CI checkout (the issue-comment-sync runner) the
        # delegated refs are not present locally, so a local-only lookup
        # silently finds nothing — and when the peer API is unavailable
        # (cross-org private repo) the commit-message strategies above
        # also yield nothing, leaving the peer issue unresolvable. The
        # comment-supplied phase is enough to gate, but we still need the
        # peer issue number; the delegation ref on origin carries it.
        local remote_listing remote_refs count
        if ! remote_listing="$(git ls-remote origin \
            "refs/heads/tasks/delegated/${top_issue}/${XREPO_OWNER}/${XREPO_REPO}/*" \
            2>/dev/null)"; then
            _xrepo_die "ingest-completion: cannot authoritatively enumerate delegations"
            return 2
        fi
        remote_refs="$(printf '%s\n' "$remote_listing" | awk '{ print $2 }')"
        # `wc -l` exits 0 even on empty input (unlike `grep -c .`, which
        # exits 1 on zero matches and would trip `set -e`). The trailing
        # newline from `printf '%s\n'` is required so a single ref counts
        # as one line.
        count="$(printf '%s\n' "$remote_refs" | sed '/^[[:space:]]*$/d' | wc -l | tr -d '[:space:]')"
        if [ "$count" = "1" ]; then
            peer_issue="${remote_refs##*/}"
        fi
    fi

    [ -n "$peer_issue" ] || {
        _xrepo_die "ingest-completion: cannot resolve delegated peer issue for ${XREPO_OWNER}/${XREPO_REPO}@${peer_full_sha} (no comment peer-issue matching a delegation, no URL: trailer, no Issue: trailer, and not exactly one delegated child)"
        return 2
    }

    local delegated_ref="refs/heads/tasks/delegated/${top_issue}/${XREPO_OWNER}/${XREPO_REPO}/${peer_issue}"

    local delegation_sha delegation_rc=0
    delegation_sha="$(_xrepo_remote_sha "$delegated_ref")" || delegation_rc=$?
    [ "$delegation_rc" -ne 3 ] || {
        _xrepo_die "ingest-completion: cannot authoritatively read ${delegated_ref}"
        return 2
    }
    [ -n "$delegation_sha" ] || {
        _xrepo_die "ingest-completion: no delegation ref ${delegated_ref} (must call 'task-dag delegate' first)"
        return 2
    }
    git fetch -q origin "$delegated_ref" || return 2

    local completion_ref="refs/heads/tasks/completions/${top_issue}/${XREPO_OWNER}/${XREPO_REPO}/${peer_issue}/${peer_full_sha}"

    local completion_sha completion_rc=0 completion_exists=false
    completion_sha="$(_xrepo_remote_sha "$completion_ref")" || completion_rc=$?
    [ "$completion_rc" -ne 3 ] || {
        _xrepo_die "ingest-completion: cannot authoritatively read ${completion_ref}"
        return 2
    }

    if [ -n "$completion_sha" ]; then
        git fetch -q origin "$completion_ref" || return 2
        _xrepo_validate_completion_fact "$completion_sha" "$delegation_sha" "$top_repo" \
            "$top_issue" "${XREPO_OWNER}/${XREPO_REPO}" "$peer_issue" "$peer_full_sha" || {
            _xrepo_die "ingest-completion: malformed completion fact at ${completion_ref}"
            return 2
        }
        completion_exists=true
        _xrepo_log "completion ref already present for ${XREPO_OWNER}/${XREPO_REPO}@${peer_full_sha}"
    else
        local empty_tree msg_file
        empty_tree="$(_xrepo_empty_tree)"
        msg_file="$(mktemp)"
        {
            printf 'kind: completion\n'
            printf 'role: system\n'
            printf 'intent: cross-repo-satisfied\n'
            printf '\n'
            printf 'issue:\n'
            printf '  repo: %s\n' "$top_repo"
            printf '  number: %s\n' "$top_issue"
            printf '\n'
            printf 'delegated:\n'
            printf '  repo: %s/%s\n' "$XREPO_OWNER" "$XREPO_REPO"
            printf '  number: %s\n' "$peer_issue"
            printf '\n'
            printf 'source:\n'
            printf '  repo: %s/%s\n' "$XREPO_OWNER" "$XREPO_REPO"
            printf '  commit: %s\n' "$peer_full_sha"
            if [ -n "$peer_phase" ]; then
                printf '  phase: %s\n' "$peer_phase"
            fi
            printf '  comment_id: %s\n' "$comment_id"
            printf '  comment_url: %s\n' "$comment_url"
            printf '\n'
            printf 'body: |\n'
            printf '  Satisfies %s#%s via %s/%s@%s\n' \
                "$top_repo" "$top_issue" "$XREPO_OWNER" "$XREPO_REPO" "${peer_full_sha:0:12}"
        } > "$msg_file"
        completion_sha="$(git commit-tree "$empty_tree" -p "$delegation_sha" -F "$msg_file")"
        rm -f "$msg_file"
    fi

    # ingest-comment prepares the completion object here, then publishes it
    # together with its receipt.  Do not create any local disposition ref.
    XREPO_PREPARED_COMPLETION_SHA="$completion_sha"
    XREPO_PREPARED_COMPLETION_REF="$completion_ref"
    XREPO_PREPARED_COMPLETION_EXISTS="$completion_exists"
    XREPO_PREPARED_DELEGATION_SHA="$delegation_sha"
    return 0
}

# Helper: return 0 if delegated child <rest> (= <owner>/<repo>/<peer>)
# under epic <top_issue> has exact parent-authoritative close evidence.
_xrepo_child_satisfied() {
    local top_issue="$1" rest="$2"
    local owner="${rest%%/*}" trail="${rest#*/}" repo peer record delegation top_repo
    repo="${trail%%/*}"; peer="${trail#*/}"
    record=$(git rev-parse -q --verify "refs/heads/tasks/delegated-close/v1/${top_issue}/${owner}/${repo}/${peer}^{commit}" 2>/dev/null) || return 1
    delegation=$(git rev-parse -q --verify "refs/heads/tasks/delegated/${top_issue}/${owner}/${repo}/${peer}^{commit}" 2>/dev/null) || return 2
    top_repo=$(_xrepo_current_repo) || return 2
    _xrepo_validate_delegated_close_v1 "$record" "$delegation" "$top_repo" "$top_issue" "${owner}/${repo}" "$peer"
}

# Helper: print one of:
#   epic ready-to-close: <N>
#   epic still waiting: <N> missing <repo>#<issue>, ...
# Exits 0 in either case. Used by ingest-completion and the close-epic
# decision in ingest-comment.
_xrepo_epic_status() {
    local top_issue="$1"

    # Ensure we have a complete local view of delegated and strict close refs.
    git fetch --prune origin \
        "+refs/heads/tasks/delegated/${top_issue}/*:refs/heads/tasks/delegated/${top_issue}/*" \
        "+refs/heads/tasks/delegated-close/v1/${top_issue}/*:refs/heads/tasks/delegated-close/v1/${top_issue}/*" \
        >/dev/null 2>&1 || return 2

    local missing=()
    local any_delegated="false"

    while read -r refname; do
        any_delegated="true"
        # refname = refs/heads/tasks/delegated/<top>/<owner>/<repo>/<peer>
        local rest="${refname#refs/heads/tasks/delegated/${top_issue}/}"
        # Satisfied? (any completion, or final-phase completion if gated)
        if ! _xrepo_child_satisfied "$top_issue" "$rest"; then
            # rest = <owner>/<repo>/<peer>; render as owner/repo#peer
            local owner repo peer
            owner="${rest%%/*}"
            local trail="${rest#*/}"
            repo="${trail%%/*}"
            peer="${trail#*/}"
            missing+=("${owner}/${repo}#${peer}")
        fi
    done < <(git for-each-ref --format='%(refname)' \
        "refs/heads/tasks/delegated/${top_issue}/" 2>/dev/null)

    if [ "$any_delegated" = "false" ]; then
        _xrepo_log "epic has no delegations: ${top_issue}"
        return 0
    fi

    if [ ${#missing[@]} -eq 0 ]; then
        echo "epic ready-to-close: ${top_issue}"
    else
        echo "epic still waiting: ${top_issue} missing $(IFS=,; echo "${missing[*]}")"
    fi
}

# ─────────────────────────────────────────────────────────────────────
# cmd_ingest_comment — ingest a top-level issue comment
# ─────────────────────────────────────────────────────────────────────

cmd_ingest_comment() {
    local issue="" comment_id="" author="" comment_url="" body_file="" body_stdin=false created_at="" updated_at=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --issue)        issue="$2";       shift 2 ;;
            --comment-id)   comment_id="$2";  shift 2 ;;
            --author)       author="$2";      shift 2 ;;
            --comment-url)  comment_url="$2"; shift 2 ;;
            --body-file)    body_file="$2";   shift 2 ;;
            --body-stdin)   body_stdin=true;  shift ;;
            --created-at)   created_at="$2";  shift 2 ;;
            --updated-at)   updated_at="$2";  shift 2 ;;
            *) _xrepo_die "ingest-comment: unknown arg: $1"; return 2 ;;
        esac
    done
    [ -n "$issue"        ] || { _xrepo_die "ingest-comment: --issue is required";        return 2; }
    [ -n "$comment_id"   ] || { _xrepo_die "ingest-comment: --comment-id is required";   return 2; }
    [ -n "$author"       ] || { _xrepo_die "ingest-comment: --author is required";       return 2; }
    [ -n "$comment_url"  ] || { _xrepo_die "ingest-comment: --comment-url is required";  return 2; }
    if [ "$body_stdin" = true ] && [ -n "$body_file" ]; then
        _xrepo_die "ingest-comment: use exactly one of --body-file or --body-stdin"; return 2
    fi
    if [ "$body_stdin" = false ]; then
        [ -n "$body_file" ] || { _xrepo_die "ingest-comment: --body-file or --body-stdin is required"; return 2; }
        [ -r "$body_file" ] || { _xrepo_die "ingest-comment: cannot read $body_file"; return 2; }
    fi
    if { [ -n "$created_at" ] && [ -z "$updated_at" ]; } || { [ -z "$created_at" ] && [ -n "$updated_at" ]; }; then
        _xrepo_die "ingest-comment: --created-at and --updated-at are required as a pair"; return 2
    fi
    [[ "$issue" =~ ^[1-9][0-9]*$ ]] || { _xrepo_die "ingest-comment: --issue must be a positive integer"; return 2; }
    [[ "$comment_id" =~ ^[1-9][0-9]*$ ]] || { _xrepo_die "ingest-comment: --comment-id must be a positive integer"; return 2; }
    if [ -n "$created_at" ]; then
        _xrepo_valid_timestamp "$created_at" && _xrepo_valid_timestamp "$updated_at" \
            && { [ "$created_at" \< "$updated_at" ] || [ "$created_at" = "$updated_at" ]; } \
            || { _xrepo_die "ingest-comment: invalid observation timestamps"; return 2; }
    fi
    # Classification is pure. Completion observations are receipt-only hints;
    # the canonical delegated-close reconciler derives authority independently.
    local pre_classification pre_disposition _pre_from _pre_phase _pre_issue pre_repo body_value="" body_tmp=""
    if [ "$body_stdin" = true ]; then
        IFS= read -r -d '' body_value || true
    fi
    pre_repo="$(printf '%s' "$(_xrepo_current_repo_offline)" | tr '[:upper:]' '[:lower:]')"
    [[ "$pre_repo" =~ ^[a-z0-9_.-]+/[a-z0-9_.-]+$ ]] \
        || { _xrepo_die "ingest-comment: cannot determine repository without network access"; return 2; }
    if [ "$body_stdin" = true ]; then
        pre_classification="$(_xrepo_classify_comment_body "$pre_repo" "$issue" <(printf '%s' "$body_value"))" || return 2
    else
        pre_classification="$(_xrepo_classify_comment_body "$pre_repo" "$issue" "$body_file")" || return 2
    fi
    IFS=$'\x1f' read -r pre_disposition _pre_from _pre_phase _pre_issue <<<"$pre_classification"
    : "$pre_disposition"
    # Offline/event fixtures may explicitly provide their coherent snapshot.
    # Without timestamps obtain body and metadata from one direct API response.
    if [ -z "$created_at" ]; then
        local pre_ref pre_sha pre_rc=0
        pre_ref="refs/heads/gh/comments/${issue}/${comment_id}"
        pre_repo="$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]')"
        pre_sha="$(_xrepo_remote_sha "$pre_ref")" || pre_rc=$?
        [ "$pre_rc" -ne 3 ] || { _xrepo_die "cannot authoritatively read $pre_ref"; return 2; }
        if [ -n "$pre_sha" ]; then
            git fetch -q origin "$pre_ref" || return 2
            _xrepo_validate_origin_receipt "$pre_sha" "$pre_repo" "$issue" "$comment_id" >/dev/null || { _xrepo_die "origin has an invalid comment receipt: repo=${pre_repo} issue=${issue} comment-id=${comment_id} ref=${pre_ref} sha=${pre_sha}; refusing to overwrite it. Run 'task-dag validate --strict' and repair the receipt before retrying."; return 2; }
            git update-ref "$pre_ref" "$pre_sha" || true
            return 0
        fi
        _xrepo_need_cmd gh || return $?
        _xrepo_need_cmd jq || return $?
        local observation tmp rc
        observation="$(gh api "repos/$(_xrepo_current_repo)/issues/comments/${comment_id}")" || return 2
        created_at="$(printf '%s' "$observation" | jq -r .created_at)"
        updated_at="$(printf '%s' "$observation" | jq -r .updated_at)"
        tmp="$(mktemp)" || return 2
        printf '%s' "$observation" | jq -j .body >"$tmp" || { rm -f "$tmp"; return 2; }
        body_file="$tmp"
        _xrepo_ensure_git_identity
        _xrepo_ingest_observed_comment "$issue" "$comment_id" "$created_at" "$updated_at" "$author" "$comment_url" "$body_file"
        rc=$?
        rm -f "$tmp"
        return "$rc"
    fi

    if [ "$body_stdin" = true ]; then
        body_tmp="$(mktemp)" || return 2
        printf '%s' "$body_value" >"$body_tmp" || { rm -f "$body_tmp"; return 2; }
        body_file="$body_tmp"
    fi
    _xrepo_ensure_git_identity

    local rc=0
    _xrepo_ingest_observed_comment "$issue" "$comment_id" "$created_at" "$updated_at" "$author" "$comment_url" "$body_file" || rc=$?
    [ -z "$body_tmp" ] || rm -f "$body_tmp"
    return "$rc"
}

_xrepo_remote_sha() {
    local out
    out="$(git ls-remote --refs origin "$1")" || return 3
    printf '%s\n' "$out" | awk 'NR==1 {print $1}'
}

_xrepo_receipt_field() { git log -1 --format=%B "$1" | git interpret-trailers --parse | awk -F': ' -v k="$2" '$1==k {print substr($0,length(k)+3); exit}'; }

_xrepo_valid_timestamp() {
    local rendered
    [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
    rendered="$(date -u -d "$1" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || return 1
    [ "$rendered" = "$1" ]
}

_xrepo_write_sorted_listing() {
    local listing="$1" output="$2"
    if [ -n "$listing" ]; then
        printf '%s\n' "$listing"
    fi | LC_ALL=C sort >"$output"
}

# Validate either the durable v1 receipt or a narrowly recognised historical
# provenance commit.  For v1, echo its disposition, updated-at and body hash.
_xrepo_validate_receipt() {
    local sha="$1" repo="$2" issue="$3" cid="$4" tree parents msg version disposition effect
    [ "$(git cat-file -t "$sha" 2>/dev/null)" = commit ] || return 2
    tree="$(git rev-parse "$sha^{tree}")"; [ "$tree" = "$(_xrepo_empty_tree)" ] || return 2
    msg="$(git log -1 --format=%B "$sha")"
    version="$(_xrepo_receipt_field "$sha" Receipt-Version)"
    if [ -z "$version" ]; then
        local li lc legacy_repo
        li="$(awk '/^issue:/{f=1;next} f && /^  number: /{print $2;exit}' <<<"$msg")"
        lc="$(awk '/^github:/{f=1;next} f && /^  comment_id: /{print $2;exit} /^source:/{f=1;next} f && /^  comment_id: /{print $2;exit}' <<<"$msg")"
        [ "$li" = "$issue" ] || return 2
        if [ "$(grep -cx 'kind: message' <<<"$msg")" = 1 ] && [ "$(grep -cx 'role: human' <<<"$msg")" = 1 ] && [ "$(grep -Ec '^intent: (comment|clarification)$' <<<"$msg")" = 1 ]; then
            [ "$lc" = "$cid" ] || return 2
            echo legacy-human
            return 0
        fi
        if [ "$(grep -cx 'kind: completion' <<<"$msg")" = 1 ] && [ "$(grep -cx 'role: system' <<<"$msg")" = 1 ] && [ "$(grep -cx 'intent: cross-repo-satisfied' <<<"$msg")" = 1 ]; then
            legacy_repo="$(awk '/^issue:/{f=1;next} f && /^  repo: /{print $2;exit}' <<<"$msg" | tr '[:upper:]' '[:lower:]')"
            [ "$legacy_repo" = "$repo" ] || return 2
            # Historical completion provenance may be shared by several
            # comment refs, so its embedded source comment ID is not identity.
            echo legacy-completion
            return 0
        fi
        return 2
    fi
    [ "$version" = 1 ] || return 2
    [ "$(git log -1 --format=%s "$sha")" = 'Record GitHub comment receipt' ] || return 2
    local k
    for k in Receipt-Version Repository Issue Comment-ID Disposition Created-At Observed-Updated-At Body-SHA256; do
        [ "$(grep -c "^${k}: " <<<"$msg")" = 1 ] || return 2
    done
    [ "$(_xrepo_receipt_field "$sha" Repository)" = "$repo" ] || return 2
    [ "$(_xrepo_receipt_field "$sha" Issue)" = "$issue" ] || return 2
    [ "$(_xrepo_receipt_field "$sha" Comment-ID)" = "$cid" ] || return 2
    disposition="$(_xrepo_receipt_field "$sha" Disposition)"
    [[ "$disposition" =~ ^(human|completion|machine-skip)$ ]] || return 2
    local ca ua bh
    ca="$(_xrepo_receipt_field "$sha" Created-At)"; ua="$(_xrepo_receipt_field "$sha" Observed-Updated-At)"; bh="$(_xrepo_receipt_field "$sha" Body-SHA256)"
    _xrepo_valid_timestamp "$ca" || return 2
    _xrepo_valid_timestamp "$ua" || return 2
    [ "$ca" \< "$ua" ] || [ "$ca" = "$ua" ] || return 2
    [[ "$bh" =~ ^[0-9a-f]{64}$ ]] || return 2
    parents="$(git rev-list --parents -n1 "$sha" | awk '{print NF-1}')"
    effect="$(_xrepo_receipt_field "$sha" Effect-Commit)"
    if [ "$disposition" = machine-skip ] || { [ "$disposition" = completion ] && [ -z "$effect" ]; }; then
        [ "$parents" = 0 ] \
            && [ "$(grep -c '^Effect-Commit:' <<<"$msg")" = 0 ] \
            && [ "$(grep -c '^Effect-Ref-At-Creation:' <<<"$msg")" = 0 ] || return 2
    else
        [ "$(grep -c '^Effect-Commit: ' <<<"$msg")" = 1 ] && [ "$(grep -c '^Effect-Ref-At-Creation: ' <<<"$msg")" = 1 ] || return 2
        [ "$parents" = 1 ] && [ -n "$effect" ] && [ "$effect" = "$(git rev-parse "$sha^")" ] && [ -n "$(_xrepo_receipt_field "$sha" Effect-Ref-At-Creation)" ] || return 2
        [ "$(git rev-parse "$effect^{tree}" 2>/dev/null)" = "$(_xrepo_empty_tree)" ] || return 2
        local er em
        er="$(_xrepo_receipt_field "$sha" Effect-Ref-At-Creation)"; em="$(git log -1 --format=%B "$effect")"
        if [ "$disposition" = human ]; then
            local recorded_short="${er#refs/heads/tasks/frontier/}"
            [[ "$er" =~ ^refs/heads/tasks/frontier/[0-9a-f]{7,40}$ ]] || return 2
            [[ "$effect" = "$recorded_short"* ]] || return 2
            [ "$(grep -cx 'kind: message' <<<"$em")" = 1 ] && [ "$(grep -cx 'role: human' <<<"$em")" = 1 ] && [ "$(grep -cx 'intent: comment' <<<"$em")" = 1 ] || return 2
            [ "$(awk '/^issue:/{f=1;next} f && /^  number: /{print $2;exit}' <<<"$em")" = "$issue" ] || return 2
            [ "$(awk '/^github:/{f=1;next} f && /^  comment_id: /{print $2;exit}' <<<"$em")" = "$cid" ] || return 2
        else
            [[ "$er" =~ ^refs/heads/tasks/completions/${issue}/[^/]+/[^/]+/[1-9][0-9]*/[0-9a-f]{7,40}$ ]] || return 2
            [ "$(grep -cx 'kind: completion' <<<"$em")" = 1 ] && [ "$(grep -cx 'role: system' <<<"$em")" = 1 ] && [ "$(grep -cx 'intent: cross-repo-satisfied' <<<"$em")" = 1 ] || return 2
            local completion_tail completion_owner completion_repo completion_issue completion_commit
            completion_tail="${er#refs/heads/tasks/completions/${issue}/}"
            completion_owner="${completion_tail%%/*}"; completion_tail="${completion_tail#*/}"
            completion_repo="${completion_tail%%/*}"; completion_tail="${completion_tail#*/}"
            completion_issue="${completion_tail%%/*}"; completion_commit="${completion_tail#*/}"
            _xrepo_validate_completion_fact "$effect" "$(git rev-parse "$effect^")" "$repo" "$issue" \
                "${completion_owner}/${completion_repo}" "$completion_issue" "$completion_commit" || return 2
        fi
    fi
    printf '%s %s %s\n' "$disposition" "$ua" "$bh"
}

_xrepo_validate_origin_receipt() {
    local sha="$1" repo="$2" issue="$3" cid="$4" info disposition effect effect_ref tail owner peer_repo peer_issue delegation_ref delegation_sha rc=0
    info="$(_xrepo_validate_receipt "$sha" "$repo" "$issue" "$cid")" || return 2
    disposition="${info%% *}"
    if [ "$disposition" = completion ] && [ -n "$(_xrepo_receipt_field "$sha" Effect-Commit)" ]; then
        effect="$(_xrepo_receipt_field "$sha" Effect-Commit)"
        effect_ref="$(_xrepo_receipt_field "$sha" Effect-Ref-At-Creation)"
        tail="${effect_ref#refs/heads/tasks/completions/${issue}/}"
        owner="${tail%%/*}"; tail="${tail#*/}"
        peer_repo="${tail%%/*}"; tail="${tail#*/}"
        peer_issue="${tail%%/*}"
        delegation_ref="refs/heads/tasks/delegated/${issue}/${owner}/${peer_repo}/${peer_issue}"
        delegation_sha="$(_xrepo_remote_sha "$delegation_ref")" || rc=$?
        [ "$rc" -ne 3 ] && [ -n "$delegation_sha" ] || return 2
        [ "$(git rev-parse "$effect^")" = "$delegation_sha" ] || return 2
    fi
    printf '%s\n' "$info"
}

_xrepo_make_receipt() {
    local repo="$1" issue="$2" cid="$3" disposition="$4" ca="$5" ua="$6" hash="$7" effect="$8" effect_ref="$9" f
    f="$(mktemp)"
    { printf 'Record GitHub comment receipt\n\nReceipt-Version: 1\nRepository: %s\nIssue: %s\nComment-ID: %s\nDisposition: %s\nCreated-At: %s\nObserved-Updated-At: %s\nBody-SHA256: %s\n' "$repo" "$issue" "$cid" "$disposition" "$ca" "$ua" "$hash"
      [ -z "$effect" ] || printf 'Effect-Commit: %s\nEffect-Ref-At-Creation: %s\n' "$effect" "$effect_ref"; } >"$f"
    if [ -n "$effect" ]; then git commit-tree "$(_xrepo_empty_tree)" -p "$effect" -F "$f"; else git commit-tree "$(_xrepo_empty_tree)" -F "$f"; fi
    rm -f "$f"
}

# Pure classifier shared by event ingestion and repair scans.  Completion is
# deliberately tested before the generic machine marker.  On success it emits
# unit-separator-delimited disposition and completion arguments (the latter are
# empty for non-completions). A non-whitespace delimiter preserves an empty
# phase followed by a present peer issue.
_xrepo_classify_comment_body() {
    local repo="$1" issue="$2" body_file="$3" first_line first_nonblank
    first_line="$(head -n1 "$body_file")"
    first_nonblank="$(grep -m1 -v '^[[:space:]]*$' "$body_file" 2>/dev/null || true)"
    if [[ "$first_line" =~ ^[[:space:]]*\<\!--[[:space:]]*task-dag:completion[[:space:]]*--\>[[:space:]]+Satisfies[[:space:]]+([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#([0-9]+)[[:space:]]+via[[:space:]]+([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)@([A-Fa-f0-9]+)([[:space:]]+phase[[:space:]]+([A-Za-z0-9]+))?([[:space:]]+peer-issue[[:space:]]+([0-9]+))?[[:space:]]*$ ]]; then
        local target_repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}" target_issue="${BASH_REMATCH[3]}"
        [ "$(printf '%s' "$target_repo" | tr '[:upper:]' '[:lower:]')" = "$repo" ] && [ "$target_issue" = "$issue" ] || return 2
        printf 'completion\x1f%s/%s@%s\x1f%s\x1f%s\n' "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}" "${BASH_REMATCH[6]}" "${BASH_REMATCH[8]}" "${BASH_REMATCH[10]}"
    elif [[ "$first_nonblank" =~ ^[[:space:]]*\<\!-- ]] || grep -q '<!-- task-dag:' "$body_file"; then
        printf 'machine-skip\x1f\x1f\x1f\n'
    else
        printf 'human\x1f\x1f\x1f\n'
    fi
}

_xrepo_ingest_observed_comment() {
    local issue="$1" comment_id="$2" created_at="$3" updated_at="$4" author="$5" comment_url="$6" body_file="$7"
    local repo comment_ref remote_sha existing hash disposition effect_sha="" effect_ref="" classification peer_from peer_phase peer_issue
    repo="$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]')"; comment_ref="refs/heads/gh/comments/${issue}/${comment_id}"
    [[ "$repo" =~ ^[a-z0-9_.-]+/[a-z0-9_.-]+$ ]] || { _xrepo_die "cannot determine canonical owner/repository"; return 2; }
    [[ "$issue" =~ ^[1-9][0-9]*$ && "$comment_id" =~ ^[1-9][0-9]*$ ]] || { _xrepo_die "invalid issue/comment identity"; return 2; }
    local probe=0
    if [ "${_XREPO_SNAPSHOT_ABSENT:-false}" = true ]; then
        remote_sha=""
    else
        remote_sha="$(_xrepo_remote_sha "$comment_ref")" || probe=$?
    fi
    [ "$probe" -ne 3 ] || { _xrepo_die "cannot authoritatively read $comment_ref"; return 2; }
    if [ -n "$remote_sha" ]; then git fetch -q origin "$comment_ref" || return 2; _xrepo_validate_origin_receipt "$remote_sha" "$repo" "$issue" "$comment_id" >/dev/null || { _xrepo_die "origin has an invalid comment receipt: repo=${repo} issue=${issue} comment-id=${comment_id} ref=${comment_ref} sha=${remote_sha}; refusing to overwrite it. Run 'task-dag validate --strict' and repair the receipt before retrying."; return 2; }; git update-ref "$comment_ref" "$remote_sha" || true; return 0; fi
    _xrepo_valid_timestamp "$created_at" && _xrepo_valid_timestamp "$updated_at" \
        && { [ "$created_at" \< "$updated_at" ] || [ "$created_at" = "$updated_at" ]; } \
        || { _xrepo_die "invalid comment observation timestamps"; return 2; }
    hash="$(sha256sum "$body_file" | awk '{print $1}')"
    classification="$(_xrepo_classify_comment_body "$repo" "$issue" "$body_file")" || return 2
    IFS=$'\x1f' read -r disposition peer_from peer_phase peer_issue <<<"$classification"
    if [ "$disposition" = completion ]; then
        # Completion comments are latency hints, never completion authority.
        # Persist the receipt only; the canonical delegated-close reconciler
        # independently verifies the peer's exact close merge.
        : "$peer_from" "$peer_phase" "$peer_issue" "$comment_url"
    elif [ "$disposition" = human ]; then
        local epic msgf short nonce
        _xrepo_watchdog_fence || return 2
        epic="$(_xrepo_ensure_issue_epic "$issue")" || return $?; msgf="$(mktemp)"
        nonce="$(printf '%s:%s:%s:%s\n' "$BASHPID" "$RANDOM" "$(date +%s%N)" "$comment_id" | git hash-object --stdin)" || return 2
        { printf 'kind: message\nrole: human\nintent: comment\n\nissue:\n  number: %s\n\ngithub:\n  comment_id: %s\n  actor: %s\n  url: %s\n\nmessage_id: msg_%s\n\nbody: |\n' "$issue" "$comment_id" "$author" "$comment_url" "$nonce"; sed 's/^/  /' "$body_file"; } >"$msgf"
        effect_sha="$(git commit-tree "$(_xrepo_empty_tree)" -p "$epic" -F "$msgf")"; rm -f "$msgf"; short="$(git rev-parse --short "$effect_sha")"; effect_ref="refs/heads/tasks/frontier/$short"
    fi
    local effect_exists="${effect_exists:-false}"
    local receipt_sha
    receipt_sha="$(_xrepo_make_receipt "$repo" "$issue" "$comment_id" "$disposition" "$created_at" "$updated_at" "$hash" "$effect_sha" "$effect_ref")" || return 2
    _xrepo_validate_receipt "$receipt_sha" "$repo" "$issue" "$comment_id" >/dev/null || {
        _xrepo_die "refusing to publish an internally invalid comment receipt"
        return 2
    }
    local args=(--atomic "--force-with-lease=$comment_ref:")
    if [ -n "$effect_ref" ] && [ "$effect_exists" != true ]; then
        args+=("--force-with-lease=$effect_ref:" "$effect_sha:$effect_ref")
    fi
    args+=("$receipt_sha:$comment_ref")
    local publish_rc=0
    _xrepo_watchdog_fence || return 2
    if [ "$disposition" = human ]; then
        taskdag_consumer_prepare ingest-human-comment-pre-push || return 2
        if [ "$TASKDAG_CONSUMER_MODE" = canonical ]; then
            local updates
            updates=$(jq -ncS --arg rr "$comment_ref" --arg receipt "$receipt_sha" \
                --arg er "$effect_ref" --arg effect "$effect_sha" --argjson exists "$effect_exists" \
                '[{ref:$rr,old:"",new:$receipt}]
                 + (if ($er!="" and ($exists|not)) then [{ref:$er,old:"",new:$effect}] else [] end)
                 | sort_by(.ref)') || return 2
            _xrepo_watchdog_fence || return 2
            taskdag_consumer_fenced_scheduling_push ingest-human-comment "${TASK_DAG_CLAIMER:-comment-ingest}" "$updates" || publish_rc=$?
        else
            _xrepo_watchdog_fence || return 2
            git push origin "${args[@]}" || publish_rc=$?
        fi
    else
        _xrepo_watchdog_fence || return 2
        git push origin "${args[@]}" || publish_rc=$?
    fi
    if [ "$publish_rc" -ne 0 ]; then
        remote_sha="$(_xrepo_remote_sha "$comment_ref")" || return 2
        if [ -z "$remote_sha" ] && [ "$disposition" = completion ] && [ -n "$effect_ref" ] && [ "$effect_exists" != true ]; then
            # A concurrent completion for another comment can win only the
            # shared fact ref. Adopt that valid fact, then retry this
            # comment's create-only receipt once.
            local raced_effect raced_rc=0
            raced_effect="$(_xrepo_remote_sha "$effect_ref")" || raced_rc=$?
            [ "$raced_rc" -ne 3 ] && [ -n "$raced_effect" ] || return 2
            git fetch -q origin "$effect_ref" || return 2
            local raced_tail raced_owner raced_repo raced_issue raced_commit
            raced_tail="${effect_ref#refs/heads/tasks/completions/${issue}/}"
            raced_owner="${raced_tail%%/*}"; raced_tail="${raced_tail#*/}"
            raced_repo="${raced_tail%%/*}"; raced_tail="${raced_tail#*/}"
            raced_issue="${raced_tail%%/*}"; raced_commit="${raced_tail#*/}"
            _xrepo_validate_completion_fact "$raced_effect" "$expected_delegation" \
                "$repo" "$issue" "${raced_owner}/${raced_repo}" \
                "$raced_issue" "$raced_commit" || return 2
            effect_sha="$raced_effect"
            receipt_sha="$(_xrepo_make_receipt "$repo" "$issue" "$comment_id" "$disposition" \
                "$created_at" "$updated_at" "$hash" "$effect_sha" "$effect_ref")" || return 2
            _xrepo_validate_receipt "$receipt_sha" "$repo" "$issue" "$comment_id" >/dev/null || return 2
            _xrepo_watchdog_fence || return 2
            git push origin --atomic "--force-with-lease=$comment_ref:" "$receipt_sha:$comment_ref" >/dev/null 2>&1 || true
            remote_sha="$(_xrepo_remote_sha "$comment_ref")" || return 2
        fi
        [ -n "$remote_sha" ] || return 2
        git fetch -q origin "$comment_ref" || return 2
        existing="$(_xrepo_validate_origin_receipt "$remote_sha" "$repo" "$issue" "$comment_id")" || return 2
        local wd wu wh; read -r wd wu wh <<<"$existing"
        if [ "$wu" = "$updated_at" ] && [ "$wh" = "$hash" ] && [ "$wd" != "$disposition" ]; then _xrepo_die "origin receipt conflict: repo=${repo} issue=${issue} comment-id=${comment_id} ref=${comment_ref} sha=${remote_sha}; the same updated-at/body hash is stored as '${wd}' but this run classified it as '${disposition}'. Inspect the origin receipt and comment before retrying."; return 2; fi
        receipt_sha="$remote_sha"
    else
        if [ "${_XREPO_SNAPSHOT_ABSENT:-false}" = true ]; then
            remote_sha="$receipt_sha"
        else
            remote_sha="$(_xrepo_remote_sha "$comment_ref")" || return 2; [ "$remote_sha" = "$receipt_sha" ] || return 2
        fi
    fi
    local winner_info winner_disposition winner_effect winner_ref
    winner_info="$(_xrepo_validate_origin_receipt "$receipt_sha" "$repo" "$issue" "$comment_id")" || return 2
    read -r winner_disposition _ _ <<<"$winner_info"
    winner_effect="$(_xrepo_receipt_field "$receipt_sha" Effect-Commit)"
    winner_ref="$(_xrepo_receipt_field "$receipt_sha" Effect-Ref-At-Creation)"
    local origin_effect="" origin_effect_rc=0 mirror_effect=false
    if [ -n "$winner_ref" ]; then
        origin_effect="$(_xrepo_remote_sha "$winner_ref")" || origin_effect_rc=$?
        [ "$origin_effect_rc" -ne 3 ] || return 2
        if [ -n "$origin_effect" ] && [ "$origin_effect" != "$winner_effect" ]; then
            _xrepo_die "origin effect conflict: repo=${repo} issue=${issue} comment-id=${comment_id} receipt-ref=${comment_ref} receipt-sha=${receipt_sha} effect-ref=${winner_ref} expected-sha=${winner_effect} origin-sha=${origin_effect}; repair the conflicting origin effect ref before retrying ingest-comment."
            return 2
        fi
        [ -z "$origin_effect" ] || mirror_effect=true
    fi
    git update-ref "$comment_ref" "$receipt_sha" || _xrepo_log "warning: receipt is durable on origin, but the local mirror update failed: ref=${comment_ref} sha=${receipt_sha}; fetch the ref before relying on local state"
    if [ -n "$winner_ref" ]; then
        if [ "$mirror_effect" = true ]; then
            git update-ref "$winner_ref" "$winner_effect" || _xrepo_log "warning: completion effect is durable on origin, but the local mirror update failed: ref=${winner_ref} sha=${winner_effect}; fetch the ref before relying on local state"
        else
            git update-ref -d "$winner_ref" >/dev/null 2>&1 || true
        fi
    fi
    if [ "$winner_disposition" = completion ] && [ "${_XREPO_DEFER_CONVERGENCE:-false}" != true ]; then
        local status_line root
        _xrepo_reconcile_issue_delegated_closes "$issue" || return 2
        status_line="$(_xrepo_epic_status "$issue" | tail -n1)"
        if [[ "$status_line" =~ ^epic[[:space:]]ready-to-close: ]]; then
            root=$(_xrepo_ensure_issue_epic "$issue") || return 2
            _xrepo_watchdog_fence || return 2
            taskdag_emit_origin_epic_close "$issue" "$root" || return $?
        fi
    fi
}

# Bounded repair scanner for issue comments.  It deliberately delegates every
# mutation to the same atomic primitive as the webhook path above.
_xrepo_reconcile_argument_failure() {
    local mode="$1" message="$2"
    jq -nc --arg mode "$mode" --arg message "$message" '
        {schema_version:1,mode:(if $mode=="" then null else $mode end),status:"failed",dry_run:false,
         requests:0,pages:0,returned:0,unique:0,eligible:0,pull_requests:0,pre_boundary:0,
         already_receipted:0,missing:0,dispositions:{human:0,completion:0,machine_skip:0},
         attempted:0,applied:0,deferred:0,failures:1,exhausted:false,
         failure_items:[{stage:"arguments",issue:null,comment_id:null,message:$message}],
         duration_seconds:0,rate_limit:{remaining:null,reset:null},
         recent_success_at:null,complete_success_at:null}'
}

_xrepo_reconcile_comments_impl() {
    local mode="" start="" since="" dry=false max_apply=100 max_pages=100 max_comments=10000 max_seconds=300 watchdog_token=""
    local -a allows=()
    while [ $# -gt 0 ]; do
        case "$1" in
            --mode|--ingestion-start-at|--since|--allow-comment|--max-apply|--max-pages|--max-comments|--max-seconds|--watchdog-token-file)
                [ $# -ge 2 ] || { _xrepo_reconcile_argument_failure "$mode" "$1 requires a value"; return 2; }
                case "$1" in
                    --mode) mode="$2";; --ingestion-start-at) start="$2";; --since) since="$2";;
                    --allow-comment) allows+=("$2");; --max-apply) max_apply="$2";;
                    --max-pages) max_pages="$2";; --max-comments) max_comments="$2";;
                    --max-seconds) max_seconds="$2";; --watchdog-token-file) watchdog_token="$2";;
                esac
                shift 2 ;;
            --dry-run) dry=true; shift;;
            --help|-h) cat <<'EOF'
Usage: task-dag reconcile-comments --mode recent|complete --ingestion-start-at RFC3339
       [--since RFC3339] [--allow-comment ISSUE:ID ...] [--dry-run]
       [--max-apply N] [--max-pages N] [--max-comments N] [--max-seconds N]
EOF
                return 0;;
            *) _xrepo_reconcile_argument_failure "$mode" "unknown argument: $1"; return 2;;
        esac
    done
    _xrepo_need_cmd jq || return 2
    if ! _xrepo_need_cmd gh; then _xrepo_reconcile_argument_failure "$mode" "required command not found: gh"; return 2; fi
    local v; for v in "$max_apply" "$max_pages" "$max_comments" "$max_seconds"; do [[ "$v" =~ ^[1-9][0-9]*$ ]] || { _xrepo_reconcile_argument_failure "$mode" "ceilings must be positive integers"; return 2; }; done
    [ "$mode" = recent ] || [ "$mode" = complete ] || { _xrepo_reconcile_argument_failure "$mode" "--mode must be recent or complete"; return 2; }
    _xrepo_valid_timestamp "$start" || { _xrepo_reconcile_argument_failure "$mode" "invalid --ingestion-start-at"; return 2; }
    if [ "$mode" = recent ]; then _xrepo_valid_timestamp "$since" || { _xrepo_reconcile_argument_failure "$mode" "recent requires valid --since"; return 2; }; else [ -z "$since" ] || { _xrepo_reconcile_argument_failure "$mode" "complete rejects --since"; return 2; }; fi
    local _XREPO_WATCHDOG_TOKEN_FILE="$watchdog_token"
    if [ -n "$watchdog_token" ]; then
        [ -f "$watchdog_token" ] && [ "$max_seconds" -le 240 ] && taskdag_comment_watchdog_check_file "$watchdog_token" $((max_seconds+30)) \
            || { _xrepo_reconcile_argument_failure "$mode" "invalid, stale, or insufficient watchdog lease"; return 2; }
    fi

    local began now deadline repo tmp listing rc=0 fatal=false real_git
    began=$(date +%s); deadline=$((began + max_seconds)); repo=$(printf '%s' "$(_xrepo_current_repo_offline)" | tr '[:upper:]' '[:lower:]')
    local GITHUB_REPOSITORY="$repo"
    tmp=$(mktemp -d)
    real_git=$(command -v git)
    mkdir -p "$tmp/bin"
    cat >"$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
remaining=$((TASKDAG_RECONCILE_DEADLINE - $(date +%s)))
[ "$remaining" -gt 0 ] || exit 124
exec timeout --signal=TERM "${remaining}s" "$TASKDAG_RECONCILE_REAL_GIT" "$@"
EOF
    chmod 0755 "$tmp/bin/git"
    export TASKDAG_RECONCILE_DEADLINE="$deadline" TASKDAG_RECONCILE_REAL_GIT="$real_git"
    local PATH="$tmp/bin:$PATH"
    local requests=0 pages=0 returned=0 unique=0 eligible=0 prs=0 pre=0 receipted=0 missing=0 human=0 completion=0 machine=0 attempted=0 applied=0 deferred=0 failures=0 remaining=null reset=null
    local failure_file="$tmp/failures"; : >"$failure_file"
    _rc_fail() { failures=$((failures+1)); if [ "$failures" -le 100 ]; then jq -nc --arg stage "$1" --arg issue "${2:-}" --arg comment_id "${3:-}" --arg message "$4" '{stage:$stage,issue:(if ($issue|test("^[1-9][0-9]*$")) then ($issue|tonumber) else null end),comment_id:(if ($comment_id|test("^[1-9][0-9]*$")) then ($comment_id|tonumber) else null end),message:$message}' >>"$failure_file"; fi; return 0; }
    _rc_time() { [ "$(date +%s)" -lt "$deadline" ]; }
    # One authoritative namespace advertisement. It is also the proof used by
    # the private no-initial-probe ingestion mode.
    listing=$(timeout "${max_seconds}s" git ls-remote --refs origin 'refs/heads/gh/comments/*' 'refs/heads/tasks/completions/*' 'refs/heads/tasks/delegated/*' 'refs/heads/tasks/delegated-close/v1/*' 2>"$tmp/git.err") || { _rc_fail snapshot "" "" "$(cat "$tmp/git.err")"; fatal=true; listing=""; }
    _xrepo_write_sorted_listing "$listing" "$tmp/manifest"
    if awk 'NF && $2 !~ /^refs\/heads\/gh\/comments\/[1-9][0-9]*\/[1-9][0-9]*$/ && $2 !~ /^refs\/heads\/gh\/comments\/[1-9][0-9]*\/manual-cleanup-[A-Za-z0-9_.-]+-[1-9][0-9]*$/ && $2 !~ /^refs\/heads\/tasks\/delegated\/[1-9][0-9]*\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[1-9][0-9]*$/ && $2 !~ /^refs\/heads\/tasks\/delegated-close\/v1\/[1-9][0-9]*\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[1-9][0-9]*$/ && $2 !~ /^refs\/heads\/tasks\/completions\/[1-9][0-9]*\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[1-9][0-9]*\/[0-9a-f]{7,40}$/ {exit 1}' "$tmp/manifest"; then :; else _rc_fail snapshot "" "" "malformed ref in advertised namespace"; fatal=true; fi
    printf '%s\n' "$listing" | awk '$2 ~ /^refs\/heads\/gh\/comments\/[1-9][0-9]*\/[1-9][0-9]*$/ {print $2}' >"$tmp/receipts"
    git init -q --bare "$tmp/snapshot.git" && git --git-dir="$tmp/snapshot.git" remote add origin "$(git remote get-url origin)" || { _rc_fail snapshot "" "" "cannot initialize isolated snapshot"; fatal=true; }
    if [ "$fatal" = false ] && [ -s "$tmp/manifest" ]; then
        timeout "${max_seconds}s" git --git-dir="$tmp/snapshot.git" fetch -q --no-tags origin \
            '+refs/heads/gh/comments/*:refs/heads/gh/comments/*' \
            '+refs/heads/tasks/completions/*:refs/heads/tasks/completions/*' \
            '+refs/heads/tasks/delegated/*:refs/heads/tasks/delegated/*' \
            '+refs/heads/tasks/delegated-close/v1/*:refs/heads/tasks/delegated-close/v1/*' || { _rc_fail snapshot "" "" "isolated snapshot fetch failed"; fatal=true; }
    fi
    git --git-dir="$tmp/snapshot.git" for-each-ref --format='%(objectname)%09%(refname)' refs/heads/gh/comments refs/heads/tasks/completions refs/heads/tasks/delegated refs/heads/tasks/delegated-close/v1 | LC_ALL=C sort >"$tmp/fetched"
    cmp -s "$tmp/manifest" "$tmp/fetched" || { _rc_fail snapshot "" "" "snapshot changed during fetch"; fatal=true; }
    : >"$tmp/converge-issues"
    while IFS=$'\t' read -r sha ref; do
        if [[ "$ref" =~ ^refs/heads/gh/comments/([1-9][0-9]*)/([1-9][0-9]*)$ ]]; then
            local receipt_issue="${BASH_REMATCH[1]}" receipt_id="${BASH_REMATCH[2]}" receipt_info
            if ! receipt_info=$(GIT_DIR="$tmp/snapshot.git" _xrepo_validate_receipt "$sha" "$repo" "$receipt_issue" "$receipt_id"); then
                _rc_fail snapshot "$receipt_issue" "$receipt_id" "malformed comment receipt"; fatal=true
            elif [[ "$receipt_info" = completion* || "$receipt_info" = legacy-completion* ]]; then
                printf '%s\n' "$receipt_issue" >>"$tmp/converge-issues"
            fi
        elif [[ "$ref" =~ ^refs/heads/gh/comments/([1-9][0-9]*)/(manual-cleanup-[A-Za-z0-9_.-]+-[1-9][0-9]*)$ ]]; then
            local legacy_issue="${BASH_REMATCH[1]}" legacy_id="${BASH_REMATCH[2]}" legacy_info
            if ! legacy_info=$(GIT_DIR="$tmp/snapshot.git" _xrepo_validate_receipt "$sha" "$repo" "$legacy_issue" "$legacy_id") \
                || [ "$legacy_info" != legacy-completion ]; then
                _rc_fail snapshot "$legacy_issue" "" "malformed historical completion provenance"; fatal=true
            else
                printf '%s\n' "$legacy_issue" >>"$tmp/converge-issues"
            fi
        elif [[ "$ref" =~ ^refs/heads/tasks/delegated/([1-9][0-9]*)/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/([1-9][0-9]*)$ ]]; then
            local delegated_issue="${BASH_REMATCH[1]}" delegated_owner="${BASH_REMATCH[2]}" delegated_repo="${BASH_REMATCH[3]}" delegated_peer="${BASH_REMATCH[4]}"
            GIT_DIR="$tmp/snapshot.git" _xrepo_validate_delegation "$sha" "$repo" \
                "$delegated_issue" "${delegated_owner}/${delegated_repo}" "$delegated_peer" \
                || { _rc_fail snapshot "$delegated_issue" "" "malformed delegation fact"; fatal=true; }
        elif [[ "$ref" =~ ^refs/heads/tasks/completions/([1-9][0-9]*)/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/([1-9][0-9]*)/([0-9a-f]{7,40})$ ]]; then
            local fact_issue="${BASH_REMATCH[1]}" fact_owner="${BASH_REMATCH[2]}" fact_repo="${BASH_REMATCH[3]}" fact_peer="${BASH_REMATCH[4]}" fact_commit="${BASH_REMATCH[5]}" fact_parent
            fact_parent=$(git --git-dir="$tmp/snapshot.git" rev-parse -q --verify \
                "refs/heads/tasks/delegated/${fact_issue}/${fact_owner}/${fact_repo}/${fact_peer}^{commit}") \
                || { _rc_fail snapshot "$fact_issue" "" "completion fact has no canonical delegation"; fatal=true; continue; }
            GIT_DIR="$tmp/snapshot.git" _xrepo_validate_completion_fact "$sha" "$fact_parent" "$repo" \
                "$fact_issue" "${fact_owner}/${fact_repo}" "$fact_peer" "$fact_commit" \
                || { _rc_fail snapshot "$fact_issue" "" "malformed completion fact"; fatal=true; }
            printf '%s\n' "$fact_issue" >>"$tmp/converge-issues"
        fi
    done <"$tmp/manifest"

    _rc_api() {
        local endpoint="$1" required="${2:-required}" try=0 code retry="" envelope="$tmp/envelope" headers="$tmp/headers"
        while :; do
            _rc_time || return 124; requests=$((requests+1)); : >"$envelope"
            local gh_rc=0 left
            left=$((deadline - $(date +%s)))
            [ "$left" -gt 0 ] || return 124
            timeout --signal=TERM "${left}s" gh api --include "$endpoint" >"$envelope" 2>"$tmp/gh.err" || gh_rc=$?
            awk 'BEGIN{h=1} h{gsub("\r",""); if($0==""){h=0;next} print}' "$envelope" >"$headers"
            awk 'BEGIN{h=1} h{gsub("\r",""); if($0==""){h=0;next}} !h{print}' "$envelope" >"$tmp/body"
            code=$(awk 'NR==1 && $1 ~ /^HTTP\// {print $2}' "$headers")
            remaining=$(awk 'tolower($1)=="x-ratelimit-remaining:" {print $2}' "$headers" | tail -1); reset=$(awk 'tolower($1)=="x-ratelimit-reset:" {print $2}' "$headers" | tail -1)
            [[ "$remaining" =~ ^[0-9]+$ ]] || remaining=null; [[ "$reset" =~ ^[0-9]+$ ]] || reset=null
            [ "$gh_rc" -eq 0 ] && [ "$(grep -c '^HTTP/' "$headers")" -eq 1 ] && [[ "$code" =~ ^2[0-9][0-9]$ ]] && jq -e . "$tmp/body" >/dev/null 2>&1 && return 0
            if { [ "$code" = 403 ] || [ "$code" = 429 ]; } && [ "$try" -eq 0 ]; then
                retry=$(awk 'tolower($1)=="retry-after:" {print $2}' "$headers" | tail -1)
                if [[ "$retry" =~ ^[0-9]+$ ]] && [ $(( $(date +%s) + retry )) -lt "$deadline" ]; then sleep "$retry"; try=1; continue; fi
            fi
            return 1
        done
    }

    local repo_numeric_id=""
    if [ "$fatal" = false ]; then
        if _rc_api "repos/$repo" && repo_numeric_id=$(jq -r '.id // empty' "$tmp/body") \
            && [[ "$repo_numeric_id" =~ ^[1-9][0-9]*$ ]]; then
            :
        else
            _rc_fail list "" "" "cannot resolve repository pagination identity"
            fatal=true
        fi
    fi

    local scan_from="$start"
    [ "$mode" = recent ] && scan_from="$since"
    scan_from=$(date -u -d "$scan_from - 900 seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || fatal=true
    local endpoint="repos/$repo/issues/comments?sort=updated&direction=asc&per_page=100&since=$scan_from" next next_lc item issue cid iu ca ua author url bodyf
    : >"$tmp/all"
    : >"$tmp/allow-receipts"
    while [ "$fatal" = false ] && [ -n "$endpoint" ]; do
        _rc_time || { _rc_fail ceiling "" "" "time ceiling reached"; fatal=true; break; }
        _rc_api "$endpoint" || { _rc_fail list "" "" "comment page request failed"; fatal=true; break; }
        pages=$((pages+1)); jq -e 'type=="array"' "$tmp/body" >/dev/null || { _rc_fail list "" "" "page body is not an array"; fatal=true; break; }
        local n; n=$(jq length "$tmp/body"); returned=$((returned+n)); [ "$returned" -le "$max_comments" ] || { _rc_fail ceiling "" "" "comment ceiling reached"; fatal=true; break; }
        jq -c '.[]' "$tmp/body" >>"$tmp/all"
        next=$(awk 'tolower($1)=="link:" {$1=""; print substr($0,2)}' "$tmp/headers" | grep -o '<[^>]*>; rel="next"' | head -1 | sed 's/^<//;s/>; rel="next"$//' || true)
        if [ -n "$next" ]; then
            next_lc=${next,,}
            if [[ "$next_lc" == "https://api.github.com/repos/${repo}/issues/comments?"* \
                || "$next_lc" == "https://api.github.com/repositories/${repo_numeric_id}/issues/comments?"* ]]; then
                endpoint=${next#https://api.github.com/}
            else
                _rc_fail list "" "" "unsafe pagination link"; fatal=true; break
            fi
        else endpoint=""; fi
        [ "$pages" -lt "$max_pages" ] || { [ -z "$endpoint" ] || { _rc_fail ceiling "" "" "page ceiling reached with next page"; fatal=true; }; break; }
    done
    # Explicit historical objects are fetched even when outside the scan.
    local a expected
    for a in "${allows[@]}"; do
        [ "$fatal" = false ] || break
        [[ "$a" =~ ^([1-9][0-9]*):([1-9][0-9]*)$ ]] || { _rc_fail allowlist "" "" "invalid allow-comment: $a"; fatal=true; continue; }
        expected=${BASH_REMATCH[1]}; cid=${BASH_REMATCH[2]}
        if grep -qx "refs/heads/gh/comments/$expected/$cid" "$tmp/receipts"; then
            printf '%s:%s\n' "$expected" "$cid" >>"$tmp/allow-receipts"
            continue
        fi
        _rc_api "repos/$repo/issues/comments/$cid" || { _rc_fail allowlist "$expected" "$cid" "direct comment request failed"; fatal=true; continue; }
        returned=$((returned+1)); if [ "$returned" -gt "$max_comments" ]; then _rc_fail ceiling "$expected" "$cid" "comment ceiling reached"; fatal=true; break; fi
        jq -c --arg expected "$expected" '. + {__allow_issue:$expected}' "$tmp/body" >>"$tmp/all"
    done
    [ "$fatal" = false ] || : >"$tmp/all"
    if ! jq -se 'all(.[]; (.id|type)=="number" and (.id|floor)==.id and .id>0 and (.issue_url|type)=="string" and (.created_at|type)=="string" and (.updated_at|type)=="string" and (.body|type)=="string")' "$tmp/all" >/dev/null 2>&1; then _rc_fail validate "" "" "malformed comment object"; fatal=true; fi
    if ! jq -se 'group_by(.id) | all(.[]; (map({issue_url,created_at})|unique|length)==1)' "$tmp/all" >/dev/null 2>&1; then _rc_fail validate "" "" "conflicting observations for comment id"; fatal=true; fi
    [ "$fatal" = false ] || : >"$tmp/all"
    jq -sc 'map(select((.id|type)=="number" and (.issue_url|type)=="string" and (.created_at|type)=="string" and (.updated_at|type)=="string" and (.body|type)=="string")) | group_by(.id) | map(. as $g | (min_by([.updated_at,tojson])) + (if any($g[]; has("__allow_issue")) then {__allow_issue:($g|map(select(has("__allow_issue"))|.__allow_issue)|first)} else {} end)) | sort_by(.updated_at,.id) | .[]' "$tmp/all" >"$tmp/sorted" 2>/dev/null || { _rc_fail validate "" "" "invalid comment objects"; fatal=true; }
    unique=$(wc -l <"$tmp/sorted")
    declare -A issue_pr=()
    while IFS= read -r item; do
        _rc_time || { _rc_fail ceiling "" "" "time ceiling reached"; fatal=true; break; }
        cid=$(jq -r '.id|tostring' <<<"$item"); iu=$(jq -r .issue_url <<<"$item"); issue=${iu##*/}
        [[ "${iu,,}" == "https://api.github.com/repos/${repo}/issues/${issue}" && "$issue" =~ ^[1-9][0-9]*$ ]] || { _rc_fail validate "$issue" "$cid" "invalid issue_url"; continue; }
        ca=$(jq -r .created_at <<<"$item"); ua=$(jq -r .updated_at <<<"$item")
        if ! _xrepo_valid_timestamp "$ca" || ! _xrepo_valid_timestamp "$ua" || [[ "$ua" < "$ca" ]]; then _rc_fail validate "$issue" "$cid" "invalid comment timestamps"; continue; fi
        expected=$(jq -r '.__allow_issue // empty' <<<"$item"); [ -z "$expected" ] || [ "$expected" = "$issue" ] || { _rc_fail allowlist "$issue" "$cid" "allowlist issue mismatch"; continue; }
        if grep -qx "refs/heads/gh/comments/$issue/$cid" "$tmp/receipts"; then receipted=$((receipted+1)); continue; fi
        if [ -z "$expected" ] && [[ "$(jq -r .created_at <<<"$item")" < "$start" ]]; then pre=$((pre+1)); continue; fi
        if [ -z "${issue_pr[$issue]+x}" ]; then
            if ! _rc_api "repos/$repo/issues/$issue"; then
                issue_pr[$issue]=-1
                _rc_fail issue "$issue" "$cid" "issue request failed"
            elif ! jq -e --argjson issue "$issue" 'type=="object" and .number==$issue and (.title|type)=="string" and (.html_url|type)=="string" and (.user.login|type)=="string" and ((.body|type)=="string" or .body==null) and ((has("pull_request")|not) or (.pull_request|type)=="object")' "$tmp/body" >/dev/null; then
                issue_pr[$issue]=-1
                _rc_fail issue "$issue" "$cid" "malformed issue metadata"
            elif jq -e 'has("pull_request")' "$tmp/body" >/dev/null; then
                issue_pr[$issue]=1
            else
                issue_pr[$issue]=0
            fi
            [ "${issue_pr[$issue]}" = -1 ] || cp "$tmp/body" "$tmp/issue-${issue}.json"
        fi
        [ "${issue_pr[$issue]}" != -1 ] || continue
        if [ "${issue_pr[$issue]}" = 1 ]; then prs=$((prs+1)); continue; fi
        eligible=$((eligible+1)); missing=$((missing+1))
        bodyf="$tmp/body-$cid"; jq -rj .body <<<"$item" >"$bodyf"
        local classified
        if ! classified="$(_xrepo_classify_comment_body "$repo" "$issue" "$bodyf")"; then _rc_fail classify "$issue" "$cid" "invalid completion target"; continue; fi
        case "${classified%%$'\x1f'*}" in
            completion) completion=$((completion+1)); printf '%s\n' "$issue" >>"$tmp/converge-issues" ;;
            machine-skip) machine=$((machine+1)) ;;
            human) human=$((human+1)) ;;
        esac
        if [ "$dry" = true ]; then deferred=$((deferred+1)); continue; fi
        if [ "$attempted" -ge "$max_apply" ]; then deferred=$((deferred+1)); continue; fi
        attempted=$((attempted+1)); ca=$(jq -r .created_at <<<"$item"); ua=$(jq -r .updated_at <<<"$item"); author=$(jq -r '.user.login // "unknown"' <<<"$item"); url=$(jq -r .html_url <<<"$item")
        if ISSUE_TITLE="$(jq -r .title "$tmp/issue-${issue}.json")" \
            ISSUE_AUTHOR="$(jq -r .user.login "$tmp/issue-${issue}.json")" \
            ISSUE_URL="$(jq -r .html_url "$tmp/issue-${issue}.json")" \
            ISSUE_BODY="$(jq -r '.body // ""' "$tmp/issue-${issue}.json")" \
            _XREPO_SNAPSHOT_ABSENT=true _XREPO_DEFER_CONVERGENCE=true \
            _xrepo_ingest_observed_comment "$issue" "$cid" "$ca" "$ua" "$author" "$url" "$bodyf"; then
            applied=$((applied+1))
        else
            _rc_fail ingest "$issue" "$cid" "atomic ingestion failed"
        fi
    done <"$tmp/sorted"
    while IFS=: read -r issue cid; do
        [ -n "$issue" ] || continue
        if ! jq -e --argjson id "$cid" 'select(.id == $id)' "$tmp/sorted" >/dev/null 2>&1; then
            receipted=$((receipted+1))
            unique=$((unique+1))
        fi
    done < <(LC_ALL=C sort -u "$tmp/allow-receipts")
    # Refresh each issue independently immediately before deciding to close.
    # Delegations live outside master, so the initial run snapshot is not
    # sufficient authority for a close several minutes later.
    _rc_fresh_issue_status() {
        local ci="$1" dir="$tmp/converge-${ci}.git" manifest="$tmp/converge-${ci}.manifest" fetched="$tmp/converge-${ci}.fetched"
        local advertised
        rm -rf "$dir"
        advertised=$(git ls-remote --refs origin \
            "refs/heads/tasks/delegated/${ci}/*" "refs/heads/tasks/delegated-close/v1/${ci}/*") || return 2
        _xrepo_write_sorted_listing "$advertised" "$manifest"
        git init -q --bare "$dir" && git --git-dir="$dir" remote add origin "$(git remote get-url origin)" || return 2
        if [ -s "$manifest" ]; then
            git --git-dir="$dir" fetch -q --no-tags origin \
                "+refs/heads/tasks/delegated/${ci}/*:refs/heads/tasks/delegated/${ci}/*" \
                "+refs/heads/tasks/delegated-close/v1/${ci}/*:refs/heads/tasks/delegated-close/v1/${ci}/*" || return 2
        fi
        git --git-dir="$dir" for-each-ref --format='%(objectname)%09%(refname)' \
            "refs/heads/tasks/delegated/${ci}/" "refs/heads/tasks/delegated-close/v1/${ci}/" | LC_ALL=C sort >"$fetched"
        cmp -s "$manifest" "$fetched" || return 2
        _xrepo_strict_snapshot_status "$dir" "$repo" "$ci"
    }
    if [ "$dry" = false ] && [ "$fatal" = false ]; then
        while IFS= read -r issue; do
            [ -n "$issue" ] || continue
            _rc_time || { _rc_fail convergence "$issue" "" "time ceiling reached"; fatal=true; break; }
            if ! _xrepo_reconcile_issue_delegated_closes "$issue"; then
                _rc_fail convergence "$issue" "" "delegated-close reconciliation failed"
                continue
            fi
            local strict_status
            if ! strict_status=$(_rc_fresh_issue_status "$issue"); then
                _rc_fail convergence "$issue" "" "cannot obtain a valid fresh delegation/completion snapshot"
                continue
            fi
            [ "$strict_status" = ready ] || continue
            local root
            root=$(_xrepo_ensure_issue_epic "$issue") || { _rc_fail convergence "$issue" "" "cannot resolve epic root"; continue; }
            if ! _xrepo_watchdog_fence; then _rc_fail convergence "$issue" "" "watchdog lease lost"; fatal=true; break; fi
            if ! _XREPO_STRICT_SNAPSHOT_GIT_DIR="$tmp/converge-${issue}.git" \
                taskdag_emit_origin_epic_close "$issue" "$root" >"$tmp/close-${issue}.out"; then
                _rc_fail convergence "$issue" "" "strict epic close failed"
            fi
        done < <(LC_ALL=C sort -nu "$tmp/converge-issues")
    fi
    now=$(date +%s); local status=success exhausted=true
    if [ "$fatal" = true ] || [ "$failures" -gt 0 ]; then status=failed; exhausted=false
    elif [ "$dry" = false ] && [ "$deferred" -gt 0 ]; then status=partial; exhausted=false
    fi
    local failure_json='[]'; [ -s "$failure_file" ] && failure_json=$(jq -s . "$failure_file")
    local recent_at=null complete_at=null stamp
    if [ "$status" = success ] && [ "$dry" = false ] && [ "$exhausted" = true ]; then stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ); [ "$mode" = recent ] && recent_at="\"$stamp\"" || complete_at="\"$stamp\""; fi
    jq -nc --arg mode "$mode" --arg status "$status" --argjson dry_run "$dry" --argjson exhausted "$exhausted" --argjson requests "$requests" --argjson pages "$pages" --argjson returned "$returned" --argjson unique "$unique" --argjson eligible "$eligible" --argjson prs "$prs" --argjson pre "$pre" --argjson receipts "$receipted" --argjson missing "$missing" --argjson human "$human" --argjson completion "$completion" --argjson machine "$machine" --argjson attempted "$attempted" --argjson applied "$applied" --argjson deferred "$deferred" --argjson failures "$failures" --argjson items "$failure_json" --argjson duration "$((now-began))" --argjson remaining "$remaining" --argjson reset "$reset" --argjson recent "$recent_at" --argjson complete "$complete_at" '{schema_version:1,mode:$mode,status:$status,dry_run:$dry_run,exhausted:$exhausted,requests:$requests,pages:$pages,returned:$returned,unique:$unique,eligible:$eligible,pull_requests:$prs,pre_boundary:$pre,already_receipted:$receipts,missing:$missing,dispositions:{human:$human,completion:$completion,machine_skip:$machine},attempted:$attempted,applied:$applied,deferred:$deferred,failures:$failures,failure_items:$items,duration_seconds:$duration,rate_limit:{remaining:$remaining,reset:$reset},recent_success_at:$recent,complete_success_at:$complete}'
    rm -rf "$tmp"
    [ "$status" = success ]
}

cmd_reconcile_comments() {
    if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then
        _xrepo_reconcile_comments_impl "$@"
        return
    fi
    if ! command -v jq >/dev/null 2>&1; then
        printf '%s\n' '{"schema_version":1,"mode":null,"status":"failed","dry_run":false,"exhausted":false,"requests":0,"pages":0,"returned":0,"unique":0,"eligible":0,"pull_requests":0,"pre_boundary":0,"already_receipted":0,"missing":0,"dispositions":{"human":0,"completion":0,"machine_skip":0},"attempted":0,"applied":0,"deferred":0,"failures":1,"failure_items":[{"stage":"dependencies","issue":null,"comment_id":null,"message":"required command not found: jq"}],"duration_seconds":0,"rate_limit":{"remaining":null,"reset":null},"recent_success_at":null,"complete_success_at":null}'
        return 2
    fi
    local output rc=0
    output=$(mktemp)
    _xrepo_reconcile_comments_impl "$@" >"$output" || rc=$?
    if [ "$(jq -s 'length' "$output" 2>/dev/null || printf 0)" = 1 ]; then
        cat "$output"
    else
        _xrepo_reconcile_argument_failure "" "reconciliation terminated before metrics finalization"
        [ "$rc" -ne 0 ] || rc=2
    fi
    rm -f "$output"
    return "$rc"
}

# ─────────────────────────────────────────────────────────────────────
# cmd_close_epic — emit the additive close commit on master
# ─────────────────────────────────────────────────────────────────────

cmd_close_epic() {
    local top_issue=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --issue) top_issue="$2"; shift 2 ;;
            *) _xrepo_die "close-epic: unknown arg: $1"; return 2 ;;
        esac
    done
    [ -n "$top_issue" ] || { _xrepo_die "close-epic: --issue is required"; return 2; }
    [[ "$top_issue" =~ ^[1-9][0-9]*$ ]] || { _xrepo_die "close-epic: --issue must be a positive integer"; return 2; }

    taskdag_migration_guard epic-close || return $?

    _xrepo_ensure_git_identity

    local pending_ref="refs/heads/tasks/pending/${top_issue}"
    local gh_issue_ref="refs/heads/gh/issues/${top_issue}"

    # Refresh the durable close facts before consulting the live pending ref.
    # close-completed-issues legitimately retires tasks/pending/<N> after a
    # close, while gh/issues/<N> remains as the immutable structural identity.
    # A late delegated completion must therefore observe the existing close
    # and succeed without recreating the retired dispatch root.
    git fetch --quiet --no-tags origin \
        '+refs/heads/master:refs/remotes/origin/master' >/dev/null 2>&1 || {
        _xrepo_die "close-epic: cannot sync origin/master to check durable close facts"
        return 2
    }

    local gh_epic_sha="" pending_epic_sha="" gh_rc=0 pending_rc=0 epic_sha=""
    gh_epic_sha="$(remote_ref_sha_checked "$gh_issue_ref")" || gh_rc=$?
    pending_epic_sha="$(remote_ref_sha_checked "$pending_ref")" || pending_rc=$?
    if [ "$gh_rc" -eq 3 ] || [ "$pending_rc" -eq 3 ]; then
        _xrepo_die "close-epic: cannot read epic #${top_issue} identity refs on origin (indeterminate transport/auth)"
        return 2
    fi
    if [ -n "$gh_epic_sha" ] && [ -n "$pending_epic_sha" ] \
        && [ "$gh_epic_sha" != "$pending_epic_sha" ]; then
        _xrepo_die "close-epic: ${gh_issue_ref} and ${pending_ref} disagree; refusing to choose an epic identity"
        return 2
    fi
    epic_sha="${gh_epic_sha:-$pending_epic_sha}"
    [ -n "$epic_sha" ] || {
        _xrepo_die "close-epic: no durable epic identity ${gh_issue_ref} or live root ${pending_ref}"
        return 2
    }

    # Idempotency requires the exact root-parent + Closes-Epic trailer pair,
    # not a trailer-only match or ordinary completion merge parentage.
    if epic_already_closed_on "$top_issue" "$epic_sha" "origin/master"; then
        _xrepo_log "close-epic: epic ${top_issue} already closed on master"
        return 0
    fi

    # No durable close exists, so creating one still requires the authoritative
    # live pending root. gh/issues preserves identity but is never permission to
    # resurrect or operate on a retired root.
    [ -n "$pending_epic_sha" ] || {
        _xrepo_die "close-epic: no live epic root ${pending_ref} on origin"
        return 2
    }
    epic_sha="$pending_epic_sha"
    git fetch --quiet origin \
        "+${pending_ref}:${pending_ref}" >/dev/null 2>&1 || {
        _xrepo_die "close-epic: cannot fetch live epic root ${pending_ref}"
        return 2
    }

    # Enumerate delegated children and confirm each has at least one completion.
    # Reconciliation supplies a freshly advertised, isolated snapshot so a
    # delegation created during a long scan cannot be missed at close time.
    if [ -n "${_XREPO_STRICT_SNAPSHOT_GIT_DIR:-}" ]; then
        local strict_status
        strict_status=$(_xrepo_strict_snapshot_status "$_XREPO_STRICT_SNAPSHOT_GIT_DIR" \
            "$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]')" "$top_issue") || {
            _xrepo_die "close-epic: strict delegation/completion snapshot is invalid"
            return 2
        }
        [ "$strict_status" = ready ] || {
            _xrepo_die "close-epic: epic ${top_issue} is still waiting in the strict snapshot"
            return 3
        }
    else
        git fetch --prune origin \
            "+refs/heads/tasks/delegated/${top_issue}/*:refs/heads/tasks/delegated/${top_issue}/*" \
            "+refs/heads/tasks/delegated-close/v1/${top_issue}/*:refs/heads/tasks/delegated-close/v1/${top_issue}/*" \
            >/dev/null 2>&1 || {
                _xrepo_die "close-epic: cannot refresh strict delegated-close authority"
                return 2
            }

        local missing=()
        local any_delegated="false"

        while read -r refname; do
            any_delegated="true"
            local rest="${refname#refs/heads/tasks/delegated/${top_issue}/}"
            if ! _xrepo_child_satisfied "$top_issue" "$rest"; then
                local owner repo peer trail
                owner="${rest%%/*}"
                trail="${rest#*/}"
                repo="${trail%%/*}"
                peer="${trail#*/}"
                missing+=("${owner}/${repo}#${peer}")
            fi
        done < <(git for-each-ref --format='%(refname)' \
            "refs/heads/tasks/delegated/${top_issue}/" 2>/dev/null)

        if [ "$any_delegated" = "false" ]; then
            _xrepo_die "close-epic: epic ${top_issue} has no delegated children to gate close on"
            return 3
        fi

        if [ ${#missing[@]} -ne 0 ]; then
            _xrepo_die "close-epic: epic ${top_issue} still waiting on $(IFS=,; echo "${missing[*]}")"
            return 3
        fi
    fi

    echo "all delegated children satisfied for $(_xrepo_current_repo)#${top_issue}"

    # Build the additive close commit:
    #   tree    = current master tip's tree (no diff)
    #   parent1 = current master tip
    #   parent2 = epic SHA
    # That mirrors what `scripts/task-dag complete` does for ordinary
    # tasks, which is what close-completed-issues.yml expects to see.
    git fetch --quiet --no-tags origin \
        '+refs/heads/master:refs/remotes/origin/master' >/dev/null 2>&1 || {
        _xrepo_die "close-epic: cannot refresh origin/master before close"
        return 2
    }
    local master_tip master_tree
    master_tip="$(git rev-parse --verify origin/master)" || return 2

    # A concurrent closer may have landed since the initial idempotency check.
    # Re-check the exact tip we will parent on: if the close landed before this
    # fetch, observe it here; if it lands after, our push rejects non-FF and a
    # retry observes it. Either case prevents duplicate close facts.
    if epic_already_closed_on "$top_issue" "$epic_sha" "$master_tip"; then
        _xrepo_log "close-epic: epic ${top_issue} already closed on master (concurrent close)"
        return 0
    fi

    if ! taskdag_materialisation_intents_durable "$top_issue" "$epic_sha" "$master_tip"; then
        _xrepo_die "close-epic: child-epic materialisation intent for #${top_issue} is not durably delegated yet"
        return 3
    fi
    master_tree="$(git rev-parse "${master_tip}^{tree}")"

    local close_msg_file
    close_msg_file="$(mktemp)"
    {
        printf 'Close epic for %s#%s (all delegated children satisfied)\n' \
            "$(_xrepo_current_repo)" "$top_issue"
        printf '\n'
        printf 'This commit is intentionally tree-equal to its first parent.\n'
        printf 'It records the epic SHA as a second parent so that the\n'
        printf 'existing close-completed-issues.yml workflow finds it and\n'
        printf 'closes issue #%s with the canonical "completed in <commit>"\n' "$top_issue"
        printf 'comment.\n'
        printf '\n'
        # Explicit close signal consumed by .github/scripts/close-completed-issues.sh.
        # Without this trailer, that workflow will NOT close the issue or delete
        # the tasks/pending/<N> ref, even though the parent-ref structure matches.
        # See docs/task_dag/EPIC_CLOSURE.md.
        printf 'Closes-Epic: #%s\n' "$top_issue"
    } > "$close_msg_file"

    local close_sha
    close_sha="$(git commit-tree "$master_tree" -p "$master_tip" -p "$epic_sha" -F "$close_msg_file")"
    rm -f "$close_msg_file"

    echo "created close commit ${close_sha}"
    git update-ref refs/heads/master "$close_sha"
    cmd_publish "$close_sha"
    echo "pushed master"
}

# ─────────────────────────────────────────────────────────────────────
# cmd_close_ops_epic — close a single-repo, ops-only (no-code) epic
# ─────────────────────────────────────────────────────────────────────
#
# The sanctioned closure path for an epic whose resolution is an
# out-of-band OPERATIONS action (reboot a host, flip a manual switch, run a
# one-off maintenance task): there is NO implementation commit to link and
# NO cross-repo delegated children, so neither `complete` (needs a real
# implementation commit; refuses to complete a root) nor `close-epic`
# (gates entirely on delegated children) can express it. Before this
# command the only remaining path was a hand-authored `Closes-Epic:` merge
# — exactly the ref surgery docs/INVARIANTS.md forbids.
#
# It emits the SAME closure signal the tooling already relies on — a
# tree-equal merge on master whose non-primary parent is the epic's
# tasks/pending/<N> commit and whose message carries the `Closes-Epic: #<N>`
# trailer — constructed BY THE TOOL (no hand ref surgery), then pushes it
# directly to origin/master (mirroring `close-epic`), so
# close-completed-issues.yml closes the issue and cleans up
# tasks/pending/<N> + any blocked/frontier overlay refs.
#
# It mints NO new ref namespace and NO new trailer: its only artifact is
# the documented "Close" merge shape on master, so it needs no addition to
# TASKDAG_KNOWN_*_NS and stays within the invariant floor.
#
# GUARD RAILS (all fail CLOSED — refuse rather than risk a premature close):
#   * confirm the pending-root identity on ORIGIN (origin unreachable →
#     refuse), mirroring `complete`'s root guard;
#   * refuse if the epic has ANY DAG child tasks — decomposed children,
#     live frontier/active/blocked leaves, or ingested-comment tasks (every
#     such leaf is a DAG child of the root, so "no children" ⇒ no live work);
#   * refuse if the epic has cross-repo delegated children (that is
#     `close-epic`'s job);
#   * refuse if the epic ROOT itself is blocked (unblock it first);
#   * refuse if a FOREIGN, still-live root-decompose lock
#     (tasks/root-active/<N>) is held by another worker;
#   * a non-interactive caller MUST pass --yes (explicit confirmation).
# It is idempotent and race/stale-tip safe: a re-run after the close merge
# has landed (even after close-completed-issues.yml deleted the pending
# ref) is a no-op success; a concurrent master advance turns the push into
# a non-fast-forward rejection that a re-run converges from.

# Helper for the post-close case where pending/<N> is gone. The durable
# gh/issues/<N> identity remains available, so this still delegates to the
# exact root-parent + parsed-trailer close predicate rather than accepting a
# trailer-only historical match.
_ops_epic_closed_trailer_on() {
    local issue="$1" base_ref="$2" root_ref="refs/heads/gh/issues/${issue}" root rc=0
    root=$(remote_ref_sha_checked "$root_ref") || rc=$?
    case "$rc" in 0) ;; 2) return 1 ;; *) return 2 ;; esac
    git fetch --quiet origin "+${root_ref}:${root_ref}" >/dev/null 2>&1 || return 2
    [ "$(git rev-parse -q --verify "${root_ref}^{commit}" 2>/dev/null || true)" = "$root" ] || return 2
    taskdag_issue_closed_at_tip "$base_ref" "$issue" "$root"
}

cmd_close_ops_epic() {
    local top_issue="" assume_yes=false reason=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --issue) top_issue="$2"; shift 2 ;;
            --issue=*) top_issue="${1#*=}"; shift ;;
            --yes|-y) assume_yes=true; shift ;;
            --reason) reason="$2"; shift 2 ;;
            --reason=*) reason="${1#*=}"; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag close-ops-epic --issue N [--yes] [--reason "..."]

Close a single-repo, OPS-ONLY (no-code) epic: one whose resolution is an
out-of-band operations action (reboot a host, flip a switch, a one-off
maintenance task) with NO implementation commit to link and NO cross-repo
delegated children. Neither `complete` (needs a real implementation commit)
nor `close-epic` (gates on delegated children) can close such an epic.

This emits the sanctioned tree-equal `Closes-Epic: #N` merge on master
(constructed by the tool, never hand-rolled) and pushes it to origin/master,
so close-completed-issues.yml closes the issue and cleans up its refs.

Guard rails (all fail closed): confirms the pending root on origin; refuses
if the epic has any DAG child tasks (decomposed / live frontier/active/
blocked leaves / ingested-comment tasks), any cross-repo delegated children
(use `close-epic`), a blocked root (unblock first), or a foreign live
root-decompose lock. Idempotent: a re-run after the close landed is a no-op.

Options:
  --issue N        the epic issue number (required)
  --yes, -y        confirm non-interactively (required for non-TTY callers)
  --reason "..."   free-text audit note recorded in the close-merge body
EOF
                return 0
                ;;
            *) _xrepo_die "close-ops-epic: unknown arg: $1"; return 2 ;;
        esac
    done
    [ -n "$top_issue" ] || { _xrepo_die "close-ops-epic: --issue is required"; return 2; }
    case "$top_issue" in
        ''|*[!0-9]*) _xrepo_die "close-ops-epic: --issue must be a number"; return 2 ;;
    esac

    taskdag_migration_guard epic-close || return $?

    _xrepo_ensure_git_identity

    local repo_slug
    repo_slug="$(_xrepo_current_repo)"

    # ── 1. Confirm pending-root identity on ORIGIN (authoritative) ──────
    local epic_sha rc=0
    epic_sha=$(pending_sha_on_remote_checked "$top_issue") || rc=$?
    if [ "$rc" = 3 ]; then
        _xrepo_die "close-ops-epic: cannot reach origin to confirm epic #${top_issue} root (indeterminate transport/auth); refusing (fail-closed). Retry when origin is reachable."
        return 2
    fi
    # Refresh origin/master for the idempotency scans below.
    git fetch --quiet origin '+refs/heads/master:refs/remotes/origin/master' >/dev/null 2>&1 || true
    local master_ref="master"
    git rev-parse --verify -q origin/master >/dev/null 2>&1 && master_ref="origin/master"

    if [ "$rc" = 2 ]; then
        # Pending ref absent on origin: either it never existed, OR the epic
        # was already closed (close-completed-issues.yml deletes pending/<N>
        # after our close merge lands). Distinguish via a trailer-only scan
        # of master — we no longer have the epic SHA for a parent check.
        if _ops_epic_closed_trailer_on "$top_issue" "$master_ref"; then
            _xrepo_log "close-ops-epic: epic #${top_issue} already closed on ${master_ref} (pending ref gone); nothing to do."
            return 0
        fi
        _xrepo_die "close-ops-epic: no epic root tasks/pending/${top_issue} on origin (nothing to close)."
        return 2
    fi
    [ -n "$epic_sha" ] || { _xrepo_die "close-ops-epic: could not resolve epic #${top_issue} root SHA on origin."; return 2; }

    # Mirror the pending ref locally so we can inspect the root commit
    # (blocked overlay / children reasoning below reads local refs).
    git fetch --quiet origin \
        "+refs/heads/tasks/pending/${top_issue}:refs/heads/tasks/pending/${top_issue}" \
        >/dev/null 2>&1 || true

    # ── 2. Idempotency: already closed on master (epic-as-parent + trailer)? ──
    # Cheap idempotency short-circuit BEFORE the confirmation prompt so a
    # re-run of an already-closed epic is a silent no-op (never prompts).
    if epic_already_closed_on "$top_issue" "$epic_sha" "$master_ref"; then
        _xrepo_log "close-ops-epic: epic #${top_issue} already closed on ${master_ref}; nothing to do."
        return 0
    fi

    # ── 3. Explicit confirmation ────────────────────────────────────────
    # Confirm BEFORE the substantive guards (children / delegated / blocked /
    # root-lock) so those guards are evaluated AFTER confirmation, right
    # before the push — an interactive prompt can sit for a long time, and we
    # must not close on state that went stale during the wait. With --yes
    # (the CI/worker path) this is a no-op.
    if [ "$assume_yes" != true ]; then
        if [ -t 0 ] && [ -t 1 ]; then
            printf 'Close ops-only epic %s#%s (no implementation commit, no children)? [y/N] ' \
                "$repo_slug" "$top_issue"
            local ans=""
            read -r ans
            case "$ans" in
                y|Y|yes|YES|Yes) ;;
                *) _xrepo_die "close-ops-epic: aborted (no confirmation)."; return 1 ;;
            esac
        else
            _xrepo_die "close-ops-epic: non-interactive caller must pass --yes to confirm closing epic #${top_issue}."
            return 2
        fi
    fi

    # ── 4. Sync the full task-ref namespace (fail closed) ───────────────
    # Needed so the child / blocked-root / lock checks below see origin
    # state, not a partial local view. A non-zero rc means "could not read
    # origin", which for a close decision MUST refuse, not fall through.
    if ! fetch_root_refs "$top_issue"; then
        _xrepo_die "close-ops-epic: cannot reach origin to verify epic #${top_issue} state (child/lock refs); refusing (fail-closed). Retry when online."
        return 2
    fi

    # ── 5. Refuse cross-repo delegated epics → use close-epic ───────────
    # epic_has_delegated_children fails closed (treats an indeterminate
    # origin as "has delegated children"), so this also covers an
    # unreadable origin for the delegated dimension.
    if epic_has_delegated_children "$top_issue"; then
        _xrepo_die "close-ops-epic: epic #${top_issue} has cross-repo delegated children (or origin is unreadable); use 'task-dag close-epic --issue ${top_issue}', which gates on their completion."
        return 3
    fi

    # ── 6. Refuse if the epic has ANY DAG child tasks ───────────────────
    if task_has_children "$epic_sha" >/dev/null; then
        _xrepo_die "close-ops-epic: epic #${top_issue} has DAG child tasks (decomposition, live frontier/active/blocked leaves, or ingested-comment tasks). Handle/complete/drop them, or close via the normal leaf-completion path. close-ops-epic is only for an UNdecomposed, ops-only epic."
        return 3
    fi

    # ── 7. Refuse a blocked epic ROOT ───────────────────────────────────
    if is_task_blocked "$epic_sha"; then
        local breason
        breason=$(read_blocked_meta_field "$epic_sha" "Reason")
        _xrepo_die "close-ops-epic: epic #${top_issue} root is BLOCKED${breason:+ (reason: ${breason})}. Unblock it first: task-dag unblock ${epic_sha}."
        return 3
    fi

    # ── 8. Refuse a FOREIGN, still-live root-decompose lock ─────────────
    # A concurrent lock-holder on another host may be decomposing this epic
    # right now; closing under it would prune the leaves they are about to
    # publish. Ours (dispatcher pre-claim) or provably-dead → proceed.
    local ra_sha ra_rc=0
    ra_sha=$(remote_ref_sha_checked "refs/heads/tasks/root-active/${top_issue}") || ra_rc=$?
    if [ "$ra_rc" = 3 ]; then
        _xrepo_die "close-ops-epic: cannot read tasks/root-active/${top_issue} on origin (indeterminate); refusing (fail-closed)."
        return 2
    fi
    if [ "$ra_rc" = 0 ] && [ -n "$ra_sha" ]; then
        git fetch --quiet origin \
            "+refs/heads/tasks/root-active/${top_issue}:refs/heads/tasks/root-active/${top_issue}" \
            >/dev/null 2>&1 || true
        local rmsg rclaimer rhost me_claimer me_host
        rmsg=$(parse_commit_metadata "$ra_sha" 2>/dev/null || true)
        rclaimer=$(extract_field "$rmsg" "Claimer" 2>/dev/null || true)
        rhost=$(extract_field "$rmsg" "Claimer-Host" 2>/dev/null || true)
        me_claimer="${TASK_DAG_CLAIMER:-${USER:-unknown}}"
        me_host="${TASK_DAG_CLAIMER_HOST:-$(hostname -s 2>/dev/null || echo unknown)}"
        if [ "$rclaimer" = "$me_claimer" ] && [ "$rhost" = "$me_host" ]; then
            : # our own lock (dispatcher pre-claim / same worker) → proceed
        elif claim_is_dead "$ra_sha"; then
            _xrepo_log "close-ops-epic: root lock for #${top_issue} held by ${rclaimer:-?}@${rhost:-?} is provably dead (${claim_dead_reason}); proceeding."
        else
            _xrepo_die "close-ops-epic: epic #${top_issue} has a LIVE root-decompose lock held by ${rclaimer:-?}@${rhost:-?} (not you: ${me_claimer}@${me_host}). Refusing to close while decomposition may be in progress."
            return 3
        fi
    fi

    # ── 9. Build the sanctioned tree-equal Closes-Epic merge and push ───
    # Same shape as close-epic:
    #   tree    = current origin/master tip's tree (no diff)
    #   parent1 = current origin/master tip
    #   parent2 = epic SHA (tasks/pending/<N>)
    # Push the OBJECT directly to origin/master; we do NOT mutate local
    # master (that could leave a checked-out worktree in a phantom-dirty
    # state).
    git fetch --quiet origin '+refs/heads/master:refs/remotes/origin/master' >/dev/null 2>&1 || true
    local master_tip master_tree
    master_tip="$(git rev-parse --verify origin/master 2>/dev/null || git rev-parse --verify master)"

    # Re-check idempotency against the EXACT tip we are about to parent on.
    # This closes a TOCTOU duplicate-close race: a concurrent close of the
    # same epic that landed since the step-2 check is now an ancestor of
    # master_tip and is caught here; any close that lands AFTER this fetch
    # makes our push a non-fast-forward rejection that a re-run converges
    # from. Together those two cases guarantee at most one close merge.
    if epic_already_closed_on "$top_issue" "$epic_sha" "$master_tip"; then
        _xrepo_log "close-ops-epic: epic #${top_issue} already closed on master (concurrent close); nothing to do."
        return 0
    fi

    if ! taskdag_materialisation_intents_durable "$top_issue" "$epic_sha" "$master_tip"; then
        _xrepo_die "close-ops-epic: child-epic materialisation intent for #${top_issue} is not durably delegated; refusing to close."
        return 3
    fi

    master_tree="$(git rev-parse "${master_tip}^{tree}")"

    local close_msg_file
    close_msg_file="$(mktemp)"
    {
        printf 'Close ops-only epic for %s#%s (no code change)\n' "$repo_slug" "$top_issue"
        printf '\n'
        printf 'This epic was resolved by an out-of-band operations action, with no\n'
        printf 'implementation commit to link and no cross-repo delegated children.\n'
        printf 'This commit is intentionally tree-equal to its first parent; it records\n'
        printf 'the epic SHA as a second parent so that close-completed-issues.yml finds\n'
        printf 'it and closes issue #%s with the canonical "completed in <commit>"\n' "$top_issue"
        printf 'comment, then cleans up tasks/pending/%s.\n' "$top_issue"
        if [ -n "$reason" ]; then
            printf '\n'
            printf 'Reason: %s\n' "$(printf '%s' "$reason" | tr '\n' ' ')"
        fi
        printf '\n'
        # Explicit close signal consumed by .github/scripts/close-completed-issues.sh.
        # Without this trailer that workflow will NOT close the issue or delete
        # tasks/pending/<N>, even though the parent-ref structure matches.
        # See docs/task_dag/EPIC_CLOSURE.md.
        printf 'Closes-Epic: #%s\n' "$top_issue"
    } > "$close_msg_file"

    local close_sha
    close_sha="$(git commit-tree "$master_tree" -p "$master_tip" -p "$epic_sha" -F "$close_msg_file")"
    rm -f "$close_msg_file"

    echo "created close commit ${close_sha}"
    cmd_publish "$close_sha"
    echo "pushed master — issue #${top_issue} will close via close-completed-issues.yml"
}

# ─────────────────────────────────────────────────────────────────────
# cmd_close_completed_epic — close a completed decomposed local epic
# ─────────────────────────────────────────────────────────────────────
#
# This is the sanctioned repair/last-cell path for an epic that WAS
# decomposed into local DAG children, where all still-relevant child work is
# already durably complete (or was explicitly dropped as no-longer relevant),
# but no final-child completion emitted the normal `Closes-Epic:` merge. It
# exists for states like top-level#59: useful rollout was recorded, child
# refs had converged away or completed, `validate --strict` was clean, but
# `close-epic` refused because there were no delegated children and
# `close-ops-epic` correctly refused because the root was decomposed.
#
# It emits the SAME tree-equal close merge as every other closer, but only
# after proving from origin that:
#   * tasks/pending/<N> exists and matches a decomposed root;
#   * there are no delegated children (those belong to close-epic);
#   * the local DAG subtree is complete as seen from origin/master;
#   * no frontier/active/blocked descendant remains live;
#   * the root itself is not blocked and no foreign live root lock exists;
#   * the caller supplies --reason so the close merge records why this epic is
#     safe to close (rollout/done evidence or the approved exception).

_epic_subtree_complete_at_commit() {
    local tip="$1" node="$2" cur
    taskdag_recon_prepare --no-fetch || return 2
    taskdag_load_facts "$tip" || return 2
    cur=$(taskdag_current_repo) || return 2
    taskdag_node_complete "task:${cur}@${node}"
}

_epic_first_incomplete_leaf_at_commit() {
    local tip="$1" node="$2" child had_child=false found=""
    while IFS= read -r child; do
        [ -z "$child" ] && continue
        had_child=true
        found="$(_epic_first_incomplete_leaf_at_commit "$tip" "$child")"
        if [ -n "$found" ]; then
            printf '%s\n' "$found"
            return 0
        fi
    done < <(list_dag_children "$node")
    if [ "$had_child" = false ] && ! task_is_completed_at_commit "$tip" "$node"; then
        printf '%s\n' "$node"
    fi
    return 0
}

cmd_close_completed_epic() {
    local top_issue="" assume_yes=false reason=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --issue) top_issue="$2"; shift 2 ;;
            --issue=*) top_issue="${1#*=}"; shift ;;
            --yes|-y) assume_yes=true; shift ;;
            --reason) reason="$2"; shift 2 ;;
            --reason=*) reason="${1#*=}"; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag close-completed-epic --issue N --reason "..." [--yes]

Close a DECOMPOSED, single-repo epic whose local DAG subtree is already fully
complete (or irrelevant children were explicitly dropped), with no live
frontier/active/blocked work and no delegated children. This is the sanctioned
path for a completed decomposed epic that still lacks the normal
tree-equal `Closes-Epic: #N` merge.

Guard rails (all fail closed): confirms the pending root on origin; requires
the root to be decomposed; refuses delegated children (use close-epic), any
incomplete/live descendant, a blocked root, a foreign live root-decompose lock,
or unreachable origin; requires --reason as an audit note; non-TTY callers must
pass --yes. Idempotent: a re-run after the close landed is a no-op.
EOF
                return 0
                ;;
            *) _xrepo_die "close-completed-epic: unknown arg: $1"; return 2 ;;
        esac
    done
    [ -n "$top_issue" ] || { _xrepo_die "close-completed-epic: --issue is required"; return 2; }
    case "$top_issue" in
        ''|*[!0-9]*) _xrepo_die "close-completed-epic: --issue must be a number"; return 2 ;;
    esac
    [ -n "$reason" ] || { _xrepo_die "close-completed-epic: --reason is required to record rollout/done evidence or an approved exception."; return 2; }
    validate_ops_trailer_value "--reason" "$reason" || return 2

    taskdag_migration_guard epic-close || return $?

    _xrepo_ensure_git_identity

    local repo_slug
    repo_slug="$(_xrepo_current_repo)"

    local epic_sha rc=0
    epic_sha=$(pending_sha_on_remote_checked "$top_issue") || rc=$?
    if [ "$rc" = 3 ]; then
        _xrepo_die "close-completed-epic: cannot reach origin to confirm epic #${top_issue} root (indeterminate transport/auth); refusing (fail-closed). Retry when origin is reachable."
        return 2
    fi
    git fetch --quiet origin '+refs/heads/master:refs/remotes/origin/master' >/dev/null 2>&1 || true
    local master_ref="master"
    git rev-parse --verify -q origin/master >/dev/null 2>&1 && master_ref="origin/master"

    if [ "$rc" = 2 ]; then
        if _ops_epic_closed_trailer_on "$top_issue" "$master_ref"; then
            _xrepo_log "close-completed-epic: epic #${top_issue} already closed on ${master_ref} (pending ref gone); nothing to do."
            return 0
        fi
        _xrepo_die "close-completed-epic: no epic root tasks/pending/${top_issue} on origin (nothing to close)."
        return 2
    fi
    [ -n "$epic_sha" ] || { _xrepo_die "close-completed-epic: could not resolve epic #${top_issue} root SHA on origin."; return 2; }

    git fetch --quiet origin \
        "+refs/heads/tasks/pending/${top_issue}:refs/heads/tasks/pending/${top_issue}" \
        >/dev/null 2>&1 || true

    if epic_already_closed_on "$top_issue" "$epic_sha" "$master_ref"; then
        _xrepo_log "close-completed-epic: epic #${top_issue} already closed on ${master_ref}; nothing to do."
        return 0
    fi

    if [ "$assume_yes" != true ]; then
        if [ -t 0 ] && [ -t 1 ]; then
            printf 'Close completed decomposed epic %s#%s? [y/N] ' "$repo_slug" "$top_issue"
            local ans=""
            read -r ans
            case "$ans" in
                y|Y|yes|YES|Yes) ;;
                *) _xrepo_die "close-completed-epic: aborted (no confirmation)."; return 1 ;;
            esac
        else
            _xrepo_die "close-completed-epic: non-interactive caller must pass --yes to confirm closing epic #${top_issue}."
            return 2
        fi
    fi

    if ! fetch_root_refs "$top_issue"; then
        _xrepo_die "close-completed-epic: cannot reach origin to verify epic #${top_issue} state (child/lock refs); refusing (fail-closed). Retry when online."
        return 2
    fi
    if ! git fetch --quiet --no-tags origin '+refs/heads/master:refs/remotes/origin/master' >/dev/null 2>&1; then
        _xrepo_die "close-completed-epic: cannot fetch origin/master; refusing without an authoritative completion view."
        return 2
    fi
    local origin_master
    origin_master=$(git rev-parse --verify origin/master) || return 2

    if epic_has_delegated_children "$top_issue"; then
        _xrepo_die "close-completed-epic: epic #${top_issue} has cross-repo delegated children (or origin is unreadable); use 'task-dag close-epic --issue ${top_issue}', which gates on their completion."
        return 3
    fi

    if ! task_has_children "$epic_sha" >/dev/null; then
        _xrepo_die "close-completed-epic: epic #${top_issue} is not decomposed; use close-ops-epic for undecomposed ops-only roots or complete a real leaf."
        return 3
    fi

    if is_task_blocked "$epic_sha"; then
        local breason
        breason=$(read_blocked_meta_field "$epic_sha" "Reason")
        _xrepo_die "close-completed-epic: epic #${top_issue} root is BLOCKED${breason:+ (reason: ${breason})}. Unblock it first: task-dag unblock ${epic_sha}."
        return 3
    fi

    if ! _epic_subtree_complete_at_commit "$origin_master" "$epic_sha"; then
        local incomplete short_incomplete
        incomplete="$(_epic_first_incomplete_leaf_at_commit "$origin_master" "$epic_sha")"
        short_incomplete="${incomplete:0:12}"
        _xrepo_die "close-completed-epic: epic #${top_issue} still has incomplete local DAG work${short_incomplete:+ (first incomplete leaf: ${short_incomplete})}; complete/drop/block-resolution it first."
        return 3
    fi

    local ra_sha ra_rc=0
    ra_sha=$(remote_ref_sha_checked "refs/heads/tasks/root-active/${top_issue}") || ra_rc=$?
    if [ "$ra_rc" = 3 ]; then
        _xrepo_die "close-completed-epic: cannot read tasks/root-active/${top_issue} on origin (indeterminate); refusing (fail-closed)."
        return 2
    fi
    if [ "$ra_rc" = 0 ] && [ -n "$ra_sha" ]; then
        git fetch --quiet origin \
            "+refs/heads/tasks/root-active/${top_issue}:refs/heads/tasks/root-active/${top_issue}" \
            >/dev/null 2>&1 || true
        local rmsg rclaimer rhost me_claimer me_host
        rmsg=$(parse_commit_metadata "$ra_sha" 2>/dev/null || true)
        rclaimer=$(extract_field "$rmsg" "Claimer" 2>/dev/null || true)
        rhost=$(extract_field "$rmsg" "Claimer-Host" 2>/dev/null || true)
        me_claimer="${TASK_DAG_CLAIMER:-${USER:-unknown}}"
        me_host="${TASK_DAG_CLAIMER_HOST:-$(hostname -s 2>/dev/null || echo unknown)}"
        if [ "$rclaimer" = "$me_claimer" ] && [ "$rhost" = "$me_host" ]; then
            :
        elif claim_is_dead "$ra_sha"; then
            _xrepo_log "close-completed-epic: root lock for #${top_issue} held by ${rclaimer:-?}@${rhost:-?} is provably dead (${claim_dead_reason}); proceeding."
        else
            _xrepo_die "close-completed-epic: epic #${top_issue} has a LIVE root-decompose lock held by ${rclaimer:-?}@${rhost:-?} (not you: ${me_claimer}@${me_host}). Refusing to close while decomposition may be in progress."
            return 3
        fi
    fi

    local master_tip master_tree
    git fetch --quiet origin '+refs/heads/master:refs/remotes/origin/master' >/dev/null 2>&1 || true
    master_tip="$(git rev-parse --verify origin/master 2>/dev/null || git rev-parse --verify master)"
    if epic_already_closed_on "$top_issue" "$epic_sha" "$master_tip"; then
        _xrepo_log "close-completed-epic: epic #${top_issue} already closed on master (concurrent close); nothing to do."
        return 0
    fi
    if ! taskdag_materialisation_intents_durable "$top_issue" "$epic_sha" "$master_tip"; then
        _xrepo_die "close-completed-epic: child-epic materialisation intent for #${top_issue} is not durably delegated; refusing to close."
        return 3
    fi
    master_tree="$(git rev-parse "${master_tip}^{tree}")"

    local close_msg_file close_sha
    close_msg_file="$(mktemp)"
    {
        printf 'Close completed decomposed epic for %s#%s\n' "$repo_slug" "$top_issue"
        printf '\n'
        printf 'This epic was decomposed into local task-dag children, and the tool\n'
        printf 'proved from origin/master plus origin task refs that the local DAG\n'
        printf 'subtree is complete with no live frontier, active, blocked, or\n'
        printf 'delegated child work remaining. This tree-equal merge records the\n'
        printf 'epic SHA as a second parent so close-completed-issues.yml closes\n'
        printf 'issue #%s and cleans up tasks/pending/%s.\n' "$top_issue" "$top_issue"
        printf '\n'
        printf 'Reason: %s\n' "$(printf '%s' "$reason" | tr '\n' ' ')"
        printf '\n'
        printf 'Closes-Epic: #%s\n' "$top_issue"
    } > "$close_msg_file"
    close_sha="$(git commit-tree "$master_tree" -p "$master_tip" -p "$epic_sha" -F "$close_msg_file")"
    rm -f "$close_msg_file"

    echo "created close commit ${close_sha}"
    cmd_publish "$close_sha"
    echo "pushed master — issue #${top_issue} will close via close-completed-issues.yml"
}
