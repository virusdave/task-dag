# Pending-purchase classifier — operator decision record

**Repo:** `FreshlyBakedNYC/automation` (Helios app under `helios/`).
**Issue:** [FreshlyBakedNYC/automation#54](https://github.com/FreshlyBakedNYC/automation/issues/54)
(the Helios child epic of the parent
[virusdave/top-level#33](https://github.com/virusdave/top-level/issues/33)).
**Authoritative design + staged plan (top-level repo):**
`docs/designs/prospective-pending-purchase-classifier.md` and
`docs/epics/prospective-pending-purchase/EPIC_PLAN.md`.

This file records a **mid-epic operator redirect** that supersedes part of
the C8 charter and the parent epic's "operator decision 4". It exists so
the workers who implement the re-chartered C8 children (C8a/C8b/C8c) act on
the operator's actual intent rather than the now-stale "delete the legacy
classifier" text baked into the immutable C8 task commit.

## Source

Operator (`virusdave`) reply on issue #54, comment
[`#issuecomment-4887093467`](https://github.com/FreshlyBakedNYC/automation/issues/54#issuecomment-4887093467),
answering the C8 worker's two blocking questions
("C8 — Direct cutover + legacy classifier deletion", task `e01c52ca`).

## Decision 1 — parsekit is KEPT ALIVE; build a 3-way comparison instead of deleting it

The original C8 charter (and the parent epic's "decision 4: go direct")
called for **deleting the legacy rule-based classifier**, which internally
runs `parseProductName()` — the live entry point that runs **parsekit** as
the live parser, compares it against the old hardcoded heuristics, and
records every match/mismatch to the `parsekit_reverse_shadow_events` table
(surfaced on **Helios → Config → Parsing → Purchases**). Parsekit's tuned
configs live in the separate repo
[`FreshlyBakedNYC/helios-parser-configs`](https://github.com/FreshlyBakedNYC/helios-parser-configs)
(`use-cases/pending-purchases/parsers/`).

**Operator veto:** *"I definitely want parsekit kept alive."* Rather than
retire it, run parsekit and the old heuristics **hand-in-hand** with the
new LLM classifier so parsekit can gain confidence over time and,
eventually, handle some/all line items on its own with the LLM as a more
expensive fallback. To see where each approach agrees/disagrees, surface a
per-packet **"Purchase ETL Details"** page (linked from every purchase
packet created going forward) showing a **3-way comparison**: the new LLM
result next to what parsekit and the old heuristics would have produced.

**Implications:**

- Do **NOT** delete `parseProductName` / `parseProductNameLegacy`, the
  parsekit stack, the `helios-parser-configs` usage, or the
  `parsekit_reverse_shadow_events` feed. The Config → Parsing → Purchases
  scorecard stays live.
- The generate job must, per packet, compute and **persist** what parsekit
  and the legacy heuristics would have produced (a 3-way per-line
  comparison record) alongside the LLM result that drives the packet.

## Decision 2 — reject the "accept lower recall" posture; add notes/hint upload to the create-packet UI

The C8 worker flagged that dropping the parsed-brand pre-search lowers
reuse recall at cutover. The operator **rejected accepting that as-is** and
instead wants to supply free context to the LLM:

> *"…I should be able to provide a freeform or uploaded 'notes' to provide
> context, which the LLM system can realistically understand and use to
> bias its results appropriately… This needs to be typeable / uploadable
> on the 'create new packet' page…"*

**Implications:** wire the already-built hint-bundle backend (C2/C3:
`pending_purchase_hint_bundles` / `pending_purchase_hint_documents`, the
`/api/catalog/pending-purchases/hint-bundles…` admin API, and the
`hintFactExtraction` extractor) into the **create-new-packet** form so an
operator can type or upload notes; create a hint bundle and pass the
already-accepted `hintBundleId` on `POST
/api/catalog/pending-purchases/generate`.

## Routing performed (task-dag)

C8 (`e01c52ca`, "Direct cutover + legacy classifier deletion") was
**decomposed and its refs dropped** — deliberately **not** `unblock`ed,
because its immutable charter mandates the vetoed parsekit deletion and
would otherwise be re-dispatched verbatim. Its resolved children:

| Task | Short SHA | Summary |
|---|---|---|
| **C8a** | `8bc43e2` | Wire the C4 LLM classifier + C5 reconciler into `generatePendingPurchasePacketJob.ts` as the driving path; keep parsekit + legacy heuristics running hand-in-hand (NO deletion); persist a per-packet 3-way comparison record. |
| **C8b** | `0a8e91d` | New per-packet "Purchase ETL Details" page rendering the LLM-vs-parsekit-vs-legacy comparison. Depends on C8a. |
| **C8c** | `0d4af74` | Notes/hints upload UI on the create-packet page, wired to the hint-bundle backend + `hintBundleId`. Independent of C8a. |

Every implementation commit satisfying any of these must carry the trailer
`Satisfies: virusdave/top-level#33`.
