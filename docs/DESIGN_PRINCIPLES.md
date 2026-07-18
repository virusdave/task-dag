# task-dag design principles — READ BEFORE ADDING/CHANGING FUNCTIONALITY

Audience: implementers of future task-dag functionality or design changes,
and the Oracle when reviewing a proposed task-dag design. This is **not**
top-level canon — it is task-dag-specific design law. For the *shapes* of
individual commits/refs see [`INVARIANTS.md`](./INVARIANTS.md); this doc is
the higher-level rule that governs where task semantics are allowed to
live at all.

## Principle 1 — encode task semantics in the git DAG and git refs (operator law)

> **We encode task semantics, wherever possible and sensible, in the
> underlying git DAG and git references.**

- It is **very OK to make creative use of git's underlying data
  structures** (commit parentage, trees, refs, ref namespaces,
  `commit-tree`/`update-ref` plumbing) — **so long as we do not interfere
  with git's own semantics and tooling**. A reader/`git log`/`git
  merge-base`/GitHub UI must still see a correct, honest graph.
- The design is **explicitly ENCOURAGED by the operator to make heavy use
  of those data structures wherever the git tooling needed to consume them
  already exists and is highly efficient.** Prefer a parent edge, a ref, or
  a namespace over a message tag whenever git can answer the question for
  us in O(git) rather than by scanning/grepping commit messages.
  - Examples we already rely on: "is this task done?" is a **parent-edge**
    reachability query (`is_task_completed` walks `%P`; the completion
    merge carries the task commit as a non-primary **parent**). Claims,
    frontier, blocked state, and epic identity are all **refs** under
    `refs/heads/tasks/**`. Completion of an implementation is the completion
    merge's **first parent** being that implementation commit. The modern
    dependency graph is a git tree on the fixed `tasks/v1/graph` branch, still
    consumed through git object identity and fast-forward ref updates rather
    than an external database.

## Principle 2 — moving semantics OUT of the DAG requires operator approval

Do **not** move a piece of task semantics out of the git DAG/refs and into
a commit-message trailer (or any other side channel) **without operator
approval**. Requesting that approval MUST include **all** of:

1. The **STRONG reasons** why we should not / cannot use the git data
   structures directly for this specific semantic (e.g. it would require
   rewriting already-**published** history, which our safety canon forbids;
   or git has no efficient tooling to consume the needed structure).
2. The **Oracle design-review response** for the proposed alternative
   encoding.
3. A **`page-dave` page at priority 4 or higher** that carries:
   - a **`mss-one-offs` link** to the review & details page for the change, and
   - a **link to the GitHub issue** the operator will answer on.

Only proceed once the operator says yes on that issue. (Do not gate this
behind a codeword — state plainly what is being moved, why the DAG can't
carry it, and the reversibility, per canon.)

## Principle 3 — live mirrored refs are bounded

Task-dag is intentionally mirrored into every worker checkout and polled by
dispatchers. A design that creates one live ref per historical fact, edge, or
message is therefore a scalability bug even if it is technically git-native.
The standing invariant is:

- lifecycle refs are `O(open work)` (`pending`, `frontier`, `active`,
  `blocked`, etc.);
- dependency edges live as blobs in the single per-repo `tasks/v1/graph` tree;
- cross-repo completion hints live as blobs in the fixed 16 mailbox shard refs;
- derived facts (`done`, `satisfied`, readiness, complete) are computed from
  `master` + the graph in memory and never materialized as refs.

If a new feature seems to need an unbounded namespace, first try to encode it
as a bounded data-in-tree ref with an audited shape invariant, or derive it
from existing durable history. Adding a genuinely unbounded live ref family is
a format/scalability change and needs operator approval plus Oracle review.

## Principle 4 — authoritative facts come from `master`, not hints

The graph records obligations and supersede relationships; the mailbox records
notifications. Neither is authority that work is done. Completion authority is
always the destination repo's durable `master` history:

- task done = the empty-tree task commit is a parent-field token reachable from
  `master`;
- issue done = a reachable merge carries a parsed `Closes-Epic: #N` trailer;
- foreign done = verified in that foreign repo's local worktree / origin view,
  never trusted from a mailbox message alone.

Mailbox messages may speed up convergence, but a lost or duplicated message
must not change the final state. The periodic backstop re-derives the same
facts from authoritative history and folds any still-active satisfied edges.

## Principle 5 — mutation happens in the owning ref by direct CAS

Graph and mailbox mutations are not queued through a separate ledger and are
not repaired with manual `git update-ref`. The owning repo updates its own
fixed ref by direct fast-forward compare-and-set: fetch/read current tip,
recompute the tree, push with a lease, read back, and retry contention with
bounded jittered backoff. On retry exhaustion or indeterminate reads, fail loud
and leave the safer retryable state.

This principle is what makes thin wrappers safe: `delegate`,
`block --downstream --on`, `supersede`, graph convergence, and legacy migration
all call the same edge writer instead of each inventing a write path.

### The one standing, sanctioned exception: `complete-historical`

`task-dag complete-historical` links an implementation commit that has
**already landed on `master` unlinked**. Its impl↔task association is
recorded by **message** (the historical commit SHA in the link commit's
body), NOT by first-parent parentage, because making the already-published
impl a parent would require **rewriting published history** — forbidden by
the safety canon (no `--force`/reset of published refs). The task itself is
still linked in the DAG (the link commit carries the task as a non-primary
parent), so completion detection stays a parent-edge query; only the
*impl-commit provenance* is message-borne, and only because the DAG cannot
carry it after the fact. This exception is admin-recovery only. It creates the
link locally and pages the operator once, explicitly saying the link is not
authoritative until the caller runs `task-dag publish`; an
idempotent rerun does not page.

### The no-implementation sanctioned path: `complete-ops`

`task-dag complete-ops` is the live path for an operations-only **leaf** whose
real work happened out of band and has no honest implementation commit to link.
It deliberately does **not** relax normal `complete`'s real-work guard. Instead
it mints a tool-built, tree-equal merge on `master` whose first parent is the
synced `origin/master` tip and whose second parent is the leaf task commit.

That means the task completion fact still lives in the git DAG exactly like any
other completion: `done(task)` is the task commit appearing as a reachable parent
token on `master`. The absence of implementation provenance is intentional and
audited with mandatory `Ops-*` trailers (`Ops-Evidence:`, `Ops-Authorization:`,
who/host/time). Those trailers distinguish a sanctioned no-code operations
completion from `drop`/irrelevant work, but readers must not use them as the
authoritative done fact.

### Completion publication and projection ownership

Every completion command creates only a local candidate on `HEAD`. It never
pushes `master`, removes scheduling refs, or posts a completion status comment.
The caller publishes the candidate with exactly `task-dag publish`. Before
activation that command preserves the legacy fast-forward push. After
activation it validates the exact completion/close shape and pre-tip canonical
status, then atomically advances master and the shared semantic generation.
Only then is completion parentage authoritative. Server-side `graph-converge`
derives and lease-cleans `frontier`, `active`, `blocked`, and `blocked-meta`
projections from durable master. A crash or rejected push therefore leaves work
dispatchable and recoverable; a convergence failure leaves conservative stale
refs that scheduled reconciliation can repair.

## Commit-message guard (stop accidental hand-crafted task commits)

Every task-dag control commit — task/epic root, claim, blocked-meta,
completion merge, close merge, historical link (see
[`INVARIANTS.md`](./INVARIANTS.md) "Per-kind commit shapes") — is built with
`git commit-tree`, which **bypasses git hooks**. That asymmetry is load-
bearing: a `commit-msg` hook can therefore treat the presence of any
control-plane marker in a *hook-visible* `git commit` as proof that a human
or agent is hand-crafting a task-impacting commit instead of using the CLI
(the footgun behind the fabricated `Task-Commit` in
`FreshlyBakedNYC/automation@53c9e712b`, which recorded a completion against a
task SHA that never existed).

- The canonical check is `task-dag guard-commit-message <file>`. It rejects a
  message whose non-comment lines carry any of: a `Task:` subject, `Type:`,
  `Task-Commit:`, `Status: completed|pending`, `Closes-Epic:`,
  `Historical-Commit:`, `Retroactive:`, `Blocked-Meta:`, any `Ops-*`
  completion trailer minted by `complete-ops`, or a GitHub-native
  close/fix/resolve keyword followed by `#N` / `owner/repo#N` — and points at
  the subcommand that should have produced it. Cross-repo trailers a normal
  impl commit legitimately carries by hand (`Satisfies:`, `Phase:`,
  `Materialise-Child-Epic:`) are deliberately allowed.
- The same check **also enforces canon commit style** (top-level
  `rules/WORKFLOW.md` "Commit messages"): it rejects a Conventional-Commits
  subject prefix (`feat:`, `fix(scope):`, `chore!:`, `seo(faq):`, …) because
  canon requires a plain, capitalized, imperative subject. This is the
  mechanical half of the fleet-wide commit-style fix (top-level#45); it
  matches only the high-signal leading-lowercase-`type(scope):` pattern, so
  capitalized subjects, `fixup!`/`squash!`, and git-generated `Revert "…"` /
  `Merge …` subjects always pass.
- The marker→tooling map is the **single source of truth** in the CLI. The
  per-repo hook ([`.githooks/commit-msg`](../.githooks/commit-msg)) is
  repo-agnostic and only *delegates* to the CLI — it must never re-encode the
  list (no duplicated logic).
- Enable per clone (git will not auto-activate a committed hooks dir):
  `git config core.hooksPath .githooks`. If the CLI is unavailable the hook
  fails **open** with a warning (set `TASK_DAG_BIN` to enforce): the goal is
  to reliably stop an agent from *accidentally* doing this by hand, not to
  defeat a determined adversary.

## Consequences for `complete` (and why the #7 fix is DAG-native)

When one worker stacks several sibling-leaf implementation commits in one
worktree, each leaf's completion merge is built **directly on that leaf's
implementation commit** (first parent = impl), replaying any commits that
were stacked above it — so the full impl↔task↔completion relationship lives
in the DAG and `git log` shows an honest linear graph. We do **not** record
the impl in an `Impl-Commit:` message trailer (an earlier draft did; it was
removed under Principle 1). See
[`REF_LIFECYCLE.md`](./REF_LIFECYCLE.md) → "Completing several sibling
leaves in one worktree".
