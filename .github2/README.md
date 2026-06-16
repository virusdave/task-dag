# ⚠️ TEMPORARY — run the task-dag promote, then this dir disappears

Staged by an agent that only holds a repo deploy key (which GitHub forbids
from pushing `.github/workflows/`). To activate, an operator with a
`workflow`-scoped credential runs, from a `virusdave/task-dag` checkout:

    scripts/promote-github2.sh <owner>/<this-repo>

That moves `.github2/workflows/task-dag.yml` -> `.github/workflows/`,
applies `.github2/REMOVE.txt` (deletes superseded local workflows/scripts),
and removes this `.github2/` — all in one commit. Inert until then.
