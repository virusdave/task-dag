# Staged for operator promotion (`.github2/`)

Deploy keys (and tokens without the `workflow` scope) cannot push changes
under `.github/workflows/`. So workflow-affecting changes are staged here
and promoted by an operator with a `workflow`-scoped credential via
`virusdave/task-dag:scripts/promote-github2.sh`.

This staging has **no files to add** — only `REMOVE.txt`, which retires
this repo's vendored task-dag CLI (`scripts/task-dag` +
`scripts/task-dag.d/`) and its `task-dag-drift-guard.yml`. They are
superseded by the single canonical runtime in `virusdave/task-dag`
(consumed via `.github/workflows/task-dag.yml`).

Context: virusdave/top-level#21 ·
virusdave/top-level:docs/task_dag/CLI_DISTRIBUTION.md

## Promote (operator)

```sh
gh auth refresh -s workflow        # once, if needed
./scripts/promote-github2.sh \
    FreshlyBakedNYC/automation \
    Nicponskis/mostly-static-sites \
    Nicponskis/nixos-sbc
```
