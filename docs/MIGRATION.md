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
    with:
      # Keep this equal to the ref in `uses:` so the reusable workflow and
      # its checked-out task-dag runtime are one coherent revision.
      ref: master
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
push-range inputs, reusable workflow source (`virusdave/task-dag@master`), and
a comment runtime ref that differs from the reusable workflow ref.

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
peer edits. The comment workflow checks out its helper, CLI, modules, and
config together at `with.ref`; callers must set that input explicitly to the
same ref used by `uses:`. Roll back by repinning both values to the same
known-good tag or SHA. Existing durable comment receipts and task refs remain
valid and must not be deleted during rollback.

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

## Semantic migration drain (committed state)

The committed `scripts/task-dag.d/semantic-migration-policy.json` is the sole
authority for the current drain. It recognizes only the legacy read schema and
authorizes only `legacy-read-only` semantics. Legacy epic-close,
materialisation, completion-ingest, and projection writers are disabled;
`task-dag migration-status --json` reports the strict policy consumed by every
guarded entry point. A missing, malformed, or unsupported policy fails closed
for those writers and for migration status, without disabling unrelated reads
or local completion recording. Human work-request comments remain available;
completion comments are classified and rejected before API fallback, receipt,
or ref effects. Reusable workflows obtain each mutator, guard, and policy from
one checkout/archive revision and translate only exact status 75 into an
explicit deferred-success result. Every other policy or runtime failure stays
red.

An ordinary revert is safe only before any canonical-v1 activation,
epoch-backed write, or other activation write has occurred. After activation,
rollback must be fenced against the activated epoch and preserve its durable
facts. Never restore a legacy writer that is incompatible with activated
canonical-v1 state.

After this drain policy is pushed, the next implementation leaf must not start
until mandatory post-push evidence shows every legacy writer workflow has
observed the exact `draining-legacy-writers` status and either skipped or
deferred successfully, with malformed/missing-policy probes remaining red.

### Canonical activation and the private materialisation fence

Canonical activation is now represented only by
`refs/heads/tasks/v1/activation`. Use `task-dag activation apply --spec-file`,
`activation status --json`, and `activation check-compatible` rather than
editing the ref. Records are permanent monotonic epochs; writer guard commits
are replaceable same-tree children and are bypassed by the next epoch.

The private canonical-v1 materialisation reservation core requires an enabled,
runtime-compatible activation snapshot. It persists activation provenance in
batch and slot records and advances the materialisation authority together
with an activation guard in one leased atomic push. This is infrastructure for
the later migration and census stages only: public `materialise-batch` and
`materialise-child` still validate then exit 75 under the unchanged committed
policy. Activation alone never enables producers. Rollback first advances to a
disabled epoch; records, guards and materialisation provenance are never
deleted. A task-dag runtime repin must follow this exact order: apply a
disabled epoch, confirm `activation status --json` reports that disabled
authority, run `activation check-compatible` offline for the proposed runtime,
and only then repin. Never repin before the disable, confirmation, and offline
compatibility check have all succeeded.

### Consumer cutover and rollback

Live semantic readers enter through the epoch-aware consumer adapter. Before
activation it authorizes only the legacy parent-encoded read bridge. The
presence of any valid activation history is the irreversible reader boundary:
enabled and disabled epochs both use canonical facts and graph reconciliation.
A disabled epoch therefore stops fenced producers without making an older
reader authoritative again.

Each online operation validates runtime compatibility, snapshots activation,
facts, graph, and task refs, then compares them with one origin advertisement
before returning a verdict. A moving or unreadable authority fails closed. Dispatch discovery,
dependency reporting, direct claims, root discovery/claims, and completion
gates all consume the shared requirements/status adapters. Activated graph,
block, breakdown, claim, release, reap, and master completion/close writers
advance the activation authority as a shared semantic generation in the same
atomic push as their effect. This is a moving server-side fence; unchanged
graph/master refspecs are not treated as leases. Completion and close tips use
`task-dag publish` after exact shape/status validation, and the managed
task-dag pre-push hook rejects raw master publication after activation. A
disabled epoch pauses scheduling effects. Internal no-fetch helpers may reuse an enclosing operation's freshly
observed pre-activation absence; standalone offline absence fails closed. Once
`refs/task-dag/activation-observed` exists, online disappearance also fails
closed and cannot revive legacy interpretation.

Missing-epic human comment ingestion crosses a documented valid-state boundary
in two fenced generations: first matching pending/issue epic refs, then the
frontier effect and receipt. A crash between them leaves a valid pending epic;
retry adopts it and completes the comment generation. Create-only leases plus
authoritative readback converge concurrent or ambiguously acknowledged pushes,
and disabled epochs reject the epic generation before remote effects.

Rollback is a new disabled activation epoch followed by a runtime certified
compatible with every persisted schema. It does not delete activation or graph
history and cannot restore parent-only semantics. Re-enabling uses another
monotonic activation epoch after compatibility and drain checks; no consumer
configuration toggle or legacy fallback participates.

### Offline census/import/adoption schemas

`materialise-census` accepts one strict schema-1 JSON object with exactly
`activationRecord`, `issuePages`, `repositories`, and `schema`. Repositories
are sorted `{path,repository,tip}` objects and must equal both the activation
registry and `sourceTips`; every path is a full local checkout at that exact
tip. Issue pages are sorted `{file,hasNextPage,page,repository}` objects. Each
issue snapshot includes exact title and body bytes, repository and issue node
identities, creator and creation time, reconstructed declarations, markers,
old completion evidence, and live delegations. Evidence refs must exactly
equal the relevant refs enumerated from the frozen checkout; omission is an
error. Declarations are independently reconstructed by applying the shared
legacy parser to every commit reachable from each frozen source tip and reading
body bytes from the declaring commit. The reconstructed and issue-classified
multisets must match exactly. Trailer-field presence participates in identity:
present-empty slug is invalid, while present-empty delegation note is distinct
from an absent note. Pages start at 1, are contiguous, end in
`hasNextPage:false`, and cover every registry repository. Issue node IDs,
`(repository,number)` pairs, slot IDs, and adopted issue node IDs are globally
unique.

The census writes canonical artifact bytes and a separate lowercase SHA-256
digest. `materialise-import` requires those exact files and the same input,
repeats census, byte-compares it, then performs one activation-fenced atomic
multi-ref compare-and-swap. The artifact has separately keyed `slots`,
`legacyCompletionRefs`, and `liveDelegations` arrays; every member carries
exactly one disposition. Any inaccessible repository, tip drift, evidence
omission, incomplete pagination, collision, or corruption fails before a
write. Import persists the reviewed census, exact bodies and declarations,
and a generation-zero append-only state for every slot. Imported slots can
never be create-capable reservations.

Run import once from each parent repository. The current repository identity
selects exactly one parent-origin partition; the global census remains the
reviewed input, but no command may write another repository's slots or strict
delegated-close outputs. Review the canonical census bytes and its digest
together, retain both unchanged, and supply both to import. On any malformed
evidence, unknown peer, identity mismatch, slot collision, candidate-validation
failure, push conflict, or readback mismatch, retain the reviewed files, repair
the source evidence, regenerate and review a new digest, then retry. Never edit
an imported generation or reuse an old digest for changed bytes.

Adopt and rearm use different strict schemas. Adoption binds one exact repository/issue node identity and appends
`issue-adopted(g+1)`. Rearm appends `rearm-authorized(g+1)` with the reviewed
evidence and approval. Only the sole reconciler may consume that authorization
immediately before its one POST; there is no public non-POST consume command.
The private consume transition must name the authorization digest and appends
`create-in-flight-or-uncertain(g+1)`. Generation paths and
predecessor-state digests make each authorization and transition structurally
one-use; old evidence is never edited.

## Repair-chain reconciliation format activation

The reconciliation lease and evidence fields extend the existing
`tasks/ci-chains/**` message format without creating another state store.
Current `chain-write` preserves every new field, but a pre-extension binary
serializes only the legacy field list and would erase a live lease, fence,
evidence, and accepted registry authority.

Do not invoke `reconcile-lease` or write any nonempty new-format field until
every classifier, tree-fix, and repair-ticket caller is running the preserving
binary and all in-flight jobs using an older binary have drained. In
particular, never run an old `repair-ticket` against an active new-format
chain. This upgrade/drain check is an activation barrier, not an optional
compatibility precaution.

Rollback disables new callers first and leaves chain refs and repair tickets
intact. If any active chain contains new-format state, migrate it with an
explicit compare-and-set operation and verify origin readback before an older
writer is allowed to resume. Never interpret a fence erased by an old writer
as a legitimate legacy zero, and never delete coordination refs or tickets as
rollback.

## Transitional duplication (known, accepted)

During the migration the canonical CLI exists both here and in
`virusdave/top-level:scripts/task-dag` (top-level's local workflows + the
worker host still invoke it). This is the intended phased state — old
paths stay live until step 5 makes this repo the sole CLI home.
