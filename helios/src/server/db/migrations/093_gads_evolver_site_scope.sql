-- Migration 093: per-attempt site scope for the GAds evolver
-- introspection dashboards (Evolution + Iteration).
--
-- Parent epic virusdave/top-level#24, Helios child epic
-- FreshlyBakedNYC/automation#51, phase P2. The authoritative decision
-- this migration implements is the P1 audit deliverable:
--   docs/helios/gads-evolver-introspection/P1_DATA_AUDIT_AND_SITE_SCOPE.md
--
-- WHY a `site` column is needed
-- ─────────────────────────────
-- The /metrics/gads-<site>/ surface (epic #18) is per-site and grant
-- gated (gads-bronx / gads-midtown / gads-all). The Evolution and
-- Iteration sub-pages read `gads_ad_attempts` (and, for the P6 LP
-- panel, `landingpage_ad_outcomes`), but NEITHER table currently
-- carries a usable site key:
--   * `account_id` is uniformly 'unknown' in prod (the Ads Editor
--     export leaves the customer id empty) — it cannot scope.
--   * The only reliable site signal already present is the
--     campaign / ad-group NAME, exactly what the snapshot builder
--     already parses via pickGeoTarget() in buildSnapshotFromCsv.ts.
--
-- So P2 materialises that derived signal as a stored, server-trusted
-- `site` column the read path can filter on with a server-derived
-- predicate (`site = $key`), never a client-supplied widening param.
--
-- SEMANTICS of the column (mirrors mapGeoToGadsSite() exactly)
-- ───────────────────────────────────────────────────────────
--   site = 'bronx'   -> belongs to the Bronx site
--   site = 'midtown' -> belongs to the Midtown site
--   site IS NULL     -> UNKNOWN-SCOPE: cross-site / unmappable
--                       (e.g. the single 'Trials 2026-05-16' campaign,
--                        or any brooklyn/queens/manhattan geo that is
--                        not one of the two GADS_SITES).
-- `null` is deliberate (no enum / NOT NULL): genuinely cross-site rows
-- MUST be representable. Per-site reads use `site = 'bronx'|'midtown'`,
-- which excludes NULL automatically (NULL = 'bronx' is not true), so
-- unknown-scope rows can never leak into a per-site page; they appear
-- only under the cross-site `gads-all` grant, badged "site unknown".
--
-- DERIVATION (single source of truth — do NOT add a 2nd parser)
-- ────────────────────────────────────────────────────────────
-- The write path sets `site` at insert time via
--   mapGeoToGadsSite(pickGeoTarget(lower(campaign_name||' '||ad_group_name)))
-- (mapGeoToGadsSite is in helios/src/shared/domain/gadsSites.ts; it maps
--  only the two GADS_SITES through, everything else -> null). The
-- best-effort backfill below reproduces ONLY that final bronx/midtown
-- decision in SQL (not the full geo parser), so a pre-093 row gets the
-- same value the write path would have stored. It is deterministic from
-- the already-stored campaign_name + ad_group_name and idempotent
-- (`where site is null`), so it is safe to re-run.
--
-- DB-cost note (canon §3)
-- ───────────────────────
-- `gads_ad_attempts` is ~540 rows / ~1.0 MB and `landingpage_ad_outcomes`
-- ~63 rows / ~0.5 MB in prod (P1 §1). At that size the per-site
-- predicate is a trivial seq scan; an explain on the read pattern does
-- NOT justify a `(site, created_at desc)` index (it would cost writes +
-- storage to save microseconds on a sub-thousand-row table). No index
-- is added here by design; revisit only if these tables grow orders of
-- magnitude AND a plan shows a scan is the bottleneck. No rollup /
-- hypertable / CAGG / HLL (out of scope for V1).
--
-- Idempotent: `add column if not exists` + `where site is null` backfill.
-- Safe to re-run. Does NOT auto-apply on deploy (canon §3): applied on
-- prod by the agent only after Oracle DB review + explicit operator
-- approval, then verified live.

\set ON_ERROR_STOP on
\timing on

\echo 'Running migration 093: gads evolver per-attempt site scope...'

begin;
set local lock_timeout = '5s';

-- ── gads_ad_attempts: the Evolution/Iteration core table ──────────────
alter table gads_ad_attempts
  add column if not exists site text;

comment on column gads_ad_attempts.site is
  'GAds site scope derived from campaign/ad-group name via '
  'mapGeoToGadsSite(pickGeoTarget(...)): ''bronx''|''midtown'', or NULL '
  'for unknown/cross-site scope. Per-site reads filter site = $key '
  '(server-derived); NULL appears only under the gads-all grant. '
  'See automation#51 P1/P2.';

-- Best-effort backfill (mirrors mapGeoToGadsSite∘pickGeoTarget for the
-- two GADS_SITES only). Two known-only updates rather than one CASE so a
-- re-run is a true no-op (no null→null rewrites): midtown is applied
-- first, so a name mentioning both resolves to midtown (matching
-- pickGeoTarget's ordering) and the bronx pass then skips it (site is no
-- longer null). Unmatched rows stay null = unknown-scope.
update gads_ad_attempts
   set site = 'midtown'
 where site is null
   and lower(coalesce(campaign_name, '') || ' ' || coalesce(ad_group_name, '')) like '%midtown%';

update gads_ad_attempts
   set site = 'bronx'
 where site is null
   and lower(coalesce(campaign_name, '') || ' ' || coalesce(ad_group_name, '')) like '%bronx%';

-- ── landingpage_ad_outcomes: the P6 LP-reaction panel surface ─────────
-- Same policy/derivation. There is currently no live writer for this
-- table (P1 §1: the 63 rows are a single historical ingest), so the
-- column is populated here by backfill only; whenever a writer is
-- (re)introduced it MUST set `site` via the same mapGeoToGadsSite path.
alter table landingpage_ad_outcomes
  add column if not exists site text;

comment on column landingpage_ad_outcomes.site is
  'GAds site scope derived from campaign/ad-group name via '
  'mapGeoToGadsSite(pickGeoTarget(...)): ''bronx''|''midtown'', or NULL '
  'for unknown/cross-site scope. Same semantics as '
  'gads_ad_attempts.site. See automation#51 P1/P2.';

update landingpage_ad_outcomes
   set site = 'midtown'
 where site is null
   and lower(coalesce(campaign_name, '') || ' ' || coalesce(ad_group_name, '')) like '%midtown%';

update landingpage_ad_outcomes
   set site = 'bronx'
 where site is null
   and lower(coalesce(campaign_name, '') || ' ' || coalesce(ad_group_name, '')) like '%bronx%';

commit;

\echo 'Migration 093 complete.'
