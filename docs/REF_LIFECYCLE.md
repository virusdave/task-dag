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

## Non-task namespace: CI repair chains (`tasks/ci-chains/...`)

`refs/heads/tasks/ci-chains/<owner>/<repo>/<branch>` is **not** a task
workflow ref — it is the durable per-repo/branch state store for the
CI-driven broken-master auto-repair subsystem (`chain-read` /
`chain-write`; design §1/§4). The ref points at an empty-tree commit
whose *message* holds the chain fields (`Current-Head`, `Last-Green`,
`First-Red`, `State`, `Repair-Mode`, `Repair-Issue`, `Repair-Attempt`);
each write's first parent is the prior chain commit, so the ref is the
chain's audit history. `<branch>` is percent-encoded to one ref-safe
path component so a slashed branch (`release/v1`) can't D/F-conflict with
a plain `release` ref. Writes are compare-and-set: an atomic
`--force-with-lease` push + readback (concurrency) **plus** a stale-run
guard that refuses a `--for-sha` already superseded by a newer stored
`Current-Head` (out-of-order CI). See `scripts/task-dag.d/ci-chains.sh`.

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

## Born-claimed children (`breakdown ... "claim": true`)

To close the same-issue root/leaf race without a fragile claim-after-create
window, `breakdown` accepts a per-child `"claim": true` flag. Such a child
is created **already claimed by the caller**: in the same atomic push,
`breakdown` publishes its `tasks/active/<short>` ref (a normal claim
commit, attributed via `TASK_DAG_CLAIMER` / `_HOST` / `_PID` /
`TTL_HOURS`) and does **not** publish a `tasks/frontier/<short>` ref. The
child therefore never exists as a pickable frontier ref, so no other
worker can race to take it (zero window).

An epic-root worker uses this to atomically reserve the child(ren) it will
implement itself: decompose with those children marked `"claim": true`,
then do the work and `task-dag complete <child>` each one (same claimer
identity). Unmarked children remain ordinary frontier leaves for the
fleet. A born-claimed child is recovered exactly like any other claim
(claim-commit TTL, `claim --force`, same-host PID reaping) and can be
handed back with `release` (active -> frontier) if the worker decides not
to do it. `breakdown --json` reports `"claimed": true|false` per child.

## Known gaps (tracked)

Both stem from the two facts above and are the root cause of observed
duplicate-worker incidents (e.g. mostly-static-sites #14, where an
epic-root worker decomposed *and* implemented while a second worker
independently implemented the freshly-minted leaf):

1. **Epic roots are not cross-host claimable.** Two hosts can dispatch
   the same `tasks/pending/<N>` before any leaf exists.
2. **The root/leaf split is only as safe as the root worker's
   decomposition.** Born-claimed children (above) give a root worker a
   zero-race way to reserve its own implementation work, but a root
   worker that decomposes into *plain* (unclaimed) leaves and then also
   implements them still self-duplicates. This is enforced by the worker
   contract, not the DAG.

A first-class, cross-host-claimable epic-root state (or converting roots
into claimable frontier tasks) would close gap 1, but it is a lifecycle
redesign that must preserve pending-root identity for closure,
delegation, and comment ancestry. Tracked as a task-dag design issue.
The born-claimed-child primitive closes the same-host root-vs-own-leaf
race when the root worker uses it; the host-local enforcement half
(decompose-only-or-born-claim root contract +
same-host leaf suppression while a root claim is active) lives in the
worker fleet; see `Nicponskis/github-worker:docs/DISPATCH_CONCURRENCY.md`.
