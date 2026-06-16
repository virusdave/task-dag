# Staged for operator promotion (`.github2/`)

Deploy keys (and tokens without the `workflow` scope) cannot push under
`.github/workflows/`. Workflow-affecting changes are staged here and
promoted by an operator with a `workflow`-scoped credential via
`scripts/promote-github2.sh` (default target: this repo).

Staged: `workflows/cli-tests.yml` — the central task-dag CLI quality gate
(runs `tests/task-dag/run-all.sh`), which replaces the retired per-repo
`task-dag-drift-guard.yml`. Context: virusdave/top-level#21.

## Promote (operator)

```sh
gh auth refresh -s workflow        # once, if needed
./scripts/promote-github2.sh       # this repo (virusdave/task-dag)
```
