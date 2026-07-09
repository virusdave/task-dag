# task-dag commit & ref invariants — READ BEFORE TOUCHING ANY TASK REF

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
evolves (with review).

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
   | `tasks/completions/<N>/…/<sha>` | recorded downstream completion | `ingest-completion` |
   | `tasks/ci-chains/<owner>/<repo>/<branch>` | CI broken-master repair-chain state (NOT a task-workflow ref) | `chain-write` |
   | `tasks/v1/graph` | dependency-edge index branch — the ONE ref exempt from the empty-tree floor (see below) | the edge writer (issue #13) |
   | `gh/issues/<N>` | GitHub-side epic mapping | `create-task-commit.sh` |
   | `gh/comments/<N>/<id>` | comment provenance (kept so a comment is never re-ingested) | `ingest-comment` |
   | `gh/child-epics/<N>/<owner>/<repo>` | materialised child-epic provenance (default slot, one child per (parent, peer repo)) | cross-repo materialisation |
   | `gh/child-epic-slots/<N>/<owner>/<repo>/<slug>` | materialised named-slot child-epic provenance (allows multiple children per (parent, peer repo)); `<slug>` is `^[a-z0-9][a-z0-9-]{0,63}$`, validated by the minter | cross-repo materialisation |

   **Adding a new namespace is a format change.** You must add it to
   `TASKDAG_KNOWN_*_NS` **and** add a golden fixture in `tests/task-dag/`
   in the *same* change, or `validate --strict` (and the CLI-tests CI gate)
   will correctly reject it. This ordering is deliberate: it forces the
   contract and its test to land before any ref uses the new path.

`validate --strict` is **read-only** and **race-tolerant**: it snapshots
refs in a single `for-each-ref` and skips any ref whose object vanished
mid-walk (concurrent `claim`/`complete`/`drop`), so it never flaps under
fleet churn. A flapping gate trains the fleet to ignore it — worse than no
gate.

---

## The dependency-graph index (`tasks/v1/graph`) — the ONE empty-tree exception

The north-star dependency graph (issue #13) stores its **active edge set**
as an ordinary per-repo git branch, `refs/heads/tasks/v1/graph`, whose
**latest tree IS the edge set**. This is the single, deliberate,
operator-approved (issue #13 Phase 0) exception to invariant-floor rule #1
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
- **Schema v1 has no tombstones.** Active edges live only under `edges/`.
  Satisfied-edge pruning and explicit tombstones are a **separate** reviewed
  change (a later sibling task) and will use their own path; do not overload
  the edge blob with `deleted`/`active` flags.

The read side + data-model helpers live in `scripts/task-dag.d/edges.sh`
(`taskdag_edge_id`, `taskdag_edge_blob`, `taskdag_normalize_node`,
`taskdag_repo_numeric_id`, `taskdag_read_edges`, and the `edges` read
command). The direct-CAS **writer**, pruning, mailbox, reconciler, and the
`graph --explain` resolver are separate tasks. Golden fixtures for the
exemption + its shape invariant are in `tests/task-dag/validate-strict.sh`
(TEST 11–14) and the model/reader is unit-tested in `tests/task-dag/edges.sh`.

### Derived facts (`done` / `satisfied`) — in-memory, ZERO per-fact refs

The two primitive facts the dependency graph reasons over are **derived**
from `master`'s completion history and cached **in memory** for the life of
one process — **never** one-ref-per-fact (this is what keeps the live
mirrored ref count `O(open work)`, not `O(total history)`):

- `done(node)` is authoritative from **this repo's** master history and is
  **scoped to the current repo** (a node's identity is `owner/repo` +
  object-id, and local history is authoritative only for the current repo):
  a `task:<cur-repo>@<sha>` is done ⟺ `<sha>` appears as a parent-field
  token of a commit reachable from the master tip **and** is an empty-tree
  task commit (mirrors the tool's authoritative `task_is_completed_at_commit`
  semantics, with an empty-tree guard so an implementation SHA — a first
  parent — is never mistaken for a completed task); an `issue:<cur-repo>#<N>`
  is done ⟺ a merge reachable from the tip carries a `Closes-Epic: #<N>`
  **trailer** (parsed as a git trailer, so body prose cannot forge it). A
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
`tests/task-dag/facts.sh`. It computes **raw facts only** — leaf readiness,
epic closure, and supersede propagation are separate reviewed tasks.

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
  `Status: completed`. Built on the **rebased** master tip.
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
