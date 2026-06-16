# ⚠️ TEMPORARY — run the task-dag promote, then this dir disappears

Staged by an agent (deploy keys can't delete `.github/workflows/` files).
Activate from a `virusdave/task-dag` checkout with a `workflow`-scoped
credential:

    scripts/promote-github2.sh <owner>/<this-repo>

Applies `.github2/REMOVE.txt` (deletes the retired drift-guard workflow)
and removes this dir — one commit. Inert until then.
