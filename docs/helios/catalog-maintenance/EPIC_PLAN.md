# Catalog Image Maintenance — Helios Page (mobile-first)

Epic plan for a new Helios screen under **Catalog → Maintenance** that lets a
human operator (often on a phone, on the floor) close two recurring catalog
gaps:

1. **In-stock SKUs missing a product-catalog-level image** — i.e. the
   Sweed product *group* this SKU lives under has zero images.
2. **In-stock SKUs with multiple in-stock variants under the same product but
   without exhaustive variant images** — the group has ≥2 in-stock variants
   and one or more of those variants lacks a variant-specific image
   (everything is sharing the group image, or sharing one variant image).

For both lists the operator must be able to upload or capture a photo on the
spot and have Helios attach it to the appropriate Sweed group or selected
variant(s).

## Task breakdown

1. **Server: shared Sweed session helper + maintenance survey.**
   - Centralize Sweed RPC + session-lock for the server (today two copies
     exist in `liveInventoryScope.ts` and `catalog/liveRecentSales.ts`).
   - Add `src/server/catalog/maintenance.ts` that pulls live in-stock product
     IDs, groups them, fetches `store.product.group.get` per unique group,
     and emits two candidate lists (missing-group-image vs.
     missing-variant-image).
   - Add an in-memory TTL cache (10 min) with `?refresh=1` override and
     post-upload invalidation.

2. **Server: routes + multipart upload.**
   - `GET  /api/catalog/maintenance/missing-group-images`
   - `GET  /api/catalog/maintenance/missing-variant-images`
   - `POST /api/catalog/maintenance/images` (multipart: target group or
     variants; one image; appends to existing image set).
   - Register `@fastify/multipart`.
   - Reuse `downloadValidatedImageAsset` validators (allowed MIME types,
     size cap) for direct uploads.

3. **Client: page, sidebar, router.**
   - Sidebar leaf `Maintenance` under Catalog.
   - Route `catalog/maintenance` rendering `CatalogMaintenancePage`.
   - Two stacked sections, mobile-first card list, preview image per
     candidate, hidden `<input type="file" accept="image/*"
     capture="environment">` and a single big CTA. After successful upload
     the candidate disappears and both lists refresh.

4. **Verify and ship.**
   - Build, deploy, smoke-test on phone + desktop, page Dave.
   - Close the epic via `task-dag complete`.

---

## UX redesign (2026-06) — "Photos & Barcodes"

The page shipped above grew over time (barcodes, METRC/shelf controls,
cache-repair flow) and became one of the most user-hostile pages in
Helios for nontechnical floor staff: implementation jargon everywhere
(Sweed/METRC/cache/orphan/job ids), multiple confusing "refresh"
buttons, and no obvious way to make a newly-received brand appear. This
redesign reframes the page around the floor operator.

### Phases 1–3 (done)

- Renamed **Images & Barcodes → Photos & Barcodes** (page, sidebar,
  index, copy).
- One discoverable primary action, **"Check for new or updated
  stock"**, on both index and per-site pages. It runs the
  stock-refresh → discover-orphan-groups → group-sync chain that
  surfaces a just-received brand into the brand-filter strip and as
  worklist cards, with inline progress feedback.
- New first-class **"still loading"** state (`pendingImportCount`) for
  just-received items not yet linked to a catalog group, replacing the
  scary raw-id "Cache is incomplete" banner.
- Section labels → **Needs photo** / **Needs barcode**.
- Scrubbed all user-facing implementation jargon and raw backend
  errors (routed to telemetry via `reportClientError`; users see calm
  "Dave has been notified" copy).
- Replaced `window.confirm` with accessible shared `.wh-modal*` modals
  (dialog semantics, focus management, Escape/backdrop close, labeled
  confirmation input).
- The live-Sweed-latency modal (warns when a refresh exceeds typical
  page latency) is handled by a parallel effort.

### Phase 4 (planned) — three co-equal per-item actions

**Note (operator):** *image, barcode, and warehousing location should
all be together as the three things we can fix/update per item.*

Today only **photo** and **barcode** are first-class per-site worklist
**sections** (`CatalogMaintenanceSectionKind` =
`missing-catalog-image` | `missing-or-invalid-barcode`). **Warehouse /
shelf location** exists only buried inside the per-package
`ShelfControl` in the packages panel (`warehouseLocationCode` /
internal track code, shared with `WarehouseLocationsPage`), and is not
surfaced as something an operator is prompted to fix per item.

Phase 4 elevates warehouse/shelf location to a co-equal third
per-item dimension so the page consistently presents **photo,
barcode, and shelf location** as the three fixable/updatable things
per item. Concrete work:

- Add a third section kind (e.g. `missing-warehouse-location`) to
  `CatalogMaintenanceSectionKindSchema` and the server survey in
  `src/server/catalog/maintenance.ts` (define what "needs a shelf
  location" means: in-stock package with no/invalid
  `warehouseLocationCode`).
- Add a **"Needs shelf location"** worklist section to the per-site
  page, reusing the existing `ShelfControl` picker as the inline fix.
- Include the new dimension in the per-site `totalIssueCount`, the
  brand-filter strip counts, the index/site "to fix" pills, and the
  sidebar site counts.
- Unify the card so photo / barcode / shelf-location status and their
  fix actions read as one consistent set of three per item.
- Keep all copy floor-staff-friendly (no METRC/internal-track/Sweed
  jargon) and the modals accessible, per phases 1–3.
