-- 042_visitor_scan_address_link.sql
--
-- Wire visitor_scans rows into the shared `addresses` /
-- geocoding pipeline (FreshlyBakedNYC/automation#25's reusable
-- layer, originally built for sweed delivery / customer enrichment).
--
-- Why now: the `visitor_scans.latitude / longitude` columns are
-- populated from the VeriScan envelope's `Data.Latitude /
-- Data.Longitude` fields. Empirically those fields actually contain
-- the SCANNER kiosk location — not a geocoded document address — so
-- the customer-origin map page (`/admin/customers/map`) was plotting
-- every customer at the store. We need a separate, real geocode of
-- the document-address text (`address / city / state / postal_code`)
-- that lives on every scan row, and the cheapest way to get that is
-- to link each scan to a row in the existing `addresses` table and
-- let the existing Census-geocoder drain (in
-- enrichDeliveryAddressJob) process it as part of its normal tick.
--
-- One column + one index. Backfill is performed out-of-band by
-- helios/scripts/backfill-visitor-scan-geocodes.ts which upserts
-- one `addresses` row per (line1, city, state, zip) combination and
-- writes the FK back. Geocoding itself happens later as the
-- geocode-drain phase of the delivery enrichment job pulls pending
-- rows.
--
-- Idempotent: column / index add use `if not exists`.

\echo 'Running migration 042: visitor_scan_address_link...'

alter table visitor_scans
  add column if not exists address_id bigint references addresses(id);

-- Reverse-lookup for "all scans pointing at this address" queries
-- (used by the customer-details panel when surfacing
-- "other visits from this household"). Partial so the index stays
-- small for the still-significant fraction of rows with no address.
create index if not exists visitor_scans_address_id_idx
  on visitor_scans (address_id)
  where address_id is not null;

\echo 'Migration 042 complete.'
