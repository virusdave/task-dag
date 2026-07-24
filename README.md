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
  validate-caller-workflow.sh        preflight for per-repo task-dag.yml callers
  task-dag.d/
    cross-repo.sh                   cross-repo subcommands (delegate, ingest-comment, ...)
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
    materialise-child-epic.yml        pinned immutable-intent reconciler (any wired peer)
  scripts/                          coordinator / per-repo action helpers (source of truth)
    create-task-commit.sh           issue → task ref
    close-completed-issues.sh       auto-close issues whose tasks are all complete
    materialise-child-epics.sh      effect-free retired legacy entry point
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

Comment ingestion checks out its helper, CLI, modules, and config together at
the same explicit `ref` that pins the reusable workflow. This prevents mixed
moving-ref observations while retaining one logic-free caller.

Cross-repo child-epic materialisation is reconciled from immutable reserved
intents by `materialise-child-epic.yml`. The pinned reconciler is the sole
issue-creation actuator and finalizes the operation-bound marker, delegation,
and dependency edge. Any wired peer with reserved intents, the exact enabled
runtime ref, and the task-dag GitHub App secrets can run it. See
`docs/MIGRATION.md` for the caller template and rollout fence.

## Status

The single-home migration is live: peer repos consume the reusable workflows
from this repo and keep only the thin `.github/workflows/task-dag.yml` caller.
The issue #13 workflow rollout contract is represented by this repo's own
self-hosting caller, the caller preflight (`scripts/validate-caller-workflow.sh`),
and the fixture suite wired through `.github/workflows/cli-tests.yml`.

Before changing any caller workflow, run the preflight from `docs/MIGRATION.md`;
CI also runs the fixture suite when the self-hosting caller, reusable scripts,
tests, or migration docs change.

## Native Rust bootstrap

The native CLI is an incremental migration target; `scripts/task-dag` remains
the canonical production CLI until the migration is complete. Do not install
Rust, Cargo, or native libraries imperatively. The repository's flake provides
the pinned development and build environment:

```sh
nix develop                     # interactive Rust development shell
nix develop --command cargo run --locked # build and run the native bootstrap
nix build                       # reproducible native package in result/
nix run                         # run the flake's native package directly
nix flake check                 # evaluate and build the package check
```

`flake.lock` pins the same `nixpkgs` revision already used by the production
development host. The flake deliberately uses nixpkgs' standard
`rustPlatform.buildRustPackage` and Rust toolchain instead of another overlay:
this keeps evaluation small, maximizes binary-store reuse, and makes a
toolchain update an explicit flake-input and lock-file change. `Cargo.lock`
independently pins the Rust dependency graph.

The planned canonical Rust stack is `clap` for root/command/subcommand parsing,
`proptest` for shrinkable semantic and invariant tests, and `git2` for direct
Git operations. These dependencies will be added only with the first code that
uses them, avoiding unused build, security, and platform cost. When remote Git
transport is introduced, `git2` must enable both `https` and `ssh`. The same
change must deliberately choose and encode a vendored-versus-system-library
policy, including the platform-specific Nix inputs it actually requires,
rather than relying on ambient system libraries.
