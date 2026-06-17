-- Migration 091: seo_source_items
--
-- Helios-driven SEO widgets — auto-blog SOURCE INGESTION (parent epic
-- virusdave/top-level#15, child epic FreshlyBakedNYC/automation#44,
-- phase P4).
--
-- P4's auto-blog control plane (migration 072/073) shipped the manual
-- author / generate / review / APPROVE spine for blog posts. This migration
-- adds the *first* brick of the auto-blog pipeline's step 1 — "source /
-- topic intake" (parent EPIC_PLAN §7.1): a durable record of the source
-- content / links Helios will later draft posts from.
--
-- Operator-decision scope (issue #44, option (a) approved by the operator):
-- this is **schema + operator/API-driven ingest only**. There is NO
-- automated fetching / scraping here — items are inserted by an operator or
-- by a future authorized pipeline through the /api/seo/source-items route.
-- Sources are constrained to an operator-managed ALLOWLIST so the §7.1
-- "approved sources" guardrail is enforced at ingest time, fail-closed.
--
-- Two tables:
--
--   seo_source_allowlist — operator-managed list of APPROVED sources. The
--                          ingest path fail-closes against this set: an item
--                          can only be recorded for a source_key that exists
--                          here AND is enabled. This is the §7.1
--                          "approved sources" guardrail as data.
--
--   seo_source_items     — append-style intake rows. Each carries a
--                          `dedup_hash` (a content_sha256 over the source's
--                          canonical identity — see
--                          helios/src/server/seo/sourceContent.ts,
--                          `sourceItemDedupHash`) with a UNIQUE constraint,
--                          so re-ingesting the same source link is an
--                          idempotent no-op (ON CONFLICT DO NOTHING) rather
--                          than a duplicate. Mirrors the P3/P4
--                          content_sha256-fingerprinting + append-only style.
--
-- These items are NOT published content and carry NO approval ledger row:
-- they are raw drafting *inputs*, never served to the public. The IRONCLAD
-- human-approval gate (canon §1) still applies one step later, to the posts
-- a human authors/approves FROM these inputs (migration 072 seo_posts).
--
-- DB-cost note (canon §3): small, operator/automation-write-rate
-- control-plane tables (single-digit GB/year at current scale, parent
-- EPIC_PLAN §9). There is NO recurring/background/scheduled workload here
-- (no automated fetchers in option (a)), so the P5 high-risk-DB gate does
-- not apply. Indexes: PK + unique(source_key) on the allowlist; PK +
-- unique(source_item_id) + unique(dedup_hash) + (status, created_at desc) +
-- (source_key, created_at desc) on the items.
--
-- Idempotent: every create is `if not exists`; constraint adds are guarded.
-- Safe to re-run.

\set ON_ERROR_STOP on

\echo 'Running migration 091: seo_source_items...'

-- ── operator-managed approved-source allowlist ────────────────────────
create table if not exists seo_source_allowlist (
  id                   bigserial   primary key,
  -- Stable logical source slug, e.g. 'nyc-eater', 'mjbiz-daily',
  -- 'fb-internal'. Lowercase kebab; FK target for seo_source_items.
  source_key           text        not null unique,
  -- Intake category (parent §7.1 source taxonomy).
  kind                 text        not null,
  display_name         text        not null,
  -- Optional canonical homepage for the source (provenance only).
  homepage_url         text,
  -- Disabled sources are kept for provenance but reject new ingest.
  enabled              boolean     not null default true,
  note                 text,
  created_by_user_id   bigint,
  updated_by_user_id   bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint seo_source_allowlist_kind_check
    check (kind in (
      'local_culture', 'industry_news', 'fb_news',
      'gsc_opportunity', 'social_opportunity', 'other'
    )),
  -- Lowercase-kebab slug, 3-64 chars, alphanumeric start/end. Mirrors
  -- SOURCE_KEY_RE in sourceContent.ts so the app + DB agree.
  constraint seo_source_allowlist_source_key_check
    check (source_key ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$')
);

-- ── source-item intake rows ───────────────────────────────────────────
create table if not exists seo_source_items (
  id                   bigserial   primary key,
  -- Stable public id `seosrc_YYYY-MM-DD_HHMMSS_<6hex>`.
  source_item_id       text        not null unique,
  -- Must reference an allowlisted source (FK); the app additionally
  -- rejects DISABLED sources at ingest (the FK can't check `enabled`).
  source_key           text        not null references seo_source_allowlist (source_key),
  -- Source link. Nullable: internal FB announcements / GSC opportunities
  -- may have no canonical URL.
  url                  text,
  title                text        not null,
  -- The source's own publication date, when known.
  published_at         timestamptz,
  summary              text,
  -- Free-form topic tags + risk flags (normalized lowercase, deduped by
  -- the app before insert).
  topic_tags           text[]      not null default '{}',
  risk_flags           text[]      not null default '{}',
  -- content_sha256 over the source's canonical identity = the dedup key.
  -- UNIQUE → re-ingesting the same source link is an idempotent no-op.
  dedup_hash           text        not null unique,
  status               text        not null default 'new',
  -- How the row arrived (operator paste vs. an authorized API caller).
  ingest_source        text        not null default 'api',
  -- Compact provenance for the ingest (caller, raw payload echo, etc.).
  ingest_meta          jsonb,
  created_by_user_id   bigint,
  updated_by_user_id   bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint seo_source_items_status_check
    check (status in ('new', 'reviewed', 'drafted', 'dismissed')),
  constraint seo_source_items_ingest_source_check
    check (ingest_source in ('api', 'manual')),
  constraint seo_source_items_dedup_hash_check
    check (dedup_hash ~ '^[0-9a-f]{64}$')
);

-- Intake-queue list view ("show me new items, newest first") + the
-- per-source audit list both seek on these.
create index if not exists seo_source_items_status_idx
  on seo_source_items (status, created_at desc, id desc);
create index if not exists seo_source_items_source_key_idx
  on seo_source_items (source_key, created_at desc, id desc);

\echo 'Migration 091 complete.'
