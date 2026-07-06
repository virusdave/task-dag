#!/bin/bash
# Create an epic task commit for a GitHub issue, exactly once.
#
# Triggered by issue-to-task.yml on issues:[opened, reopened, edited].
#
# Create-only (F2 of virusdave/top-level#22):
#   - First time we see an issue, create the epic task commit, set both
#       refs/heads/tasks/pending/<N>   (agent-visible epic / dispatch root)
#       refs/heads/gh/issues/<N>       (GitHub-side epic mapping)
#     to point at it, push both atomically, and post the
#     "Task metadata commit:" comment exactly once.
#   - On any subsequent edit/reopen, DO NOTHING that moves tasks/pending/<N>.
#
# Why create-only: this workflow used to mint a *new* revision commit on
# every edit and fast-forward tasks/pending/<N> to it. The dispatcher
# (github-worker) treats tasks/pending/<N> as pickable and dedups by exact
# commit SHA, so every issue body-edit produced a fresh root SHA that
# bypassed dedup (and any `task-dag block` on the prior root), spawning a
# worker onto an already-handled issue — pure wasted agent runs. Nothing
# consumes the epic commit's *body*: `task-dag delegate` reads the issue
# body live (`gh issue view`) and uses the epic ref only as an existence
# check + parent SHA; comment-sync likewise uses the ref only as a parent
# anchor and reads issue text from the event/API. So freezing the ref
# loses nothing and stops the re-dispatch loop. The pending/<N> ref is
# also the epic *identity* (closure/delegation/comment ancestry), so it is
# kept (never deleted), just not rewritten.
#
# Authority: existence decisions use ORIGIN only (a local stale ref must
# not influence what we create/move). Pushes are atomic + race-tolerant so
# this is safe to run concurrently across opened/reopened/edited events.

set -euo pipefail

: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
: "${ISSUE_TITLE:?ISSUE_TITLE is required}"
: "${ISSUE_AUTHOR:?ISSUE_AUTHOR is required}"
: "${ISSUE_URL:?ISSUE_URL is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

ISSUE_BODY="${ISSUE_BODY:-}"

# ── "Blocked at birth" support (virusdave/top-level#36 follow-up) ──────
# An epic can be born already-blocked so the github-worker dispatcher never
# picks it up in the window between this workflow minting the epic ref and a
# separate `task-dag block` landing. The trigger is a GitHub label present
# ON THE ISSUE AT FIRST SIGHTING; the block is applied ATOMICALLY in the
# same push that creates the epic (see the first-sighting section below), so
# origin never exposes a dispatchable-but-unblocked epic.
#
# ISSUE_LABELS is a comma-separated list of the issue's label names (from
# the workflow's `join(github.event.issue.labels.*.name, ',')`). The
# sentinel is matched case-insensitively and exact per element; our sentinel
# name contains no comma, so comma-splitting is safe.
ISSUE_LABELS="${ISSUE_LABELS:-}"
BLOCK_AT_BIRTH_LABEL="${BLOCK_AT_BIRTH_LABEL:-blocked-at-birth}"

# task-dag CLI source for best-effort meta enrichment (see below). Pinned by
# the caller to the same ref this script was fetched from so script and CLI
# can't skew; TASK_DAG_CLI, if set, is used directly (hermetic tests).
TASK_DAG_REPO="${TASK_DAG_REPO:-virusdave/task-dag}"
TASK_DAG_REF="${TASK_DAG_REF:-master}"

# Returns 0 iff the issue carries the block-at-birth sentinel label.
# `read -ra` (not word-splitting an unquoted var) avoids pathname/glob
# expansion of a label like `*` and keeps IFS scoped to the read.
labels_request_block_at_birth() {
    local -a parts=()
    IFS=',' read -ra parts <<<"$ISSUE_LABELS"
    local name
    for name in "${parts[@]}"; do
        name="$(printf '%s' "$name" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
        if [ "${name,,}" = "${BLOCK_AT_BIRTH_LABEL,,}" ]; then
            return 0
        fi
    done
    return 1
}

# Attach blocked-meta side-data to an already-blocked epic via the CANONICAL
# task-dag CLI (the single source of truth for the meta commit format — we do
# NOT reimplement it here). The blocked OVERLAY ref is the race-critical part
# and is already durable by the time this runs; this only enriches the
# operator-blocked #29 dashboard. Best-effort: on any failure the epic stays
# blocked and simply renders as kind:"unknown" until a later `task-dag block`
# enriches it idempotently. Honors a pre-set TASK_DAG_CLI (skips download).
enrich_block_at_birth_meta() {
    local sha="$1"
    local cli="${TASK_DAG_CLI:-}" dir="" rc=0
    if [ -z "$cli" ]; then
        dir="$(mktemp -d)"
        local base="https://raw.githubusercontent.com/${TASK_DAG_REPO}/${TASK_DAG_REF}/scripts"
        mkdir -p "$dir/task-dag.d"
        curl -fsSL "$base/task-dag"                    -o "$dir/task-dag"                 || { rm -rf "$dir"; return 1; }
        curl -fsSL "$base/task-dag.d/cross-repo.sh"    -o "$dir/task-dag.d/cross-repo.sh" || { rm -rf "$dir"; return 1; }
        curl -fsSL "$base/task-dag.d/phase-gates.conf" -o "$dir/task-dag.d/phase-gates.conf" 2>/dev/null || true
        chmod +x "$dir/task-dag" || { rm -rf "$dir"; return 1; }
        cli="$dir/task-dag"
    fi
    TASK_DAG_CLAIMER="${TASK_DAG_CLAIMER:-github-actions[issue-to-task]}" \
        "$cli" block "$sha" --operator \
            --reason="Blocked at birth via '${BLOCK_AT_BIRTH_LABEL}' label" \
            --request-url="$ISSUE_URL" || rc=$?
    [ -n "$dir" ] && rm -rf "$dir"
    return $rc
}

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

PENDING_REF="refs/heads/tasks/pending/${ISSUE_NUMBER}"
GH_ISSUES_REF="refs/heads/gh/issues/${ISSUE_NUMBER}"

# Origin is the single source of truth for "does this epic already exist".
remote_ref_sha() { git ls-remote origin "$1" | awk 'NR == 1 {print $1}'; }

EXISTING_PENDING="$(remote_ref_sha "$PENDING_REF")"
EXISTING_GH="$(remote_ref_sha "$GH_ISSUES_REF")"

# Anomaly: gh/issues/<N> exists but the dispatch root is missing. Do NOT
# recreate the dispatch root (that would re-dispatch). Fail closed.
if [ -z "$EXISTING_PENDING" ] && [ -n "$EXISTING_GH" ]; then
    echo "WARNING: ${GH_ISSUES_REF} exists at ${EXISTING_GH} but ${PENDING_REF} is missing; \
not recreating dispatch root (create-only)." >&2
    exit 0
fi

if [ -n "$EXISTING_PENDING" ]; then
    # Issue already tracked -> create-only no-op for the dispatch root.
    echo "Issue #${ISSUE_NUMBER} already tracked at ${EXISTING_PENDING}; \
leaving ${PENDING_REF} unchanged (create-only)."

    # If both refs exist but disagree, leave both alone and surface it for
    # a human; never silently rewrite either.
    if [ -n "$EXISTING_GH" ] && [ "$EXISTING_GH" != "$EXISTING_PENDING" ]; then
        echo "WARNING: ${GH_ISSUES_REF}=${EXISTING_GH} differs from \
${PENDING_REF}=${EXISTING_PENDING}; leaving both unchanged." >&2
        exit 0
    fi

    # Backfill gh/issues/<N> only if it is absent on origin (epics created
    # before that ref existed). Point it at the existing epic SHA; never
    # move pending.
    if [ -z "$EXISTING_GH" ]; then
        echo "Backfilling ${GH_ISSUES_REF} -> ${EXISTING_PENDING}"
        # Make sure the epic object is present locally before pointing a
        # ref at it (cheap no-op when fetch-depth:0 already has it).
        git cat-file -e "${EXISTING_PENDING}^{commit}" 2>/dev/null \
            || git fetch --no-tags origin "$PENDING_REF" >/dev/null 2>&1 || true
        git update-ref "$GH_ISSUES_REF" "$EXISTING_PENDING"
        if ! git push origin "$GH_ISSUES_REF"; then
            if [ "$(remote_ref_sha "$GH_ISSUES_REF")" = "$EXISTING_PENDING" ]; then
                echo "Lost backfill race; ${GH_ISSUES_REF} already present at ${EXISTING_PENDING}."
                exit 0
            fi
            echo "ERROR: failed to backfill ${GH_ISSUES_REF}." >&2
            exit 1
        fi
    fi
    exit 0
fi

# ---- First sighting: create the epic, anchored to master HEAD. ----
PARENT_SHA="$(git rev-parse HEAD)"
EMPTY_TREE="$(git mktree </dev/null)"

cat > /tmp/msg.txt <<EOF
Task: ${ISSUE_TITLE}

Issue: #${ISSUE_NUMBER}
Author: ${ISSUE_AUTHOR}
URL: ${ISSUE_URL}
Status: pending
Type: epic

${ISSUE_BODY}
EOF

TASK_COMMIT="$(git commit-tree "$EMPTY_TREE" -p "$PARENT_SHA" -F /tmp/msg.txt)"
echo "Created epic task commit: ${TASK_COMMIT} (parent=${PARENT_SHA}, first_seen=true)"

git update-ref "$PENDING_REF" "$TASK_COMMIT"
git update-ref "$GH_ISSUES_REF" "$TASK_COMMIT"

# "Blocked at birth": if (and ONLY if) this first-sighting issue carries the
# sentinel label, create the blocked overlay ref pointing at the epic commit
# and push it in the SAME atomic push as pending+gh. The github-worker
# dispatcher skips a pending root whose blocked overlay exists (worker-loop
# is_task_blocked, checked before pre-claim), and both refs reach origin
# atomically, so there is never a dispatchable-but-unblocked window.
#
# This lives ONLY on the first-sighting path (reached only when the epic did
# not previously exist on origin). An edit/reopen of an already-tracked issue
# returns from the create-only guards above and never gets here, so a STALE
# label can never re-block an epic the operator has already unblocked.
PUSH_REFS=("$PENDING_REF" "$GH_ISSUES_REF")
BLOCK_AT_BIRTH=false
if labels_request_block_at_birth; then
    BLOCK_AT_BIRTH=true
    BLOCKED_REF="refs/heads/tasks/blocked/${TASK_COMMIT}"
    git update-ref "$BLOCKED_REF" "$TASK_COMMIT"
    PUSH_REFS+=("$BLOCKED_REF")
    echo "Block-at-birth: issue #${ISSUE_NUMBER} labeled '${BLOCK_AT_BIRTH_LABEL}'; creating epic already blocked (${BLOCKED_REF})."
fi

# Atomic so we never leave one ref created and the other rejected (and, when
# blocking at birth, never leave the epic pickable without its blocked overlay).
if ! git push --atomic origin "${PUSH_REFS[@]}"; then
    # A concurrent first-seen run may have won. If the dispatch root now
    # exists on origin, the desired end state is reached; don't double-post.
    AFTER_PENDING="$(remote_ref_sha "$PENDING_REF")"
    if [ -n "$AFTER_PENDING" ]; then
        echo "Lost first-seen race; ${PENDING_REF} now exists at ${AFTER_PENDING}. Not commenting."
        # If we wanted to block at birth but the winning concurrent run
        # created the epic WITHOUT a blocked overlay (its event snapshot
        # lacked the label), the epic is dispatchable. We do NOT block the
        # winner's SHA here (that would be label-after-birth semantics,
        # deliberately deferred) — but surface it loudly so it's observable.
        if [ "$BLOCK_AT_BIRTH" = true ] \
           && [ -z "$(remote_ref_sha "refs/heads/tasks/blocked/${AFTER_PENDING}")" ]; then
            echo "WARNING: issue #${ISSUE_NUMBER} is labeled '${BLOCK_AT_BIRTH_LABEL}' but a concurrent run created epic ${AFTER_PENDING} WITHOUT a blocked overlay; it may be dispatched. Run 'task-dag block ${AFTER_PENDING} --operator' to park it." >&2
        fi
        exit 0
    fi
    echo "ERROR: first-seen push failed and ${PENDING_REF} still does not exist." >&2
    exit 1
fi

gh issue comment "${ISSUE_NUMBER}" \
    --body "Task metadata commit: ${TASK_COMMIT} | Branch: tasks/pending/${ISSUE_NUMBER}"

# Best-effort meta enrichment for the operator-blocked #29 dashboard. The
# blocked overlay above already guarantees the epic is not dispatched; this
# only attaches descriptive side-metadata (kind/reason/url) via the canonical
# CLI. Never let this become the blocking mechanism — the overlay is.
if [ "$BLOCK_AT_BIRTH" = true ]; then
    enrich_block_at_birth_meta "$TASK_COMMIT" \
        || echo "WARNING: block-at-birth meta enrichment failed for #${ISSUE_NUMBER}; epic is blocked, #29 dashboard kind renders 'unknown' until re-blocked with 'task-dag block'." >&2
fi
