# Pending-purchase packet REPL design

Status: accepted design record for [automation#70](https://github.com/FreshlyBakedNYC/automation/issues/70).  
Oracle review: completed 2026-07-09; the initial packet-revision idea was not
approved until the state machine, concurrency, lineage, patch contract, and
apply gate below were made explicit.

## Goal

Turn pending-purchase packet review into a short, turn-based interaction with a
packet analyst model. The operator should be able to submit feedback such as
"all of those 1g prerolls are infused and should be $16.50", wait for a
regenerated packet revision, and continue reviewing the improved packet without
re-running the entire purchase import flow from scratch or manually editing many
rows one at a time.

Non-negotiables:

- The model proposes; deterministic validators and the existing apply path keep
  authority over product ids, taxonomy, approval, and live Sweed writes.
- Every operator turn and generated revision is auditable and reversible.
- A failed refinement never supersedes or mutates the packet being reviewed.
- The mobile review surface keeps the next useful action at the top; provenance
  and history are available but collapsed by default.
- Schema-changing work is a separate implementation step that requires explicit
  operator approval before migrations land or deploy.

## Current seams

- Packet generation starts in
  `helios/src/worker/jobs/generatePendingPurchasePacketJob.ts`. It collects live
  pending purchase orders from Sweed, builds catalog context, calls the
  event-level classifier, reconciles proposals, and persists a packet.
- The classifier in
  `helios/src/worker/pendingPurchases/classifyPendingPurchasePacket.ts` is the
  safety pattern to reuse: bounded JSON data payload, strict output validation,
  no invented ids, taxonomy validation, and fail-loud behavior.
- Packet/row review APIs live in
  `helios/src/server/routes/pendingPurchases.ts`; row edits and approvals use
  row-level optimistic versions, and apply queues only approved selected rows.
- Row loading in `helios/src/server/db/queries/pendingPurchaseQueries.ts` merges
  normalized columns with richer `raw_row_json` fields and exposes effective
  reviewer overrides to the SPA.
- The reviewer UI is
  `helios/src/client/routes/catalog/PendingPurchasesPage.tsx`. It already has
  generation polling, per-row edits, family grouping, and apply controls, but
  the new REPL must not bury its feedback box behind admin generation controls.
- API/domain contracts are in
  `helios/src/shared/contracts/api/pendingPurchases.ts` and
  `helios/src/shared/contracts/domain/pendingPurchases.ts`.

Before writing migrations, the schema task must reconcile the committed schema
include with the columns the current query layer uses (`raw_row_json`, row
`version`, `last_apply_status`, `approval_updated_at`, and related apply/edit
state). Do not assume `schema/pendingPurchases.sql` alone is the complete live
contract without checking the migration artifacts and deployed database shape.

## Accepted revision model

Use a packet-root model with candidate revisions.

```diagram
╭─────────────╮       submit feedback       ╭─────────────────────╮
│ current rev │────────────────────────────▶│ refinement turn/job │
╰──────┬──────╯                             ╰──────────┬──────────╯
       │                                               │ success
       │ apply allowed only here                       ▼
       │                                      ╭──────────────────╮
       │             accept / make current   │ candidate rev     │
       └────────────────────────────────────▶│ apply disabled    │
                                              ╰──────────────────╯
```

- A packet root groups all revisions derived from the same initial purchase
  packet.
- Exactly one revision is current and applyable at a time.
- A successful refinement creates a candidate revision. It is visible for
  review and diffing, but apply is disabled until the operator accepts it as
  current.
- Accepting a candidate is transactional: it flips the root's current pointer,
  marks the previous current revision non-current, and records an audit event.
- Rollback is the same operation pointed at an earlier revision that is still
  safe to review. Applied rows are never silently rolled back.
- A failed refinement turn stores status/error and leaves every packet revision
  unchanged.
- There is at most one queued/running refinement per packet root.

Apply gating must be implemented with the persistence skeleton, not deferred to
UI only: the apply route must reject any packet that is not the root's current
applyable revision.

## Concurrency snapshot

Refinement is asynchronous, so enqueue-time state must be captured and verified
again in the worker before it materializes a candidate revision.

Store on each turn:

- target packet root and target packet revision id,
- target packet/root version or monotonic revision number,
- row ids and row versions included in the prompt,
- a deterministic `row_snapshot_sha256` over the row lineage ids, row versions,
  effective proposal fields, effective reviewer overrides, apply/approval state,
  and relevant raw provenance fields,
- operator feedback text, author, created timestamp, job id/status, model and
  prompt provenance when available.

The worker must re-load and fail loud if the root current pointer, row set, row
versions, or snapshot hash changed between enqueue and persist. This prevents a
turn based on stale review state from overwriting later human work.

## Stable row lineage

Copied revision rows get new database row ids, so history and diffs need a
stable identity that survives revisions.

Required fields/semantics:

- `row_lineage_id` or equivalent stable public lineage key: minted for the base
  packet row and copied to every descendant revision row.
- `parent_row_id` and `parent_packet_id` for direct provenance/debugging.
- Diffs, anchors, LLM patch targets, and history compare by lineage, never by
  current `row_id` or distributor-name heuristics.
- V1 refinements may patch existing lineages only. No add/delete/split/merge is
  allowed until a later design defines identity, approval, apply, and diff
  semantics for those operations.

## V1 LLM patch contract

The refinement model returns a narrow allow-listed patch set, not full row
replacements and not apply instructions.

Allowed patch targets should be limited to existing row lineages and fields in
these families:

- structured proposal fields: brand, group, category, subcategory, size, pack
  count, variant name/tab, strain,
- reuse candidate proposal, constrained to product ids offered in the prompt,
- proposed price, description, and primary image proposal,
- review flags / rationale / cited evidence ids.

Forbidden in model output:

- packet status, root/current pointers, row identity, order ids, position ids,
  approval status, apply status, apply request ids, audit fields, arbitrary
  `raw_row_json`, and any live-write instruction.

Validator requirements:

- reject unknown or duplicate row lineage ids,
- reject unknown/disabled/deleted product ids unless a later task explicitly
  defines the exception,
- reject taxonomy outside the allowed set,
- reject citations that were not provided in prompt context,
- reject unknown keys and oversized output,
- reject add/delete/split/merge operations in v1,
- preserve the existing classifier stance: operator feedback is trusted business
  guidance but remains subordinate to system rules, schema, offered candidates,
  and deterministic validation.

The worker materializes validated patches by copying the current revision's rows
into a candidate packet revision. For changed rows, flatten the effective base
values into the new proposal fields and reset reviewer override columns rather
than carrying old overrides forward as hidden state. All candidate rows start as
`approval_status = pending`, apply status `not_requested`, no apply request
linkage, no apply error, and fresh row versions.

## Provenance and ETL details

Refined rows must not present the original classifier provenance as if it still
fully explains the current row.

- Keep original generation/classifier evidence available for audit.
- Add refinement provenance separately, e.g. prompt/model version, turn id,
  parent row snapshot, patch rationale, warning flags, and cited evidence ids.
- Label or hide the existing ETL-details link on refined packets unless the UI
  makes clear it is the original classifier comparison, not the refinement's
  current reasoning.

## Context policy

Mandatory context for the first refinement implementation:

- current packet rows and effective values,
- stable row lineages and row versions,
- allowed taxonomy and current catalog candidates used for validation,
- current distributor links / Sweed suggestions when offered as reuse candidates,
- operator feedback and bounded prior turn history.

Optional enrichment, after the core loop works:

- prior same-distributor/vendor sanctioned purchase outcomes,
- additional live Sweed catalog/current-link context,
- LitAlerts market evidence.

Optional evidence providers must emit stable evidence ids, bound prompt size, and
degrade with explicit "context unavailable" notes. Optional evidence never
changes row identity or apply authorization semantics.

## API, permissions, and audit

Expected API surface:

- submit refinement feedback for a packet revision,
- list refinement turns/history for a packet root,
- accept/make-current a candidate revision,
- rollback/switch to a previous safe revision,
- load candidate/current status and lineage-based row diffs for the review UI.

Permissions:

- submit feedback: editor or stronger,
- accept/make-current and rollback: editor or stronger,
- apply remains approver-gated.

Audit events:

- feedback submitted,
- refinement job queued/started/finished/failed,
- candidate revision created,
- current revision accepted/switched/rolled back,
- apply rejected because packet is non-current or non-applyable.

Input safety:

- bound feedback length, turn history size, row count, candidate count, and
  serialized prompt size,
- preserve feedback text on job/API failure,
- render stored operator/model text escaped only,
- never point tests or examples at live Sweed/prod resources.

## UI/UX shape

On packet row-review pages, the REPL is primary work, not admin chrome.

- Put a compact "Ask the packet analyst" feedback box near the top/sticky on
  rows mode.
- Show current/candidate revision state and the latest turn status next to it.
- Poll refinement jobs independently from generation jobs.
- On success, navigate to the candidate revision's row review and show changed
  fields with compact lineage-based diff chips.
- Preserve feedback text on failure so retry/edit is one tap.
- Keep turn history, provenance, methodology, and raw evidence collapsed by
  default.
- Keep per-row overrides and apply controls as escape hatches, but they are no
  longer the primary way to fix repeated packet-wide mistakes.
- Display timestamps with the existing NY-time helpers; no browser-local or UTC
  display.

## Rollout and rollback

1. Land this design record only.
2. Before schema work, get explicit operator approval for the migrations.
3. Land migrations/contracts without enabling LLM refinement behavior.
4. Land deterministic candidate revision persistence and apply gating.
5. Land strict refinement LLM service.
6. Land the UI.
7. Add optional evidence enrichment.
8. Add end-to-end coverage and operator runbook.

Rollback should be simple while behavior is feature-incomplete: disable/hide the
refinement submit UI and leave existing packet generation/review/apply behavior
in place. Once migrations land, rollback is behavioral unless a later task ships
a separately approved down migration/runbook.

## Task breakdown

The epic was decomposed into these leaves:

1. Record accepted pending-purchase REPL design.
2. Add pending-purchase refinement schema and contracts, gated on operator
   approval for migrations.
3. Implement deterministic refinement revision persistence and apply gating.
4. Add strict LLM packet-refinement service.
5. Build packet-refinement REPL review UI.
6. Enrich refinement context with prior outcomes and market evidence.
7. Add pending-purchase REPL end-to-end coverage and runbook.
