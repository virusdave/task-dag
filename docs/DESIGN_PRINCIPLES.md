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
    `refs/heads/tasks/**`. Dependencies are **parent edges**. Completion
    of an implementation is the completion merge's **first parent** being
    that implementation commit.

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
carry it after the fact. This exception is admin-recovery only and pages
the operator on every use.

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
  `Historical-Commit:`, `Retroactive:`, `Blocked-Meta:` — and points at the
  subcommand that should have produced it. Cross-repo trailers a normal impl
  commit legitimately carries by hand (`Satisfies:`, `Phase:`,
  `Materialise-Child-Epic:`) are deliberately allowed.
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
