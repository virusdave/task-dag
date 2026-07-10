# task-dag consolidation — migration plan

This repo is the single consolidated home for task-dag infrastructure
(decision "Option A′", `virusdave/top-level:docs/task_dag/INFRA_CONSOLIDATION.md`).
Before consolidation the infra was scattered across **three** places with
real duplication and drift:

- `Nicponskis/shared-workflows` — reusable workflows + their scripts.
- per-repo **local** workflows + copy-pasted scripts in every repo's
  `.github/` (`create-task-commit.sh` copied ×4, `close-completed-issues.sh`
  ×3 and missing on `automation`, `issue-comment-sync` missing on `mss`
  and `nixos-sbc` — the deadlock class that triggered this work).
- vendored `scripts/task-dag` CLI per peer.

## Hard platform constraint

GitHub Actions only runs a workflow in response to **that repository's**
events. There is no native way to get **zero** per-repo workflow files
while keeping repo-local event triggers. So the target is: all *logic,
scripts, and config live here once*, and every peer keeps exactly **one**
logic-free caller (`.github/workflows/task-dag.yml`).

A private host cannot share reusable workflows cross-org, and the fleet
spans `virusdave` / `Nicponskis` / `FreshlyBakedNYC` — hence this repo is
**public**.

## Per-peer caller template

```yaml
name: Task-DAG
on:
  schedule:
    - cron: '17 * * * *'
  workflow_dispatch: {}
  issues: { types: [opened, reopened, edited] }
  issue_comment: { types: [created] }
  push: { branches: [master] }
jobs:
  issue-to-task:
    if: ${{ github.event_name == 'issues' }}
    uses: virusdave/task-dag/.github/workflows/issue-to-task.yml@master
    permissions:
      contents: write
      issues: write
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
  reopen-notice:
    # Monotonic-completion notice on REOPEN (issue #13). create-task-commit.sh
    # is create-only (no phantom task on reopen); this upserts ONE
    # `<!-- task-dag:status -->`-markered, non-task-creating comment saying the
    # completed task stays done and a NEW task must be opened in-thread if more
    # work is needed. Gated on the `reopened` action so it fires only on reopen.
    if: ${{ github.event_name == 'issues' && github.event.action == 'reopened' }}
    uses: virusdave/task-dag/.github/workflows/reopen-notice.yml@master
    permissions:
      issues: write
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
  comment-sync:
    if: ${{ github.event_name == 'issue_comment' }}
    uses: virusdave/task-dag/.github/workflows/sync-comment-to-task.yml@master
    permissions:
      contents: write
      issues: write
    # Add the two App secrets ONLY on a repo whose comment-sync can auto-close
    # a cross-repo delegated epic (it runs `task-dag close-epic`, which pushes a
    # `Closes-Epic: #N` merge to master). A GITHUB_TOKEN push cannot trigger the
    # push-reactive close-completed workflow (GitHub recursion guard, issue #9);
    # the App token can. Requires the App to have contents:write on this repo
    # (see docs/SECRETS.md). Omit them on ordinary peers (unchanged behaviour).
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
      # app_id: ${{ secrets.TASK_DAG_APP_ID }}
      # app_private_key: ${{ secrets.TASK_DAG_APP_PRIVATE_KEY }}
  close-completed:
    # Push is the low-latency path; schedule/manual are the master-derived
    # projection backstop when a push workflow was missed.
    if: ${{ github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}
    uses: virusdave/task-dag/.github/workflows/close-completed-issues.yml@master
    # contents: write (not read) — the close script deletes the stale
    # tasks/pending/<N> + tasks/root-active/<N> refs after closing the issue;
    # schedule/manual provide the master-derived projection backstop when the
    # push-range workflow was missed.
    permissions:
      contents: write
      issues: write
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
  graph-converge:
    # Folds satisfied dependency-graph edges on push and also runs from the
    # schedule/manual backstop so lost mailbox/push events still converge from
    # durable master history.
    if: ${{ github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}
    uses: virusdave/task-dag/.github/workflows/graph-converge.yml@master
    permissions:
      contents: write
    with:
      base_sha: ${{ github.event_name == 'push' && github.event.before || '' }}
      head_sha: ${{ github.event_name == 'push' && github.sha || '' }}
  completion-aggregate:
    if: ${{ github.event_name == 'push' }}
    uses: virusdave/task-dag/.github/workflows/aggregate-cross-repo-completions.yml@master
    with:
      base_sha: ${{ github.event.before }}
      head_sha: ${{ github.sha }}
    secrets:
      app_id: ${{ secrets.TASK_DAG_APP_ID }}
      app_private_key: ${{ secrets.TASK_DAG_APP_PRIVATE_KEY }}
  materialise:
    # Optional: only add this job (and the App secrets) in a peer that must be
    # able to spawn cross-repo child epics via the Materialise-Child-Epic:
    # trailer. Keep it a single push-triggered caller so a trailer is processed
    # exactly once per push (no double execution). Reuses the same two
    # TASK_DAG_APP_* App secrets as completion-aggregate.
    if: ${{ github.event_name == 'push' }}
    uses: virusdave/task-dag/.github/workflows/materialise-child-epic.yml@master
    permissions:
      contents: write
      issues: write
    with:
      base_sha: ${{ github.event.before }}
      head_sha: ${{ github.sha }}
    secrets:
      app_id: ${{ secrets.TASK_DAG_APP_ID }}
      app_private_key: ${{ secrets.TASK_DAG_APP_PRIVATE_KEY }}
```

Before promoting a peer caller, validate the actual file with the canonical
preflight (use `--require-materialise` only for peers that wire the optional
materialise job; add `--require-comment-sync-app` on repos whose comment-sync
can auto-close delegated parent epics):

```sh
scripts/validate-caller-workflow.sh .github/workflows/task-dag.yml
```

The preflight fails closed on drift in the event matrix, per-job permissions,
required secrets, projection and graph-convergence backstop wiring,
push-range inputs, and reusable workflow source (`virusdave/task-dag@master`).

### Rollout authority for cross-repo completions

As of the issue #15 repair window, **legacy `tasks/completions/*` refs remain
the authoritative cross-repo completion signal**. Dependency-graph edges and
mailbox messages are additive convergence aids until a caller workflow can
prove foreign completions from authoritative peer `master` history in its own
GitHub Actions environment.

Why: `graph-converge` deliberately refuses to trust a foreign mailbox hint on
its own. Foreign nodes require a configured local peer checkout
(`taskdag.peer-path.<owner/repo>.path` or `TASKDAG_PEER_PATH_PREFIX`) so the
completed task/issue can be verified from that peer's durable `master` history;
the reusable workflow currently checks out only the caller repo. Retiring the
legacy completion refs before provisioning peer verification would make the
graph look newer without giving it equivalent authority.

Per-repo rollout validation may proceed against the repaired caller template,
but each validation leaf must record one of these two states before it can be
marked ready:

- **Legacy-authoritative (current default):** `completion-aggregate` and the
  top-level `comment-sync` ingestion path still create/read
  `tasks/completions/*`; graph convergence is additive only.
- **Graph-authoritative:** the repo's workflow environment provisions the peer
  access above and demonstrates that `graph-converge` can verify every required
  foreign completion from the owning peer's `master` history.

Do not close the fleet rollout gate by treating graph edges alone as foreign
completion authority while the repo is still in the legacy-authoritative state.

Pin `@master` while stabilising; cut a moving `task-dag-v1` tag once the
fixture smoke test is green and pin peers to it so future patches need no
peer edits. The workflow `ref` input (script fetch) defaults to the same
branch the workflow is pinned to — keep them aligned.

The caller is the **only** per-repo file (a logic-free shim). The single
canonical implementation is the set of reusable workflows + scripts + CLI in
this repo. The one manual per-repo step is provisioning the two App secrets
(`TASK_DAG_APP_ID`, `TASK_DAG_APP_PRIVATE_KEY`) used by `completion-aggregate`
(and by the optional `materialise` job, and — on delegating-parent repos that
auto-close cross-repo epics — by the optional `comment-sync` App path) —
identical values on every peer; exact runbook in
[`docs/SECRETS.md`](SECRETS.md).

The `materialise` job is **optional**: add it only to peers that must be able
to spawn cross-repo child epics (via the `Materialise-Child-Epic:` commit
trailer). It reuses the same two App secrets and is fleet-wide — any wired peer
with the job + secrets can originate a child epic, not only
`virusdave/top-level`. The task-dag GitHub App must be installed (Issues: read
& write) on every peer a child epic may be materialised **in**.

## Sequenced rollout (CI-safe; canary first)

0. **[done] Bootstrap.** Land CLI + scripts + reusable workflows + docs
   here. Additive: no peer references this repo, so nothing is at risk.
1. **New reusable workflows. [authored 2026-06-16]** Reusable
   `issue-to-task` and `close-completed-issues` wrap the self-contained
   `.github/scripts/create-task-commit.sh` / `close-completed-issues.sh`
   (git + gh only — no CLI fetch needed), following the proven
   `sync-comment-to-task` fetch-from-raw pattern. **Currently staged under
   `.github2/workflows/`** because deploy keys / the available token can't
   push `.github/workflows/` (see top-level KB discovery 2026-06). Move
   them into `.github/workflows/` with a `workflow`-capable credential,
   smoke-test on a fixture/scratch issue, then cut `task-dag-v1`.

   > **Rollout gate:** every step below pushes a `.github/workflows/`
   > file into a peer repo. That requires a credential carrying `workflow`
   > scope (a `workflow`-scoped PAT, or the task-dag GitHub App granted
   > `workflows: write` and installed on each peer + this repo). Per-repo
   > deploy keys are **not** sufficient. Provision this once before the
   > canary; otherwise each peer caller must be hand-placed via the web UI.
2. **Canary = automation. [staged 2026-06-16]** A single `task-dag.yml`
   caller + a `REMOVE.txt` manifest are staged under `automation`'s
   `.github2/`. Promoting it adds the caller and, in the **same commit**,
   removes the superseded `issue-to-task.yml`, `issue-comment-sync.yml`,
   `cross-repo-completion-sync.yml` and `.github/scripts/create-task-commit.sh`
   — and it gains the missing `close-completed` path. `task-dag-drift-guard.yml`
   and the vendored CLI are intentionally kept (CLI distribution = step 5).
   Promote with `scripts/promote-github2.sh FreshlyBakedNYC/automation` and
   verify the full event matrix on a scratch issue before the rest.
3. **Roll out. [staged 2026-06-16]** The identical caller + `REMOVE.txt`
   are staged under `mostly-static-sites` and `nixos-sbc` `.github2/` (they
   gain the missing `issue_comment` → comment-sync path, fixing the deadlock
   class; `REMOVE.txt` also drops their `close-completed-issues.yml` +
   `close-completed-issues.sh`). Promote with
   `scripts/promote-github2.sh Nicponskis/mostly-static-sites Nicponskis/nixos-sbc`.

   > **Order:** promote **task-dag first** (`scripts/promote-github2.sh`,
   > default) so the reusable `issue-to-task` / `close-completed-issues`
   > exist at `@master` before any peer caller references them.
4. **Retire `shared-workflows`' task-dag workflows. [done 2026-06-16,
   top-level#21]** Every caller now points at
   `virusdave/task-dag/.github/workflows/*@master` and no repo vendors the
   CLI, so `Nicponskis/shared-workflows`' task-dag workflows + scripts were
   removed (staged via its `.github2/REMOVE.txt`, promoted by the operator)
   and the repo tombstoned. The per-repo drift-guard is dropped — see
   step 5.
5. **CLI home. [done 2026-06-16, top-level#21]** The CLI source of truth is
   this repo. Because no peer vendors `scripts/task-dag` any longer,
   `task-dag-drift-guard.yml` has nothing to guard and was retired here
   (staged via `.github2/REMOVE.txt`, promoted by the operator) rather than
   re-pointed. Peer `AGENTS.md` files already drop stale `scripts/task-dag`
   references and run the CLI via `ephemeral-checkout task-dag`.
6. **Materialise reusable. [done, #6]** Cross-repo child-epic
   materialisation was the last non-reusable step: the slug-aware
   `materialise-child-epics.sh` was canonicalised here (generalised
   `TOP_LEVEL_TOKEN`→`SOURCE_TOKEN` so any source repo works), wrapped in the
   reusable `materialise-child-epic.yml` (`on: workflow_call`), and
   `child-epic-slots` was added to the strict invariant floor
   (`TASKDAG_KNOWN_GH_NS`). `top-level`'s standalone
   `materialise-child-epic.yml` + vendored script were retired and repointed
   at the reusable workflow (single push-triggered caller, no double
   execution). Any peer can now originate cross-repo child epics by adding the
   optional `materialise` caller job + the two App secrets — it is no longer
   `top-level`-only.

## Ordering hazards

- Don't point a peer caller at `task-dag-v1` before the tag + reusable
  workflows exist.
- Don't delete `shared-workflows` reusable workflows while any caller
  still references them.
- Don't delete a peer's `.github/scripts/*` before the local workflow
  that calls them is removed.

Each step is independently revertible; no force-push; canary before fleet;
keep the old path live until the new one is green.

## Legacy dependency encodings → bounded edge graph

Issue #13's edge model is now the canonical dependency substrate. Historical
encodings are still readable during rollout, but new automation should converge
onto ordinary `tasks/v1/graph` edges:

| Legacy source | Edge written by migration/wrapper | Notes |
|---|---|---|
| extra task parents beyond the containment first parent | `requires` from the task node to the dependency task node | The first parent remains containment/epic structure; extra parents are the old dependency encoding. |
| `tasks/delegated/<N>/<owner>/<repo>/<peer>` refs | `requires` from the parent epic/root task node to `issue:<owner>/<repo>#<peer>` | `delegate` now dual-writes only after the legacy delegated ref is durable on origin, so reruns backfill older delegations safely. |
| downstream blocked metadata with explicit `task:` / `issue:` nodes (`Downstream-On`, `On`, `Depends-On`, `Reason`, `Request-URL`) | `requires` from the blocked task to each explicit node | `block --downstream --on <node>` is the new precise path. Prose-only blocks are not guessed. |
| explicit supersede/re-scope metadata or canonical nodes in old task text | `satisfies` from the superseded task to the replacing task/issue node | `supersede <node> --by <node>` is the new wrapper. |

Runbook for a repo migration:

1. Make sure the repo is using the current `task-dag` CLI and has no red master
   gate unrelated to the migration.
2. Inspect what would be backfilled:

   ```sh
   task-dag migrate-legacy-edges --dry-run --json
   ```

3. If the dry-run contains only intended canonical nodes, write the edges:

   ```sh
   task-dag migrate-legacy-edges
   ```

   The command writes through the same `dep add` direct-CAS path as live
   commands, so it is idempotent by semantic edge-id and safe to rerun after a
   contention failure.
4. Validate the graph shape and reader:

   ```sh
   task-dag validate --strict
   task-dag edges --json
   task-dag reconcile --json
   ```

5. Leave legacy refs/history in place. The migration is additive: it does not
   rewrite task commits, delete delegated refs, or unpark blocked tasks. Once
   the wrappers and reconciler are deployed everywhere, legacy encodings are
   compatibility inputs rather than the source of truth for new work.

Rollback is bounded: stop reading the graph or delete/revert only
`refs/heads/tasks/v1/graph` to the prior tip. Do **not** rewrite historical
task commits or hand-edit lifecycle refs to undo an edge migration.

Operational caveats:

- Configure `taskdag.current-repo` (or ensure origin URL resolution works) so
  node identities are canonical `owner/repo` values before migration.
- Cross-repo convergence needs the periodic backstop to be able to verify
  foreign completions from configured local peer worktrees
  (`taskdag.peer-path.<owner/repo>.path` or `TASKDAG_PEER_PATH_PREFIX`). A
  mailbox hint is never trusted as completion authority by itself.
- Tombstones are for deliberate removal of not-yet-prunable active edges. A
  satisfied edge should be pruned (plain deletion) by `dep prune` /
  graph-convergence instead; no tombstone is needed because `master` carries the
  durable completion witness.

## Transitional duplication (known, accepted)

During the migration the canonical CLI exists both here and in
`virusdave/top-level:scripts/task-dag` (top-level's local workflows + the
worker host still invoke it). This is the intended phased state — old
paths stay live until step 5 makes this repo the sole CLI home.
