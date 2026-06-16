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
#   2. `git mv` every file under `.github2/` to the matching `.github/`
#      path (e.g. `.github2/workflows/x.yml` -> `.github/workflows/x.yml`),
#      skipping the `.github2/README.md` note and `.github2/REMOVE.txt`;
#   3. if `.github2/REMOVE.txt` exists, `git rm --ignore-unmatch` each path
#      it lists (one repo-relative path per line; `#` comments / blanks
#      ignored) — for retiring workflows the caller supersedes;
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

    moved=0
    while IFS= read -r -d '' f; do
      case "${f}" in
        .github2/README.md|.github2/REMOVE.txt) continue ;;   # control files, not promoted
      esac
      dest=".github/${f#.github2/}"
      mkdir -p "$(dirname "${dest}")"
      git mv "${f}" "${dest}"
      echo "  promote: ${f} -> ${dest}"
      moved=$((moved + 1))
    done < <(find .github2 -type f -print0)

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

    rm -rf .github2
    git add -A

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
