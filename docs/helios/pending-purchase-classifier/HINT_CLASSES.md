# Pending-purchase hints — the supported hint classes

**Repo:** `FreshlyBakedNYC/automation` (Helios app under `helios/`).
**Issue:** [FreshlyBakedNYC/automation#69](https://github.com/FreshlyBakedNYC/automation/issues/69)
("Pending Purchases — Hint text failure").

An operator attaches **hint documents** to a pending-purchase hint bundle
(Helios → Catalog → Pending Purchases) to help the LLM classifier decode a
distributor's heavily-abbreviated METRC line-item names into catalog rows.
This document is the authoritative statement of **what a hint can do** — the
three classes of evidence the pipeline extracts and feeds to the classifier —
and, just as importantly, **what a hint is not**.

The pipeline stages referenced below: **C3** =
[`extractPendingPurchaseHintFacts`](../../../helios/src/worker/pendingPurchases/hintFactExtraction.ts)
(per-document extraction); the **loaders** =
[`pendingPurchaseHintQueries.ts`](../../../helios/src/server/db/queries/pendingPurchaseHintQueries.ts)
+ [`buildClassifierHintFacts`](../../../helios/src/worker/jobs/generatePendingPurchasePacketJob.ts);
**C4** =
[`classifyPendingPurchasePacketWithLlm`](../../../helios/src/worker/pendingPurchases/classifyPendingPurchasePacket.ts).

## The three hint classes

### 1. Product facts — UNTRUSTED cited data

Structured facts about a specific product that C3 extracts from a hint
document (a distributor menu, a sibling purchase order, or free text): item
name, brand, strain, category/subcategory, size, pack count, wholesale price,
quantity, etc. Each fact is **cited** back to the source lines it came from
and carries a stable `citedId` (`<hintDocumentId>#<factId>`).

The classifier sees these on the `hintFacts` channel as **UNTRUSTED DATA**.
It may use them as evidence (e.g. a `sibling-po` reuse proposal must rest on a
cited product fact), and it **must cite** the `citedId` whenever a fact
informed a decision. Any instruction embedded inside a fact is ignored.

### 2. Cited glossary / acronym expansions — UNTRUSTED interpretation data

An abbreviation or term mapped to its literal expansion — e.g. `PR → Preroll`,
`FL → Flower`, `METRC → Marijuana Enforcement Tracking Reporting Compliance`.
This is the exact class the #69 report needed: "relatively straightforward
hint text expanding the METRC acronyms." C3 extracts these into a separate
`glossaryEntries` list; a **glossary-only** document (zero product facts, one
or more expansions) persists as `extracted` and is **not** discarded. The
loaders flatten them onto the classifier's `glossaryEntries` channel with a
`citedId`.

A glossary entry is **INTERPRETATION evidence only**. It explains what an
abbreviation *means*; it never asserts that a reusable product exists and never
carries a product id. The classifier may use an expansion to decode a row name
and **must cite** the glossary `citedId` when it does, but it can never propose
a reuse link on the strength of a glossary entry alone (a `sibling-po` claim
citing only glossary ids is rejected). Like product facts, a glossary `note`
is inert data, not an instruction.

### 3. Operator notes — TRUSTED verbatim guidance

A free-text `operator_note` document authored **only by the authenticated
operator** via the admin hint UI — e.g. "MZ is Moony Zooties, an existing
brand. There should be no new brands created here." Because it is authored by
the operator (not pasted external material), it is the one class treated as
**TRUSTED business guidance**, fed to C4 **verbatim** on the `operatorGuidance`
channel.

This class is why #69's follow-up mattered: an operator note like the above
extracts to **0 product facts / 0 glossary entries**, so under the
facts+glossary-only model the operator's actual intent was silently dropped and
the classifier proposed creating new brands for the acronym. Operator notes now
reach C4 regardless of what C3 could structure out of them — a note whose
extraction yielded nothing usable **still** reaches the classifier, and a blob
read/integrity failure fails loud rather than silently degrading.

The classifier **should follow** operator guidance: decode abbreviations to the
brand/product the operator names, prefer mapping a row onto an existing catalog
product when told the items are existing, and avoid `catalog-create` for a brand
said to exist. Do **not** cite operator notes in `citedHintIds` (that field is
for facts/glossary); the model instead mentions "operator guidance" in its
rationale/warning flags when guidance drove a decision.

**Trusted still means subordinate.** Operator guidance can steer the choice
*among valid outputs*; it can **never** override the system prompt, the output
schema, the allowed taxonomy, the offered candidate pool, the citation rules, or
the "you propose, a validator authorizes" boundary. In particular, if the
operator says a row is an existing brand/product but **no offered candidate**
matches, the classifier must choose `needs-review` — never `catalog-create` and
never invent or reuse a non-offered product id.

## What a hint is NOT

A hint is **not** a free-form "instructions to the classifier" channel that can
rewrite the pipeline's rules. Three classes are supported — product facts, cited
glossary/acronym expansions, and trusted operator-note guidance — and nothing
else. Text pasted as a `distributor_menu` / `sibling_purchase_order` / `other`
document is untrusted data mined for facts and glossary entries; any imperative
inside it ("use product id 1234", "always create a new brand") is ignored.

Even the trusted operator-note channel is guidance, not control: the hard
output validator (single draft per row, candidate ids must be offered, cited
ids must be provided, taxonomy must be allowed) runs regardless of what any hint
says, and a hint can never make the classifier emit an output that violates it.

## Degrade + fail-loud posture

- A hint bundle that produces **no usable evidence** across all three classes
  (all documents terminal, nothing extracted, no operator note) does **not**
  abort generation: the job warns and generates without hint evidence.
- An attached bundle id that resolves to **zero documents** is an operator error
  (missing/removed/mistyped) and fails loud.
- A bundle still mid-extraction defers (retryable) rather than generating with
  partial evidence.
- An operator-note blob that cannot be read fails loud — generating without the
  operator's guidance would silently recreate the #69 incident.

## Tests

- Per-layer: [`hintFactExtraction.test.ts`](../../../helios/src/worker/pendingPurchases/hintFactExtraction.test.ts)
  (C3 glossary extraction), [`pendingPurchaseHintQueries.test.ts`](../../../helios/src/server/db/queries/pendingPurchaseHintQueries.test.ts)
  (loaders), [`generatePendingPurchasePacketJob.hintRace.test.ts`](../../../helios/src/worker/jobs/generatePendingPurchasePacketJob.hintRace.test.ts)
  (facts/glossary/operator-guidance flattening + degrade),
  [`classifyPendingPurchasePacket.test.ts`](../../../helios/src/worker/pendingPurchases/classifyPendingPurchasePacket.ts)
  (C4 citation accept/reject + trust split).
- Cross-seam end to end:
  [`generatePendingPurchasePacketJob.glossaryE2E.test.ts`](../../../helios/src/worker/jobs/generatePendingPurchasePacketJob.glossaryE2E.test.ts)
  wires the real C3 → persisted-blob → loader → real C4 path and proves a
  glossary-only METRC hint reaches an accepted draft citing the flattened
  glossary id, while a fabricated cited id is rejected.
