#!/usr/bin/env bash
# Scan commits in $BEFORE_SHA..$AFTER_SHA for `Materialise-Child-Epic:`
# trailer groups and, for each:
#
#   1. Mint a GitHub App installation token scoped to the peer repo
#      (the `task-dag` App must be installed on the peer repo with
#      Issues: read & write).
#   2. Create the peer-repo issue using the trailer-specified body
#      file (read from the trailer commit's tree, not the workflow
#      checkout tip).
#   3. Run the canonical `task-dag delegate` (fetched at job time from the
#      public virusdave/task-dag — see ensure_task_dag) to register the
#      delegation on the parent epic body (the epic issue lives in THIS
#      source repo — whichever peer carried the trailer, not necessarily
#      top-level) and push the `refs/heads/tasks/delegated/...` ref.
#
# Idempotency: each materialisation pushes a marker ref pointing at an
# empty-tree commit that records the assigned peer issue number.
# Re-running on the same trailer commit (or a second push that
# re-introduces the trailer) is a no-op once the ref exists.
#
# There are TWO marker namespaces, selected by whether the group
# carries an (optional) `Child-Epic-Slug:` trailer:
#
#   * No slug (the default slot, LEGACY-COMPATIBLE — unchanged):
#       refs/heads/gh/child-epics/<parent_N>/<peer_owner>/<peer_repo>
#     This is the historical scheme.  It permits exactly ONE child epic
#     per (parent issue, peer repo) — the common case.
#
#   * With slug (NAMED slot, allows MULTIPLE child epics per
#     (parent, peer repo)):
#       refs/heads/gh/child-epic-slots/<parent_N>/<peer_owner>/<peer_repo>/<slug>
#     A separate top-of-tree ref namespace (`child-epic-slots`, not
#     `child-epics`) is used deliberately so a named-slot marker can
#     never collide with the legacy default-slot marker via git's
#     directory/file ref restriction (a ref at `.../<repo>` forbids refs
#     under `.../<repo>/*`).  The two namespaces are independent: a slug
#     lookup consults ONLY the slot namespace, and the default lookup
#     consults ONLY the legacy namespace, so old single-child-epic
#     behaviour is byte-for-byte unchanged and old markers are honoured
#     forever.
#
# Mixing is coherent: unslugged = "the default slot"; each slug = a
# distinct named slot.  Once you use slugs for a (parent, peer repo),
# keep using them for every child epic on that pair.
#
# Trailer contract (case-insensitive keys per RFC 822):
#
#   Materialise-Child-Epic: <owner/repo>
#   Child-Epic-Title: <title>
#   Child-Epic-Body-File: <path-in-repo>
#   Parent-Issue: #<N>
#   Child-Epic-Slug: <slug>            (optional; ^[a-z0-9][a-z0-9-]*$, <=64)
#   Delegation-Note: <optional free text>
#
# Multiple groups per commit are allowed; each
# `Materialise-Child-Epic:` opens a new group, and the subsequent
# trailers (until the next `Materialise-Child-Epic:` or end of
# message) apply to that group.  All four of {Title, Body-File,
# Parent-Issue} are required; Delegation-Note is optional.
#
# Important: when emitting multiple groups in one commit message,
# keep them in a **single trailer block** (no blank lines between
# them).  `git interpret-trailers --parse` only recognises the LAST
# trailer block in a message; intervening blank lines hide earlier
# groups.  Co-author the groups one per line, group-delimited only
# by the `Materialise-Child-Epic:` key itself.
#
# Failure visibility:
#   - App-installation missing on the peer repo → ::error:: log + a
#     paging comment on the parent issue (`@<issue-author> the
#     task-dag App is not installed on <owner/repo>; manual
#     intervention required`).
#   - Issue-create failure → ::error:: log; no marker ref pushed
#     (so a subsequent push can retry).
#   - Delegate failure after issue-create succeeded → ::error:: log +
#     the marker ref is still pushed (so we don't double-create the
#     peer issue on retry) but the delegation must be re-run manually
#     (or via a subsequent commit re-trigger).
#
# Invoked by the reusable .github/workflows/materialise-child-epic.yml
# (or top-level's standalone workflow) with:
#   BEFORE_SHA            push event before-SHA (40-zero on first push)
#   AFTER_SHA             push event after-SHA
#   GH_REPO               the SOURCE repo carrying the trailer (owner/repo);
#                         any wired peer, not necessarily top-level
#   SOURCE_TOKEN          the source repo's GITHUB_TOKEN (for delegate-back +
#                         marker-ref push). Legacy alias TOP_LEVEL_TOKEN is
#                         still honoured for back-compat.
#   APP_ID                task-dag GitHub App ID
#   APP_PRIVATE_KEY       PEM-encoded private key for the same App

set -euo pipefail

# When sourced by the unit test with MATERIALISE_LIB_ONLY=1, define the
# helper functions but skip the required-env checks, the App-key setup,
# and the main scan at the bottom of this file.
if [ -z "${MATERIALISE_LIB_ONLY:-}" ]; then
    : "${BEFORE_SHA:?BEFORE_SHA is required}"
    : "${AFTER_SHA:?AFTER_SHA is required}"
    : "${GH_REPO:?GH_REPO is required}"
    # SOURCE_TOKEN is the source repo's GITHUB_TOKEN. Accept the legacy
    # TOP_LEVEL_TOKEN name for back-compat (top-level's standalone workflow
    # still exports it) so repointing callers is a no-flag-day migration.
    SOURCE_TOKEN="${SOURCE_TOKEN:-${TOP_LEVEL_TOKEN:-}}"
    : "${SOURCE_TOKEN:?SOURCE_TOKEN (or legacy TOP_LEVEL_TOKEN) is required}"
    : "${APP_ID:?APP_ID is required}"
    : "${APP_PRIVATE_KEY:?APP_PRIVATE_KEY is required}"

    # Stash the App key in a temp file for openssl signing.
    APP_KEY_FILE="$(mktemp)"
    chmod 600 "$APP_KEY_FILE"
    printf '%s\n' "$APP_PRIVATE_KEY" > "$APP_KEY_FILE"
    trap 'rm -f "$APP_KEY_FILE"' EXIT
fi

# --- helpers ----------------------------------------------------------------

# Resolve the canonical task-dag CLI. top-level's vendored copy was retired
# (virusdave/top-level#21): the single canonical runtime now lives in the
# public repo virusdave/task-dag. Fetch it at job time (shallow clone, no
# auth — the repo is public) and cache the path in $TASK_DAG. A pre-set
# $TASK_DAG (tests / local override) is honoured. The CLI binds git ops to
# the CALLER's cwd (this source-repo checkout), so `delegate` still updates the
# parent epic in the source repo; only its own task-dag.d/ helpers are sourced
# from the clone.
TASK_DAG="${TASK_DAG:-}"
ensure_task_dag() {
    if [ -n "$TASK_DAG" ] && [ -x "$TASK_DAG" ]; then
        return 0
    fi
    local td_dir
    td_dir="$(mktemp -d)"
    if ! git clone --quiet --depth 1 \
            https://github.com/virusdave/task-dag "$td_dir/task-dag"; then
        echo "::error ::failed to fetch canonical task-dag CLI from virusdave/task-dag" >&2
        return 1
    fi
    TASK_DAG="$td_dir/task-dag/scripts/task-dag"
    chmod +x "$TASK_DAG" 2>/dev/null || true
}

# base64url encode: stdin -> stdout, no padding.
b64url() {
    base64 -w0 | tr '+/' '-_' | tr -d '='
}

# Mint a short-lived JWT for the App (valid for ~9 min).
mint_app_jwt() {
    local now exp header payload sig
    now="$(date +%s)"
    # Clock-skew safety: start `iat` 30s in the past per GitHub guidance.
    exp=$((now + 540))
    header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
    payload="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 30)) "$exp" "$APP_ID" | b64url)"
    sig="$(printf '%s.%s' "$header" "$payload" \
        | openssl dgst -sha256 -sign "$APP_KEY_FILE" -binary \
        | b64url)"
    printf '%s.%s.%s' "$header" "$payload" "$sig"
}

# Mint an installation access token scoped to one repo.
# Args: $1 = JWT, $2 = owner, $3 = repo
# Stdout: token (or empty on failure).
# Stderr: human-readable diagnostic.
mint_installation_token() {
    local jwt="$1" owner="$2" repo="$3"
    local install_id token resp http_code

    # Look up the installation for that repo.
    resp="$(curl -sS -w '\n%{http_code}' \
        -H "Authorization: Bearer $jwt" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/${owner}/${repo}/installation" || true)"
    http_code="$(printf '%s' "$resp" | tail -n1)"
    body="$(printf '%s' "$resp" | sed '$d')"
    if [ "$http_code" != "200" ]; then
        echo "::error ::task-dag App not installed on ${owner}/${repo} (HTTP $http_code from installation lookup). Install the App on that repo with Issues: read & write." >&2
        return 1
    fi
    install_id="$(printf '%s' "$body" | jq -r '.id // empty')"
    if [ -z "$install_id" ]; then
        echo "::error ::App-installation lookup for ${owner}/${repo} returned no .id; body was: $body" >&2
        return 1
    fi

    # Exchange JWT for an installation token scoped to that single repo
    # with only the permissions we need.
    resp="$(curl -sS -w '\n%{http_code}' -X POST \
        -H "Authorization: Bearer $jwt" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/app/installations/${install_id}/access_tokens" \
        -d "$(jq -nc --arg repo "$repo" '{repositories:[$repo],permissions:{issues:"write",metadata:"read"}}')" || true)"
    http_code="$(printf '%s' "$resp" | tail -n1)"
    body="$(printf '%s' "$resp" | sed '$d')"
    if [ "$http_code" != "201" ]; then
        echo "::error ::Failed to mint installation token for ${owner}/${repo} (HTTP $http_code): $body" >&2
        return 1
    fi
    token="$(printf '%s' "$body" | jq -r '.token // empty')"
    if [ -z "$token" ]; then
        echo "::error ::Installation-token response for ${owner}/${repo} had no .token; body was: $body" >&2
        return 1
    fi
    printf '%s' "$token"
}

# Page the parent issue when materialisation fails fatally.
page_on_failure() {
    local parent_issue="$1" reason="$2"
    local author
    author="$(GH_TOKEN="$SOURCE_TOKEN" gh issue view "$parent_issue" --repo "$GH_REPO" --json author -q .author.login 2>/dev/null || echo "")"
    local mention=""
    [ -n "$author" ] && mention="@${author} "
    local body
    body="$(printf '%s\n\n## :warning: Child-epic materialisation failed\n\n%s' \
        "<!-- materialise-failure:${AFTER_SHA}:${parent_issue}:$(date +%s) -->" \
        "${mention}\`materialise-child-epic\` workflow run on commit \`${AFTER_SHA}\` reported: ${reason}")"
    GH_TOKEN="$SOURCE_TOKEN" gh issue comment "$parent_issue" --repo "$GH_REPO" --body "$body" >/dev/null || true
}

# Validate an optional child-epic slug. Empty is valid (default slot).
# A non-empty slug must be lowercase alnum + dashes, start alnum, <=64
# chars — a charset with no git-refname hazards (`..`, `.lock`, `@{`, `/`).
valid_slug() {
    local slug="$1"
    [ -z "$slug" ] && return 0
    [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]
}

# Compute the idempotency marker ref for a group.
#
# No slug -> the LEGACY default-slot ref (unchanged historical scheme,
# one child epic per (parent, peer repo)). With a slug -> a NAMED-slot
# ref in the SEPARATE `child-epic-slots` namespace, which avoids the git
# directory/file conflict with the legacy default-slot ref and permits
# multiple child epics per (parent, peer repo). See the header comment.
marker_ref_for() {
    local parent_issue="$1" peer_owner="$2" peer_repo="$3" slug="$4"
    if [ -n "$slug" ]; then
        printf 'refs/heads/gh/child-epic-slots/%s/%s/%s/%s' \
            "$parent_issue" "$peer_owner" "$peer_repo" "$slug"
    else
        printf 'refs/heads/gh/child-epics/%s/%s/%s' \
            "$parent_issue" "$peer_owner" "$peer_repo"
    fi
}

# Push the idempotency marker ref recording the peer issue number.
# Uses the workflow checkout's pre-authenticated `origin` remote.
push_marker_ref() {
    local parent_issue="$1" peer_owner="$2" peer_repo="$3" peer_issue="$4" trailer_commit="$5" slug="$6"
    local ref
    ref="$(marker_ref_for "$parent_issue" "$peer_owner" "$peer_repo" "$slug")"

    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"

    local empty_tree msg_file marker_sha
    empty_tree="$(git hash-object -t tree /dev/null)"
    msg_file="$(mktemp)"
    {
        printf 'kind: gh-child-epic-marker\n'
        printf 'role: system\n'
        printf '\n'
        printf 'parent_issue: %s\n' "$parent_issue"
        printf 'peer:\n'
        printf '  repo: %s/%s\n' "$peer_owner" "$peer_repo"
        printf '  issue: %s\n' "$peer_issue"
        [ -n "$slug" ] && printf 'slug: %s\n' "$slug"
        printf 'materialised_by_commit: %s\n' "$trailer_commit"
        printf 'materialised_at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "$msg_file"
    marker_sha="$(git commit-tree "$empty_tree" -F "$msg_file")"
    rm -f "$msg_file"

    git update-ref "$ref" "$marker_sha"
    git push origin "${marker_sha}:${ref}" >/dev/null
    echo "Pushed marker ref ${ref} -> ${marker_sha}"
}

# Check whether the marker ref already exists on origin. A slug lookup
# consults ONLY the slot namespace; the default lookup consults ONLY the
# legacy namespace (see marker_ref_for) — the two never cross-suppress.
marker_exists() {
    local parent_issue="$1" peer_owner="$2" peer_repo="$3" slug="$4"
    local ref
    ref="$(marker_ref_for "$parent_issue" "$peer_owner" "$peer_repo" "$slug")"
    git ls-remote origin "$ref" 2>/dev/null | grep -q .
}

# --- main scan --------------------------------------------------------------

# Skip the scan when sourced for unit testing (helpers are defined above).
if [ -n "${MATERIALISE_LIB_ONLY:-}" ]; then
    # `return` succeeds when sourced; `exit` is the fallback if this file
    # is ever executed directly with the flag set.
    # shellcheck disable=SC2317
    return 0 2>/dev/null || exit 0
fi

# Empty-on-first-push fallback (mirrors post-issue-comments.sh).
if [[ "$BEFORE_SHA" =~ ^0+$ ]]; then
    commit_range=("$AFTER_SHA" "-1")
else
    commit_range=("${BEFORE_SHA}..${AFTER_SHA}")
fi

JWT=""
mint_jwt_lazy() {
    if [ -z "$JWT" ]; then
        JWT="$(mint_app_jwt)"
    fi
}

processed_any=false

# Process one materialisation group; reads cur_* and `commit` from
# the enclosing scope via bash dynamic scoping, sets `processed_any`
# in the enclosing scope on success.
flush_group() {
    if [ -z "$cur_peer" ]; then
        return 0
    fi
    if [[ ! "$cur_peer" =~ ^[^/]+/[^/]+$ ]]; then
        echo "::error ::Commit $commit: Materialise-Child-Epic value '$cur_peer' is not <owner/repo>. Skipping group."
        return 0
    fi
    if [ -z "$cur_title" ] || [ -z "$cur_body_file" ] || [ -z "$cur_parent" ]; then
        echo "::error ::Commit $commit: materialisation group for $cur_peer missing one of Child-Epic-Title / Child-Epic-Body-File / Parent-Issue. Skipping."
        return 0
    fi

    local peer_owner="${cur_peer%/*}" peer_repo="${cur_peer#*/}"
    local parent_num="${cur_parent#\#}"

    if ! [[ "$parent_num" =~ ^[0-9]+$ ]]; then
        echo "::error ::Commit $commit: Parent-Issue value '$cur_parent' is not '#<N>'. Skipping group."
        return 0
    fi

    # Optional slug: validate up front so a bad value fails loud instead
    # of minting a malformed ref. Page the parent-issue author too, so a
    # typo'd slug surfaces at dispatch time rather than as an epic that
    # silently never materialises.
    if ! valid_slug "$cur_slug"; then
        echo "::error ::Commit $commit: Child-Epic-Slug '$cur_slug' is invalid (must match ^[a-z0-9][a-z0-9-]{0,63}$). Skipping group."
        page_on_failure "$parent_num" "Child-Epic-Slug \`${cur_slug}\` for \`${peer_owner}/${peer_repo}\` is invalid (must match \`^[a-z0-9][a-z0-9-]{0,63}\$\`). Fix the slug in the trailer and re-push to retry."
        return 0
    fi

    local slug_label=""
    [ -n "$cur_slug" ] && slug_label=" (slug '${cur_slug}')"

    if marker_exists "$parent_num" "$peer_owner" "$peer_repo" "$cur_slug"; then
        echo "Skipping ${peer_owner}/${peer_repo} for #${parent_num}${slug_label}: marker ref already present (already materialised)."
        return 0
    fi

    # Read the body file from the trailer commit's tree.
    local body_blob
    if ! body_blob="$(git show "${commit}:${cur_body_file}" 2>/dev/null)"; then
        echo "::error ::Commit $commit: Child-Epic-Body-File '${cur_body_file}' not present in that commit's tree. Skipping group."
        return 0
    fi

    mint_jwt_lazy
    local peer_token
    if ! peer_token="$(mint_installation_token "$JWT" "$peer_owner" "$peer_repo")"; then
        page_on_failure "$parent_num" "App is not installed on \`${peer_owner}/${peer_repo}\`, or the install lacks Issues: write. Install the \`task-dag\` GitHub App on that repo (Issues: read & write) and re-push the materialisation commit (or amend it with no body change) to retry."
        return 0
    fi

    # Create the peer issue.
    local body_file
    body_file="$(mktemp)"
    printf '%s\n' "$body_blob" > "$body_file"

    local issue_url peer_issue
    if ! issue_url="$(GH_TOKEN="$peer_token" gh issue create \
            --repo "${peer_owner}/${peer_repo}" \
            --title "$cur_title" \
            --body-file "$body_file" 2>&1)"; then
        echo "::error ::gh issue create failed for ${peer_owner}/${peer_repo}: $issue_url"
        rm -f "$body_file"
        return 0
    fi
    rm -f "$body_file"

    # gh prints the new issue URL on the last line of stdout.
    peer_issue="$(printf '%s' "$issue_url" | grep -oE '/issues/[0-9]+' | head -n1 | grep -oE '[0-9]+')"
    if [ -z "$peer_issue" ]; then
        echo "::error ::gh issue create succeeded for ${peer_owner}/${peer_repo} but no issue number parsed from output: $issue_url"
        return 0
    fi
    echo "Created peer issue ${peer_owner}/${peer_repo}#${peer_issue} for parent #${parent_num} (${GH_REPO})"

    # Push the marker ref FIRST so retries don't double-create even
    # if the delegate-back step fails next.
    push_marker_ref "$parent_num" "$peer_owner" "$peer_repo" "$peer_issue" "$commit" "$cur_slug"

    # Register the delegation back on the parent epic (in this source repo)
    # using its own GITHUB_TOKEN (this repo's workflow token).
    local delegate_args=(--issue "$parent_num" --to "${peer_owner}/${peer_repo}#${peer_issue}")
    [ -n "$cur_note" ] && delegate_args+=(--note "$cur_note")
    if ! { ensure_task_dag && GH_TOKEN="$SOURCE_TOKEN" "$TASK_DAG" delegate "${delegate_args[@]}"; }; then
        echo "::error ::task-dag delegate failed for #${parent_num} -> ${peer_owner}/${peer_repo}#${peer_issue}. Marker ref pushed; re-run delegate manually."
        return 0
    fi

    processed_any=true
    echo "Materialised ${peer_owner}/${peer_repo}#${peer_issue} for parent #${parent_num} (${GH_REPO}) and registered the delegation."
}

while IFS= read -r commit; do
    [ -z "$commit" ] && continue
    msg="$(git log -1 --format=%B "$commit")"
    trailers="$(printf '%s\n' "$msg" | git interpret-trailers --parse)"
    [ -z "$trailers" ] && continue

    # Collect groups: each Materialise-Child-Epic: opens one.
    cur_peer="" cur_title="" cur_body_file="" cur_parent="" cur_note="" cur_slug=""

    while IFS= read -r line; do
        [ -z "$line" ] && continue
        key="${line%%:*}"
        val="${line#*:}"
        val="${val#"${val%%[![:space:]]*}"}"
        key_lc="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"

        case "$key_lc" in
            materialise-child-epic|materialize-child-epic)
                # Flush any pending group, then open a new one.
                flush_group
                cur_peer="$val"
                cur_title=""
                cur_body_file=""
                cur_parent=""
                cur_note=""
                cur_slug=""
                ;;
            child-epic-title)
                cur_title="$val"
                ;;
            child-epic-body-file)
                cur_body_file="$val"
                ;;
            parent-issue)
                cur_parent="$val"
                ;;
            child-epic-slug)
                cur_slug="$val"
                ;;
            delegation-note)
                cur_note="$val"
                ;;
            *)
                : # ignore unrelated trailers (Post-Comment etc.)
                ;;
        esac
    done <<< "$trailers"

    # Flush the last group in this commit.
    flush_group

done < <(git rev-list --reverse "${commit_range[@]}")

if [ "$processed_any" = "true" ]; then
    echo "Materialised one or more child epics."
else
    echo "No Materialise-Child-Epic trailers acted upon in $BEFORE_SHA..$AFTER_SHA."
fi
