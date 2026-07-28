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

`task-dag epic-create` is the sole public root writer. It accepts either an
operation identity or immutable provider repository/issue node IDs, persists
the desired GitHub projection, and atomically publishes the registry fact,
root, and born-active claim. It never calls GitHub; `--help` documents its
strict `--json` contract. The command remains dormant until activation is
enabled and `minimumCompatibleTaskDagCommit` is at or after the completed
public-writer prerequisite commit `4e964e3294915e8625c7ce8047b1ab8751096a15`.
The plan4 epoch-13 floor `73bfe103b6f5e1bddc318e5592085619c7f0f2f4`
therefore leaves every public writer dormant after publication.
Rollout must first deploy the new runtime everywhere, drain every old
issue-writer run, and only then raise that floor. Before the raise, both the
new public writer and the replaced workflow fail closed without mutation.

Numeric GitHub refs are migration input only. The minter snapshots
`gh/issues/N`, `tasks/pending/N`, and `tasks/root-active/N` together and adopts
an exact legacy root inside its activation-fenced transaction; any partial or
conflicting tuple aborts. The operational drain above excludes a raw old
writer after this snapshot.

Projected issues are bound with `task-dag epic-bind-projection`, run from the
target operation-root repository and supplied an absolute `--source-checkout`
for the declaration's source repository. Its origin identity and activation
source tip must match the registry before the declaration is fetched from
that origin. GitHub issue ingress has no such source authority: a marker can
only replay an existing binding and otherwise fails closed. Projectors must
bind first, then enable issue ingress for that issue; they must never simulate
convergence by deleting either root.

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

The `task-dag` Rust binary implements the minimal v2 self-hosting path;
`scripts/task-dag` remains the canonical production CLI until the migration is
complete. Do not install
Rust, Cargo, or native libraries imperatively. The repository's flake provides
the pinned development and build environment:

```sh
nix develop                     # interactive Rust development shell
nix develop --command cargo run --locked # build and run the native bootstrap
scripts/run-rust-tests.sh       # run all Rust tests through pinned Nix
scripts/run-rust-tests.sh NAME  # run Rust tests matching NAME
nix build                       # reproducible native package in result/
nix run                         # run the flake's native package directly
nix flake check                 # evaluate and build the package check
```

The bootstrap command surface is intentionally small. Every command has
side-effect-free `--help`; mutation commands use one origin advertisement,
an activation-fenced append-only transition journal, explicit ref leases, one
atomic push, and authoritative readback.

```text
task-dag init --trusted-floor <OID>
task-dag runtime identity
task-dag runtime publish --commit <LOCAL-OID>
task-dag create --operation-id <KEY> --title <TEXT> --description <TEXT> [--claim] [--requires <TASK-ID>...]
task-dag claim <TASK-ID> --owner <OWNER> --operation-id <STABLE-KEY> [--ttl-hours 12]
task-dag renew <TASK-ID> --claim-token <TOKEN> [--ttl-hours 12]
task-dag release <TASK-ID> --claim-token <TOKEN>
task-dag reap <TASK-ID>
task-dag block <TASK-ID> --claim-token <TOKEN> --reason <TEXT> --authorization <TEXT> --operation-id <KEY>
task-dag unblock <TASK-ID> --block-lease <OID> --authorization <TEXT> --operation-id <KEY>
task-dag breakdown <TASK-ID> --spec <STRICT-JSON-FILE> --claim-token <TOKEN>
task-dag complete <TASK-ID> --commit <PUBLICATION-OID> --claim-token <TOKEN>
task-dag complete-ops <TASK-ID> --description <TEXT> --authorization <TEXT> --claim-token <TOKEN> [--evidence <URL-OR-TEXT>]...
task-dag converge <TASK-ID>
task-dag activate-runtime --commit <LOCAL-OID> --activation-lease <OID>
task-dag activation
task-dag show <TASK-ID>
task-dag frontier
task-dag blocked
task-dag deps <TASK-ID>
task-dag context <TASK-ID>
task-dag migrate-v1 --root <LEGACY-OID> --operation-id <KEY>
```

`block` consumes the exact live claim and publishes a manual blocked record;
`unblock` consumes the exact block lease only when immutable direct
requirements are currently done. Both operations publish an immutable receipt
in the same atomic transition. `blocked`, `deps`, and `context` are direct,
provider-free readers. Commands that are outside minimal v2 (`comment`,
`delegate`, dependency mutation, `dag`, epic creation/composition, project,
and provider operations) fail without network access or mutation and point to
supported task-dag commands rather than suggesting raw Git edits.

`migrate-v1` is an exceptional, single-repository importer and requires an
operator-enforced writer freeze for its entire run. It performs one bounded
legacy discovery (at most 100 closure tasks, 500 refs, and 10 MiB of metadata),
rejects unsupported or conflicting legacy state before mutation, and atomically
creates deterministic v2 tasks, lifecycle records, provenance mappings, an
operation receipt, and a transition-journal entry while deleting the exact
legacy closure refs. Exact operation replay is checked before discovery. Keep
the freeze active if post-write readback reports that master or either v1
authority changed.

`breakdown` accepts
`{"operationId":"...","children":[{"key":"...","title":"...","description":"...","requires":[],"claim":false}]}`.
Requirements may be child keys or full v2 Task-IDs. Zero or more independently
ready children may set `claim` to true; each receives a distinct claim token.
Dependencies on children born in the same breakdown do not establish readiness.
Run the binary built from the candidate implementation commit. Build identity is
compile-time only; default builds reject dirty Rust, Cargo, or build inputs.
Flake package builds inject the exact immutable flake revision without enabling
the test seam. Publish each runtime first under the canonical immutable
`refs/tags/task-dag-runtime-v2/<40-hex-commit>` ref. Initialization requires
the trusted floor to equal the peer's advertised master while independently
validating the embedded runtime publication; genesis has parents `[runtime,
trusted floor]`. Activation does not inspect peer master. Its canonically
published candidate is selected under the exact activation lease. Activation
retains both the current and candidate runtime for the handoff epoch, allowing
the current runtime to publish the next runtime and that next runtime to
activate a later candidate without traversing repository history.

Every claim mutation consumes an exact token. Renewal and release use the live
token; reap accepts only an expired claim and returns it to frontier under an
exact ref lease. Direct child completion creates an idempotent reconciliation
marker for its structural parent. `converge` consumes one such marker only after
reading the waiting manifest and exact done evidence for every direct child,
then queues at most the next structural generation.

`flake.lock` pins the same `nixpkgs` revision already used by the production
development host. The flake deliberately uses nixpkgs' standard
`rustPlatform.buildRustPackage` and Rust toolchain instead of another overlay:
this keeps evaluation small, maximizes binary-store reuse, and makes a
toolchain update an explicit flake-input and lock-file change. `Cargo.lock`
independently pins the Rust dependency graph.

`scripts/run-rust-tests.sh` is the canonical Rust test entry point. It uses
Cargo's built-in parallel runner for both the complete suite and selected test
filters; do not create a second scheduler. The aggregate
`tests/task-dag/run-all.sh` gate invokes this command before its shell checks
and fixtures.

The bootstrap uses `clap`, `serde`, `sha2`, and the system `git` command. Using
Git itself preserves receive-pack, atomic push, and force-with-lease behavior
without adding libgit2 and its native transport dependency surface.
## Cross-repository composition

`task-dag epic-compose` is the provider-free cross-repository coordinator. It
level-triggeredly composes `epic-create --claim`, `breakdown --claim-first`,
and pointwise source `dep add` operations from one strict JSON spec bound to an
exact live source claim. Replaying the same spec repairs a crash at any
boundary; it neither mints children itself nor calls a provider. See
`task-dag epic-compose --help` for the schema.
