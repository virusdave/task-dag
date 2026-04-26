# Helios Migration And Ownership

This doc is the durable home for current Helios migration boundaries and ownership notes.

## Canonical Rule

- If a task touches a workflow Helios has already subsumed, work in Helios first instead of extending or reviving a separate bespoke webapp.
- The operator-facing app, shared auth/session flow, job queue, audit history, and dependency-health surfaces now live in Helios.
- Standalone scripts can still be the execution engine behind a Helios worker job, but the operator surface and new orchestration logic should go into Helios unless the user explicitly asks for a non-Helios path.

## Shared Helios Surface

- Base-path-safe app mounting under `/internal/tools` is implemented from `APP_BASE_URL`.
- One Fastify app, one React shell, one Google OAuth/session layer, one worker queue, one append-only audit stream, and one shared dependency-health surface are live.
- The global dashboard, global jobs page, and global history page are live and module-aware.

## Fully Migrated Modules

### Catalog

- `catalog` is a live Helios module.
- The namespaced catalog routes are live at `/catalog`, `/catalog/review`, `/catalog/browser`, `/catalog/history`, `/catalog/pending-purchases`, and `/catalog/groups/:catalogGroupId`.
- Legacy `/review` and `/groups/:catalogGroupId` URLs now redirect into the module routes.
- Catalog review, browser, first-class catalog history, pending-purchase packet review/generate/import/apply, group-detail, sync/mirror, reconcile, and related job or audit flows should be treated as Helios-owned functionality.
- `/catalog/pending-purchases` can queue a first-class Sweed-backed generator job over the Bronx or Midtown outstanding PO queue, persist `generated` review packets with append-only audit history, keep the older JSON packet import as a fallback replay path, and move approved rows into a first-pass queued worker apply flow with row approval state, richer preserved packet evidence on the review cards, structured suggestion-verification or manual-follow-up summaries, and worker-side HTTPS or public-host or content-type or size guardrails before reviewed image URLs are uploaded into Sweed blobs.
- `/catalog/history` gives operators a catalog-owned history surface for proposal batches, review decisions, live write operations, pending-purchase packets, and pending-purchase apply runs without falling back to raw global audit payloads.

### Screens

- `screens` is a live Helios module with a real operator page at `/screens`.
- `/screens/devices` is a live first-pass devices-management page. It reads the latest banner-refresh or direct-readback artifact into a browseable Bronx or Midtown screen inventory and lets operators queue selected-device image-banner sync jobs without leaving Helios.
- The following screens workflows are fully migrated into Helios jobs with dry-run or live-apply support, runtime artifacts, and append-only audit events:
  - `screens.banner_refresh`
  - `screens.banner_health_maintenance`
  - `screens.enable_healthy_banners`
  - `screens.bronx_midtown_image_clone`
  - `screens.midtown_priced_to_move_promo_rebind`
  - `screens.midtown_fresh_and_intense_promo_rebind`
  - `screens.image_banner_sync`
- These screens workflows still wrap proven Python playbooks underneath, but Helios is now the canonical operator surface.
- `screens.image_banner_sync` is intentionally limited to static image banners for now. Promo-backed product-menu duplication still belongs to the dedicated rebind workflows because cross-site `promoActionId` reuse is not generally safe.

## Not Fully Migrated Yet

- `crm`, `communications`, `pricing`, and `utilities` are planned Helios modules, not fully migrated ones.
- For those areas, check the user request carefully before assuming Helios already owns the workflow.
- Promo proposal review surfaces are not fully migrated yet. Until a Helios pricing or communications promo workflow exists, keep using the local reviewer-first packet pattern established in `bulk_additions/2026-04-16`: bundle related promos together, make before or after GM and selector-pool sales analysis prominent, keep clickable detail pages, and collapse raw payload or debug material by default.
- The next major Helios screens follow-up is wiring the existing hourly scheduled enqueue path for `screens.banner_health_maintenance`.

## Useful Code Paths

- Canonical app: [`../../bulk_additions/catalog_curation`](../../bulk_additions/catalog_curation)
- Module definitions and rollout summaries: [`../../bulk_additions/catalog_curation/src/shared/contracts/domain/modules.ts`](../../bulk_additions/catalog_curation/src/shared/contracts/domain/modules.ts)
- Shared screens workflow constants and job payloads: [`../../bulk_additions/catalog_curation/src/shared/contracts/domain/screens.ts`](../../bulk_additions/catalog_curation/src/shared/contracts/domain/screens.ts)
- Operator-facing route and UI behavior: [`../../bulk_additions/catalog_curation/src/client/routes`](../../bulk_additions/catalog_curation/src/client/routes)
- Queueing, audit, and worker behavior: [`../../bulk_additions/catalog_curation/src/server`](../../bulk_additions/catalog_curation/src/server) and [`../../bulk_additions/catalog_curation/src/worker`](../../bulk_additions/catalog_curation/src/worker)
- Artifact-backed screens inventory bootstrap: [`../../bulk_additions/catalog_curation/src/server/screens/inventory.ts`](../../bulk_additions/catalog_curation/src/server/screens/inventory.ts)
- Underlying screens playbooks and safety rules: [`../sweed/marketing/screens-and-banners.md`](../sweed/marketing/screens-and-banners.md)

## Live Status Note

- For the current queue, immediate next steps, or handoff state, read [`../../bulk_additions/catalog_curation/AGENT_TODO.md`](../../bulk_additions/catalog_curation/AGENT_TODO.md).
- Do not move durable ownership guidance out of this doc and into the handoff file.
