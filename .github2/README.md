# Staged for operator promotion (`.github2/`)

Deploy keys (and tokens without the `workflow` scope) cannot push changes
under `.github/workflows/`. So workflow-affecting changes are staged here
and promoted by an operator with a `workflow`-scoped credential via
`virusdave/task-dag:scripts/promote-github2.sh`, which moves each file to
the same path minus the `.github2/` prefix
(`.github2/workflows/X` → `.github/workflows/X`).

Files to **add**:

- `workflows/ci.yml` — non-gating CI running the full gate set
  (repo scanners, helios typecheck server+client / test / build,
  ads/google typecheck) on `push` to `master` and on `pull_request`.
  See "CI is non-gating" below before touching branch protection.
  (FreshlyBakedNYC/automation#49 Phase D.8; driven from
  virusdave/top-level#20.)

Workflow files are authored as a **JSON subset of YAML** (no significant
whitespace) per operator standard; this also sidesteps the YAML 1.1
`on:` → `true` boolean-key footgun.

Context: virusdave/top-level#20 · virusdave/top-level#21 ·
virusdave/top-level:docs/task_dag/CLI_DISTRIBUTION.md

## CI is non-gating (do not make it a required check)

`ci.yml` runs for **visibility only**. The operator has explicitly
disapproved required-status / branch-protection gating because it would
force a PR-based flow and block the direct `git push origin HEAD:master`
workflow agents use. Do **not** add `ci` to required status checks in
branch protection. Keep it a non-blocking signal unless the operator
reverses that decision.

## Promote (operator)

```sh
gh auth refresh -s workflow        # once, if needed
./scripts/promote-github2.sh FreshlyBakedNYC/automation
```
