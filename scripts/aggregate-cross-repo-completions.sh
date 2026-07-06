#!/usr/bin/env bash
# Aggregate cross-repo completion signals.
#
# Triggered by `push` to master in a peer repo. For each commit in the push
# range, parse `Satisfies: <owner>/<repo>#<issue>` trailers and, for each
# that targets the configured top-level repo, POST a structured completion
# comment to the named top-level issue.
#
# The body shape (anchored on the `<!-- task-dag:completion -->` marker) is
# what the top-level comment-sync workflow recognises and turns into a
# completion ref via `scripts/task-dag ingest-completion`.
#
# Idempotent: a matching prior comment short-circuits the POST.
#
# Required env:
#   GH_TOKEN         fine-grained PAT with issues:write on TOP_LEVEL_REPO
#   TOP_LEVEL_REPO   owner/repo (e.g. virusdave/top-level)
#   BASE_SHA         github.event.before
#   HEAD_SHA         github.sha
#   PEER_REPO        github.repository (peer repo doing the push)

set -euo pipefail

log()  { echo "[$(date -u +%FT%TZ)] $*"; }
warn() { echo "::warning::$*"; }
die()  { echo "::error::$*"; exit 1; }

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${TOP_LEVEL_REPO:?TOP_LEVEL_REPO is required}"
: "${BASE_SHA:?BASE_SHA is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"
: "${PEER_REPO:?PEER_REPO is required}"

ZERO_SHA="0000000000000000000000000000000000000000"

# First push to a branch reports BASE_SHA=zero. In that case, only scan the
# tip commit (we have no merge-base to compute against).
if [[ "${BASE_SHA}" == "${ZERO_SHA}" ]]; then
  RANGE="${HEAD_SHA}"
else
  RANGE="${BASE_SHA}..${HEAD_SHA}"
fi

mapfile -t COMMITS < <(git rev-list --reverse "${RANGE}")

if [[ ${#COMMITS[@]} -eq 0 ]]; then
  log "No commits to scan in ${RANGE}"
  exit 0
fi

# Returns "true" if a comment whose body exactly equals $2 already exists on
# top-level issue $1; "false" otherwise.
comment_exists() {
  local issue="$1"
  local body="$2"

  gh api --paginate "repos/${TOP_LEVEL_REPO}/issues/${issue}/comments?per_page=100" \
    | jq -s --arg body "${body}" 'add | any(.[]?; .body == $body)'
}

# Post a completion comment to the named top-level issue if and only if an
# identical comment does not already exist.
post_completion_comment() {
  local issue="$1"
  local body="$2"

  if [[ "$(comment_exists "${issue}" "${body}")" == "true" ]]; then
    log "Comment already present on ${TOP_LEVEL_REPO}#${issue}: ${body}"
    return 0
  fi

  local url
  if ! url="$(
    gh api \
      --method POST \
      -H "Accept: application/vnd.github+json" \
      "repos/${TOP_LEVEL_REPO}/issues/${issue}/comments" \
      -f body="${body}" \
      --jq .html_url
  )"; then
    die "Failed posting completion comment to ${TOP_LEVEL_REPO}#${issue} from ${PEER_REPO}"
  fi

  log "Posted ${url}"
}

for commit in "${COMMITS[@]}"; do
  short_sha="$(git rev-parse --short=12 "${commit}")"
  message="$(git log -1 --format=%B "${commit}")"

  mapfile -t trailers < <(
    printf '%s\n' "${message}" \
      | git interpret-trailers --parse \
      | awk -F': ' '$1 == "Satisfies" { print $2 }'
  )

  # Optional `Phase: P<n>` trailer. We embed it in the completion comment
  # so the top-level coordinator can phase-gate epics WITHOUT having to
  # read this (often cross-org, private) peer repo over the API — its
  # token usually can't. We're the only side that can read this commit,
  # so we resolve the phase here. Empty when the commit has no phase.
  phase="$(
    printf '%s\n' "${message}" \
      | git interpret-trailers --parse \
      | awk -F': ' '$1 == "Phase" { print $2 }' \
      | head -n1 \
      | tr -d '[:space:]'
  )"
  # Guard the ingest-side regex: a phase containing any char outside
  # [A-Za-z0-9] would make the top-level completion-comment regex fail to
  # match, the comment would be treated as machine noise and skipped, and
  # `comment_exists` dedup would prevent any retry — a permanent silent
  # completion drop. Drop a malformed phase rather than risk that.
  [[ "$phase" =~ ^[A-Za-z0-9]+$ ]] || phase=""

  if [[ ${#trailers[@]} -eq 0 ]]; then
    continue
  fi

  # Resolve THIS commit's own peer-repo issue number so the top-level
  # coordinator can attribute the completion to the right delegated child
  # WITHOUT having to read this (often cross-org, private) peer repo over
  # the API — a token it usually does not have. We are the only side that
  # can read this commit, so we resolve it here, exactly like `phase`.
  #
  # A commit belongs to a single peer issue (independent of how many
  # top-level issues it Satisfies), so resolve once per commit. Prefer the
  # explicit `Issue: #<N>` trailer; fall back to an own-repo issue URL in
  # the message. Empty when neither is present (older/hand commits) — the
  # top-level side then falls back to its existing resolution strategies.
  peer_issue="$(
    printf '%s\n' "${message}" \
      | git interpret-trailers --parse \
      | awk -F': ' '$1 == "Issue" { print $2 }' \
      | head -n1 \
      | tr -d '[:space:]' \
      | sed -n 's/^#\{0,1\}\([0-9][0-9]*\)$/\1/p'
  )"
  if [[ -z "${peer_issue}" ]]; then
    peer_issue="$(
      printf '%s\n' "${message}" \
        | grep -Eo "https://github\.com/${PEER_REPO}/issues/[0-9]+" \
        | head -n1 \
        | grep -Eo '[0-9]+$' || true
    )"
  fi

  for trailer in "${trailers[@]}"; do
    if [[ ! "${trailer}" =~ ^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#([0-9]+)$ ]]; then
      warn "${PEER_REPO}@${short_sha} has malformed trailer: Satisfies: ${trailer}"
      continue
    fi

    owner="${BASH_REMATCH[1]}"
    repo="${BASH_REMATCH[2]}"
    issue="${BASH_REMATCH[3]}"

    if [[ "${owner}/${repo}" != "${TOP_LEVEL_REPO}" ]]; then
      log "Ignoring Satisfies: ${trailer} on ${PEER_REPO}@${short_sha}; target is not ${TOP_LEVEL_REPO}"
      continue
    fi

    body="<!-- task-dag:completion --> Satisfies ${owner}/${repo}#${issue} via ${PEER_REPO}@${short_sha}"
    if [[ -n "${phase}" ]]; then
      body+=" phase ${phase}"
    fi
    # Order matters: the top-level ingest regex expects an optional
    # ` phase <P>` BEFORE an optional ` peer-issue <M>`.
    if [[ -n "${peer_issue}" ]]; then
      body+=" peer-issue ${peer_issue}"
    fi
    post_completion_comment "${issue}" "${body}"
  done
done
