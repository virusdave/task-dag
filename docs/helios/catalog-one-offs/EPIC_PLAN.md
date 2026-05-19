# Helios product catalog one-off actions — epic plan

Tracking [issue #12 — *Helios product catalog one-offs*][issue]. The issue
calls out a family of "one-off" catalog actions that should be first-class
in Helios' product-catalog flows UI section, beyond the existing whole-
catalog operations (handle pending purchases, reprice, promo items, etc.):

1. Find all in-stock items without catalog images and make it trivial to
   take and upload photos from the mobile website.
2. Find all in-stock items with bad or missing barcodes (of a particular
   type), and allow uploading a photo of the barcode, which is then parsed
   prior to updating the package's barcode.
3. Create a new catalog entry (or small number of entries / variants),
   given an English description of what we need and zero or more product
   or variant photos. Especially useful for non-cannabis items (510
   batteries, rolling papers, blunt wraps, etc.). The proposal should
   end up going through the same review process used by other catalog
   modification / curation flows.

...and "probably more". The intent is to support **at least** these
initial one-offs as first-class flows in Helios' "product catalog flows"
section.

[issue]: https://github.com/FreshlyBakedNYC/automation/issues/12

## Status — what already ships today

Two of the three named one-offs already exist in Helios under the
**Catalog → Images & Barcodes** page
(`/helios/catalog/maintenance`, file
[`helios/src/client/routes/catalog/CatalogMaintenancePage.tsx`](../../../helios/src/client/routes/catalog/CatalogMaintenancePage.tsx)):

| Issue bullet | Helios surface today | Status |
|---|---|---|
| 1. In-stock + missing catalog image | "Missing group image" and "Missing variant image" sections on the Images & Barcodes page. Operator uploads / captures from phone; bytes land in the icebox (`/cloud/data/fbnyc/icebox/sweed/images/...`); worker job attaches to Sweed group/variant. | **Shipped** (epics: [catalog-image-maintenance](../catalog-maintenance/EPIC_PLAN.md), [catalog-image-icebox](../catalog-image-icebox/EPIC_PLAN.md)). |
| 2. In-stock + bad/missing barcode | "Missing or invalid barcode" section on the same page. Variant card supports manual edit and photo-capture; the captured photo is parsed (UPC/EAN/Code-128) and the parsed barcode is written via `POST /api/catalog/maintenance/barcode`. | **Shipped** (see `CatalogMaintenancePage` `barcode` card mode, `scanningBarcode`, `barcodeFileInputRef`, server route `helios/src/server/routes/catalogMaintenance.ts`, function `updateVariantBarcode`). |
| 3. Create a new catalog entry from English description + photos | — | **Not implemented.** This is the work tracked by this epic. |

Bullets 1 and 2 only need ongoing tuning (filter scopes, scan-quality
hints, per-site/brand quick filters — all incremental work on the existing
page). No new top-level epic is required for them; we will keep
incremental work tracked in follow-up issues if/when operator feedback
asks for specific changes.

The substantive new work is bullet 3 — operator-driven creation of a
brand-new catalog entry from a freeform English description plus zero or
more photos.

## Bullet 3 — design sketch

The "create a new catalog entry" flow is the only first-class catalog
mutation Helios currently *cannot* originate from inside Helios. Every
other proposal flow either (a) mirrors a Sweed change (pending purchases,
sales-driven sweeps) or (b) re-prices / re-categorizes existing entries.

### Surface

A new page under **Catalog → New entry** (sidebar leaf in
`catalogSidebarSubtree.ts`, route `catalog/new-entry`,
`CatalogNewEntryPage.tsx`). Mobile-first (operator may be on the floor
scanning a vendor box).

The page is a single form:

* **Free-text description** (multiline textarea). The operator types
  whatever they would write in Slack: *"Add Backwoods Original Honey
  Berry 5-pack, blunt wraps, $X, smoke shop dept."*
* **Photos** — zero or more, with the same capture/upload widget the
  Images & Barcodes page already uses (`<input type="file"
  accept="image/*" capture="environment">`, multi-file). Each photo is
  tagged by the operator as either *product photo* or *variant photo*
  (default: product). The first product photo becomes the candidate
  group image.
* **Optional structured hints** the operator may want to override before
  hitting *Propose* — department, category, brand, retail price, barcode.
  Each field is prefilled by the LLM extraction below but stays editable.
* **Propose** CTA — submits the bundle.

### Pipeline

1. **Stage uploads.** Photos go through the existing icebox path
   (`pendingImageUploadStore.put`, same code that backs the images &
   barcodes page), so the bytes are durable from the moment the operator
   hits *Propose*.

2. **LLM extraction (server).** New module
   `helios/src/server/catalog/newEntryProposal.ts`. Calls our existing
   LLM gateway with:
   * the description text,
   * thumbnails of the staged photos,
   * the controlled vocabulary the catalog uses today (departments,
     categories, brands — same lists the proposal-review flow uses).

   It returns a structured `NewCatalogEntryDraft` (department, category,
   brand, product name, variant names + per-variant attributes,
   suggested barcode if visible in a photo, suggested retail price, free-
   form rationale). Errors and low-confidence fields are surfaced for
   the operator to fix in the form before submission.

3. **Proposal materialization.** The accepted draft is turned into a
   proposal that flows through the *same* review queue that the rest of
   the catalog curation surface uses, by inserting into the proposal
   tables that `proposalBatches.ts` / `reviewPacketImport.ts` already
   read from. The proposal records the source as
   `kind: 'operator-new-entry'` so the review queue can render it with
   a "submitted by &lt;operator&gt; from Helios *New entry*" lane.

4. **Worker apply (post-approval).** When the reviewer approves the
   proposal it runs through the existing apply path (whatever the rest
   of the catalog modification flows use) — the new entry's
   `store.product.group.create` + per-variant `store.product.create`
   RPCs, plus image attachment using the icebox refs captured in step 1.
   No new worker job is required; we just need to teach the existing
   apply path to handle a "create-from-scratch" proposal kind (today
   everything is an update on an existing group/variant).

5. **Operator feedback.** The Helios page transitions to a per-proposal
   status card that links into the standard review queue, so the
   operator can see when the reviewer approves/rejects without leaving
   the new-entry flow.

### Out of scope for this epic

* Full vendor-PO import flow ("upload this entire invoice PDF and
  propose every line as a new catalog entry"). That is a richer
  variation of the same pipeline and can be a follow-up once the
  single-entry path is solid.
* Bulk barcode reconciliation across a whole department (current
  barcode flow is per-variant; bulk is a different operator task).
* Any auto-pricing on the new entry — pricing flows through its own
  proposal pipeline and that's where the price should be set; the
  operator's "suggested price" in step 2 above is just a hint stored
  on the proposal.

## Task breakdown

Each subtask becomes its own task-dag commit under this epic. Subtasks
are intentionally small and merge-shaped so they can ship independently
and so we surface intermediate progress in the review queue early.

1. **Plumbing: `newEntryProposal` server module + LLM extraction.**
   * New module `helios/src/server/catalog/newEntryProposal.ts`.
   * Reuses the existing LLM gateway and the controlled-vocabulary
     loader used by the proposal-review flow.
   * Pure data in / data out — no Fastify wiring yet. Unit-tested with
     recorded LLM fixtures.

2. **Server: routes.**
   * `POST /api/catalog/new-entry/draft` — accepts `{ description, photoRefs[] }`,
     returns a `NewCatalogEntryDraft`. Wraps step 1.
   * `POST /api/catalog/new-entry/propose` — accepts the operator-edited
     draft, persists a proposal row tagged `operator-new-entry`, returns
     the proposal id for the status card.
   * Reuses `@fastify/multipart` already registered for the images
     route to accept the photo uploads (or accepts pre-staged refs from
     a separate upload endpoint — pick whichever matches the existing
     Images & Barcodes upload contract).

3. **Apply path: handle `kind: 'operator-new-entry'` proposals.**
   * Extend the existing catalog-apply worker so that on approval it
     calls `store.product.group.create` + variant creation, then attaches
     icebox images using the existing image-attach helpers.
   * Idempotent (the apply step records the resulting `productGroupId`
     so a repeat run no-ops instead of re-creating).

4. **Client: `CatalogNewEntryPage` + sidebar + router.**
   * New sidebar leaf `catalog.new-entry` in `catalogSidebarSubtree.ts`.
   * Route `catalog/new-entry` rendering `CatalogNewEntryPage.tsx`.
   * New module-card on `CatalogModulePage.tsx` linking to it.
   * Form: description, multi-photo capture, structured-hint fields,
     *Propose* CTA. After submit, transitions to a status card linking
     into the review queue.

5. **Verify and ship.**
   * Server typecheck + the in-process SPA smoke test the pre-commit
     hook runs.
   * Manual smoke from phone + desktop: submit a 510-battery proposal
     end-to-end, walk it through review, confirm the group + variant
     get created in Sweed.
   * Close the epic via `task-dag complete`.

## Open questions for the operator

These were surfaced for the operator before locking the design in step 1
(see [issue #12 comment 4487365557][q-comment]). As of the date this
section was last edited, the operator has not yet responded, so the
implementation proceeds with the defaults previously proposed in this
plan. Each decision is reversible if the operator wants to override in a
follow-up comment; the relevant surface area (one route + one form) is
narrow.

[q-comment]: https://github.com/FreshlyBakedNYC/automation/issues/12#issuecomment-4487365557

| Question | Adopted default | Reversibility cost if overridden |
|---|---|---|
| Single new-entry form vs. also support "add variant to existing group" on the same page? | **Combined page** with an "add to existing group" mode toggle at the top. The LLM extraction module returns the same `NewCatalogEntryDraft` shape either way; only the apply path branches (`group.create` + variants vs. variants under an existing `productGroupId`). | Low — flipping the toggle into a separate route is a router + nav change; the draft schema does not change. |
| `Propose` CTA must reject drafts missing a retail-price suggestion? | **Accept** drafts without a retail price. Pricing is set during review by the existing pricing proposal flow; the operator's suggested price (if any) rides along on the proposal as a hint. | Low — flipping to "required at submit" is a single guard in the route handler + a form-validation message; no schema change. |
| LLM extraction taxonomy: canonical list only, or free-form? | **Canonical only.** The extraction prompt is given the same controlled-vocabulary lists (departments, categories, brands) the proposal-review UI uses; out-of-vocabulary values surface as a low-confidence hint for the operator to correct before submit, rather than minting new taxonomy entries. | Low — relaxing to free-form means dropping the vocabulary list from the LLM prompt and removing the validation step; the draft schema already carries the strings as plain text. |

If the operator wants any of these flipped, please reply on the issue
and the worker can land a follow-up that adjusts the corresponding hunk
in subtask 1 / 2 / 4.
