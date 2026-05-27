-- 039_visitor_scans.sql
--
-- Customer / Visitor Address Ingestion Pipeline (virusdave/top-level#9,
-- child epic FreshlyBakedNYC/automation#31, phase A1).
--
-- Adds the visitor_scans table that holds every customer / visitor
-- check-in captured by VeriScan at the Bronx (`bx`) and Midtown (`mh`)
-- retail sites. Two write paths land in this single table:
--
--   1. Live webhook POSTs from VeriScan Cloud, hitting the routes
--      `POST /wh/{bx,mh}/veriscan/checkin` on helios-server (mounted
--      by helios/src/server/routes/visitorScans.ts).
--
--   2. Operator-driven backfill from the historical Drive export,
--      ingested via the helios visitor-scans-backfill script
--      (helios/scripts/visitor-scans-backfill.ts).
--
-- Both paths share the exact same insert helper and the same
-- `ON CONFLICT (provider, hash_id) DO NOTHING` idempotency so a
-- backfill row + a live webhook for the same scan collapse to one row.
--
-- The full incoming JSON body is preserved verbatim in `raw_envelope`
-- so future analyses don't have to re-parse the wire format, and so
-- we can re-derive any normalised column if our mapping rule changes.
--
-- Schema mirrors the VeriScan webhook payload
-- (https://docs.idscan.net/veriscan-online/webhook/payloads.html);
-- envelope fields live at the top, `Data.*` fields are snake-cased
-- below, plus a small set of ingestion-metadata columns at the very
-- top.
--
-- Idempotent: every `create` is `if not exists`. Safe to re-run.

\echo 'Running migration 039: visitor_scans...'

create table if not exists visitor_scans (
  -- ingestion-metadata
  id                bigserial primary key,
  ingested_at       timestamptz not null default now(),
  ingest_source     text        not null,            -- 'webhook' | 'backfill'
  site_slug         text        not null,            -- 'bx' | 'mh' (or future)
  provider          text        not null,            -- 'veriscan'
  raw_envelope      jsonb       not null,

  -- envelope
  event_id          bigint,
  webhook_id        bigint,
  webhook_type      text,
  webhook_type_id   integer,
  created_at        timestamptz,
  sent_at           timestamptz,

  -- Data.* — identity / dedup
  hash_id           uuid        not null,
  history_log_id    bigint,
  scanned_at        timestamptz,

  -- Data.* — person
  id_num            text,
  first_name        text,
  middle_name       text,
  last_name         text,
  birth_date        date,
  exp_date          date,
  gender            text,
  phone             text,
  email             text,

  -- Data.* — address (the headline reason this epic exists)
  address           text,
  city              text,
  state             text,
  postal_code       text,
  country           text,
  country_code      text,
  jurisdiction_code text,

  -- Data.* — geo (location on the document AND of the scan device)
  latitude          numeric(9, 6),
  longitude         numeric(9, 6),
  scan_latitude     numeric(9, 6),
  scan_longitude    numeric(9, 6),

  -- Data.* — scan device + status
  device_id         bigint,
  device_name       text,
  device_login      text,
  location_id       bigint,
  location_name     text,
  group_id          bigint,
  group_name        text,
  group_comment     text,
  document_type     text,
  document_is_valid boolean,
  authentication_status text,
  scan_status       text,
  comments          text,
  profile_comments  text,
  tags              text,
  user_agent        text,

  -- Data.* — links (24h expiry; we record the URL only, no blob mirror)
  image_link        text,
  signature_link    text,
  attachment_links  jsonb,                            -- array of url strings

  -- Re-delivered webhook from VeriScan collapses to a no-op via this
  -- unique constraint; the insert helper uses
  -- `ON CONFLICT (provider, hash_id) DO NOTHING`.
  constraint visitor_scans_provider_hash_id_unique
    unique (provider, hash_id)
);

create index if not exists visitor_scans_scanned_at_idx
  on visitor_scans (scanned_at desc);

create index if not exists visitor_scans_site_idx
  on visitor_scans (site_slug, scanned_at desc);

create index if not exists visitor_scans_postal_idx
  on visitor_scans (postal_code);

create index if not exists visitor_scans_state_idx
  on visitor_scans (state);

\echo 'Migration 039 complete.'
