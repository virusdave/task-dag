#!/usr/bin/env bash
#
# promote-github2.sh — promote staged `.github2/` files into `.github/`.
#
# WHY THIS EXISTS
#   Agents on the worker host only hold per-repo SSH *deploy keys*, and
#   GitHub forbids deploy keys (and any token lacking the `workflow`
#   scope) from creating or updating files under `.github/workflows/`
#   (see virusdave/top-level:docs/agent-kb/discoveries/2026-06.md). So an
#   agent stages reusable workflows / callers under `.github2/workflows/`
#   (a non-restricted path it *can* push), and the operator runs this
#   one-off script — with their own `workflow`-capable credentials — to
#   move them into place.
#
# WHAT IT DOES, per repo (default: virusdave/task-dag):
#   1. clone it (via your `gh` auth);
#   2. if `.github2/REMOVE.txt` exists, `git rm --ignore-unmatch` each path
#      it lists (one repo-relative path per line; `#` comments / blanks
#      ignored) — for retiring workflows the caller supersedes, AND so an
#      in-place update can list its own target here and have the staged
#      copy replace it (removals run BEFORE moves);
#   3. `git mv` every file under `.github2/` to the matching `.github/`
#      path (e.g. `.github2/workflows/x.yml` -> `.github/workflows/x.yml`),
#      skipping the `.github2/README.md` note and `.github2/REMOVE.txt`;
#   4. remove the now-empty `.github2/`;
#   5. commit and push to the default branch.
#   Repos with no `.github2/` are skipped, so it is safe to re-run.
#
# PREREQUISITE
#   `gh` authenticated with the `workflow` scope and push access to each
#   repo:   gh auth login   (or)   gh auth refresh -s workflow
#
# USAGE
#   ./promote-github2.sh                                  # task-dag only
#   ./promote-github2.sh virusdave/task-dag
#   ./promote-github2.sh FreshlyBakedNYC/automation \
#                        Nicponskis/mostly-static-sites \
#                        Nicponskis/nixos-sbc
#
set -euo pipefail

# --- preflight: warn if gh lacks the 'workflow' scope -------------------
if scopes=$(gh auth status 2>&1 | sed -n 's/.*Token scopes: //p' | head -1); then
  if [[ -n "${scopes}" && "${scopes}" != *workflow* ]]; then
    echo "WARNING: gh token scopes (${scopes}) do not include 'workflow';" >&2
    echo "         pushing .github/workflows/ will be rejected." >&2
    echo "         Fix: gh auth refresh -s workflow" >&2
    echo >&2
  fi
fi

repos=( "$@" )
[[ ${#repos[@]} -gt 0 ]] || repos=( virusdave/task-dag )

tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

rc=0
for slug in "${repos[@]}"; do
  echo "=== ${slug} ==="
  dir="${tmp}/${slug##*/}"
  gh repo clone "${slug}" "${dir}" -- --quiet || { echo "  ERROR: clone failed" >&2; rc=1; continue; }
  (
    cd "${dir}"
    if [[ ! -d .github2 ]]; then
      echo "  no .github2/ — nothing to promote (skip)"
      exit 0
    fi

    # Removals run FIRST so a staged file can replace its own target
    # (plain `git mv` refuses to overwrite an existing destination).
    removed=0
    if [[ -f .github2/REMOVE.txt ]]; then
      while IFS= read -r line; do
        line="${line%%#*}"; line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
        [[ -z "${line}" ]] && continue
        if [[ -e "${line}" ]]; then
          git rm -q --ignore-unmatch -- "${line}"
          echo "  remove:  ${line}"
          removed=$((removed + 1))
        fi
      done < .github2/REMOVE.txt
    fi

    moved=0
    dests=()
    while IFS= read -r -d '' f; do
      case "${f}" in
        .github2/README.md|.github2/REMOVE.txt) continue ;;   # control files, not promoted
      esac
      dest=".github/${f#.github2/}"
      mkdir -p "$(dirname "${dest}")"
      # `-f` so a staged file ALWAYS overwrites its destination in a single
      # operation. Without it, `git mv` refuses an existing destination, which
      # historically forced an in-place replacement to also be listed in
      # REMOVE.txt (a `git rm` of the destination BEFORE the move). That
      # rm-then-recreate dance is fragile: any divergence between the removal
      # and the move (e.g. a stale local copy of this script, or the move
      # silently not happening) leaves the destination DELETED with no
      # replacement — exactly the failure that wiped issue-to-task.yml in
      # a7252fff and broke every caller's task-dag automation. `-f` makes a
      # delete-without-replace structurally impossible for staged files, and
      # REMOVE.txt is then only needed to retire files with NO staged successor.
      git mv -f "${f}" "${dest}"
      echo "  promote: ${f} -> ${dest}"
      dests+=( "${dest}" )
      moved=$((moved + 1))
    done < <(find .github2 -type f -print0)

    rm -rf .github2
    git add -A

    # Guard: every promoted destination MUST be present in the index after the
    # move. If any is missing, abort before committing rather than publishing a
    # commit that deletes a workflow without its replacement.
    for dest in ${dests[@]+"${dests[@]}"}; do
      if ! git ls-files --error-unmatch -- "${dest}" >/dev/null 2>&1; then
        echo "  ERROR: promoted file ${dest} is missing from the index after move; aborting (no commit)." >&2
        exit 1
      fi
    done

    if git diff --cached --quiet; then
      echo "  no changes after promote (skip)"
      exit 0
    fi

    git commit -q -m "Promote staged .github2/ task-dag files into .github/ (${moved} added, ${removed} removed)"
    git push
    echo "  pushed ${slug} (${moved} added, ${removed} removed)"
  ) || rc=1
done

exit "${rc}"
