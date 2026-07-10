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
        *) printf '%s' "$raw" ;;
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

    git update-ref "$pending_ref" "$epic_sha"
    git update-ref "$gh_issues_ref" "$epic_sha"
    if ! git push --atomic origin "$pending_ref" "$gh_issues_ref" 1>&2; then
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
    if [[ ! "$spec" =~ ^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)@([A-Fa-f0-9]+)$ ]]; then
        _xrepo_die "expected <owner>/<repo>@<sha>, got: $spec"
        return 2
    fi
    XREPO_OWNER="${BASH_REMATCH[1]}"
    XREPO_REPO="${BASH_REMATCH[2]}"
    XREPO_SHA_PREFIX="${BASH_REMATCH[3]}"
}

# ─────────────────────────────────────────────────────────────────────
# cmd_delegate — declare a delegated child of an epic
# ─────────────────────────────────────────────────────────────────────

cmd_delegate() {
    local top_issue="" target="" note=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --issue) top_issue="$2"; shift 2 ;;
            --to)    target="$2";    shift 2 ;;
            --note)  note="$2";      shift 2 ;;
            *) _xrepo_die "delegate: unknown arg: $1"; return 2 ;;
        esac
    done
    [ -n "$top_issue" ] || { _xrepo_die "delegate: --issue is required"; return 2; }
    [ -n "$target"    ] || { _xrepo_die "delegate: --to is required";    return 2; }

    _xrepo_need_cmd gh
    _xrepo_need_cmd jq
    _xrepo_parse_repo_issue "$target" || return $?

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
# Helper: return 0 if a delegation ref exists (locally OR on origin) for
# the given epic + peer repo + candidate peer issue. Used to validate a
# comment-supplied --peer-issue before trusting it (Strategy 0).
_xrepo_delegation_exists() {
    local top_issue="$1" owner="$2" repo="$3" peer_issue="$4"
    local ref="refs/heads/tasks/delegated/${top_issue}/${owner}/${repo}/${peer_issue}"
    git rev-parse --verify "$ref" >/dev/null 2>&1 && return 0
    git ls-remote origin "$ref" 2>/dev/null | grep -q .
}

# cmd_ingest_completion — record a peer-repo Satisfies: as completion
# ─────────────────────────────────────────────────────────────────────

cmd_ingest_completion() {
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

    _xrepo_need_cmd gh
    _xrepo_need_cmd jq
    _xrepo_parse_repo_sha "$from" || return $?

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
    if peer_commit_json="$(gh api "repos/${XREPO_OWNER}/${XREPO_REPO}/commits/${XREPO_SHA_PREFIX}" 2>/dev/null)"; then
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
        if _xrepo_delegation_exists "$top_issue" "$XREPO_OWNER" "$XREPO_REPO" "$comment_peer_issue"; then
            peer_issue="$comment_peer_issue"
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
        # Enumerate delegated refs from BOTH origin and any local refs.
        # On a fresh CI checkout (the issue-comment-sync runner) the
        # delegated refs are not present locally, so a local-only lookup
        # silently finds nothing — and when the peer API is unavailable
        # (cross-org private repo) the commit-message strategies above
        # also yield nothing, leaving the peer issue unresolvable. The
        # comment-supplied phase is enough to gate, but we still need the
        # peer issue number; the delegation ref on origin carries it.
        local remote_refs local_refs all_refs count
        remote_refs="$(git ls-remote origin \
            "refs/heads/tasks/delegated/${top_issue}/${XREPO_OWNER}/${XREPO_REPO}/*" \
            2>/dev/null | awk '{ print $2 }')"
        local_refs="$(git for-each-ref --format='%(refname)' \
            "refs/heads/tasks/delegated/${top_issue}/${XREPO_OWNER}/${XREPO_REPO}/*" \
            2>/dev/null)"
        all_refs="$(printf '%s\n%s\n' "$remote_refs" "$local_refs" \
            | sed '/^[[:space:]]*$/d' | sort -u)"
        # `wc -l` exits 0 even on empty input (unlike `grep -c .`, which
        # exits 1 on zero matches and would trip `set -e`). The trailing
        # newline from `printf '%s\n'` is required so a single ref counts
        # as one line.
        count="$(printf '%s\n' "$all_refs" | sed '/^[[:space:]]*$/d' | wc -l | tr -d '[:space:]')"
        if [ "$count" = "1" ]; then
            peer_issue="${all_refs##*/}"
        fi
    fi

    [ -n "$peer_issue" ] || {
        _xrepo_die "ingest-completion: cannot resolve delegated peer issue for ${XREPO_OWNER}/${XREPO_REPO}@${peer_full_sha} (no comment peer-issue matching a delegation, no URL: trailer, no Issue: trailer, and not exactly one delegated child)"
        return 2
    }

    local delegated_ref="refs/heads/tasks/delegated/${top_issue}/${XREPO_OWNER}/${XREPO_REPO}/${peer_issue}"

    # Try local then remote fetch.
    local delegation_sha
    delegation_sha="$(git rev-parse --verify "$delegated_ref" 2>/dev/null || true)"
    if [ -z "$delegation_sha" ]; then
        git fetch origin "$delegated_ref":"$delegated_ref" >/dev/null 2>&1 || true
        delegation_sha="$(git rev-parse --verify "$delegated_ref" 2>/dev/null || true)"
    fi
    [ -n "$delegation_sha" ] || {
        _xrepo_die "ingest-completion: no delegation ref ${delegated_ref} (must call 'task-dag delegate' first)"
        return 2
    }

    local completion_ref="refs/heads/tasks/completions/${top_issue}/${XREPO_OWNER}/${XREPO_REPO}/${peer_issue}/${peer_full_sha}"

    local completion_sha
    completion_sha="$(git rev-parse --verify "$completion_ref" 2>/dev/null || true)"
    if [ -z "$completion_sha" ]; then
        git fetch origin "$completion_ref":"$completion_ref" >/dev/null 2>&1 || true
        completion_sha="$(git rev-parse --verify "$completion_ref" 2>/dev/null || true)"
    fi

    if [ -n "$completion_sha" ]; then
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
        git update-ref "$completion_ref" "$completion_sha"
    fi

    # Always (re-)point the comment-id mapping ref at the completion commit.
    git update-ref "$comment_ref" "$completion_sha"

    # Push both, ignore non-fast-forward on comment_ref since it can only
    # change between distinct completion_sha values for the same comment_id
    # (which should never happen).
    git push origin "$completion_ref" "$comment_ref"

    _xrepo_log "completion ${completion_sha} for ${XREPO_OWNER}/${XREPO_REPO}#${peer_issue}@${peer_full_sha:0:12}${peer_phase:+ (phase ${peer_phase})}"

    # Report epic status (ready-to-close vs still-waiting).
    _xrepo_epic_status "$top_issue"
}

# Helper: echo the required final phase for a phase-gated epic, or
# nothing if the epic is not phase-gated. Config is the line-based
# scripts/task-dag.d/phase-gates.conf ("<issue> <final-phase>").
_xrepo_required_final_phase() {
    local top_issue="$1"
    local conf="${_XREPO_MODULE_DIR}/phase-gates.conf"
    [ -f "$conf" ] || return 0
    awk -v issue="$top_issue" '
        /^[[:space:]]*#/ { next }
        /^[[:space:]]*$/ { next }
        { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, "") }
        $1 == issue { print $2; exit }
    ' "$conf"
}

# Helper: return 0 if delegated child <rest> (= <owner>/<repo>/<peer>)
# under epic <top_issue> is satisfied. Non-phase-gated epics are
# satisfied by any completion ref; phase-gated epics require at least one
# completion recorded at the epic's required final phase.
_xrepo_child_satisfied() {
    local top_issue="$1" rest="$2"
    local required_phase
    required_phase="$(_xrepo_required_final_phase "$top_issue")"

    if [ -z "$required_phase" ]; then
        local found
        found="$(git for-each-ref --format='%(refname)' \
            "refs/heads/tasks/completions/${top_issue}/${rest}/*" 2>/dev/null | head -n1)"
        [ -n "$found" ]
        return
    fi

    local ref phase
    while read -r ref; do
        [ -n "$ref" ] || continue
        phase="$(git log -1 --format=%B "$ref" 2>/dev/null \
            | awk -F': ' '$1 ~ /^[[:space:]]*phase$/ { gsub(/[[:space:]]/, "", $2); print $2; exit }')"
        if [ "$phase" = "$required_phase" ]; then
            return 0
        fi
    done < <(git for-each-ref --format='%(refname)' \
        "refs/heads/tasks/completions/${top_issue}/${rest}/*" 2>/dev/null)
    return 1
}

# Helper: print one of:
#   epic ready-to-close: <N>
#   epic still waiting: <N> missing <repo>#<issue>, ...
# Exits 0 in either case. Used by ingest-completion and the close-epic
# decision in ingest-comment.
_xrepo_epic_status() {
    local top_issue="$1"

    # Ensure we have a complete local view of delegated and completion refs.
    git fetch origin \
        "+refs/heads/tasks/delegated/${top_issue}/*:refs/heads/tasks/delegated/${top_issue}/*" \
        "+refs/heads/tasks/completions/${top_issue}/*:refs/heads/tasks/completions/${top_issue}/*" \
        >/dev/null 2>&1 || true

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
    local issue="" comment_id="" author="" comment_url="" body_file=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --issue)        issue="$2";       shift 2 ;;
            --comment-id)   comment_id="$2";  shift 2 ;;
            --author)       author="$2";      shift 2 ;;
            --comment-url)  comment_url="$2"; shift 2 ;;
            --body-file)    body_file="$2";   shift 2 ;;
            *) _xrepo_die "ingest-comment: unknown arg: $1"; return 2 ;;
        esac
    done
    [ -n "$issue"        ] || { _xrepo_die "ingest-comment: --issue is required";        return 2; }
    [ -n "$comment_id"   ] || { _xrepo_die "ingest-comment: --comment-id is required";   return 2; }
    [ -n "$author"       ] || { _xrepo_die "ingest-comment: --author is required";       return 2; }
    [ -n "$comment_url"  ] || { _xrepo_die "ingest-comment: --comment-url is required";  return 2; }
    [ -n "$body_file"    ] || { _xrepo_die "ingest-comment: --body-file is required";    return 2; }
    [ -r "$body_file"    ] || { _xrepo_die "ingest-comment: cannot read $body_file";     return 2; }

    _xrepo_ensure_git_identity

    local comment_ref="refs/heads/gh/comments/${issue}/${comment_id}"

    # Idempotency: this comment was already ingested.
    if git rev-parse --verify "$comment_ref" >/dev/null 2>&1; then
        _xrepo_log "ingest-comment: ${comment_ref} already exists"
        return 0
    fi
    if git ls-remote origin "$comment_ref" | grep -q .; then
        git fetch origin "$comment_ref":"$comment_ref" >/dev/null 2>&1
        _xrepo_log "ingest-comment: ${comment_ref} already exists on origin"
        return 0
    fi

    local first_line
    first_line="$(head -n1 "$body_file")"

    # Completion comment path:
    #   <!-- task-dag:completion --> Satisfies <owner>/<repo>#<N> via <peer>@<short>
    # Optionally followed by ` phase <P>` and/or ` peer-issue <M>` (in that
    # order) — the peer-side aggregator appends the commit's `Phase:`
    # trailer (so phase-gating works) and the peer repo's OWN issue number
    # (so a completion is attributed to the right delegated child), both
    # without the top-level workflow having to read the (often cross-org
    # private) peer repo. Both suffixes are optional for backward
    # compatibility with older completion comments.
    if [[ "$first_line" =~ ^[[:space:]]*\<\!--[[:space:]]*task-dag:completion[[:space:]]*--\>[[:space:]]+Satisfies[[:space:]]+([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#([0-9]+)[[:space:]]+via[[:space:]]+([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)@([A-Fa-f0-9]+)([[:space:]]+phase[[:space:]]+([A-Za-z0-9]+))?([[:space:]]+peer-issue[[:space:]]+([0-9]+))?[[:space:]]*$ ]]; then
        local target_owner="${BASH_REMATCH[1]}"
        local target_repo="${BASH_REMATCH[2]}"
        local target_issue="${BASH_REMATCH[3]}"
        local peer_owner="${BASH_REMATCH[4]}"
        local peer_repo="${BASH_REMATCH[5]}"
        local peer_sha="${BASH_REMATCH[6]}"
        local peer_phase="${BASH_REMATCH[8]}"
        local peer_issue="${BASH_REMATCH[10]}"

        local top_repo
        top_repo="$(_xrepo_current_repo)"
        if [ "${target_owner}/${target_repo}" != "$top_repo" ]; then
            _xrepo_die "ingest-comment: completion targets ${target_owner}/${target_repo} but we are ${top_repo}"
            return 2
        fi
        if [ "$target_issue" != "$issue" ]; then
            _xrepo_die "ingest-comment: completion targets issue #${target_issue} but comment was on #${issue}"
            return 2
        fi

        cmd_ingest_completion \
            --issue "$issue" \
            --comment-id "$comment_id" \
            --comment-url "$comment_url" \
            --from "${peer_owner}/${peer_repo}@${peer_sha}" \
            ${peer_phase:+--phase "$peer_phase"} \
            ${peer_issue:+--peer-issue "$peer_issue"}

        # If now fully satisfied, emit the close commit so close-completed-issues.yml fires.
        local status_line
        status_line="$(_xrepo_epic_status "$issue" | tail -n1)"
        if [[ "$status_line" =~ ^epic[[:space:]]ready-to-close: ]]; then
            cmd_close_epic --issue "$issue"
        fi
        return 0
    fi

    # Skip machine-generated / explicitly-marked comments so they are NOT
    # minted as new pickable tasks (the comment->task dispatch loop, where
    # one worker's status comment becomes the next worker's "task").
    #
    # Author cannot help here: agents post via the operator's `gh`
    # credentials, so an agent status comment is indistinguishable by
    # author from a genuine operator instruction. The reliable signal is a
    # LEADING HTML marker: operators dispatch work by typing prose (no
    # leading "<!--"), while every machine comment leads with one
    # (`<!-- task-dag:status -->`, `<!-- post-comment:… -->`,
    # `<!-- manual-close-page:… -->`, …). `task-dag:completion` is already
    # handled above, before this skip. We also keep the legacy
    # "task-dag: marker anywhere in the body" skip for back-compat.
    local first_nonblank
    first_nonblank="$(grep -m1 -v '^[[:space:]]*$' "$body_file" 2>/dev/null || true)"
    if [[ "$first_nonblank" =~ ^[[:space:]]*\<\!-- ]] || grep -q "<!-- task-dag:" "$body_file"; then
        _xrepo_log "ingest-comment: skipping machine/marked comment (leading HTML marker) — not minting a task"
        return 0
    fi

    # Normal human comment path: create message task commit parented to
    # the epic and a frontier ref so an agent can pick it up.
    _xrepo_ingest_human_comment "$issue" "$comment_id" "$author" "$comment_url" "$body_file"
}

_xrepo_ingest_human_comment() {
    local issue="$1" comment_id="$2" author="$3" comment_url="$4" body_file="$5"

    local comment_ref="refs/heads/gh/comments/${issue}/${comment_id}"

    # Resolve the epic, backfilling it (annotated) if it was never created
    # — so a comment on an issue whose first-sighting run failed still
    # mints a task instead of dying (virusdave/top-level#28). Whether the
    # resulting task is actually dispatched (e.g. the issue is closed) is
    # the dispatcher's call, not ours.
    local epic_sha
    epic_sha="$(_xrepo_ensure_issue_epic "$issue")" || return $?

    local empty_tree msg_file message_sha
    empty_tree="$(_xrepo_empty_tree)"
    msg_file="$(mktemp)"
    {
        printf 'kind: message\n'
        printf 'role: human\n'
        printf 'intent: comment\n'
        printf '\n'
        printf 'issue:\n'
        printf '  number: %s\n' "$issue"
        printf '\n'
        printf 'github:\n'
        printf '  comment_id: %s\n' "$comment_id"
        printf '  actor: %s\n' "$author"
        printf '  url: %s\n' "$comment_url"
        printf '\n'
        printf 'message_id: msg_%s_%s\n' "$(date +%s)" "$comment_id"
        printf '\n'
        printf 'body: |\n'
        sed 's/^/  /' "$body_file"
    } > "$msg_file"

    message_sha="$(git commit-tree "$empty_tree" -p "$epic_sha" -F "$msg_file")"
    rm -f "$msg_file"

    local short_sha frontier_ref
    short_sha="$(git rev-parse --short "$message_sha")"
    frontier_ref="refs/heads/tasks/frontier/${short_sha}"

    git update-ref "$comment_ref" "$message_sha"
    git update-ref "$frontier_ref" "$message_sha"
    git push origin "$comment_ref" "$frontier_ref"

    _xrepo_log "ingest-comment: created message ${message_sha} and pushed ${comment_ref} + ${frontier_ref}"
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

    _xrepo_ensure_git_identity

    local pending_ref="refs/heads/tasks/pending/${top_issue}"

    local epic_sha
    epic_sha="$(git rev-parse --verify "$pending_ref" 2>/dev/null || true)"
    if [ -z "$epic_sha" ]; then
        git fetch origin "$pending_ref":"$pending_ref" >/dev/null 2>&1 || true
        epic_sha="$(git rev-parse --verify "$pending_ref" 2>/dev/null || true)"
    fi
    [ -n "$epic_sha" ] || {
        _xrepo_die "close-epic: no epic ref ${pending_ref}"
        return 2
    }

    # Idempotency: a *trailer-bearing* close merge for this epic already
    # on master?  We must check the epic SHA as a parent AND a matching
    # `Closes-Epic: #<N>` trailer — the exact pair that
    # close-completed-issues.yml requires to actually close the issue.
    # Checking parentage alone is wrong: an ordinary `task-dag complete`
    # merge also lists the epic SHA as a parent but carries no trailer,
    # so a parent-only check reports "already closed" and never emits the
    # closing trailer, silently leaving the GitHub issue open forever.
    # See docs/task_dag/EPIC_CLOSURE.md.
    git fetch origin master >/dev/null 2>&1 || true
    local _master_ref
    if git rev-parse --verify origin/master >/dev/null 2>&1; then
        _master_ref="origin/master"
    else
        _master_ref="master"
    fi
    local _existing_close="" _mc _mparents
    while read -r _mc _mparents; do
        case " $_mparents " in
            *" $epic_sha "*) ;;
            *) continue ;;
        esac
        if git log -1 --format='%B' "$_mc" \
            | git interpret-trailers --parse 2>/dev/null \
            | grep -qE "^Closes-Epic:[[:space:]]*#?${top_issue}([^0-9]|\$)"; then
            _existing_close="$_mc"
            break
        fi
    done < <(git log "$_master_ref" --merges --format='%H %P' 2>/dev/null)
    if [ -n "$_existing_close" ]; then
        _xrepo_log "close-epic: epic ${top_issue} already closed on master (${_existing_close})"
        return 0
    fi

    # Enumerate delegated children and confirm each has at least one completion.
    git fetch origin \
        "+refs/heads/tasks/delegated/${top_issue}/*:refs/heads/tasks/delegated/${top_issue}/*" \
        "+refs/heads/tasks/completions/${top_issue}/*:refs/heads/tasks/completions/${top_issue}/*" \
        >/dev/null 2>&1 || true

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

    echo "all delegated children satisfied for $(_xrepo_current_repo)#${top_issue}"

    # Build the additive close commit:
    #   tree    = current master tip's tree (no diff)
    #   parent1 = current master tip
    #   parent2 = epic SHA
    # That mirrors what `scripts/task-dag complete` does for ordinary
    # tasks, which is what close-completed-issues.yml expects to see.
    git fetch origin master >/dev/null 2>&1 || true
    local master_tip master_tree
    master_tip="$(git rev-parse --verify origin/master 2>/dev/null || git rev-parse --verify master)"
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
    git push origin "${close_sha}:refs/heads/master"
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

# Helper: is there a `Closes-Epic: #<N>` trailer merge anywhere on the
# default branch? Trailer-ONLY variant used when the pending ref is already
# gone (post-close) so we no longer have the epic SHA for a parent check.
_ops_epic_closed_trailer_on() {
    local issue="$1" base_ref="$2" mc
    while read -r mc; do
        if git log -1 --format='%B' "$mc" 2>/dev/null \
            | git interpret-trailers --parse 2>/dev/null \
            | grep -qE "^Closes-Epic:[[:space:]]*#?${issue}([^0-9]|\$)"; then
            return 0
        fi
    done < <(git log "$base_ref" --merges --format='%H' 2>/dev/null)
    return 1
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
    git push origin "${close_sha}:refs/heads/master"
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
    local tip="$1" node="$2" child had_child=false
    while IFS= read -r child; do
        [ -z "$child" ] && continue
        had_child=true
        _epic_subtree_complete_at_commit "$tip" "$child" || return 1
    done < <(list_dag_children "$node")
    if [ "$had_child" = false ]; then
        task_is_completed_at_commit "$tip" "$node"
        return $?
    fi
    return 0
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
    git push origin "${close_sha}:refs/heads/master"
    echo "pushed master — issue #${top_issue} will close via close-completed-issues.yml"
}
