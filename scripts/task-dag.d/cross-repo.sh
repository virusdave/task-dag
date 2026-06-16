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

    local pending_ref="refs/heads/tasks/pending/${top_issue}"
    local delegated_ref="refs/heads/tasks/delegated/${top_issue}/${XREPO_OWNER}/${XREPO_REPO}/${XREPO_ISSUE}"

    local epic_sha
    epic_sha="$(git rev-parse --verify "$pending_ref" 2>/dev/null || true)"
    if [ -z "$epic_sha" ]; then
        # Try to fetch the ref from origin if we don't have it locally yet.
        git fetch origin "$pending_ref":"$pending_ref" >/dev/null 2>&1 || true
        epic_sha="$(git rev-parse --verify "$pending_ref" 2>/dev/null || true)"
    fi
    [ -n "$epic_sha" ] || {
        _xrepo_die "delegate: no epic ref ${pending_ref} (open the issue first or wait for issue-to-task workflow)"
        return 2
    }

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

    # Idempotency: existing delegated ref → nothing to do.
    if git rev-parse --verify "$delegated_ref" >/dev/null 2>&1; then
        _xrepo_log "delegate already present: ${delegated_ref}"
        return 0
    fi
    if git ls-remote origin "$delegated_ref" | grep -q .; then
        # Fetch and reuse the remote one.
        git fetch origin "$delegated_ref":"$delegated_ref" >/dev/null 2>&1
        _xrepo_log "delegate already present on origin: ${delegated_ref}"
        return 0
    fi

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
}

# Helper: idempotently update/insert the ```yaml ... delegated_to: ... ``` block.
#
# Args: input-body-file output-body-file repo issue note
_xrepo_upsert_delegated_block() {
    local in="$1" out="$2" repo="$3" issue="$4" note="$5"

    _xrepo_need_cmd python3 || return 2

    DELEGATE_REPO="$repo" \
    DELEGATE_ISSUE="$issue" \
    DELEGATE_NOTE="$note" \
    python3 - "$in" "$out" <<'PY'
import os, re, sys

in_path, out_path = sys.argv[1], sys.argv[2]
repo  = os.environ["DELEGATE_REPO"]
issue = int(os.environ["DELEGATE_ISSUE"])
note  = os.environ.get("DELEGATE_NOTE", "") or None

with open(in_path, "r", encoding="utf-8") as f:
    body = f.read()

# Find an existing ```yaml ... delegated_to: ... ``` block.
block_re = re.compile(
    r"(?ms)^```yaml\s*\n(.*?delegated_to:.*?)\n```\s*$"
)
m = block_re.search(body)

entries = []  # list of (repo, issue, note)

def parse_block(text):
    """Very small bespoke parser for our exact schema. Tolerant of
    blank lines and trailing whitespace; rejects anything else."""
    out = []
    cur = {}
    lines = [ln.rstrip() for ln in text.splitlines()]
    # skip up to and including the "delegated_to:" line
    i = 0
    while i < len(lines) and lines[i].strip() != "delegated_to:":
        i += 1
    i += 1
    for ln in lines[i:]:
        if not ln.strip():
            continue
        if ln.startswith("  - "):
            if cur:
                out.append(cur)
                cur = {}
            kv = ln[4:].strip()
            if ":" not in kv:
                raise SystemExit(f"malformed delegated_to entry: {ln!r}")
            k, v = kv.split(":", 1)
            cur[k.strip()] = v.strip()
        elif ln.startswith("    "):
            kv = ln.strip()
            if ":" not in kv:
                raise SystemExit(f"malformed delegated_to subline: {ln!r}")
            k, v = kv.split(":", 1)
            cur[k.strip()] = v.strip()
        else:
            raise SystemExit(f"unexpected line in delegated_to block: {ln!r}")
    if cur:
        out.append(cur)
    return out

if m:
    parsed = parse_block(m.group(1))
    for e in parsed:
        r = e.get("repo", "").strip()
        try:
            n = int(e.get("issue", "").strip())
        except ValueError:
            raise SystemExit(f"non-integer issue in delegated_to entry: {e!r}")
        nt = e.get("note")
        entries.append((r, n, nt))

# Upsert
found = False
for idx, (r, n, nt) in enumerate(entries):
    if r == repo and n == issue:
        entries[idx] = (r, n, note)
        found = True
        break
if not found:
    entries.append((repo, issue, note))

# Sort by repo, then issue.
entries.sort(key=lambda x: (x[0], x[1]))

# Render
def render(es):
    lines = ["```yaml", "delegated_to:"]
    for r, n, nt in es:
        lines.append(f"  - repo: {r}")
        lines.append(f"    issue: {n}")
        if nt:
            lines.append(f"    note: {nt}")
    lines.append("```")
    return "\n".join(lines)

new_block = render(entries)

if m:
    new_body = body[:m.start()] + new_block + body[m.end():]
else:
    # Append two-newline-separated to the end of the body.
    sep = "" if body.endswith("\n") else "\n"
    new_body = body + sep + "\n" + new_block + "\n"

with open(out_path, "w", encoding="utf-8") as f:
    f.write(new_body)
PY
}

# ─────────────────────────────────────────────────────────────────────
# cmd_ingest_completion — record a peer-repo Satisfies: as completion
# ─────────────────────────────────────────────────────────────────────

cmd_ingest_completion() {
    local top_issue="" comment_id="" comment_url="" from="" comment_phase=""
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

    # Strategy 1: parse URL: https://github.com/<owner>/<repo>/issues/<peer_issue>
    peer_issue="$(printf '%s\n' "$peer_message" \
        | grep -Eo "https://github\.com/${XREPO_OWNER}/${XREPO_REPO}/issues/[0-9]+" \
        | head -n1 \
        | grep -Eo '[0-9]+$' || true)"

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
        _xrepo_die "ingest-completion: cannot resolve delegated peer issue for ${XREPO_OWNER}/${XREPO_REPO}@${peer_full_sha} (no URL: trailer, no Issue: trailer, and not exactly one delegated child)"
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
    # Optionally followed by ` phase <P...>` — the peer-side aggregator
    # appends the commit's `Phase:` trailer so phase-gating works without
    # the top-level workflow having to read the (often cross-org private)
    # peer repo. The phase suffix is optional for backward compatibility.
    if [[ "$first_line" =~ ^[[:space:]]*\<\!--[[:space:]]*task-dag:completion[[:space:]]*--\>[[:space:]]+Satisfies[[:space:]]+([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#([0-9]+)[[:space:]]+via[[:space:]]+([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)@([A-Fa-f0-9]+)([[:space:]]+phase[[:space:]]+([A-Za-z0-9]+))?[[:space:]]*$ ]]; then
        local target_owner="${BASH_REMATCH[1]}"
        local target_repo="${BASH_REMATCH[2]}"
        local target_issue="${BASH_REMATCH[3]}"
        local peer_owner="${BASH_REMATCH[4]}"
        local peer_repo="${BASH_REMATCH[5]}"
        local peer_sha="${BASH_REMATCH[6]}"
        local peer_phase="${BASH_REMATCH[8]}"

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
            ${peer_phase:+--phase "$peer_phase"}

        # If now fully satisfied, emit the close commit so close-completed-issues.yml fires.
        local status_line
        status_line="$(_xrepo_epic_status "$issue" | tail -n1)"
        if [[ "$status_line" =~ ^epic[[:space:]]ready-to-close: ]]; then
            cmd_close_epic --issue "$issue"
        fi
        return 0
    fi

    # Any other <!-- task-dag: marker → skip; humans use this to mark
    # comments they don't want ingested.
    if grep -q "<!-- task-dag:" "$body_file"; then
        _xrepo_log "ingest-comment: skipping bot comment with non-completion task-dag marker"
        return 0
    fi

    # Normal human comment path: create message task commit parented to
    # the epic and a frontier ref so an agent can pick it up.
    _xrepo_ingest_human_comment "$issue" "$comment_id" "$author" "$comment_url" "$body_file"
}

_xrepo_ingest_human_comment() {
    local issue="$1" comment_id="$2" author="$3" comment_url="$4" body_file="$5"

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
    if [ -z "$epic_sha" ]; then
        _xrepo_die "ingest-comment: no epic ref for issue #${issue}"
        return 2
    fi

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

    local comment_ref="refs/heads/gh/comments/${issue}/${comment_id}"
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
