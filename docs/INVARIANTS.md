# task-dag commit & ref invariants — READ BEFORE TOUCHING ANY TASK REF

## Canonical semantic activation authority

`refs/heads/tasks/v1/activation` is the only activation ref. Its permanent
history is a zero-parent epoch-1 commit followed by a linear, append-only
chain. Epoch `N` adds only `records/%016d.json`; epochs are consecutive and
each record binds the previous epoch and SHA-256 digest. The ref may
temporarily point to one replaceable guard commit parented directly to the
active activation commit with an identical tree. The next activation bypasses
that guard and parents directly to the active commit.

Activation records are canonical strict JSON and bind state, compatibility
floor, immutable registry and exact source tips, guard version, actor and audit
timestamp. Registry snapshots contain schema 1, a domain-separated
`sha256:<hex>` identity, independent registry-file provenance
`{repository,path,commit,blob}`, and at most 128 sorted repositories identified
by canonical lowercase repository plus immutable repository ID. Source tips
match those repositories exactly by both fields; registry provenance is not an
extra source tip. Compatibility uses the one `virusdave/task-dag` source tip,
not registry provenance. `activation apply` snapshots its request, validates complete
non-shallow history, uses an exact leased compare-and-swap, and always reads
origin back. Compatibility is offline against the full task-dag repository;
the floor cannot move backward. Activation does not authorize public semantic
producers, which remain controlled by the committed migration drain.

An enabled writer snapshot binds origin, epoch and record digest, active
commit, current authority tip, guard version, compatibility floor and runtime
commit. A fenced writer replaces the authority tip with a strict same-tree
guard while atomically advancing its target under exact leases. Every guard
binds the active epoch, record digest, guard version and activation commit, and
separately records the prior authority tip it leased. Thus repeated writes in
one epoch remain sibling guards with only one current guard. Missing,
disabled, malformed, stale, shallow or uncertain authority fails closed.

## Immutable materialisation reservations (disabled-state schema 1)

### Reviewed legacy census import

Legacy import is partitioned by current repository identity. The global,
fully-paginated census is reviewed input, but a writer may add only declarations,
generation-zero states, and delegated-close outputs owned by that parent origin.
Evidence identity is the exact `(repository, ref, object ID)` tuple. Every source
and peer is in the pinned activation registry, whose repository IDs equal issue
page, declaration, and delegation IDs.

The census reconstructs every legacy declaration from every commit reachable
from each frozen source tip with the shared trailer parser and reads body bytes
from the declaring commit. That reconstructed multiset must exactly equal the
classified issue-page declarations. Optional trailer presence is identity:
absent and present-empty are distinct, present-empty slug is invalid, and a
present-empty delegation note remains present.

The chain stores reviewed bytes at `censuses/<sha256>.json`, partition membership
at `import-batches/<sha256>.json`, declarations at
`declarations/<declaration-digest>.json`, bodies at
`bodies/<body-sha256>.body`, states at
`slots/<slot-id>/states/<16-digit-generation>.json`, and rearm authority at
`slots/<slot-id>/authorizations/<16-digit-generation>.json`. Import rejects every
pre-existing form of a proposed slot. `issue-adopted` carries the exact peer tuple
`{repositoryId,issueNodeId,number}`; its issue node occurs in only one imported or
transitioned terminal slot globally.

The chain is a generation-zero imported terminal state, followed only by adopt,
or by `rearm-authorized(g+1)` and its exact one-use consume into
`create-in-flight-or-uncertain(g+1)`. Records name the reviewed census and exact
predecessor digest. Strict validation checks exact schemas, filenames,
memberships, generation cardinality, authorization relationships, and per-commit
deltas. Current history, the local candidate, and authoritative readback all
validate.

At command start, descriptor/realpath checks precede private snapshots of the
specification, activation record, every issue page, reviewed artifact/digest,
repository HEAD, and relevant ref manifest. Census and import use only snapshots.
Malformed evidence, missing pages, unknown peers, identity mismatches,
conflicting strict closes, or uncertain readback fail closed with no partial
import. Partial-implementation evidence remains audit-only.

`refs/heads/tasks/v1/materialisation` is one exact data-in-tree exception;
no other `tasks/v1/materialisation/*` or broad `tasks/v1/*` ref is valid. Its
history is linear (the initial commit has no parent, every successor exactly
one) and append-only. Regular `100644` blobs are restricted to
`bodies/<body-sha256>.body`, `declarations/<declaration-digest>.json`,
`batches/<batch-id>.json`, `censuses/<census-digest>.json`,
`import-batches/<census-digest>.json`, `slots/<slot-id>/state.json`,
`slots/<slot-id>/states/<generation>.json`, and
`slots/<slot-id>/authorizations/<generation>.json`.

Ordinary reservations use only `batch-reserved-before-create` at
`slots/<slot-id>/state.json`, generation 0/fence 1. Each reservation names its deterministic slot, declaration, operation and
batch IDs, durable activation `{epoch,digest,guardVersion}` provenance, and the
activation and materialisation authority tips observed before the whole-batch
leased compare-and-swap (the materialisation tip is null only initially). A reservation commit adds
complete bodies, declarations, batch membership and slot states atomically;
existing paths can never be deleted or replaced. `task-dag validate --strict`
revalidates this state offline. Imported slots exclusively use the census,
import-batch, generation-state, and authorization paths documented above; the
two forms may never coexist for one slot. Public issue-creating materialisation
commands remain denied by the semantic migration policy.

Declarations contain semantic input only. Request provenance lives in the
batch receipt's sorted member records, each of which binds slot, declaration,
operation, and complete member provenance. The batch ID also binds the
canonical activation epoch, record digest, and guard version, so an exact
cross-epoch retry appends a distinct immutable receipt without rewriting the
prior epoch's path. The later receipt attests a new observation under the
current activation; an already reserved immutable slot retains its original
reservation activation and is never rewritten to the later epoch. Repository names are deliberate immutable routing assertions in the
declaration, not display-only provenance: a repository rename conflicts until
an explicit migration defines the replacement identity. String limits count
Unicode code points; body limits count exact UTF-8 bytes. Writers snapshot the
request spec and each body once, then derive all metadata, validation, digests,
declarations, receipts, and persisted blobs only from those snapshots.

> ## ⛔ STOP — do not hand-craft task commits or do ref surgery by hand
>
> task-dag's **entire state is git** — refs under `refs/heads/tasks/**` and
> `refs/heads/gh/**`, plus a handful of trailer-bearing commits on
> `master`. These carry **subtle, load-bearing invariants**. A hand-rolled
> `git commit-tree` / `git update-ref` / `git push`, or "just fixing a
> prior mistake" by editing refs manually, **will silently**:
> - break the dispatcher's dedup (spawning duplicate workers, burning agent
>   runs), or
> - corrupt a claim / the cross-host claim-CAS (two workers on one task), or
> - wedge issue closure (an epic that never closes), or
> - poison the DAG so that repairing it needs *more* ref surgery.
>
> **What to do instead:**
> 1. Use a task-dag **subcommand** for every mutation (see `task-dag help`).
> 2. If the tool cannot express what you need: `task-dag block <sha>
>    --reason="…"`, `page-dave` once, and **STOP**. Do not improvise git
>    surgery to work around a missing feature.
> 3. Changing the tool's commit/ref **format** (message bodies, trailers,
>    namespaces) is a **critical-infra change**: it requires **operator
>    approval + an Oracle design/architecture review** (canon
>    `rules/QUALITY_GATES.md`). Do not do it "quickly."
>
> Audit any repo's DAG at any time:
>
> ```sh
> task-dag validate --strict     # fails loudly on any invariant violation
> ```

This document is the single enumeration of those invariants. If you are
about to change how any task commit or ref is shaped, this is the contract
you must not break — and the place to update when the contract legitimately
evolves (with review). The higher-level design law is in
[`DESIGN_PRINCIPLES.md`](./DESIGN_PRINCIPLES.md), the lifecycle/runbook view
is in [`REF_LIFECYCLE.md`](./REF_LIFECYCLE.md), and the legacy migration path
is in [`MIGRATION.md`](./MIGRATION.md) → "Legacy dependency encodings →
bounded edge graph".

---

## The invariant floor (enforced by `validate --strict`)

Two facts hold for **every** ref the system has ever created, so asserting
them can never false-flag legacy history. `task-dag validate --strict`
audits the whole `refs/heads/tasks/**` + `refs/heads/gh/**` namespace and
**fails (exit 3)** on any violation:

1. **Every task/gh ref points at an empty-tree commit.**
   Tree == `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. Task state lives in
   the commit *message* and the *ref path*, never in files. (The completion
   / close / historical-link commits that live on `master` are **not** in
   this namespace and legitimately carry the real tree — the audit does not
   touch `master` history.)

2. **Every task/gh ref lives under a KNOWN namespace.** A ref at any other
   path is treated as a hand-crafted / surgery artifact and is an error.
   This is the primary catch for "I did the ref surgery by hand."

   Known namespaces (kept in sync with `TASKDAG_KNOWN_TASK_NS` /
   `TASKDAG_KNOWN_GH_NS` in `scripts/task-dag`):

   | Ref | Kind / meaning | Minter |
   |---|---|---|
   | `tasks/pending/<N>` | epic root / identity for issue N | `.github/scripts/create-task-commit.sh`; backfilled by `_xrepo_ensure_issue_epic` |
   | `tasks/root-active/<N>` | cross-host epic-root orchestration lock (claim CAS) | `claim-root` |
   | `tasks/frontier/<short>` | claimable implementation leaf | `breakdown`, `ingest-comment` |
   | `tasks/active/<short>` | in-flight leaf claim (claim CAS) | `claim`, born-claimed `breakdown` |
   | `tasks/blocked/<sha>` | parked task overlay (points **at the task commit itself**) | `block` |
   | `tasks/blocked-meta/<sha>` | parked-task side metadata (tree==task tree, first parent==task commit) | `block` |
   | `tasks/delegated/<N>/<owner>/<repo>/<peer>` | cross-repo delegation edge | `delegate` |
   | `tasks/completions/<N>/…/<sha>` | recorded downstream completion | `ingest-comment` completion disposition |
   | `tasks/ci-chains/<owner>/<repo>/<branch>` | CI broken-master repair-chain state (NOT a task-workflow ref) | `chain-write`, `reconcile-lease`, `repair-retire` |
   | `tasks/repair-superseded/<64-hex>` | immutable, non-scheduling repair-retirement audit | `repair-retire` |
   | `tasks/v1/graph` | dependency-edge index branch — a data-in-tree ref exempt from the empty-tree floor (see below) | the edge writer (issue #13) |
   | `tasks/v1/mailbox/00`..`0f` | cross-repo notification mailbox — 16 fixed data-in-tree shard branches, exempt from the empty-tree floor (see below) | the mailbox writer (issue #13) |
   | `gh/issues/<N>` | GitHub-side epic mapping | `create-task-commit.sh` |
   | `gh/comments/<N>/<id>` | comment provenance (kept so a comment is never re-ingested) | `ingest-comment` |
   | `gh/child-epics/<N>/<owner>/<repo>` | materialised child-epic provenance (default slot, one child per (parent, peer repo)) | cross-repo materialisation |
   | `gh/child-epic-slots/<N>/<owner>/<repo>/<slug>` | materialised named-slot child-epic provenance (allows multiple children per (parent, peer repo)); `<slug>` is `^[a-z0-9][a-z0-9-]{0,63}$`, validated by the minter | cross-repo materialisation |

   **Adding a new namespace is a format change.** You must add it to
   `TASKDAG_KNOWN_*_NS` **and** add a golden fixture in `tests/task-dag/`
   in the *same* change, or `validate --strict` (and the CLI-tests CI gate)
   will correctly reject it. This ordering is deliberate: it forces the
   contract and its test to land before any ref uses the new path.

   CI repair-chain messages are a typed line protocol. `Current-Head` is
   derived only from `chain-write --for-sha`; the legacy classifier writer can
   mutate only its classifier fields. Evidence, registry authority,
   diagnostics, `Reconcile-Lease-*` / `Reconcile-Fence`, and
   `Reconcile-Operation-ID` are protected fields written by their owning typed
   operations. `repair-retire` assigns a fresh SHA-256 operation ID and makes a
   real first-parent chain advance in every destructive atomic transaction;
   this prevents git from optimizing an unchanged refspec away before its
   lease reaches the server. Every serializer rejects CR/LF-bearing values
   before creating a commit.

   A repair-retirement audit uses the exact ref
   `tasks/repair-superseded/<identity>`, where `identity` is lowercase SHA-256
   over the NUL-delimited tuple `repair-superseded-v1`, canonical lowercase
   repository, branch, first-red commit, and retired issue number. It points at
   an empty-tree commit with exactly one parent: the authorizing CI-chain
   commit. Its subject is `Repair-Superseded: v1`; its body contains exactly
   one each of `Repository`, `Branch`, `Issue`, `First-Red`,
   `Canonical-Issue`, `Reason`, `Registry-Commit`, `Registry-Blob`,
   `Decision-Key`, `Reconcile-Fence`, and `Retired-At`, with no unknown
   protocol lines. `Issue` and a non-`none` `Canonical-Issue` use `#N`;
   `Reason` is one of `duplicate`, `stale-chain`, `green`, `downgrade`, or
   `non-fast-forward`; object IDs are exactly 40 or 64 lowercase hex;
   `Decision-Key` is `sha256:<64-hex>`; and the positive decimal fence is at
   most `999999999999999999`. Strict validation recomputes the identity and
   verifies that the parent is in the exact encoded repository/branch chain
   ref's first-parent history, has every field in the frozen V1 parent-field
   snapshot exactly once (future chain fields do not invalidate old audits),
   and agrees on first-red, registry, decision, and fence. The retirement time
   must satisfy `Updated-At <= Retired-At < Reconcile-Lease-Until`. This
   namespace is audit-only and is never frontier,
   pending, active, blocked, or otherwise discoverable as scheduling work.
   Initial retirement atomically creates this audit, advances the live chain,
   and deletes the classifier's exact ref/OID candidates. Replay never rewrites
   the audit: its parent remains the historical authorization, while the
   current owner, unexpired trusted-time lease, fence, and exact chain token
   independently authorize late cleanup. Every outcome is decided by an
   unconditional fresh origin snapshot and reclassification; a landed
   transaction followed by new projections or newer authority is reported as
   incomplete or stale rather than as current success.

`validate --strict` is **read-only** and **race-tolerant**: it snapshots
refs in a single `for-each-ref` and skips any ref whose object vanished
mid-walk (concurrent `claim`/`complete`/`drop`), so it never flaps under
fleet churn. A flapping gate trains the fleet to ignore it — worse than no
gate.

---

## The bounded mutable data-in-tree indexes (`tasks/v1/graph`, `tasks/v1/mailbox/*`)

There are exactly two bounded mutable-index ref KINDS whose tree **is** their
current data: the dependency-graph index `tasks/v1/graph`
(below) and the 16 cross-repo mailbox shards `tasks/v1/mailbox/00..0f`
(further below, "The cross-repo mailbox shards"). Both are deliberate,
operator-approved (issue #13 Phase 0) exceptions to invariant-floor rule #1,
because storing data in-tree under a **fixed, bounded** ref set is exactly
what keeps the live mirrored **ref count bounded** (`O(open work)` /
`O(in-flight signals)`, never `O(total history)`). Each is an exact-ref
exemption with its own shape invariant, not a blanket loosening of the floor
under `tasks/v1/*`. The append-only activation and materialisation authorities
documented above are separate exact data-in-tree exceptions, not mutable
indexes.

### The dependency-graph index (`tasks/v1/graph`)

The north-star dependency graph (issue #13) stores its **active edge set**
as an ordinary per-repo git branch, `refs/heads/tasks/v1/graph`, whose
**latest tree IS the edge set**. This is one of the two bounded mutable-index,
operator-approved (issue #13 Phase 0) exceptions to invariant-floor rule #1
(empty tree): the graph index is data-in-tree by design, because that is
exactly what keeps the live mirrored **ref count bounded** — one ref per
repo instead of one ref per edge.

It is a **new ref KIND with its own invariant**, not a loosening of the
floor for everything under `tasks/v1/*`:

- **Exact-ref exemption.** Only `refs/heads/tasks/v1/graph` is recognised.
  `validate --strict` special-cases exactly this ref (`taskdag_is_graph_ref`
  in `scripts/task-dag`); a hand-crafted `tasks/v1/anything-else` still fails
  the unknown-namespace check. We deliberately do **not** add `v1` to
  `TASKDAG_KNOWN_TASK_NS`.
- **Replacement invariant (audited).** The graph ref must be a **commit**
  whose tree contains **only** regular blobs named `edges/<edge-id>.json`,
  where `<edge-id>` is a lowercase 64-hex sha256. Any other path, a non-blob
  entry, or a malformed edge-id filename is a `validate --strict` error
  (`taskdag_graph_tree_violations`). An empty tree (zero edges) is valid.
- **edge-id = SEMANTIC hash, not the blob hash.** `edge-id` is the full
  sha256 of the NUL-delimited canonical tuple `(from, to, relation, mode)`
  only. `origin` (repo-id + witness) is provenance and is **excluded** from
  the id, so a re-add or a metadata-only edit is idempotent (same path) while
  a same-path **non-identical** semantic write is detectable — the reader
  recomputes the id from the blob content and rejects any path/content
  mismatch.
- **Edge blob schema (schema:1):**
  ```json
  { "schema": 1,
    "from": "task:<owner>/<repo>@<sha>",  "to": "issue:<owner>/<repo>#<N>",
    "relation": "requires" | "satisfies", "mode": "all" | "any",
    "origin": { "repo-id": <stable numeric repo id>, "witness": "<sha/msg-id>" } }
  ```
  Node addressing is `task:<owner>/<repo>@<40|64-hex>` and
  `issue:<owner>/<repo>#<N>`; `<owner>/<repo>` is case-folded to lowercase
  for canonical identity. Relation/mode pairs are fixed: `requires`⇒`all`,
  `satisfies`⇒`any` (OR-deps out of scope). Direction: `from` is the node
  making the assertion (`from requires to` / `from satisfies to`).
  `origin.repo-id` is the **stable numeric** GitHub repository id (survives a
  rename/move), never `owner/name`.
- **Bounded + FF-only.** There are **no** per-edge refs; the branch is
  fast-forward-only and its graph commits parent only the previous graph-index
  commit (never task commits). Reading uses the **latest tree only**, not
  history.
- **Tombstones (schema v1, additive) + satisfied-edge pruning.** The tree may
  additionally contain `tombstones/<edge-id>.json` blobs — explicit, witnessed
  records that an edge was **deliberately removed BEFORE it was satisfied**, so
  a lost edge is distinguishable from an intentionally-dropped one. A tombstone
  is a **separate blob at its own path** (never a `deleted`/`active` flag
  overloaded onto the edge blob), content-addressed by the **same** semantic
  edge-id, with an added `"tombstone": true` discriminant and an
  `origin.witness` that is the **removal** witness:
  ```json
  { "schema": 1, "tombstone": true,
    "from": "<node>", "to": "<node>",
    "relation": "requires" | "satisfies", "mode": "all" | "any",
    "origin": { "repo-id": <n>, "witness": "<removal witness>" } }
  ```
  **Active edge set = `edges/<id>.json` present AND `tombstones/<id>.json`
  absent** (tombstone **wins** if both are present — remove-wins under the
  commutative union, so a racing re-add can never resurrect a tombstoned edge;
  a tombstoned edge-id is **terminal** — `dep add` of it fails loud). A
  **PRUNABLE** edge is instead **PRUNED** (plain FF deletion of
  `edges/<id>.json`, **no** tombstone) because a durable completion witness on
  `master` means re-deriving would just re-confirm the same active set.
  Prunability is **relation-aware** (NOT simply `satisfied`/`done(to)`):
  - a **`requires`** edge is prunable iff **`done(to)`** — the obligation is
    permanently met;
  - a **`satisfies`** edge is prunable iff **`done(from)`** — the DEPENDENT has
    completed, so the supersede signal has been consumed and recorded on
    `master`. A `satisfies` edge whose *target* is done is the **live**
    supersede signal and must stay active until the dependent itself completes,
    so it is **not** pruned then (the reconciler reads it to detect supersede).

  `done()` is monotonic, so a pruned edge can never wrongly reappear. A plain
  prune is **garbage-collection, not terminal** (unlike a tombstone): a
  re-`dep add` of a plain-pruned edge-id succeeds. Note `dep add` does **not**
  itself prune or reject a would-be-immediately-prunable edge — an edge records
  a real dependency relationship the reconciler reads (a leaf with a satisfied
  `requires` edge is ready-but-not-complete and must appear as an edge-source
  node), so bounding the active set is the sole job of the explicit pruning
  paths (`dep prune` / prunable `dep drop`), never of add. The reader validates
  **every** edge and tombstone blob (a tombstone must never hide corrupt graph
  content — fail closed).

The read side + data-model helpers live in `scripts/task-dag.d/edges.sh`
(`taskdag_edge_id`, `taskdag_edge_blob`, `taskdag_normalize_node`,
`taskdag_repo_numeric_id`, `taskdag_read_edges`, and the `edges` read
command). The direct-CAS **writer** lives in
`scripts/task-dag.d/edges-write.sh` (`taskdag_dep_add`, `taskdag_dep_drop`,
the FF-only CAS core `_taskdag_graph_cas`, the bounded quadratic backoff
`taskdag_cas_ramp_ms` / `taskdag_cas_jitter_ms` / `taskdag_cas_backoff_ms`,
and the `dep add` / `dep drop` command): adding or removing an edge is a
direct fast-forward push to `tasks/v1/graph` (the same ref-update CAS a
completion merge uses), retried on contention with a jittered ~1s→~10s
quadratic backoff and **failing loud** on retry-budget exhaustion. Both
add and drop are idempotent. `dep drop` is **prunability-aware** (relation-
aware): it PRUNES a prunable edge (plain FF deletion — `done(to)` for a
`requires` edge, `done(from)` for a `satisfies` edge is the durable witness on
`master`) but writes an explicit **TOMBSTONE** (`tombstones/<edge-id>.json`,
landed **atomically** with the edge removal in one compound FF commit) for a
deliberate removal BEFORE the edge is prunable — never a silent tree deletion
of a not-yet-prunable edge. The tombstone blob serializer + tombstone-aware
reader masking live in `edges.sh`; the relation-aware prunability predicate +
scan primitives (`_taskdag_edge_prunable`, `taskdag_prune_edge`,
`taskdag_prune_satisfied`, and the `dep prune` command) live in
`scripts/task-dag.d/edges-prune.sh`. The mailbox transport lives in
`scripts/task-dag.d/mailbox.sh`; graph convergence (push reaction, periodic
backstop, local folds, cross-repo hints, cascade, supersede synth-completion,
and obligation-based epic close) lives in `scripts/task-dag.d/graph-converge.sh`.
Golden fixtures for the
exemption + its shape invariant are in `tests/task-dag/validate-strict.sh`
(TEST 11–15); the model/reader is unit-tested in `tests/task-dag/edges.sh`, the
writer (backoff shape/cap/jitter/fail-loud, add/drop round-trip, and concurrent
FF contention) in `tests/task-dag/edges-write.sh`, and pruning + tombstones
(relation-aware prunable-edge prune, not-yet-prunable-removal tombstone,
tombstone-survives-recompute, remove-wins masking, terminal re-add refusal vs
plain-prune re-add allowed, add-to-done writes an active edge, fail-closed
corruption, and `validate --strict` recognising the tombstone path)
in `tests/task-dag/edges-prune.sh`.

`task-dag migrate-legacy-edges` is the one-time/idempotent compatibility
bridge from historical encodings into this graph: it reads legacy extra task
parents, `tasks/delegated/*` refs, and explicit canonical node fields in
downstream/supersede metadata, then writes ordinary edges through `dep add`.
It does **not** mutate legacy refs or task history. Rollback for a bad
migration is therefore bounded and clean: stop reading the graph, or delete /
revert only `refs/heads/tasks/v1/graph`; never rewrite task commits to undo a
legacy-edge migration.

### The cross-repo mailbox shards (`tasks/v1/mailbox/00..0f`)

Cross-repo notification delivery (issue #13 Phase 3) uses a **bounded** set
of exactly **16 fixed shard branches** `refs/heads/tasks/v1/mailbox/00` ..
`/0f`. A message — a HINT that a node completed, so a repo holding an edge
pointing at it should fold in the effect — is stored as a blob **in** a
shard's tree (`msg/<message-id>.json`), so the live mirrored ref count is
`O(1)=16` regardless of in-flight message count (the second data-in-tree
exception). A message is a **trigger, not a fact**: a lost message is
re-derived from the other repo's `master` by the periodic reconciler
backstop (a separate sibling task).

It is a **new ref KIND with its own invariant**, not a loosening of the
floor for everything under `tasks/v1/*`:

- **Exact-ref exemption.** Only the 16 refs matching
  `refs/heads/tasks/v1/mailbox/0[0-9a-f]` are recognised. `validate --strict`
  special-cases exactly these (`taskdag_is_mailbox_ref` in `scripts/task-dag`);
  a hand-crafted `tasks/v1/mailbox/10` or `tasks/v1/mailbox/0g` still fails
  the unknown-namespace check. We deliberately do **not** add `v1` to
  `TASKDAG_KNOWN_TASK_NS`.
- **Replacement invariant (audited).** A shard ref must be a **commit** whose
  tree contains **only** regular blobs named `msg/<message-id>.json`, where
  `<message-id>` is a lowercase 64-hex sha256. Any other path, a non-blob
  entry, or a malformed message-id filename is a `validate --strict` error
  (`taskdag_mailbox_tree_violations`). An empty tree (zero messages) is valid
  — that is the state a shard is left in after its last message is consumed
  (shards are created **lazily** on first put and never branch-deleted, so
  the ref count only ever *shrinks by tree*, never by dropping to fewer than
  the shards that have been touched, and never grows past 16).
- **message-id = CONTENT hash of `(kind, node, witness, dest)`.** The id is
  the full sha256 of that NUL-delimited canonical tuple. `witness` **and**
  `dest` are part of identity, so a NEW witnessed completion cannot be
  absorbed by an older in-flight same-node message (and then wrongly deleted),
  and mis-addressed delivery is caught. `origin` (repo-id + repo) is provenance
  and is **excluded** from the id — but unlike an edge, a same-id message with
  **different** content is a **fail-loud** conflict (short-lived trigger
  state; a same-id/different-content collision means something is wrong), not
  first-writer-wins. The shard is the first nibble of the id, `%02x` → `00..0f`.
- **Message blob schema (schema:1):**
  ```json
  { "schema": 1, "kind": "completion",
    "node": "task:<owner>/<repo>@<sha>" | "issue:<owner>/<repo>#<N>",
    "witness": "<40|64-hex source-completion sha / message-id>",
    "dest": "<owner>/<repo>",
    "origin": { "repo-id": <stable numeric repo id>, "repo": "<owner>/<repo>" } }
  ```
  `<owner>/<repo>` is case-folded to lowercase; `witness` is a lowercase 40-
  or 64-hex string (a git sha1 / sha256), tight so it cannot inject a commit
  trailer; for a `completion` message the completed node lives in the origin
  repo (`node`'s repo == `origin.repo`).
- **Bounded + FF-only.** There are **no** per-message refs; each shard is
  fast-forward-only and its commits parent only the previous shard commit.
  Reading uses the **latest tree only**, not history. Enqueue/consume are the
  same direct FF-only CAS the graph writer uses (fetch shard tip → recompute
  the shard tree → FF push + lease + readback → jittered ~1s→~10s quadratic
  backoff → fail loud on exhaustion); the shard tree is a commutative
  idempotent union, so contention converges.
- **Ordered fold-then-delete (no ack ledger).** `mailbox consume` runs an
  **injected** fold command per message and deletes that message **only after
  the fold exits 0** (durably folded). This is per-message fold-before-delete
  ordering (NOT FIFO). There is **no** `consumed_at` / ack / dedup ledger;
  correctness rides on the fold being **idempotent** (delivery is
  **at-least-once**) + the backstop re-deriving a lost hint. The fold's
  effect commit stamps the triggering witness into its trailer
  (`taskdag_mailbox_witness_trailer` → `Mailbox-Witness:` +
  `Mailbox-Message-Id:`) so durable `master` history carries provenance.

The mailbox transport lives in `scripts/task-dag.d/mailbox.sh`
(`taskdag_mailbox_message_id`, `taskdag_mailbox_blob`, `taskdag_mailbox_read`,
`taskdag_mailbox_put`, `taskdag_mailbox_consume`, the FF-only CAS core
`_taskdag_mailbox_cas`, the witness-trailer helper, and the `mailbox
put|list|consume` command); the shape invariant helpers
(`taskdag_is_mailbox_ref`, `taskdag_mailbox_tree_violations`) live in
`scripts/task-dag`. Golden fixtures for the exemption + its shape invariant
are in `tests/task-dag/validate-strict.sh` (TEST 16–21); the transport
(message-id/shard derivation, idempotent + conflict-fail-loud put, put/list
round-trip, target-repo guard, bounded refs, ordered fold-then-delete,
witness trailer + env passing, cross-repo delivery, FF contention, and
fail-loud exhaustion) is unit + integration tested in
`tests/task-dag/mailbox.sh`. The **reconciler** that decides what a completion
means and how to fold it (push-reaction handler + periodic backstop, local-CAS
fold, cascade), `supersede`, and epic-close unification is implemented in
`scripts/task-dag.d/graph-converge.sh`, `scripts/task-dag.d/reconcile.sh`, and
the thin wrapper commands in `scripts/task-dag` / `scripts/task-dag.d/cross-repo.sh`.

### Derived facts (`done` / `satisfied`) — in-memory, ZERO per-fact refs

The two primitive facts the dependency graph reasons over are **derived**
from `master`'s completion history and cached **in memory** for the life of
one process — **never** one-ref-per-fact (this is what keeps the live
mirrored ref count `O(open work)`, not `O(total history)`):

- `done(node)` is authoritative from **this repo's** master history and is
  **scoped to the current repo** (a node's identity is `owner/repo` +
  object-id, and local history is authoritative only for the current repo):
  a `task:<cur-repo>@<sha>` is done ⟺ a tree-equal commit on master's
  **first-parent spine** records `<sha>` as a non-primary parent **and** it is
  an empty-tree task commit (the spine restriction excludes structural and
  dependency parent tokens reachable through task commits); an
  `issue:<cur-repo>#<N>` is done ⟺ a merge reachable from the tip carries a
  `Closes-Epic: #<N>` **trailer** (parsed as a git trailer, so body prose
  cannot forge it). A
  **foreign** node (repo ≠ current) is not locally derivable ⇒ not done here
  (the cross-repo hint/backstop siblings carry those).
- `satisfied(edge) = done(edge.to)` for **both** relations. The
  `requires`=all (readiness) vs `satisfies`=any (supersede) **propagation**
  is the reconciler sibling's job — the fact layer emits only the edge-local
  boolean.

The cache is keyed on the **resolved tip OID**, so a fetch / `complete` /
HEAD move in the same process transparently re-derives (idempotent +
monotonic). This layer lives in `scripts/task-dag.d/facts.sh`
(`taskdag_load_facts`, `taskdag_node_done`, `taskdag_edges_with_facts`, and
the read-only `facts` command); it is unit-tested in
`tests/task-dag/facts.sh`. It computes **raw facts only** — the aggregation
into behavior is the reconcile layer below.

### Reconcile predicates (`complete()` / leaf-readiness) — read-only

The **aggregation** of the raw facts into the north-star behavior lives in
`scripts/task-dag.d/reconcile.sh` (`taskdag_node_complete`,
`taskdag_leaf_ready`, and the read-only `reconcile` command; unit-tested in
`tests/task-dag/reconcile.sh`). The predicate layer is **read-only** and
additive — it never writes a ref. The mutating live wiring that consumes its
verdicts is separate and explicit: `scripts/task-dag.d/graph-converge.sh`
folds satisfied edges, synthesizes supersede completions, cascades completion
signals, and emits ordinary `Closes-Epic:` merges when obligation-complete
epics are proven complete.

- `complete(node)` — `true` iff an outgoing **satisfies**-edge is satisfied
  (supersede), else — if the node has **first-parent children** (an EPIC) —
  every outgoing **requires**-edge is satisfied (mode = all) AND every child
  subtree is `complete()`; else (a LEAF / issue / foreign node) `done(node)`.
- `leaf-readiness(node)` — `NOT complete(node)` AND every outgoing
  **requires**-edge satisfied AND (for a current-repo task node) unclaimed
  AND unblocked. A LEAF's requires-edges gate **readiness**, never its own
  completeness.
- **Load-bearing ordering:** a node is classified EPIC vs LEAF by
  **containment** *before* a direct leaf-style `done()` fact is trusted.
  Canonical witness derivation prevents structural/dependency parent tokens
  from becoming facts, while epic completeness still comes from obligations
  (exactly like `epic_subtree_complete`), not a direct leaf completion.

The push-reaction handler + periodic reconciler **backstop** (local-CAS
fold, cross-repo hint delivery, cascade, supersede synth-completion), the
epic **auto-close** rewiring onto these predicates, the delegate/block/
supersede edge **wrappers** are shipped reviewed sibling layers above this
read-only predicate module. They must stay thin consumers of the predicate /
edge-writer contracts, not duplicate fact derivation or invent new refs.

---

## Per-kind commit shapes (the deeper contract)

These are the message shapes each minter produces today. They are **not**
all machine-enforced yet (see "Roadmap" / the deferred follow-up), but they
are the contract you must preserve when editing a minter.

- **Epic root** (`tasks/pending/<N>`, `gh/issues/<N>`): `Task: <title>` +
  `Issue: #N` + `Author:` + `URL:` + `Status: pending` + `Type: epic`.
  Empty tree, parent = master HEAD **at creation** (never re-anchored).
- **Leaf** (`tasks/frontier/<short>` from `breakdown`): `Task: <title>` +
  `Type: leaf|task`, parents = dependency task commits (DAG edges).
- **Message/comment task** (`tasks/frontier/<short>` from `ingest-comment`):
  `kind: message` / `role: human` / `intent: comment` + YAML block, parent
  = epic.
- **Claim** (`tasks/active/<short>`, `tasks/root-active/<N>`):
  `Task-Commit:` + `Claimer:` + `Claimer-Host:` + `Claimer-PID:` +
  `Claimed-At:` + `TTL-Hours:`, parent = the claimed commit. Written via an
  atomic `--force-with-lease` CAS + origin readback — **never** move these
  by hand.
- **Blocked-meta** (`tasks/blocked-meta/<sha>`): `Blocked-Meta:` +
  `Task-Commit:` + `Blocker-Kind:` + `Reason:` + …; tree == task tree,
  first parent == task commit, **deterministic** identity (fixed
  author/committer + `Blocked-At` date) so re-blocking is idempotent.
- **Delegation** (`tasks/delegated/…`): `kind: delegated`, parent = epic.
- **Completion record** (`tasks/completions/…`): `kind: completion`.
- **Completion merge** (on `master`, from `complete`): a merge whose
  non-first parent is the task commit, carrying `Task-Commit:` +
  `Status: completed`. Built on the **rebased** master tip. Normal
  implementation completions have the implementation commit as first parent.
- **Ops-only leaf completion merge** (on `master`, from `complete-ops`): a
  tree-equal merge whose first parent is the synced `origin/master` tip and
  whose non-first parent is the leaf task commit, carrying `Task-Commit:` +
  `Status: completed` plus `Ops-Completion: true`, `Ops-Evidence:`,
  `Ops-Authorization:`, and `Ops-Completed-*` audit trailers. The done fact is
  still the parent edge; the `Ops-*` trailers distinguish this sanctioned
  no-code operations case from dropped/irrelevant work and record evidence.
- **Close** (on `master`, from `close-epic` / `close-ops-epic` / local
  epic close): a merge carrying `Closes-Epic: #N`, consumed by
  `close-completed-issues.yml`. A parent-only check is **wrong** — the
  trailer is what triggers closure. (`close-ops-epic` is the sanctioned
  closer for a single-repo, ops-only / no-code epic; it mints this exact
  shape and **no** new namespace/trailer — see
  `docs/REF_LIFECYCLE.md` → "Closing an ops-only (no-code) epic".)

---

## Format versioning — how "permanently backwards-compatible" stays mechanical

When a rule must be **tightened** (e.g. issue #34's new mandatory naming
convention / commit format), do **not** retroactively bind it to all of
history — that turns every legacy ref red. Instead:

- Newly minted task commits stamp a **`Task-Dag-Format: <N>`** trailer.
- The auditor judges each commit against the ruleset version it *declares*.
  **Absent trailer = legacy** → validated only against the invariant floor
  above (empty tree + known namespace), which has always held.
- Tightening a rule = bump the version. The new checks bind only to commits
  declaring the new version; the tool stamps the current version on
  everything it mints.

So #34's format becomes `Task-Dag-Format: 2`, added in **one** place, and
old commits stay valid forever. The invariant floor needs no version — it
is true of every commit, past and future.

> **Status:** the `Task-Dag-Format` stamp and the per-kind *creation-time*
> assertion are the **deferred** half of this work (see below). The floor
> audit (`validate --strict`) and this contract doc ship first; they are
> read-only and cannot cause a fleet outage.

---

## Roadmap / deferred (tracked, do not silently expand scope)

The following are intentionally **not** in the first landing because they
are higher-risk and want their own Oracle diff review:

1. **Creation-time self-assertion, fail-closed.** A shared
   `assert_task_commit <kind> <sha>` called in every minter right before
   `update-ref`/push, so the tool *cannot* publish a malformed ref. Must be
   **fail-closed** (blocked creation is loud and recoverable; publishing a
   malformed ref is the exact failure we are eliminating) but kept **pure
   and local** (string checks on `git cat-file`, no network) and covered by
   a golden fixture per kind, so a validator regression fails CI before it
   reaches `master`. There are ~13 mint sites in two message dialects —
   this is the multi-day piece.
2. **`Task-Dag-Format: 1` stamp** on every minted task commit (the seam #34
   needs), landed together with (1).
3. **Periodic fleet audit workflow.** A reusable workflow that runs
   `validate --strict` against each peer repo's refs on push + schedule and
   pages the operator on failure (the only layer that catches raw-git
   hand-crafting after the fact). Needs a per-peer caller rollout **and**
   namespace reconciliation first — see the note below.

   > **Known reconciliation gap (found while landing this audit):** the
   > `FreshlyBakedNYC/automation` repo carries ~34 refs under a
   > `refs/heads/tasks/epic/<epic>/<task>` namespace that the canonical tool
   > does not mint (most are empty-tree task commits in the normal
   > `Task:`/`Type:` dialect; at least two — `catalog-image-icebox/epic`,
   > `catalog-image-maintenance/epic` — even have non-empty trees). Running
   > `validate --strict` there today reports ~38 violations. Before the
   > fleet audit can be a gate, each such namespace must be either
   > **adopted** (added to `TASKDAG_KNOWN_TASK_NS` + given a fixture, if it
   > is a legitimate convention) or **cleaned up** (if it is cruft). This is
   > an operator/reconciliation decision, not something to silently
   > legitimise by widening the known set. `top-level` itself is clean
   > (0 violations).
4. **True prevention: a GitHub Ruleset** restricting updates to
   `refs/heads/tasks/**` to the task-dag App identity. GitHub has no
   pre-receive hooks, so validation is *detection*, not prevention; a
   Ruleset is the only hard gate. Deferred because it changes fleet push
   topology and needs operator sign-off.

## Agent-authored issue comments MUST go through `task-dag comment`

The incident that triggered this work — a status comment lacking the
`<!-- task-dag:status -->` marker getting ingested as a new pickable task —
was originally read as an operator-workflow problem. It was not: the comment
was posted by an **agent** through an unmanaged path (raw `gh issue comment`
/ the REST API), so the marker was simply forgotten. That is a **tooling
gap**, and the fix is tooling, not asking anyone to remember a marker.

**Invariant: agents post issue comments ONLY via `task-dag comment`.** It is
the single writer that turns an agent body into an issue comment, and it:

- **requires `--kind`** (`status` | `operator-decision`) and fails closed on
  anything else — notably `--kind=completion` is rejected and redirected to
  the automated `Satisfies:` trailer flow (completion has its own dedicated
  path and must not be hand-emitted as a generic comment);
- **stamps the `<!-- task-dag:<kind> -->` marker as physical line 1**, so the
  comment can never be mis-ingested as a task (any leading `<!--` line, or any
  `<!-- task-dag:` anywhere in the body, is skipped by `ingest-comment`);
- **reserves the whole `task-dag:*` marker namespace**: a body that itself
  contains `<!-- task-dag:` is rejected (one marker per comment, one writer),
  so agents cannot smuggle in a second/forged marker;
- normalizes the body, rejects empty/oversize bodies, and JSON-encodes via
  `jq` so arbitrary text cannot break or inject into the API request.

Do **NOT** use `gh issue comment`, `curl` against `/issues/*/comments`, or any
other hand-rolled path to comment on a task-managed issue. A round-trip test
(`tests/task-dag/comment-cmd.sh`) feeds the exact body `comment` would post
back through the real `ingest-comment` and asserts it is skipped, locking the
no-phantom-task guarantee to the implementation.

The remaining, genuinely-operator-facing question — whether *operator* prose
(a human typing directly in the GitHub UI, who cannot be forced through the
CLI) should get an `ingest-comment` acknowledgement reply or opt-in markers —
still changes operator workflow semantics and remains an **operator
decision**, not an agent's to make unilaterally.
### Durable GitHub comment receipts (v1)

`refs/heads/gh/comments/<issue>/<comment-id>` is origin-authoritative. New
entries point to an empty-tree commit titled `Record GitHub comment receipt`
with `Receipt-Version: 1`, canonical repository and positive issue/comment
identity, canonical UTC creation/observation timestamps, exact-body SHA-256,
and one terminal disposition. `machine-skip` has no parent or effect fields.
`human` and `completion` have exactly one parent, equal to `Effect-Commit`, and
record `Effect-Ref-At-Creation`. The receipt and any newly-created effect ref
are published in one create-only atomic push. Local refs are caches, never
proof of ingestion. Recognised historical human and completion provenance is
immutable and remains accepted; malformed or unsupported origin objects are
fatal and are never replaced.
