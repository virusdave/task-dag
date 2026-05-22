-- Customer-Sentiment Capture (issue #13, A4 phase)
--
-- A4 = Sweed integration + admin force-add/remove + mark-fraudulent.
--
-- Extends `review_drawing_entries` with the columns A4 needs to record
-- per-segment Sweed add/remove outcomes, the resolved Sweed customer
-- id used for those calls, the `acceptedPasteOffer` bit captured from
-- the drawing-entry POST body, and the `fraudulent` flag the operator
-- uses to mark abuse. All columns are added idempotently so the schema
-- is safe to re-replay against an A1/A2 DB.
--
-- Per-segment status now ALSO accepts 'removed', so the same
-- column can carry the operator-force-remove outcome (or the
-- automatic remove triggered by mark-fraudulent).
--
-- Idempotent (`add column if not exists`).

alter table review_drawing_entries
  -- Captured from POST /v1/reviews/<id>/drawing-entry body. Drives
  -- the conditional free-preroll segment add (only added when
  -- LLM verdict is strong-with-text/degraded AND the customer
  -- accepted the paste-text offer).
  add column if not exists accepted_paste_offer boolean not null default false,
  -- Resolved Sweed `client.id` used for segment add/remove. NULL
  -- until A4 wiring actually runs find/create + add for this row.
  add column if not exists sweed_customer_id integer,
  -- Concrete per-site segment ids captured at attempt time, so the
  -- operator can see exactly which Sweed segment we addressed even
  -- if site_review_settings is later edited.
  add column if not exists drawing_segment_id      integer,
  add column if not exists free_preroll_segment_id integer,
  -- mark-fraudulent state. The actual segment-remove attempt happens
  -- inline when the operator clicks the action; result lands in the
  -- existing drawing_segment_status / free_preroll_segment_status
  -- columns (with 'removed' added to the allowed values below).
  add column if not exists fraudulent          boolean not null default false,
  add column if not exists fraudulent_marked_at timestamptz,
  add column if not exists fraudulent_marked_by text;

-- Expand the per-segment status check to include 'removed'. Postgres
-- doesn't support modifying a check constraint in place, so we drop
-- the old constraint by its auto-generated name (if present) and
-- recreate. Wrapped in DO blocks for idempotence.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'review_drawing_entries_drawing_segment_status_check'
      and conrelid = 'review_drawing_entries'::regclass
  ) then
    alter table review_drawing_entries
      drop constraint review_drawing_entries_drawing_segment_status_check;
  end if;
  alter table review_drawing_entries
    add constraint review_drawing_entries_drawing_segment_status_check
    check (drawing_segment_status in ('skipped','failed','added','removed'));
exception
  when duplicate_object then null;
end$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'review_drawing_entries_free_preroll_segment_status_check'
      and conrelid = 'review_drawing_entries'::regclass
  ) then
    alter table review_drawing_entries
      drop constraint review_drawing_entries_free_preroll_segment_status_check;
  end if;
  alter table review_drawing_entries
    add constraint review_drawing_entries_free_preroll_segment_status_check
    check (free_preroll_segment_status in ('skipped','failed','added','removed'));
exception
  when duplicate_object then null;
end$$;

create index if not exists review_drawing_entries_fraudulent_idx
  on review_drawing_entries (fraudulent)
  where fraudulent = true;
