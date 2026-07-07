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
  issues: { types: [opened, reopened, edited] }
  issue_comment: { types: [created] }
  push: { branches: [master] }
jobs:
  issue-to-task:
    if: ${{ github.event_name == 'issues' }}
    uses: virusdave/task-dag/.github/workflows/issue-to-task.yml@master
    permissions: { contents: write, issues: write }
    secrets: { token: ${{ secrets.GITHUB_TOKEN }} }
  comment-sync:
    if: ${{ github.event_name == 'issue_comment' }}
    uses: virusdave/task-dag/.github/workflows/sync-comment-to-task.yml@master
    permissions: { contents: write, issues: write }
    secrets: { token: ${{ secrets.GITHUB_TOKEN }} }
  close-completed:
    if: ${{ github.event_name == 'push' }}
    uses: virusdave/task-dag/.github/workflows/close-completed-issues.yml@master
    # contents: write (not read) — the close script deletes the stale
    # tasks/pending/<N> + tasks/root-active/<N> refs after closing the issue;
    # read-only silently orphans them (the deletes are `|| true`).
    permissions: { contents: write, issues: write }
    secrets: { token: ${{ secrets.GITHUB_TOKEN }} }
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
    permissions: { contents: write, issues: write }
    with:
      base_sha: ${{ github.event.before }}
      head_sha: ${{ github.sha }}
    secrets:
      app_id: ${{ secrets.TASK_DAG_APP_ID }}
      app_private_key: ${{ secrets.TASK_DAG_APP_PRIVATE_KEY }}
```

Pin `@master` while stabilising; cut a moving `task-dag-v1` tag once the
fixture smoke test is green and pin peers to it so future patches need no
peer edits. The workflow `ref` input (script fetch) defaults to the same
branch the workflow is pinned to — keep them aligned.

The caller is the **only** per-repo file (a logic-free shim). The single
canonical implementation is the set of reusable workflows + scripts + CLI in
this repo. The one manual per-repo step is provisioning the two App secrets
(`TASK_DAG_APP_ID`, `TASK_DAG_APP_PRIVATE_KEY`) used by `completion-aggregate`
(and by the optional `materialise` job) — identical values on every peer;
exact runbook in [`docs/SECRETS.md`](SECRETS.md).

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

## Transitional duplication (known, accepted)

During the migration the canonical CLI exists both here and in
`virusdave/top-level:scripts/task-dag` (top-level's local workflows + the
worker host still invoke it). This is the intended phased state — old
paths stay live until step 5 makes this repo the sole CLI home.
