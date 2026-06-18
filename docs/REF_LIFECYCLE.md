# Task ref lifecycle (`pending` / `root-active` / `frontier` / `active` / `blocked`)

How the CLI and the issue-to-task workflows move a unit of work through
the git-ref namespaces, including the cross-host **epic-root
orchestration lock** that closes the root/leaf double-dispatch
(`virusdave/task-dag#2`).

## The namespaces

| Ref | Created by | Meaning | Removed by |
|---|---|---|---|
| `tasks/pending/<N>` | issue-to-task workflow on issue open/edit/reopen (`create-task-commit.sh`) | **Epic root / identity** for issue `#N`. The durable identity used by closure (`close-epic` / `close-completed-issues.sh`), cross-repo delegation, and comment-ingest ancestry. It is an *identity*, **not** a lock. | Intentionally **kept** for the issue's life; deleted by `close-completed-issues.sh` when the epic closes. |
| `tasks/root-active/<N>` | `task-dag claim-root <N>` | The cross-host **orchestration lock** on the epic root: "this host is decomposing issue `#N`." Atomic CAS, keyed by issue number, recording Claimer / Claimer-Host / Claimer-PID / Claimed-At, exactly like a leaf claim. | `task-dag breakdown` (which **consumes** it when it publishes the leaves), `release-root`, or `close-completed-issues.sh`. |
| `tasks/frontier/<short>` | `task-dag breakdown` (run by an agent that holds the root lock) | A claimable **implementation leaf**. One per child task, published up front. | `task-dag claim` (renamed to `active`) or `complete`/`drop`. |
| `tasks/active/<short>` | `task-dag claim` | The cross-host distributed lock on a leaf: this leaf is in flight. The claim commit records Claimer / Claimer-Host / Claimer-PID / Claimed-At. | `complete` (lands the task) or `release` (back to `frontier`). |
| `tasks/blocked/<sha>` | `task-dag block` | Parked: stays in the DAG, listed by `blocked`, never dispatched. The overlay ref points straight at the task commit (source of truth for "is this task blocked"). | `unblock` / `complete` / `drop`. |
| `tasks/blocked-meta/<sha>` | `task-dag block` | Optional **side metadata** for a parked task: a deterministic side-commit (tree == task tree, first parent == task commit) whose body records `Blocker-Kind` (`operator`/`downstream`), durable `Reason`, optional `Request-URL`, derived `Repo`/`Issue`/`Source-URL`, and `Blocked-By`/`Blocked-Host`/`Blocked-At`. Consumed by the operator-blocked #29 dashboard so it need not reparse task bodies. A blocked task with **no** meta ref (a legacy block) is still fully valid. | `unblock` / `complete` / `drop` (cleared in lockstep with the overlay ref). |

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

## Epic-root orchestration is cross-host claimable (CAS)

`tasks/pending/<N>` is the durable epic identity, so it is **never moved
or renamed** — which is exactly why the leaf claim CAS (which *renames*
`frontier`→`active`) cannot protect it. Instead, a **second, parallel
lock ref** protects root orchestration:

`task-dag claim-root <N>` performs an atomic `git push --atomic` whose
real cross-host mutex is a create-only `--force-with-lease` on
`tasks/root-active/<N>` (it must not yet exist) — two simultaneous
`claim-root` calls cannot both land. The claim commit carries a unique
`Claim-ID:` nonce so distinct lock *epochs* always have distinct tokens.
It is followed by:

1. an origin readback confirming `tasks/root-active/<N>` holds **our**
   claim commit,
2. an authoritative pending readback confirming `tasks/pending/<N>` still
   points at the root we claimed (a client-side pending lease is included
   too, but git skips up-to-date refs so that lease is only best-effort —
   the readback is the real check), and
3. a post-claim re-check that the root has not been decomposed in the
   meantime; if it has, we drop our own claim and bail (and report loudly
   if that drop fails, so a stale lock is never left silently).

`release-root <N>` drops the lock again and — unlike leaf `release` —
never creates a frontier ref (a root is not a leaf).

`task-dag roots` (and `roots --pickable`) lists epic roots with their
state — `decomposed` / `claimed` / `pickable` — as the discovery surface
a dispatcher uses to spawn exactly one root/decompose worker per issue.

## Breakdown requires and consumes the root lock

`task-dag breakdown <root>` of a pending epic root now **requires** the
caller to hold `tasks/root-active/<N>` (and to be the lock's owner —
`Claimer`/`Claimer-Host` must match; take over a dead lock with
`claim-root --force`, not `breakdown --force`), and **consumes** it: the child
`tasks/frontier/<short>` refs are published and `tasks/root-active/<N>` is
deleted in the **same atomic push**, whose real cross-host mutex is a
`--force-with-lease` asserting `tasks/root-active/<N>` is still the lock
SHA we hold (a paired best-effort, client-side `pending/<N>` lease is
included too, but git skips up-to-date refs so it is not a server-side
assertion — and an undecomposed root's `pending/<N>` is never legitimately
moved anyway). `--force` only permits a *second* breakdown despite existing
children; it does **not** bypass the lock.

Consequences:

- **No duplicate breakdown across hosts.** Only the host that won
  `claim-root` can decompose; the loser cannot `breakdown` (no lock).
- **No implement-after-leaves window.** The instant the leaves exist, the
  root lock is gone, so a root worker cannot keep "implementing the root."
  If the lock was released/stolen mid-flight, the atomic push fails and
  **no leaves are created**.
- **Identity preserved.** `pending/<N>` is never moved, so closure,
  delegation, and comment ancestry are unaffected. Decomposing a non-root
  (intermediate) task needs no root lock.

`task-dag complete` additionally refuses to complete a pending root that
has children: a decomposed epic's work lives in its leaves and the epic is
closed by `close-epic` / `close-completed-issues.sh`, never by completing
the (empty) root commit. This guard runs **before** any completion side
effect and is not bypassable with `--force`.

## Born-claimed children (`breakdown ... "claim": true`)

To let a root worker reserve its own implementation work without a fragile
claim-after-create window, `breakdown` accepts a per-child `"claim": true`
flag. Such a child is created **already claimed by the caller**: in the
same atomic push, `breakdown` publishes its `tasks/active/<short>` ref (a
normal claim commit, attributed via `TASK_DAG_CLAIMER` / `_HOST` / `_PID`
/ `TTL_HOURS`) and does **not** publish a `tasks/frontier/<short>` ref.
The child therefore never exists as a pickable frontier ref, so no other
worker can race to take it (zero window).

An epic-root worker uses this to atomically reserve the child(ren) it will
implement itself: decompose with those children marked `"claim": true`,
then do the work and `task-dag complete <child>` each one (same claimer
identity). Unmarked children remain ordinary frontier leaves for the
fleet. A born-claimed child is recovered exactly like any other claim
(claim-commit TTL, `claim --force`, same-host PID reaping) and can be
handed back with `release` (active -> frontier) if the worker decides not
to do it. `breakdown --json` reports `"claimed": true|false` per child.
Because `breakdown` itself now consumes the root lock (above), even a
born-claimed decomposition happens under the single cross-host root CAS.

## End-to-end

```diagram
issue #N opened
      │  create-task-commit.sh
      ▼
tasks/pending/<N>            (identity, durable, never moved)
      │  task-dag claim-root <N>   (atomic CAS, one host wins)
      ▼
tasks/root-active/<N>        (orchestration lock held)
      │  task-dag breakdown <root> (atomic: publish leaves + delete lock)
      ▼
tasks/frontier/<short> ...   (claimable leaves)   tasks/root-active/<N> gone
      │  task-dag claim <short>
      ▼
tasks/active/<short>         (leaf in flight)
      │  task-dag complete <short>
      ▼
leaf landed → epic closes (close-completed-issues.sh deletes
              tasks/pending/<N> and any stale tasks/root-active/<N>)
```

## History (closed gap)

Before `#2`, epic roots had **no** cross-host claim protection (only each
host's local worker state file), and `breakdown` left the root concept
coexisting with the new leaves with nothing relating them under one lock.
Two distinct SHAs (root + its leaf) could be dispatched for one issue —
e.g. `Nicponskis/mostly-static-sites#14`, where an epic-root worker
decomposed *and* implemented while a second worker implemented the
freshly-minted leaf. The `tasks/root-active/<N>` lock + breakdown
consumption + the root `complete` guard close both halves of that gap.

The host-local half of the mitigation (a decompose-only root prompt
contract + same-host leaf suppression while a root claim is active) lives
in the worker fleet; see
`Nicponskis/github-worker:docs/DISPATCH_CONCURRENCY.md`.
