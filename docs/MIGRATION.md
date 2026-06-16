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
    uses: virusdave/task-dag/.github/workflows/issue-to-task.yml@main
    permissions: { contents: write, issues: write }
    secrets: { token: ${{ secrets.GITHUB_TOKEN }} }
  comment-sync:
    if: ${{ github.event_name == 'issue_comment' }}
    uses: virusdave/task-dag/.github/workflows/sync-comment-to-task.yml@main
    permissions: { contents: write, issues: write }
    secrets: { token: ${{ secrets.GITHUB_TOKEN }} }
  close-completed:
    if: ${{ github.event_name == 'push' }}
    uses: virusdave/task-dag/.github/workflows/close-completed-issues.yml@main
    permissions: { contents: read, issues: write }
    secrets: { token: ${{ secrets.GITHUB_TOKEN }} }
  completion-aggregate:
    if: ${{ github.event_name == 'push' }}
    uses: virusdave/task-dag/.github/workflows/aggregate-cross-repo-completions.yml@main
    with:
      base_sha: ${{ github.event.before }}
      head_sha: ${{ github.sha }}
    secrets:
      app_id: ${{ secrets.TASK_DAG_APP_ID }}
      app_private_key: ${{ secrets.TASK_DAG_APP_PRIVATE_KEY }}
```

Pin `@main` while stabilising; cut a moving `task-dag-v1` tag once the
fixture smoke test is green and pin peers to it so future patches need no
peer edits. The workflow `ref` input (script fetch) defaults to the same
branch the workflow is pinned to — keep them aligned.

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
2. **Canary = automation.** Add its single `task-dag.yml` caller in the
   *same commit* that removes its superseded local workflows + vendored
   scripts (never delete a script before its workflow is gone). It gains
   the missing `close-completed-issues` + comment-sync paths. Verify the
   full event matrix on a scratch issue.
3. **Roll out** the identical caller to `mostly-static-sites`, `nixos-sbc`
   (fixes the `issue-comment-sync`-missing deadlock), deleting duplicated
   scripts in the same commits.
4. **Retire `shared-workflows`' task-dag workflows** — leave thin
   re-export wrappers for one release window, then delete once every
   caller points here and the smoke test is green. Drop per-repo
   drift-guard at the same point.
5. **CLI home.** Flip `task-dag-drift-guard.yml`'s `canonical_repo`
   default to `virusdave/task-dag` and drop the App-token mint (this repo
   is public). Update each peer `AGENTS.md` to drop stale `scripts/task-dag`
   references and point at this repo.

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
