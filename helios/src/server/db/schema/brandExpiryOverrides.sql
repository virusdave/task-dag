-- Table: brand_expiry_overrides
--
-- Operator-managed exceptions to the default 4-day "market-evidence is
-- considered fresh" window used by the rolling Lit Alerts refresh
-- scheduler, the freshness view, and the alarm scanner.
--
-- Some brands' menus (e.g. statewide-stocked supply with stable
-- pricing) tolerate a longer cache window — bumping their expiry_days
-- up to 7 or 14 reduces partner-API call volume without compromising
-- the pricing signal. Conversely, a brand under active price
-- maneuvering may want a 1-2 day window to refresh faster.
--
-- Identity is the brand_name (case-folded). brand_id is the Lit Alerts
-- partner-side brand id when known; left nullable so an operator can
-- pre-seed a row by name before we've observed the brand id from a
-- successful Lit Alerts capture.
--
-- expiry_days is the threshold between the "stale" bucket and the
-- "very_stale" bucket in vw_pricing_evidence_freshness (see migration
-- 013). Bounded 1..30 so a typo can't disable refreshes indefinitely.
--
-- Writes are audit-logged via appendAuditEvent.

create table if not exists brand_expiry_overrides (
  brand_id integer null,
  brand_name text not null,
  expiry_days integer not null check (expiry_days between 1 and 30),
  notes text null,
  updated_at timestamptz not null default now(),
  updated_by_user_id integer null
);

-- Case-folded uniqueness (and primary lookup index).
create unique index if not exists brand_expiry_overrides_brand_name_lower_idx
  on brand_expiry_overrides (lower(brand_name));

comment on table brand_expiry_overrides is
  'Per-brand override of the default 4-day market-evidence freshness window. Keyed by lower(brand_name); consumed by vw_pricing_evidence_freshness and the litalerts refresh worker.';
comment on column brand_expiry_overrides.brand_id is
  'Lit Alerts partner brand id; nullable so operators can seed by name before we have observed the partner id.';
comment on column brand_expiry_overrides.brand_name is
  'Free-text brand identifier as it appears in catalog_groups.brand_name; matched case-insensitively.';
comment on column brand_expiry_overrides.expiry_days is
  'Days-since-capture threshold for the stale/very_stale boundary; bounded 1..30. Default behavior with no row = 4 days.';
comment on column brand_expiry_overrides.notes is
  'Optional operator note explaining why this brand needs an exception (e.g. "statewide stock, stable pricing").';
comment on column brand_expiry_overrides.updated_at is
  'Last upsert time; auto-managed by the API write path.';
comment on column brand_expiry_overrides.updated_by_user_id is
  'User who last wrote this row (FK to users.id at the application layer; no DB FK because other schemas do not declare one either).';
