-- 027_litalerts_retailer_geo.sql
--
-- Geo substrate for the LitAlerts review / pricing UX overhaul
-- (issue #19, follow-on for the /config/parsing/litalerts page's
-- "sort competitors by min distance to one of our stores" ask).
--
-- Two small tables:
--
--   helios_store_locations            our physical stores keyed off
--                                     the existing PricingSiteKey
--                                     ('bronx', 'midtown', …) — pre-
--                                     geocoded since the set is tiny
--                                     (currently 1–2 sites) and we
--                                     don't want a runtime geocoder
--                                     hop in the hot path.
--
--   litalerts_retailer_locations      mirror of /v1/retailers from
--                                     the LitAlerts partner API,
--                                     plus geocoded lat/lng. Refreshed
--                                     by a background worker /
--                                     one-shot script that hits the
--                                     US Census Geocoder for any new
--                                     or stale rows.
--
-- The competitor-list query in
-- helios/src/server/db/queries/litalertsCompetitorsQueries.ts joins
-- the dispensaryName from evidence_json.matchedListings onto
-- litalerts_retailer_locations.name and computes
--   min_distance_miles = MIN(haversine(retailer_lat,lng,
--                                       store_lat,lng))
-- across all rows in helios_store_locations, then orders the list
-- so the nearest dispensaries surface first.
--
-- Haversine is computed inline in the query (cheap; ≤ 555 retailers
-- × ≤ 2 stores) so we don't need PostGIS for v1.

create table if not exists helios_store_locations (
  site_key       text primary key,
  display_name   text not null,
  address        text not null,
  -- nullable so a placeholder row (no coords yet) can exist; the
  -- distance compute IGNORES rows with NULL coords.
  latitude       double precision,
  longitude      double precision,
  geocoded_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table helios_store_locations is
  'Our physical dispensary locations, keyed by PricingSiteKey. Source of truth for the "distance to nearest of our stores" computation on the LitAlerts review pages.';

create table if not exists litalerts_retailer_locations (
  retailer_id    bigint primary key,
  name           text not null,
  -- name keyed for joining the dispensaryName text in
  -- evidence_json.matchedListings against retailer rows.
  -- trim()+lower() applied at query time; no functional index needed
  -- for a ~555-row table.
  address        text,
  state_code     text not null,
  -- recreational/medical flags forwarded from the partner API.
  recreational   boolean,
  medical        boolean,
  -- Census Geocoder output. NULL when not-yet-geocoded or
  -- ungeocodable; the competitor-list query treats NULL as "no
  -- distance contribution from this retailer".
  latitude       double precision,
  longitude      double precision,
  geocoded_at    timestamptz,
  geocoder_source text,
  -- last time the row was observed in /v1/retailers — used by the
  -- backfill job to mark retailers that have left the partner-API
  -- directory.
  last_seen_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists litalerts_retailer_locations_name_lower_idx
  on litalerts_retailer_locations ((lower(trim(name))));

create index if not exists litalerts_retailer_locations_state_idx
  on litalerts_retailer_locations (state_code, last_seen_at desc);

comment on table litalerts_retailer_locations is
  'Mirror of LitAlerts /v1/retailers with geocoded lat/lng. Joined against evidence_json.matchedListings[].dispensaryName by lowercased trimmed name for distance-to-our-stores sorting.';

-- Seed our currently-known stores. The Bronx coords are derived from
-- the address (2375 Arthur Ave, The Bronx, NY 10458) via Census;
-- updated_at is left at default so the geocoder job re-resolves
-- against Census whenever the address is edited.
insert into helios_store_locations (site_key, display_name, address, latitude, longitude, geocoded_at)
values
  ('bronx', 'Freshly Baked NYC — Bronx', '2375 Arthur Ave, The Bronx, NY 10458', 40.855074, -73.888066, now())
on conflict (site_key) do nothing;

-- A placeholder midtown row with NULL coords so the distance compute
-- still works after dropping in a real address. The competitor query
-- IGNORES stores with NULL latitude/longitude so this row contributes
-- nothing until populated.
insert into helios_store_locations (site_key, display_name, address, latitude, longitude, geocoded_at)
values
  ('midtown', 'Freshly Baked NYC — Midtown (placeholder)', 'TBD — populate via UPDATE before distance sort uses this site', NULL, NULL, NULL)
on conflict (site_key) do nothing;
