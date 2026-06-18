# Task ref lifecycle (`pending` / `frontier` / `active` / `blocked`)

How the CLI and the issue-to-task workflows move a unit of work through
the git-ref namespaces, and two lifecycle facts that currently allow
duplicate work across the worker fleet (see "Known gaps").

## The namespaces

| Ref | Created by | Meaning | Removed by |
|---|---|---|---|
| `tasks/pending/<N>` | issue-to-task workflow on issue open/edit/reopen (`create-task-commit.sh`) | **Epic root** for issue `#N`. Also the durable epic *identity* used by closure (`close-epic` / `close-completed-issues.sh`), cross-repo delegation, and comment-ingest ancestry. | Intentionally **kept** for the issue's life (it is the epic identity, not just a queue entry). |
| `tasks/frontier/<short>` | `task-dag breakdown` (run by an agent) | A claimable **implementation leaf**. One per child task, published up front. | `task-dag claim` (renamed to `active`) or `complete`/`drop`. |
| `tasks/active/<short>` | `task-dag claim` | The cross-host distributed lock: this leaf is in flight. The claim commit records Claimer / Claimer-Host / Claimer-PID / Claimed-At. | `complete` (lands the task) or `release` (back to `frontier`). |
| `tasks/blocked/<sha>` | `task-dag block` | Parked: stays in the DAG, listed by `blocked`, never dispatched. | `unblock` / `drop`. |

## Claim is frontier-only (CAS)

`task-dag claim <short>` performs the only true cross-host mutex: a
single `git push --atomic` that renames `tasks/frontier/<short>` ->
`tasks/active/<short>` under two `--force-with-lease` compare-and-swaps
(active must not exist; frontier must still be at the expected SHA),
followed by an origin readback. Two simultaneous claims cannot both land.

**Consequence:** a ref that is *not* a `frontier` ref cannot be claimed
this way. `task-dag claim` on a `tasks/pending/<N>` epic root returns
`no-frontier` (exit 3). **Epic roots therefore have no cross-host claim
protection** — the only thing stopping two hosts from both dispatching
the same undecomposed root is each host's local worker state file, which
is not shared across hosts.

## Breakdown does not retire the root

`task-dag breakdown <root>` publishes child `tasks/frontier/<short>`
refs but does **not** delete, move, or complete the parent
`tasks/pending/<N>`. That is deliberate: the pending ref is the epic
identity used downstream (closure, delegation, comment ancestry). See
`.github/scripts/create-task-commit.sh` for why the pending ref is kept.

**Consequence:** immediately after a breakdown, both the (still-present)
root concept and the brand-new leaves coexist. A worker that was
dispatched on the root and then ran `breakdown` is *still running*; the
new leaves are *immediately claimable* by other workers. Nothing relates
the root SHA to its leaf SHAs under a single lock, so the same issue's
work can be picked up twice (root worker + leaf worker).

## Known gaps (tracked)

Both stem from the two facts above and are the root cause of observed
duplicate-worker incidents (e.g. mostly-static-sites #14, where an
epic-root worker decomposed *and* implemented while a second worker
independently implemented the freshly-minted leaf):

1. **Epic roots are not cross-host claimable.** Two hosts can dispatch
   the same `tasks/pending/<N>` before any leaf exists.
2. **No per-issue (root-vs-leaf) relationship at claim time.** A root
   claim and a leaf claim for the same issue are independent locks.

A first-class, cross-host-claimable epic-root state (or converting roots
into claimable frontier tasks) would close both, but it is a lifecycle
redesign that must preserve pending-root identity for closure,
delegation, and comment ancestry. Tracked as a task-dag design issue.
The host-local half of the mitigation (decompose-only root contract +
same-host leaf suppression while a root claim is active) lives in the
worker fleet; see `Nicponskis/github-worker:docs/DISPATCH_CONCURRENCY.md`.
