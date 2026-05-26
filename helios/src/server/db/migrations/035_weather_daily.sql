-- Migration 035: weather_daily
--
-- Adds the helios-owned per-site daily weather observation table
-- backing the three real `weather.scatter_*` metrics on the
-- `/metrics` page tree. Populated by the
-- `config.workers.weather_daily_ingest` worker which fetches from
-- Open-Meteo's free Historical Weather API.
--
-- See FreshlyBakedNYC/automation#26 (follow-on under #22's umbrella,
-- unblocks the P5 weather-correlation stubs from #21).
--
-- Idempotent: the schema file uses `create ... if not exists`
-- everywhere, so this migration is safe to re-run.

\echo 'Running migration 035: weather_daily...'

\i ../schema/weatherDaily.sql

\echo 'Migration 035 complete.'
