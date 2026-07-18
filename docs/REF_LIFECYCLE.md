# Task ref lifecycle (`pending` / `root-active` / `frontier` / `active` / `blocked`)

How the CLI and the issue-to-task workflows move a unit of work through
the git-ref namespaces, including the cross-host **epic-root
orchestration lock** and born-claimed leaf handoff that close the
root/leaf double-dispatch path (`virusdave/task-dag#2` and
`virusdave/task-dag#3`).

## The namespaces

| Ref | Created by | Meaning | Removed by |
|---|---|---|---|
| `tasks/pending/<N>` | issue-to-task workflow on issue open/edit/reopen (`create-task-commit.sh`) | **Epic root / identity** for issue `#N`. The durable identity used by closure (`close-epic` / `close-completed-issues.sh`), cross-repo delegation, and comment-ingest ancestry. It is an *identity*, **not** a lock. | Intentionally **kept** for the issue's life; deleted by `close-completed-issues.sh` when the epic closes. |
| `tasks/root-active/<N>` | `task-dag claim-root <N>` | The cross-host **orchestration lock** on the epic root: "this host is decomposing issue `#N`." Atomic CAS, keyed by issue number, recording Claimer / Claimer-Host / Claimer-PID / Claimed-At, exactly like a leaf claim. | `task-dag breakdown` (which **consumes** it when it publishes the leaves), `release-root`, or `close-completed-issues.sh`. |
| `tasks/frontier/<short>` | `task-dag breakdown` (run by an agent that holds the root lock) | A claimable **implementation leaf**. One per child task, published up front. | `task-dag claim` (renamed to `active`) or `complete`/`drop`; **also** `reconcile-closed-issue` (frontier-first) for a confirmed-CLOSED issue's tasks. |
| `tasks/active/<short>` | `task-dag claim` (or `breakdown ... "claim": true` / `breakdown --claim-first`, born-claimed) | The cross-host distributed lock on a leaf: this leaf is in flight. The claim commit records Claimer / Claimer-Host / Claimer-PID / Claimed-At. | `complete` (lands the task), `release` (back to `frontier`), or `task-dag breakdown <this-task>` which **consumes** our own claim when we recursively decompose the claimed task (mirrors root-lock consumption — see "Recursive breakdown consumes the parent's claim" below). |
| `tasks/blocked/<sha>` | `task-dag block` | Parked: stays in the DAG, listed by `blocked`, never dispatched. The overlay ref points straight at the task commit (source of truth for "is this task blocked"). | `unblock` / `complete` / `drop`; **also** `close-completed-issues.sh` (via `cleanup-closed-issue-task-refs.sh`) for any of the closed issue's tasks — most often the epic ROOT, which is closed by the `Closes-Epic` merge and so never `complete`d — and `reconcile-closed-issue` for out-of-band (manual) closes. |
| `tasks/blocked-meta/<sha>` | `task-dag block` | Optional **side metadata** for a parked task: a deterministic side-commit (tree == task tree, first parent == task commit) whose body records `Blocker-Kind` (`operator`/`downstream`), durable `Reason`, optional `Request-URL`, derived `Repo`/`Issue`/`Source-URL`, and `Blocked-By`/`Blocked-Host`/`Blocked-At`. Consumed by the operator-blocked #29 dashboard so it need not reparse task bodies. A blocked task with **no** meta ref (a legacy block) is still fully valid. | `unblock` / `complete` / `drop` (cleared in lockstep with the overlay ref); **also** `close-completed-issues.sh` on epic close. |
| `tasks/repair-superseded/<64-hex>` | `repair-retire` | Immutable empty-tree audit of one fenced repair projection retirement. Its semantic identity binds repository, branch, first-red, and retired issue; its sole parent is the authorizing chain state. It is never scheduling work. | Never deleted or rewritten; a later retirement pass validates it before cleaning any late projection. |

## Edge-era data refs: bounded state, not task lifecycle refs

The issue #13 north-star adds two data-in-tree ref kinds that sit beside the
task lifecycle above without changing what `pending` / `frontier` / `active`
/ `blocked` mean:

- `tasks/v1/graph` — the per-repo dependency-edge index. Its latest tree is
  the active edge set (`edges/<semantic-edge-id>.json` plus explicit
  `tombstones/<edge-id>.json` for deliberate unsatisfied removals). It is a
  fixed single ref per repo, never one ref per dependency.
- `tasks/v1/mailbox/00` .. `tasks/v1/mailbox/0f` — the 16 fixed cross-repo
  notification shards. Message blobs are short-lived hints that a completion
  happened elsewhere; they are consumed by fold-before-delete and can always be
  re-derived by the backstop from the source repo's `master`.

These refs are the only empty-tree exceptions in the task namespace. They are
fast-forward-only branches whose commits parent the previous data-ref tip, not
task commits. `validate --strict` audits their exact tree shape; everything
else under `tasks/v1/*` is still an unknown namespace error. See
[`INVARIANTS.md`](./INVARIANTS.md) for the blob schemas and
[`DESIGN_PRINCIPLES.md`](./DESIGN_PRINCIPLES.md) for why the bounded-ref
invariant is load-bearing.

## How dependency state now converges

All dependency-style lifecycle changes reduce to the same durable edge model:

- `delegate` writes the legacy delegation ref **and** a `requires` edge from
  the parent epic/root task node to the child issue node once the legacy ref is
  proven durable on origin.
- `block --downstream --on <node>` still parks the task with the normal blocked
  overlay, then writes `requires` edge(s) from that task to each explicit
  downstream node. If the edge write fails, the task remains safely blocked;
  rerunning the same command is idempotent and converges the missing edge.
- `supersede <node> --by <node>` is edge-only: it writes one `satisfies` edge.
  Once the `--by` node is durably done, graph convergence synthesizes the
  superseded local leaf's normal completion merge (unless it is an epic or is
  actively claimed, both fail closed).

Completion is still a durable `master` fact: a task is complete when its task
commit appears as a non-primary parent of a reachable completion merge, and an
issue/epic is closed by a reachable `Closes-Epic: #N` merge. The fact layer
derives `done()` from `master` in memory; it never mints per-fact refs. The
reconciler then folds satisfied edges by direct CAS on the owning repo's graph
ref, sends/consumes cross-repo mailbox hints, cascades newly durable
completions, and auto-closes obligation-complete epics with the normal close
merge shape.

### Materialisation declarations are obligations before their refs exist

A reachable `Materialise-Child-Epic:` group for parent `#N` is an obligation
declaration as soon as its commit is in the candidate close history. Its three
durable projections are created asynchronously, in safety order:

1. `gh/child-epics/<N>/<owner>/<repo>` (or the named-slot namespace) records
   the peer issue, preventing duplicate issue creation;
2. `tasks/delegated/<N>/<owner>/<repo>/<peer-issue>` records the legacy
   delegation; and
3. the parent-root `requires` edge records the dependency in `tasks/v1/graph`.

Every close producer fails closed until all three exist (or the edge has an
explicit terminal tombstone). This includes local completion auto-close,
graph convergence, and the three explicit epic closers. Therefore a GitHub
push cannot close an epic merely because graph convergence ran before the
materialisation workflow. If a run fails after publishing the marker, the
next materialisation replay reads the peer issue from that marker and reruns
the idempotent `delegate` dual-write; marker-only state is never accepted as
fully materialised.

## Graph and mailbox writes are direct CAS with bounded backoff

The graph writer and mailbox writer do not stage work through task refs or
manual ref surgery. Each mutation is:

1. sync the current data-ref tip (or prove the remote ref is absent),
2. recompute the latest tree in a scratch index,
3. commit that tree with the prior data-ref tip as the only parent,
4. push with a fast-forward lease and readback confirmation, and
5. on contention, refetch/recompute/retry with jittered quadratic backoff
   (roughly one second up to roughly ten seconds), then fail loud if the retry
   budget is exhausted.

This makes graph/mailbox writes commutative and idempotent under normal races:
two writers adding different edges/messages converge to the union; a failed or
crashed consumer leaves a retryable hint or active edge rather than an
unrecoverable partial state.

## Mailbox garbage collection is delete-on-consume

Mailbox messages are triggers, not facts. `mailbox consume` deletes a message
only after the injected fold command exits successfully for that specific
message. There is no ack ledger, `consumed_at` ref, or dedup branch. Replays are
safe because folds are idempotent and the durable effect is visible on
`master`; lost hints are recovered by `reconcile-backstop`, which re-derives
foreign/local done facts from configured peer worktrees and the owning repo's
graph.

## Non-task namespace: CI repair chains (`tasks/ci-chains/...`)

`refs/heads/tasks/ci-chains/<owner>/<repo>/<branch>` is **not** a task
workflow ref — it is the durable per-repo/branch state store for the
CI-driven broken-master auto-repair subsystem (`chain-read` /
`chain-write`; design §1/§4). The ref points at an empty-tree commit
whose *message* holds the desired repair state, bounded observation/evidence,
accepted registry generation and enrollment mode, reconciliation diagnostics,
and the `Reconcile-Lease-Owner`, `Reconcile-Lease-Until`, and monotonically
increasing `Reconcile-Fence` coordination tuple. `Reconcile-Operation-ID`
uniquely identifies the most recent multi-ref retirement transaction. The
complete field list and canonical order live in `_CICHAIN_FIELDS` in `ci-chains.sh`;
each write's first parent is the prior chain commit, so the ref is the
chain's audit history. `<branch>` is percent-encoded to one ref-safe
path component so a slashed branch (`release/v1`) can't D/F-conflict with
a plain `release` ref. Writes are compare-and-set: an atomic
`--force-with-lease` push + readback (concurrency) **plus** a stale-run
guard that refuses a `--for-sha` already superseded by a newer stored
`Current-Head` (out-of-order CI). See `scripts/task-dag.d/ci-chains.sh`.

`reconcile-lease` is the only public lease writer. It uses the same internal
compare-and-set serializer without changing `Current-Head` or any classifier
field. Acquisition after an absent, unlocked, or expired lease increments the
retained fence exactly once. Renewal requires the same owner and matching
fence and retains that fence. The five-minute deadline and `Updated-At` derive
from the caller's canonical, already clock-skew-validated `--now`; host time is
not lease authority. Partial, duplicate, noncanonical, or exhausted stored
tuples fail closed without a ref mutation.

`repair-retire` validates one coherent origin snapshot against an authenticated
repair-issue observation, then rechecks the exact chain token and live
owner/fence/deadline. Its destructive push advances the chain to a unique
operation child while creating the absent audit and deleting every classified
projection with exact leases, all atomically. A replay validates but never
rewrites the historical audit, and uses a new current chain transition to clean
late projections. Push status is advisory: an unconditional fresh origin
snapshot and classification distinguish current clean success from
stale-accepted, accepted-incomplete, conflict, and unconfirmed outcomes.

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

### Recursive breakdown consumes the parent's claim (`virusdave/top-level#53`)

The self-continue-after-breakdown contract lets a worker that decomposed a
root, born-claimed a child, and continued into it *recursively decompose
that claimed child* in the same session. When `breakdown <parent>` is run
on a **non-root** parent that carries a `tasks/active/<short>` claim
**owned by the caller** (`TASK_DAG_CLAIMER` / `_HOST` match), it **consumes
that active claim in the same atomic create-only push** that publishes the
grandchildren — exactly mirroring how a root breakdown consumes
`tasks/root-active/<N>`. The `--force-with-lease` at the exact claim SHA is
the cross-host mutex: the grandchildren appear only if our claim is still
there, and it disappears the instant they exist.

This closes a real stall: without it the parent's claim would survive the
decomposition, and the dispatcher's post-agent "sweep owned claims" pass
would block-first-release that now-**structural** parent, transitively
making its grandchildren unpickable. A **foreign** active claim on the
parent makes `breakdown` **refuse** (re-`claim --force` only if that holder
is dead); an indeterminate origin read also refuses (fail closed). A parent
with no active claim (an ordinary frontier leaf or a completed task)
decomposes unchanged — nothing to consume.

To continue straight into the first ready child without hand-marking the
spec, `breakdown --claim-first` born-claims **exactly** the
topologically-first dependency-ready child (the first entry whose deps are
all empty or already-completed external commits); it is mutually exclusive
with a per-child `"claim": true`, and **errors before any mutation** if no
child is dependency-ready (a breakdown with nothing to continue into is a
genuine dependency block, not a silent no-op). `breakdown --json` now also
reports each child's published `ref` so a caller can switch to the
born-claimed child deterministically.

### Completing several sibling leaves in one worktree (`virusdave/task-dag#7`)

When a root worker implements two+ born-claimed siblings in the **same
worktree**, it naturally stacks their implementation commits on `master`
(`… → S → C`, `HEAD=C`) and then completes each. The design law is that a
completion is a **git parent-edge**, not a message tag: every completion
merge's **first parent is that leaf's implementation commit** and its
second parent is the leaf's task commit (see
[`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md) — semantics live in the git
DAG). Keeping that invariant true for a *stack* of impls is what the batch
form does.

#### Single `complete <leaf> --commit=<sha>`

Handles only the two cases where first-parent-==-impl needs no local
rewrite:

- `<sha> == HEAD`: the completion merge is built on `HEAD` (normal path).
- `<sha>` is **ahead of** `HEAD`: the merge is built on `<sha>` and `HEAD`
  fast-forwards up to it (may touch tracked files).
- `<sha>` is **behind** `HEAD` (an already-stacked earlier sibling's
  impl): **refused**, with a pointer to the batch form. Completing it in
  place would either break first-parent-==-impl or silently rewrite local
  history, so it must be explicit.

`complete` still refuses a `--commit` that is an empty task/control/
completion commit, or one that is neither an ancestor nor a descendant of
`HEAD`.

#### Batch `complete --leaves=<leaf>:<impl>[,<leaf>:<impl>…]`

Completes a whole stack in one shot. The impls must all be **unpushed**
commits on the *linear* range `origin/master..HEAD` (proven against a
freshly fetched `origin/master`). task-dag walks the chain oldest→newest,
**replaying** each commit onto the running tip and inserting a completion
merge immediately above each impl, yielding an honest linear graph:

```
origin/master → S → M_S → C' → M_C   (HEAD)
```

where `M_S`/`M_C` are the completion merges (first parent = the impl,
second parent = the task commit). Note that any commit replayed **above**
an inserted merge is a new commit (`C'`), so a later merge's first parent
is the *replayed* impl, not the original SHA you passed in `--leaves`
(`M_C^1 == C'`, not the input `C`); the input SHA only has to identify the
impl in the pre-graft `origin/master..HEAD` range. This is a **local,
non-fast-forward rewrite of unpushed commits only** — the final tree equals the old
`HEAD`'s, so the worktree/index are untouched, the old tip is saved under
`refs/task-dag-backup/complete-batch/*` (and the reflog), and the later
`task-dag publish` is still a fast-forward publication of master together
with the semantic generation.

Safety gates (all enforced before any ref moves):

- Freshly fetches `origin/master`; refuses unless `HEAD` is ahead of it
  and the range is linear (no merges), i.e. the rewritten window is
  provably local/unpushed.
- Refuses duplicate leaves or two leaves naming the same impl commit.
- Each impl must be a real work commit in-range (not a task/control commit,
  and its tree must differ from its first parent).
- Refuses to reparent a **GPG-signed** commit (would drop the signature).
- Verifies claim ownership of every leaf up front (`--force` to override a
  known-dead claim); refuses an epic root.
- Intra-batch **dependencies** must be satisfied by an already-completed
  task or an earlier leaf **in graft order** (the dependency's impl must
  be stacked below the dependent's).
- **Idempotent**: if all named leaves are already completed on `HEAD`, it
  makes no new commits and repeats the explicit push instruction (rc 0); a
  partial state (some completed) is refused so the caller re-runs with only
  the not-yet-completed leaves.
- A single CAS `update-ref HEAD` advance (never `git reset --hard`) after a
  backup ref is written. No remote ref is changed by `complete`.

Completion is still detected purely by the task commit appearing as a
non-primary parent reachable from `HEAD` (`is_task_completed` /
`close-completed-issues.sh`). (Retroactively linking work already on
`master` remains `complete-historical`.)

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
              — via cleanup-closed-issue-task-refs.sh; schedule/manual runs
              re-derive the same projection from master if the push path was
              missed)
```

## Blocked-overlay cleanup on epic close

After the explicit master push, `graph-converge` clears a completed task's own
`blocked`/`blocked-meta` overlay together with its other scheduling refs, so
completed **leaves** self-heal. An epic **root** is closed by the additive
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

The same close script is also the master-derived projection backstop. With a
push range it scans only the new commits for low-latency repair; with no
`BEFORE_SHA` (schedule / `workflow_dispatch`) it scans the current master tip
for sanctioned `Closes-Epic:` facts and re-applies the issue-close/ref-cleanup
projection idempotently. This makes GitHub issue state and scheduling refs a
repairable projection of `master`, not the source of task truth.

## Completed-leaf scheduling refs are a repairable projection

Completion commands (`complete`, batch `complete --leaves`, `complete-ops`, and
`complete-historical`) mutate only local `HEAD`. They neither publish master nor
delete local or remote scheduling refs; each prints the canonical next action,
`task-dag publish`. That fenced publication makes completion parentage durable
while atomically advancing the semantic generation. `graph-converge`, triggered
by the push and by scheduled/manual repair,
is the sole owner of completed-leaf scheduling-ref cleanup. Thus a crash or
rejected push leaves the task visible and claim state intact, while a successful
push followed by failed convergence remains repairable from durable master.

The reconciler takes one strict, pruned snapshot of `origin/master` and the
four scheduling namespaces. It treats a task as completed for cleanup only
when a tree-equal completion merge on master's **first-parent spine** names the
task as a non-primary parent. Restricting the witness to that spine is
load-bearing: structural and dependency task commits are reachable through a
completed child but are not themselves completed.

Cleanup uses the exact ref names and object IDs in the snapshot (never a newly
computed short SHA) as `--force-with-lease` expectations and removes all refs
for one task atomically. This safely removes even a stale active claim created
after completion became durable. A replacement claim, malformed projection,
transport failure, or rejected push is left untouched and makes the workflow
fail visibly; a later run takes a fresh snapshot and retries. `--no-fetch`
explicitly skips this mutation because a stale local view is not authoritative.

## Reconciling a CONFIRMED-CLOSED issue (`reconcile-closed-issue`)

The epic-close sweep above only fires on the sanctioned bot `Closes-Epic:`
push path and only enumerates **blocked** tasks. A task whose issue is
closed **out of band** (an operator closing it by hand — the common case
behind top-level#48) is skipped by the dispatcher (which prunes only the
*local* ref) while its authoritative `frontier`/`blocked`/`blocked-meta`
refs survive on origin and re-materialise on every fetch. Such a task —
frequently a **pickable frontier leaf**, which the epic-close sweep never
touched — clutters the frontier and dashboards forever.

`task-dag reconcile-closed-issue <issue> [--repo=owner/repo] [--dry-run]
[--json] [--yes]` closes that gap. It is **fail-safe**:

- confirms the issue is **CLOSED** live via `gh issue view … --json state`
  (its own three-valued `issue_state_remote`): `CLOSED` → reconcile; any
  other state (OPEN) → clean no-op exit 0; **undetermined** (gh missing /
  unauth / API error) → no-op + report, exit 3 (never assume closed);
- enumerates every task resolving to **(this repo, issue)** — both
  `frontier/<short>` refs (scanned directly, since `frontier`'s pickable
  listing hides blocked/not-ready rows) and `blocked` tasks (via the
  canonical `blocked --json` meta-overridden resolution); a cross-repo
  `Repo:` block referencing the same number is **not** a match;
- deletes `frontier/<short>` **first** under a `--force-with-lease` on the
  observed SHA (so a racing breakdown that re-pointed a short-sha ref is
  never clobbered and no pickable window opens), then the `blocked/<sha>` +
  `blocked-meta/<sha>` overlay only once the frontier is confirmed clear
  and only while origin still points the overlay at the expected task SHA;
- never touches `pending/<N>`, `root-active/<N>`, `active/*`,
  `delegated/*`, or the `gh/comments/<N>/<id>` provenance refs;
- is idempotent (a second run is a clean no-op) and emits a machine-
  readable `--json` audit (removed SHAs/refs, skipped items + reasons,
  counts) from which a mistaken reconcile is reversible.

Fixture coverage: `tests/task-dag/reconcile-closed-issue.sh`.

### Auditing closed-issue debris without acting (`validate --closed-issue-audit`)

`reconcile-closed-issue` *fixes* one issue's lingering refs. To *detect* the
debris across the whole DAG — e.g. from a scheduled fleet audit that pages
the operator — `task-dag validate --closed-issue-audit [--repo=owner/repo]
[--json]` surfaces (never deletes) exactly the refs reconcile would clean:

- It is the **only** validate mode that goes live. Plain `validate` and
  `validate --strict` stay **100% offline** (no `gh`, no fetch); the audit
  runs only behind this explicit opt-in flag.
- It shares the **one** candidate resolver (`closed_issue_candidate_rows`)
  with `reconcile-closed-issue`, so the two can never drift: same direct
  frontier scan + canonical `blocked --json` meta-overridden resolution,
  same repo filter (a cross-repo `Repo:` block referencing the same number
  is not a match), and the same "never touch `pending`/`root-active`/
  `active`/`delegated`/`gh/comments` refs" scope.
- It does a **strict** task-ref sync (a partial view could false-clean —
  the exact bug it exists to catch) then confirms each issue's state live,
  **grouped so gh is queried at most once per unique issue** (rate-limit
  safe). A **CONFIRMED-CLOSED** issue's lingering refs are reported as
  **errors** (exit 3), so an audit can gate/page; an **undetermined** state
  (gh missing/unauth/API error) is a **warning** with `complete:false` in
  the JSON, never assumed closed — exit 0 means "no confirmed debris found",
  **not** "proved clean".
- `--json` extends validate's summary with a `closedIssueAudit` object
  (`repo`, `complete`, `lingering:[{issue,state,refs,shas}]`, `undetermined`,
  and `counts`). The non-audit `--json` shape is unchanged.

Fixture coverage: `tests/task-dag/validate-closed-issue-audit.sh`.

## Completing an ops-only (no-code) leaf (`complete-ops`)

Some **leaf** tasks represent real operations work that is completed outside the
repository — a deployed migration artifact, a manual maintenance action, a
vendor-console switch — and therefore has no honest implementation commit. Do
not fabricate an empty commit and do not `drop` the task as irrelevant. Use:

```sh
task-dag complete-ops <task-sha> \
  --evidence https://github.com/owner/repo/issues/N#issuecomment-... \
  --authorization "operator approved on <issue/comment>" \
  --yes
```

`complete-ops` emits a **tree-equal completion merge** on local `HEAD`: first
parent is the freshly-fetched `origin/master` tip, second parent is the leaf
task commit, and the tree equals the first parent's tree. That parent edge is
the candidate completion fact; it becomes durable when the caller runs exactly
`task-dag publish`. The server reconciler then removes scheduling refs. The
message carries the existing completion trailers (`Task-Commit:` and
`Status: completed`) plus mandatory `Ops-*` audit trailers for evidence,
authorization, actor, host, and time.

Guard rails fail closed:

- `HEAD` must equal freshly-fetched `origin/master` before a new ops completion
  is minted, so the explicit push cannot include unrelated local commits;
- `--evidence` must be an `https://` URL and `--authorization` must be explicit;
  user-supplied trailer values are single-line only;
- pending epic roots, `Type: epic` tasks, and any node with DAG children are
  refused — complete the children, or use `close-ops-epic` for an undecomposed
  ops-only root;
- dependencies must already be complete on `origin/master`; `--force` only
  overrides a known foreign active claim and never bypasses dependencies or
  leaf/root/children guards;
- blocked leaves are allowed (this is the pergatory/no-code case); their
  `frontier`, `active`, `blocked`, and `blocked-meta` refs are cleaned with the
  same leased cleanup as `complete`, but only after the completion tip has been
  published to `origin/master`.

The command is idempotent: if the task is already complete on `origin/master`,
it mints no duplicate merge and only cleans stale scheduling refs it is allowed
to clean. Fixture coverage: `tests/task-dag/complete-ops.sh`.

The bot epic-close sweep (`cleanup-closed-issue-task-refs.sh`) also delegates
to `reconcile-closed-issue`, passing the matched epic-root parent as
`--hint-sha` so the belt-and-braces root cleanup still runs by exact task SHA
if candidate enumeration is incomplete. A hint is accepted only if the hinted
task commit resolves back to the same `(repo, issue)`; an incomplete sweep
remains a loud non-zero exit, and the hint only narrows the leftover debris.
The `issues:[closed]` automation that invokes reconcile
(`page-on-manual-issue-close.sh`) is child 3 of the parent epic
top-level#48.

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
`close-epic`, or use `close-completed-epic` only after a decomposed local
epic is already fully resolved but still lacks the close merge); it is a
**guarded, last-cell** tool. Every guard **fails closed** — it refuses rather
than risk a premature/abusive close:

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
> `close-ops-epic` vs `close-completed-epic` decision:
> `virusdave/top-level:docs/task_dag/EPIC_CLOSURE.md`.

## Closing a completed decomposed local epic (`close-completed-epic`)

`task-dag close-completed-epic --issue N --reason "..." [--yes]` covers the
post-convergence gap where an epic **was decomposed** into local task-dag
children, the child DAG is already resolved, and the issue still lacks the
tree-equal `Closes-Epic: #<N>` merge. The trigger was
`virusdave/top-level#59`: live rollout work had completed (or optional
non-participating repo work was explicitly dropped), `validate --strict` was
green, but `close-epic` refused because there were no delegated children and
`close-ops-epic` refused because the root had DAG children.

The command emits the normal close merge shape — tree == `origin/master`,
first parent == `origin/master`, second parent == `tasks/pending/<N>`, trailer
`Closes-Epic: #<N>` — and pushes it to `origin/master`. It does not mint a new
ref namespace or trailer.

Every guard fails closed:

- confirms `tasks/pending/<N>` on origin and treats an existing close merge as
  an idempotent no-op;
- requires the root to be decomposed (undecomposed ops-only roots still use
  `close-ops-epic`);
- refuses any cross-repo delegated children (use `close-epic`);
- proves the local DAG subtree complete from freshly-fetched `origin/master`
  and origin task refs; any frontier, active, blocked, or otherwise incomplete
  descendant remains an incomplete leaf and is refused;
- refuses a blocked root and any foreign live root-decompose lock;
- requires `--reason` so the close merge records the rollout/done evidence or
  operator-approved exception that makes the epic safe to close;
- requires `--yes` for non-interactive callers.

Fixture coverage: `tests/task-dag/close-completed-epic.sh`.

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
## GitHub comment receipt lifecycle

Comment ingestion first probes `origin` for
`gh/comments/<issue>/<comment-id>`. A valid winner is terminal even when a
local ref is absent or stale. Otherwise one coherent observation is classified
and a v1 receipt is prepared. Human receipts and frontiers, and completion
receipts and absent completion facts, are created by a mandatory atomic push
with create-only leases; skip receipts create no effect. Only origin readback
permits local mirroring. Receipts are immutable and are never retired; an edit
does not rewrite a receipt or mint another task.

Historical `intent: comment` and `intent: clarification` human provenance
remains terminal. The four pre-v1 top-level
`gh/comments/10/manual-cleanup-<repo>-<issue>` records are narrowly accepted
and validated as historical completion provenance; they are not numeric
GitHub comment receipts and no current writer can create that shape.
