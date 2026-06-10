-- Migration 069: app_settings
--
-- Tiny key/value store for GLOBAL (not per-user) application settings
-- edited by admins through the UI and read by every user. The value is
-- an opaque JSONB blob whose shape is owned by the consuming feature.
--
-- First consumer: key `metrics_view_defaults` — the page-wide default
-- toolbar configuration for the /metrics pages. See
-- `helios/src/server/db/schema/appSettings.sql` for the canonical
-- schema doc.
--
-- Idempotent and additive: only creates a new table.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

commit;
