-- Migration 092: seo_prompt_schedules
--
-- Helios-driven SEO widgets — auto-blog PROMPT-SCHEDULE + TOPIC-MIX config
-- (parent epic virusdave/top-level#15 §7.2, child epic
-- FreshlyBakedNYC/automation#44, phase P4).
--
-- The blog source-of-truth intake (091, seo_source_items) gives the raw
-- material; the post control plane (072/073) gives the author/review/
-- approve/schedule workflow + the Bedrock draft generator. This migration
-- adds the missing CONFIG brick between them: a `seo_prompt_schedules` table
-- holding the operator-tunable knobs the (later) generation loop consults —
-- cadence (posts/week), the weighted topic mix, the generation mode
-- (raw/sanitized/dual), and reusable prompt templates.
--
-- Scope of THIS slice (mirrors the operator-approved #44 pattern): config +
-- operator/API-driven CRUD only. NOTHING here runs a background generator;
-- standing up the actual scheduled generation loop is a later brick (and a
-- recurring/background workload, so it will need its own cost budget +
-- Oracle DB review per canon §3 before deploy). This table is pure config —
-- it does NOT reach a signed bundle and is NOT bound to the seo_approvals
-- ledger (a generated DRAFT still passes the IRONCLAD approval gate, canon
-- §1, one step later).
--
-- DB-cost note (canon §3): a small, operator-write-rate control-plane table
-- (single-digit GB/year, parent EPIC_PLAN §9). No recurring/background
-- workload in this slice, so the P5 high-risk-DB gate does not apply.
-- Indexes: PK + unique(schedule_key) + a (scope) lookup.
--
-- Idempotent: every create is `if not exists`. Safe to re-run.

\echo 'Running migration 092: seo_prompt_schedules...'

create table if not exists seo_prompt_schedules (
  id               bigserial   primary key,
  -- Stable lower-kebab key the operator references (e.g. 'weekly-nyc-mix').
  schedule_key     text        not null unique,
  -- Targeting hint: a concrete site id or the reserved global 'all' token
  -- (mirrors the other SEO control-plane tables). Defaults to 'all'.
  scope            text        not null default 'all',
  label            text        not null default '',
  enabled          boolean     not null default true,
  -- Cadence: target posts per week (1–14; the epic targets 1–3).
  posts_per_week   integer     not null default 1,
  -- Which body variant(s) the draft loop should produce.
  mode             text        not null default 'dual',
  -- Weighted content categories the topic mix draws from: a JSON array of
  -- { category, weight } whose integer weights sum to 100 (validated in the
  -- app — see helios/src/server/seo/promptSchedule.ts).
  topic_mix        jsonb       not null default '[]'::jsonb,
  -- Optional named prompt templates (article_brief / faq_addendum /
  -- title_meta / social_caption / image_prompt) as a JSON object.
  prompt_templates jsonb       not null default '{}'::jsonb,
  notes            text        not null default '',
  created_by_user_id  bigint,
  updated_by_user_id  bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint seo_prompt_schedules_schedule_key_check
    check (schedule_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint seo_prompt_schedules_mode_check
    check (mode in ('raw', 'sanitized', 'dual')),
  -- Coarse cadence guard at the storage layer; the app enforces the exact
  -- [1,14] range + topic-mix arithmetic.
  constraint seo_prompt_schedules_posts_per_week_check
    check (posts_per_week >= 1 and posts_per_week <= 14),
  -- topic_mix is an array, prompt_templates an object (shape sanity only;
  -- the app validates contents).
  constraint seo_prompt_schedules_topic_mix_is_array
    check (jsonb_typeof(topic_mix) = 'array'),
  constraint seo_prompt_schedules_prompt_templates_is_object
    check (jsonb_typeof(prompt_templates) = 'object')
);

-- "Which schedules target site X" lookup.
create index if not exists seo_prompt_schedules_scope_idx
  on seo_prompt_schedules (scope);

\echo 'Migration 092 complete.'
