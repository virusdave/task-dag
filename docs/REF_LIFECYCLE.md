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
| `tasks/blocked/<sha>` | `task-dag block` | Parked: stays in the DAG, listed by `blocked`, never dispatched. The overlay ref points straight at the task commit (source of truth for "is this task blocked"). | `unblock` / `complete` / `drop`; **also** `close-completed-issues.sh` (via `cleanup-closed-issue-task-refs.sh`) for any of the closed issue's tasks — most often the epic ROOT, which is closed by the `Closes-Epic` merge and so never `complete`d. |
| `tasks/blocked-meta/<sha>` | `task-dag block` | Optional **side metadata** for a parked task: a deterministic side-commit (tree == task tree, first parent == task commit) whose body records `Blocker-Kind` (`operator`/`downstream`), durable `Reason`, optional `Request-URL`, derived `Repo`/`Issue`/`Source-URL`, and `Blocked-By`/`Blocked-Host`/`Blocked-At`. Consumed by the operator-blocked #29 dashboard so it need not reparse task bodies. A blocked task with **no** meta ref (a legacy block) is still fully valid. | `unblock` / `complete` / `drop` (cleared in lockstep with the overlay ref); **also** `close-completed-issues.sh` on epic close. |

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

## Born-blocked epics (block at birth via label)

An issue-originated epic can be created **already blocked** so the
github-worker dispatcher never picks it up in the window between the
`issue-to-task` workflow minting `tasks/pending/<N>` and a *separate*
`task-dag block` landing (the race that motivated
[virusdave/top-level#36](https://github.com/virusdave/top-level/issues/36)).

The trigger is a GitHub label — **`blocked-at-birth`** — present on the
issue at **first sighting**. When `create-task-commit.sh`
([`.github/scripts/create-task-commit.sh`](../.github/scripts/create-task-commit.sh))
mints the epic, it adds `tasks/blocked/<epic-sha>` to the **same
`git push --atomic`** that publishes `pending/<N>` + `gh/issues/<N>`. The
dispatcher already skips a pending root whose blocked overlay exists
(`is_task_blocked`, checked before the pre-claim in github-worker's
`worker-loop.sh`), and both refs reach origin atomically, so there is
**never** a dispatchable-but-unblocked window. Then, best-effort, the
script invokes the canonical `task-dag block <sha> --operator` to attach
the `blocked-meta` side-commit for the operator-blocked #29 dashboard —
the CLI stays the single source of truth for the meta format; if that
enrichment fails the epic is still blocked and merely renders as
`kind:"unknown"` until a later `task-dag block` enriches it idempotently.

Invariants that keep this safe:

- **First-sighting only.** The label logic runs solely on the create path
  (reached only when the epic did not previously exist on origin). An
  edit/reopen of an already-tracked issue returns from the create-only
  guards *before* the label logic, so a **stale label can never re-block
  an epic the operator has already unblocked**. This is regression-tested
  in [`tests/create-task-commit.sh`](../tests/create-task-commit.sh).
- **The overlay is the blocking mechanism; the meta call is enrichment
  only.** Never reorder so that meta-attachment becomes load-bearing —
  that would reopen the race.
- **The label is a birth *trigger*, not synced state.** After a
  `task-dag unblock` the label lingers on the issue; the `blocked` overlay
  ref remains the sole authority for "is this blocked". Toggling a block
  from the label *after* creation is intentionally **not** wired (see
  deferred work below). The trigger-shaped name (`blocked-at-birth`, not
  `blocked`) is chosen so the lingering label reads as history, not a lie.
- **Per-repo label.** The feature only fires in repos where the
  `blocked-at-birth` label exists (GitHub requires the label to exist
  before it can be applied). Create it once per repo that wants it.

### Deferred, by design (recorded so a future implementer inherits the traps)

- **Born-blocked *leaf* tasks via `breakdown` (`"blocked": true`).**
  Deferred: children decomposed under a blocked epic are already
  born-unpickable via the transitive-block filter, and an agent that
  creates a task then blocks it is a single writer with no async race.
  **If implemented:** a born-blocked child must publish its
  **frontier ref + blocked overlay + blocked-meta in the same atomic
  push** — do *not* mirror `claim:true`'s frontier-ref *skip*. `block`
  never creates a frontier ref and `unblock` only deletes the overlay, so
  a born-blocked child with no frontier ref would be permanently
  undispatchable after `unblock`.
- **Post-creation label toggling (`labeled`/`unlabeled` events →
  block/unblock).** Deferred: birth is already covered above; this only
  adds a GitHub-UI toggle after creation. **If implemented:** (1) any
  handler sharing the per-issue concurrency group must be *convergent*
  (reconcile from current origin state + the event's full issue snapshot,
  i.e. extend `create-task-commit.sh` rather than adding a block-only
  handler) so a `labeled` run arriving while the `opened` run is still
  pending can't cancel epic creation; and (2) `unlabeled` must only
  unblock a block that was **label-originated** (recognizable via
  `blocked-meta`), never a `--downstream` or manual CLI block.

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
              tasks/pending/<N>, any stale tasks/root-active/<N>, and any
              lingering tasks/blocked|blocked-meta|frontier for the issue
              — via cleanup-closed-issue-task-refs.sh)
```

## Blocked-overlay cleanup on epic close

`task-dag complete <sha>` clears a task's own `blocked`/`blocked-meta`
overlay in lockstep (see `cleanup_completed_task_refs`), so completed
**leaves** self-heal. But an epic **root** is closed by the additive
`Closes-Epic: #<N>` merge — `close-completed-issues.sh` — and is *never*
`complete`d, so if the root (or a stray leaf) was parked (e.g.
github-worker's `autopark_unprogressed_task` when an agent abandoned a
claim), its blocked overlay had nothing to clear it. The closed issue then
lingered forever in the operator-blocked #29 dashboard, which rebuilds
purely from live `blocked` refs (see FreshlyBakedNYC/automation#6).

`close-completed-issues.sh` now delegates to
`.github/scripts/cleanup-closed-issue-task-refs.sh`, which — for the closed
issue only, matched on **(repo, issue)** so a cross-repo block referencing
the same number survives — deletes each matching task's `frontier/<short>`
**first** (leased, so a blocked leaf can't briefly become pickable and get
re-dispatched), then its `blocked/<sha>` + `blocked-meta/<sha>`. It leaves
`active/*` alone (the owning worker CAS-cleans that on `complete`). Fixture
coverage: `tests/task-dag/close-issue-ref-cleanup.sh`.

**Follow-up (not yet done):** the *manual*-close path
(`page-on-manual-issue-close.sh`) still performs **no** ref cleanup at all
— an operator manually closing a task-tracked issue orphans its
`pending/<N>`, `root-active/<N>`, and any `blocked` overlay. Tracked
separately; the extracted `cleanup-closed-issue-task-refs.sh` is
deliberately reusable by that path.

## Closing an ops-only (no-code) epic (`close-ops-epic`)

Some epics are resolved by a real-world **operations action** — reboot a
host, flip a manual switch, run a one-off maintenance task — that produces
**no implementation commit to link** and has **no cross-repo delegated
children** (the trigger was `virusdave/top-level#37`, "operator go: reboot
vps3"). Such an epic-root fits none of the existing closers:

- `complete <root>` refuses (the root-completion guard above; it also
  rejects an empty/tombstone link — there is no implementation commit);
- `close-epic --issue N` refuses ("no delegated children to gate close
  on" — its gating is built entirely around cross-repo delegated children);
- hand-authoring the `Closes-Epic:` merge is exactly the ref surgery
  `docs/INVARIANTS.md` forbids.

`task-dag close-ops-epic --issue N [--yes] [--reason "..."]` fills that one
cell of the matrix — **{undecomposed root × no delegations × no
implementation commit}**. It emits the **same** additive, tree-equal
`Closes-Epic: #<N>` merge every other closer relies on (tree == master
tip's tree, first parent == master tip, second parent == the
`tasks/pending/<N>` commit, trailer `Closes-Epic: #<N>`), constructed **by
the tool**, and pushes it to `origin/master`; `close-completed-issues.sh`
then closes the issue and cleans up `tasks/pending/<N>` + any overlay refs
exactly as for any other close. It mints **no new ref namespace and no new
trailer**, so it stays within the invariant floor (nothing to add to
`TASKDAG_KNOWN_*_NS`).

It is **not** the closer for a decomposed epic (complete the leaves / use
`close-epic`); it is a **guarded, last-cell** tool. Every guard **fails
closed** — it refuses rather than risk a premature/abusive close:

- confirms the `tasks/pending/<N>` root identity on **origin** (origin
  unreachable → refuse), mirroring `complete`'s root guard;
- refuses if the epic has **any DAG child tasks** — decomposition, live
  `frontier`/`active`/`blocked` leaves, or ingested-comment task nodes
  (every such leaf is a DAG child of the root, so "no children" ⇒ no live
  work to strand);
- refuses if the epic has **cross-repo delegated children** (that is
  `close-epic`'s job, gated on their completion);
- refuses if the epic **root itself is blocked** (unblock it first — a
  parked root closing as "ops done" would contradict the parked state);
- refuses if a **foreign, still-live `tasks/root-active/<N>`** decompose
  lock is held by another worker (closing under it would prune the leaves
  they are about to publish); our own lock (the dispatcher pre-claim) or a
  provably-dead lock is fine;
- a **non-interactive caller must pass `--yes`** (explicit confirmation).

It is **idempotent** and race/stale-tip safe: a re-run once the close merge
is on `master` — even after `close-completed-issues.sh` has already deleted
`tasks/pending/<N>` (in which case it matches the `Closes-Epic: #<N>`
trailer on `master` directly, since the epic SHA is gone) — is a no-op
success. Duplicate-close is prevented on both sides of the push: it
re-checks for an existing close against the exact `origin/master` tip it is
about to parent on (catching a concurrent close that already landed), and a
close that lands *after* that fetch makes the push a non-fast-forward
rejection that a re-run converges from — so at most one close merge is ever
created. Fixture coverage: `tests/task-dag/close-ops-epic.sh`.

> Full closure-signal contract and the `complete` vs `close-epic` vs
> `close-ops-epic` decision: `virusdave/top-level:docs/task_dag/EPIC_CLOSURE.md`.

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
