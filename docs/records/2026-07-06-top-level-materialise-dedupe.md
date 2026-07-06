# Record — de-duped top-level's cross-repo child-epic materialisation

**Task-dag epic:** [virusdave/task-dag#6](https://github.com/virusdave/task-dag/issues/6)
— "make cross-repo child-epic materialisation a reusable, fleet-wide
capability", scope **D**.

**Assigned leaf SHA:** `6dc6519aa258fdd4b1d4d9caee2e1066e9afea61`
(`tasks/frontier/6dc6519` → `tasks/active/6dc6519`).

## What was done

Scope D removes top-level's *self-hosted* copy of the materialise machinery
in favour of the reusable virusdave/task-dag workflow that scope B landed,
so a `Materialise-Child-Epic:` trailer can never be processed twice on the
same push — the failure mode called out as CRITICAL in the leaf, and the one
that would appear once scope C rolls the per-peer `materialise` caller job
out to the fleet.

All changes are in **virusdave/top-level**
(commit `9ce028c`, on top of the fold-in commit `fc7f789`):

- `.github/workflows/task-dag.yml` — added a `materialise` caller job
  (`if: github.event_name == 'push'`) that calls the reusable
  `virusdave/task-dag/.github/workflows/materialise-child-epic.yml@master`,
  passing `base_sha`/`head_sha` + the `TASK_DAG_APP_ID` / `TASK_DAG_APP_PRIVATE_KEY`
  secrets, with explicit `contents: write` + `issues: write`. Mirrors the
  existing `completion-aggregate` caller; it is now the **only** materialise
  trigger on push.
- `.github/workflows/materialise-child-epic.yml` — **deleted** (the standalone
  `on: push` workflow it replaced).
- `.github/scripts/materialise-child-epics.sh` + `.test.sh` — **deleted**.
  The canonical, slug-aware copy lives here in virusdave/task-dag (scope A)
  and is downloaded by the reusable workflow at job time; top-level no longer
  vendors it.
- Docs kept in sync: `AGENTS.md`, `docs/designs/cross-repo-task-dag-driver.md`,
  `docs/task_dag/CLI_DISTRIBUTION.md`, and three `EPIC_PLAN.md` illustrative
  links now point at the `task-dag.yml` materialise job / reusable workflow.
  Dated `STATUS_*.md` snapshots were left as historical record.

## Behaviour preserved

The reusable workflow runs the *same* slug-aware script against the caller
checkout (`GH_REPO`, `SOURCE_TOKEN` — which honours the legacy
`TOP_LEVEL_TOKEN` alias, `APP_ID`, `APP_PRIVATE_KEY`, `BEFORE_SHA`/`AFTER_SHA`).
No canon (`docs/canon/**`) content changed.

## Verification

- top-level master tip `9ce028c`: **Task-DAG** run `28788960648` green —
  `materialise / materialise` job succeeded (7s), alongside `close-completed`
  and `completion-aggregate`. The push carried no materialise trailers, so
  the job was a correct no-op (self-test of the new caller path).
- **Agent Prompt Budget** run `28788960186` green (AGENTS.md 807/815 words;
  an earlier over-budget edit on `fc7f789` was trimmed in `9ce028c`).
- No double execution: the standalone `materialise-child-epic.yml` is gone,
  so the trailer is processed exactly once per push.

## Rollback

Fully reversible in top-level: `git revert 9ce028c fc7f789` restores the
standalone workflow + vendored script and drops the caller job (no state
migration involved).
