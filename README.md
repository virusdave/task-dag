# task-dag

**The single, consolidated home for all task-dag infrastructure.**

`task-dag` is a git-native DAG of work items ("tasks") layered on top of
GitHub Issues. Tasks live in git refs; GitHub Actions sync issue activity
into the DAG and DAG state back out to issue comments; a CLI drives it all.

This repository is **public on purpose**: GitHub Actions reusable
workflows can only be consumed cross-organisation when the host repo is
public, and our fleet spans three owners (`virusdave`, `Nicponskis`,
`FreshlyBakedNYC`). Nothing here is secret — no credentials, no business
data. Write-back to private repos is still gated by the task-dag GitHub
App token, passed explicitly by callers.

> Rationale and the full migration plan:
> `virusdave/top-level:docs/task_dag/INFRA_CONSOLIDATION.md`
> (architecture decision "Option A′ — reusable workflows, single PUBLIC
> home"). Peer-repo registry: `virusdave/top-level:docs/agent-kb/repos/index.md`.

## What lives here

```
scripts/
  task-dag                          canonical task-dag CLI (source of truth)
  task-dag.d/
    cross-repo.sh                   cross-repo subcommands (delegate, ingest-completion, ...)
    phase-gates.conf                multi-phase epics that need a final-phase Satisfies
  sync-comment-to-tasks.sh          comment → task ingestion (reusable-workflow helper)
  sync-tasks-to-github.sh           task message → issue comment (reusable-workflow helper)
  aggregate-cross-repo-completions.sh  Satisfies-trailer aggregation on push
  operator-blocked-dashboard.sh     render the operator-blocked #29 dashboard from fleet repos' blocked refs

.github/
  workflows/                        REUSABLE workflows (on: workflow_call) — call these from peers
    sync-comment-to-task.yml
    sync-task-to-comment.yml
    aggregate-cross-repo-completions.yml
    materialise-child-epic.yml        cross-repo child-epic materialisation (any wired peer)
  scripts/                          coordinator / per-repo action helpers (source of truth)
    create-task-commit.sh           issue → task ref
    close-completed-issues.sh       auto-close issues whose tasks are all complete
    materialise-child-epics.sh      cross-repo child-epic materialisation
    page-on-manual-issue-close.sh
    post-issue-comments.sh

docs/
  MIGRATION.md                      phased rollout from the old scattered layout
```

## How peers use it

Each peer repo carries **one** logic-free caller workflow,
`.github/workflows/task-dag.yml`, that wires its own `issues` /
`issue_comment` / `push` events to the reusable workflows here via
`uses: virusdave/task-dag/.github/workflows/<name>.yml@<ref>`. All logic,
scripts, and config live here once; the caller is pure wiring. See
`docs/MIGRATION.md` for the caller template and rollout sequence.

Helper scripts are fetched at job time from this repo's public raw URLs,
pinned to the same `ref` the caller pins the workflow to.

Cross-repo child-epic materialisation (the `Materialise-Child-Epic:` commit
trailer that mints an issue in a peer repo and registers the delegation) is
one of these reusable workflows (`materialise-child-epic.yml`). It works for
**any** wired peer that adds the `materialise` job and provisions the task-dag
GitHub App secrets — not only `virusdave/top-level`-originated epics. The
reusable workflow passes the caller repo's own token as `SOURCE_TOKEN`, so the
source epic can live in any wired repo. See `docs/MIGRATION.md` for the caller
template.

## Status

Bootstrap / Phase 1: this repo is established as the source of truth
(additive — no peer references it yet, so nothing is rewired or at risk).
Peer rewiring and retiring the old `Nicponskis/shared-workflows` task-dag
workflows + duplicated per-repo scripts is the phased migration tracked in
`docs/MIGRATION.md`.
