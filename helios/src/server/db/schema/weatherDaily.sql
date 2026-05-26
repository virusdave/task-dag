-- weather_daily
--
-- Helios-owned mirror of daily weather observations (high temp, low
-- temp, precipitation) for each operating site. Populated by the
-- `config.workers.weather_daily_ingest` worker which pulls from
-- Open-Meteo's Historical Weather API (ERA5 reanalysis), keyed on a
-- per-site (ZIP -> lat/long) lookup table in the worker code.
--
-- Backs the three real `weather.scatter_*` metrics on the /metrics
-- page tree (FreshlyBakedNYC/automation#26, follow-on under #22's
-- umbrella, unblocks the P5 weather-correlation stubs from #21).
--
-- v1 design notes:
--   * One row per (site_zip, ET calendar date). Composite primary
--     key makes the upsert idempotent on every backfill / trailing-
--     window re-fetch.
--   * `source` defaults to 'open-meteo' but is retained as a column
--     so we can fall back to NOAA NCEI CDO v2 without forking the
--     table.
--   * `raw_json` keeps the full Open-Meteo daily-array payload (one
--     element of the parallel arrays) so any future analysis can
--     pull additional fields without a re-fetch.
--   * No `weather_stations` / `site_weather_stations` config table —
--     we have two operating sites and the operator-explicit decision
--     is to hard-code the zip<->lat/long mapping in worker code.
--     When a third site opens this becomes an operator surface.
--
-- Idempotent: every `create` is `if not exists`.

create table if not exists weather_daily (
  site_zip       text not null,          -- '10019' or '10458'
  date           date not null,          -- ET calendar date
  high_temp_f    numeric(5, 1),
  low_temp_f     numeric(5, 1),
  precip_in      numeric(6, 3),
  source         text not null default 'open-meteo',
  ingested_at    timestamptz not null default now(),
  raw_json       jsonb not null,
  primary key (site_zip, date)
);

create index if not exists weather_daily_date_idx on weather_daily (date);
