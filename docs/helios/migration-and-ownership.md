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
- `/catalog/pending-purchases` can queue a first-class Sweed-backed generator job over the Bronx or Midtown outstanding PO queue, persist `generated` review packets with append-only audit history, keep the older JSON packet import as a fallback replay path, and move approved rows into a first-pass queued worker apply flow with row approval state, richer preserved packet evidence on the review cards, structured suggestion-verification or manual-follow-up summaries, worker-side HTTPS or public-host or content-type or size guardrails before reviewed image URLs are uploaded into Sweed blobs, and a grouped reviewer hierarchy that follows the shared catalog subnav plus disclosure-style site/category/subcategory/brand pattern instead of a flat legacy packet list.
- `/catalog/pending-purchases` now also exposes live pending-purchase generation feedback in-page: the queued generation job reports staged worker progress, the page renders a visible progress bar/status card while the job is queued or running, and operators can jump directly into `/jobs/:jobId` for job details and a live worker log tail instead of waiting on a silent button spinner.
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
- The `screens.banner_refresh` job now accepts `holdSeconds` and `intent: 'refresh' | 'bounce'`. When `intent='bounce'` (the canonical 30-second parallel banner/screen bounce), the worker writes structured `payload.progress` and a `payload.progressLog` tail consumed by `/jobs/:jobId` and the inline progress card on `/screens`, and calls `page-dave` on terminal status. Default `holdSeconds` remains `0` for backward compatibility with the unflagged refresh path.
- All bespoke banner-touching scripts older than one week (as of 2026-05-05) have been renamed `DEPRECATED_*.py` so future banner work must go through Helios; the still-active wrapped scripts (`refresh_all_sites_screen_banners.py`, `enable_healthy_screen_banners.py`, `clone_bronx_banners_to_midtown.py`, `tie_midtown_priced_to_move_banners_to_velocity_promos.py`, `replace_midtown_fresh_and_intense_image_banners_with_dynamic_promo.py`) remain as Helios worker execution engines only.

### Scheduling

- `scheduling` is now a live Helios module for the first employee-scheduling slice at `/scheduling`, `/scheduling/new`, and `/scheduling/runs/:schedulingRunId`.
- The first slice queues natural-language schedule runs through the shared Helios job queue, uses the approved Bedrock Mantle OpenAI-compatible path only for structured constraint extraction, persists extracted and normalized inputs plus candidate schedules in Postgres, and requires explicit human review before candidate generation.
- Scheduling runs now carry an explicit Sunday-through-Saturday scheduling window selected in the UI, can span multiple full weeks, and measure all preferred-hours-per-week or max-hours-per-week semantics separately inside each Sunday-through-Saturday week in that stored window.
- When weekly max hours are omitted, Helios now applies the current company policy default of preference 32 hours and hard max 35 hours inside normalized scheduling input; explicit zero-hour preferences still remain valid when the operator or source stated them intentionally.
- Employee `preferredShiftTags` are soft preference signals only. A shift requirement tag such as `AM` can be used to express that an employee prefers those tagged shifts, but it does not create a hard eligibility rule or restriction when the preference is absent.
- Candidate generation stays inside the Helios worker for now with a bounded TypeScript scheduling engine that emits an operator-requested number of candidates, scores strong recurring stability for longer windows with weekly and 2-week-cycle preference, and persists labor-cost, fairness, preference, overtime, and coverage-warning metrics.
- Scheduling run detail now includes a pre-solve constraint review section above the normalized JSON editor, with an employee weekly swimlane board and a store-requirements board clustered by shift label so recurring requirements can be reviewed without a separate scheduling subsystem.
- Scheduling run detail also exposes a cancel action for queued/extracting/generating work that marks the run failed, clears the active job pointer, and prevents the in-flight scheduling worker from writing a later success over the cancelled run.
- Scheduling run detail now keeps the candidate list compact: each candidate card is collapsible, shows the summary header plus month calendar inline, and links to a dedicated candidate-detail tab for swimlanes, day-by-day detail, and print/PDF export using the existing browser-print flow.
- Scheduling candidate detail now includes a collapsible hours-and-costs review section with summary totals plus per-employee weekly and total hours/labor-cost breakdowns, reusing the shared candidate presentation layer instead of a separate reporting path.
- Candidate detail export now also includes a review CSV download with one row per scheduled shift occurrence, including day, shift label, role, time, tags, assigned employees, required headcount, and unfilled seats.
- Scheduling run detail now includes a queue-and-debug section for the current run: current job metadata, waiting reason, jobs ahead, recent scheduling audit events, and a `Run now` control for queued scheduling jobs so queue diagnosis does not require direct SQL.
- The live Helios scheduling flow is now operationally verified end to end: migration `0010_scheduling_candidate_count.sql` is applied in the live DB, authenticated browser smoke has covered multi-week run creation through candidate detail and both export popups, and the shared export component no longer leaves blank print tabs from the old `window.open('', '_blank', 'noopener,noreferrer')` path.
- Final operator selection is persisted in the scheduling run record and visible through the shared Helios audit/history surface rather than a bespoke side channel.

## Communications (Partially Migrated)

- `communications` flipped from `planned` to `active` on 2026-05-05 with its first concrete workflow: the policy-limited Google Ads asset replacement review.
- Canonical reviewer surface: `/communications/policy-replacements/:packetId`, backed by [`helios/src/server/routes/communications.ts`](../../helios/src/server/routes/communications.ts) and the Zod contracts in [`src/shared/contracts/domain/communications.ts`](../../helios/src/shared/contracts/domain/communications.ts).
- Persistence: `communications_policy_replacement_drafts` (one row per `packet_id`) plus an append-only `communications_policy_replacement_audit` table that mirrors the catalog/scheduling audit pattern. Audit events also fan into the global `audit_events` table under `module = communications` so they appear in `/history`.
- The Helios route is reviewer-only. It does NOT mutate Google Ads from review submission alone. Any apply phase still runs through a separate narrow Google Ads resolver pass (validate-only, then live apply, then narrow readback). Only items with `decision == accepted` flow into that resolver/apply step.
- `ads/google/serve_asset_policy_limited_replacement_review.py` is now the offline fallback only; its file header records the supersession.
- Other communications workflows (operator messaging, mass copy, promo communications) remain pre-migration.

## Not Fully Migrated Yet

- `crm`, `pricing`, and `utilities` are still not fully migrated Helios modules. `communications` is partially migrated; see the section above.
- For those areas, check the user request carefully before assuming Helios already owns the workflow.
- Pricing and repricing now have a canonical planning proposal at [`pricing-repricing-module-proposal.md`](./pricing-repricing-module-proposal.md). Use that doc when expanding pricing beyond the current catalog-owned batch generator and generic review queue.
- Promo proposal review surfaces are not fully migrated yet. Until a Helios pricing or communications promo workflow exists, keep using the local reviewer-first packet pattern established in `bulk_additions/2026-04-16`: bundle related promos together, make before or after GM and selector-pool sales analysis prominent, keep clickable detail pages, and collapse raw payload or debug material by default.
- The next major Helios screens follow-up is wiring the existing hourly scheduled enqueue path for `screens.banner_health_maintenance`.

## Read-only Projections For External Systems

Helios is the canonical owner of any per-(site, sweed-entity) projection downstream
systems need. External callers must be granted SELECT-only access to a dedicated
projection table; they must never write into Helios-owned tables, even for
"convenience" upserts.

- **`landingpage_brand_site_presence`**: per-(site_dealer_id, brand_id) presence
  row maintained by [`../../helios/src/worker/jobs/configWorkersStockRefreshJob.ts`](../../helios/src/worker/jobs/configWorkersStockRefreshJob.ts)
  on every stock-refresh tick (migration `0018_landingpage_brand_site_presence.sql`).
  Each row carries the latest count of "for sale" variants and total available
  qty, plus `last_observed_at` and `last_for_sale_observed_at` watermarks. Rows
  persist after a brand goes to zero "for sale" inventory so downstream
  generators (currently the Freshly Baked landing-page service in the
  `mostly-static-sites` repo) can keep generating brand pages for previously-
  observed brands and the brand never silently disappears from review surfaces.
  "For sale" follows the documented Sweed inventory rule: a per-item lot counts
  only when its `stockLocation.name` starts with `FOR SALE` AND `!isTradeSample`
  AND `!isNotForSale` AND `isAvailableOnline` AND `availableQty > 0`. Grant the
  external consumer a SELECT-only role on this table only.

## Useful Code Paths

- Canonical app: [`../../helios`](../../helios)
- Module definitions and rollout summaries: [`../../helios/src/shared/contracts/domain/modules.ts`](../../helios/src/shared/contracts/domain/modules.ts)
- Shared screens workflow constants and job payloads: [`../../helios/src/shared/contracts/domain/screens.ts`](../../helios/src/shared/contracts/domain/screens.ts)
- Shared scheduling contracts and job payloads: [`../../helios/src/shared/contracts/domain/scheduling.ts`](../../helios/src/shared/contracts/domain/scheduling.ts)
- Operator-facing route and UI behavior: [`../../helios/src/client/routes`](../../helios/src/client/routes)
- Queueing, audit, and worker behavior: [`../../helios/src/server`](../../helios/src/server) and [`../../helios/src/worker`](../../helios/src/worker)
- Artifact-backed screens inventory bootstrap: [`../../helios/src/server/screens/inventory.ts`](../../helios/src/server/screens/inventory.ts)
- Underlying screens playbooks and safety rules: [`../sweed/marketing/screens-and-banners.md`](../sweed/marketing/screens-and-banners.md)

## Live Status Note

- For the current queue, immediate next steps, or handoff state, read [`../../helios/AGENT_TODO.md`](../../helios/AGENT_TODO.md).
- Do not move durable ownership guidance out of this doc and into the handoff file.
