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
