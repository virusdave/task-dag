# `.github2/` — staged GitHub Actions changes awaiting operator promotion

Agents on the worker host hold only per-repo SSH **deploy keys**, and
GitHub forbids deploy keys (and any token lacking the `workflow` scope)
from creating or updating files under `.github/workflows/`. So workflow
changes are staged here under `.github2/` (a path agents *can* push) and
the operator promotes them with `workflow`-scoped credentials:

```sh
gh auth refresh -s workflow      # once, if needed
scripts/promote-github2.sh virusdave/task-dag
```

`promote-github2.sh` removes every path in `REMOVE.txt`, then `git mv`s
each staged file under `.github2/` to its matching `.github/` path (so a
staged file can replace one listed in `REMOVE.txt`), deletes this folder,
commits, and pushes to the default branch. Repos with no `.github2/` are
skipped, so it is safe to re-run.

## Currently staged (virusdave/top-level#22, F2 follow-up)

- `workflows/issue-to-task.yml` — replaces the live reusable workflow with
  a copy that adds a per-issue job `concurrency:` group, serializing
  `opened`/`reopened`/`edited` runs for the same issue. This is optional
  noise-reduction: the promoted `create-task-commit.sh` is already
  race-tolerant (atomic push + lost-race handling). `REMOVE.txt` lists the
  old `.github/workflows/issue-to-task.yml` so the move replaces it.

Delete `.github2/` (it is removed automatically by a successful promote)
once promoted.
