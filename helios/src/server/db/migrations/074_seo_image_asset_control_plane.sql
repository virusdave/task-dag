-- Migration 074: seo_image_asset_control_plane
--
-- Helios-driven SEO widgets — auto-blog MVP, INDEPENDENT image approval
-- (parent epic virusdave/top-level#15, child epic
-- FreshlyBakedNYC/automation#44, phase P4 remainder).
--
-- P3 (migration 071) stood up the seo_approvals ledger + seo_faq_sets; P4
-- (migration 072) added seo_posts. This migration adds the THIRD content
-- kind to the same human-approval spine: SEO image assets that are reviewed
-- and APPROVED on their own merits, independently of any post (parent
-- EPIC_PLAN §0.3). A post may publish image-less; an approved image asset
-- can later be referenced by a post via the bundle contract's already-frozen
-- hero_image_sha256 / og_image_sha256 fields, and the compiler's
-- consistency layer already enforces "referenced images must be approved".
--
-- This migration:
--
--   1. EXTENDS the seo_approvals ledger's content_kind check to also allow
--      'image' approvals (071 minted 'faq_set', 072 added 'post'). The
--      append-only ledger remains the single record that satisfies the
--      human-approval gate: a row exists iff a human approved a SPECIFIC
--      content payload, identified by its content_sha256.
--
--   2. ADDS seo_image_assets — control-plane rows for SEO image assets.
--      Helios owns the METADATA + approval; the underlying image bytes are
--      hosted by the renderer / object store and addressed by asset_sha256.
--      Each row carries the current metadata fingerprint (content_sha256)
--      and, once approved, the approval_id of the ledger row that approved
--      THAT exact fingerprint. Any edit recomputes the fingerprint and
--      resets the row to 'draft' (approval_id NULL), so an approval can
--      never silently cover edited metadata.
--
-- The content_sha256 is a hex sha256 over a canonical, versioned payload of
-- the asset identity + content address + the operator-authored,
-- publicly-meaningful metadata — see helios/src/server/seo/imageContent.ts
-- (imageAssetContentSha256). The server approve path and the DB→bundle
-- asset loader both recompute + verify it; the loader additionally
-- re-verifies the append-only ledger join.
--
-- DB-cost note (canon §3): like the P3/P4 control-plane tables, this is a
-- small, operator-write-rate table (single-digit GB/year at current scale,
-- parent EPIC_PLAN §9). There is NO recurring/background workload here —
-- registration and approval are operator-triggered — so the P5
-- high-risk-DB gate does not apply. Indexes: PK + unique(asset_id) +
-- unique(approval_id) + status filter + a partial unique(asset_sha256, role)
-- over APPROVED rows so the bundle's per-(sha256,role) asset is unambiguous.
--
-- Idempotent: every create is `if not exists`; the check-constraint swap is
-- drop-if-exists + add. Safe to re-run.

\echo 'Running migration 074: seo_image_asset_control_plane...'

-- ── 1. extend the approval ledger to cover 'image' approvals ───────────
alter table seo_approvals
  drop constraint if exists seo_approvals_content_kind_check;
alter table seo_approvals
  add constraint seo_approvals_content_kind_check
    check (content_kind in ('faq_set', 'post', 'image'));

-- ── 2. SEO image-asset rows ────────────────────────────────────────────
create table if not exists seo_image_assets (
  id                   bigserial   primary key,
  -- Stable control-plane id (img_YYYY-MM-DD_HHMMSS_<6hex>).
  asset_id             text        not null unique,
  -- Content address (sha256) of the underlying image bytes; blank until the
  -- operator supplies it (a draft may not have it yet). The bytes live in
  -- the renderer / object store, not here.
  asset_sha256         text        not null default '',
  -- How the asset is placed in the bundle.
  role                 text        not null default 'hero',
  -- MIME type of the bytes (image/webp, image/png, …).
  media_type           text        not null default '',
  -- Intrinsic pixel dimensions (optional; surfaced in assets.json).
  width                integer,
  height               integer,
  -- Accessible/structured-data alt text — rendered on BOTH hosts, so it
  -- must be sanitized-safe.
  alt_text             text        not null default '',
  status               text        not null default 'draft',
  -- How the row was authored.
  source               text        not null default 'manual',
  -- Compact provenance for generated images (model ref, prompt, etc.).
  generation_meta      jsonb,
  -- Current metadata fingerprint (recomputed on every save).
  content_sha256       text        not null,
  -- Set iff status = 'approved'; the ledger row that approved THIS exact
  -- fingerprint.
  approval_id          text        references seo_approvals (approval_id),
  -- The approver's display name, stamped at approval time.
  reviewer             text,
  created_by_user_id   bigint,
  updated_by_user_id   bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint seo_image_assets_status_check
    check (status in ('draft', 'needs_review', 'approved', 'rejected')),
  constraint seo_image_assets_source_check
    check (source in ('manual', 'generated')),
  constraint seo_image_assets_role_check
    check (role in ('hero', 'og', 'derivative')),
  constraint seo_image_assets_content_sha256_check
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- The content address, once set, must be a hex sha256 (empty allowed for
  -- in-progress drafts; the approve path requires it).
  constraint seo_image_assets_asset_sha256_check
    check (asset_sha256 = '' or asset_sha256 ~ '^[0-9a-f]{64}$'),
  constraint seo_image_assets_width_check
    check (width is null or width > 0),
  constraint seo_image_assets_height_check
    check (height is null or height > 0),
  -- approval_id present iff approved — the structural half of the IRONCLAD
  -- gate (the loader additionally verifies the ledger join). An approved
  -- asset must also carry a reviewer (stamped at approval).
  constraint seo_image_assets_approval_consistency_check
    check (
      (status = 'approved' and approval_id is not null and reviewer is not null)
      or
      (status <> 'approved' and approval_id is null)
    ),
  -- One approval row can back at most one asset.
  constraint seo_image_assets_approval_id_unique
    unique (approval_id)
);

-- List/filter by review status (the control-plane list view + the
-- approved-only asset loader both filter on status).
create index if not exists seo_image_assets_status_idx
  on seo_image_assets (status);

-- Keep the per-(content-address, role) approved asset unambiguous — a post
-- referencing a sha256 in the hero slot must resolve to exactly one
-- approved asset. Drafts/needs_review/rejected rows may freely share a
-- (sha256, role) (e.g. competing alt-text drafts), so they are excluded.
create unique index if not exists seo_image_assets_sha_role_approved_uidx
  on seo_image_assets (asset_sha256, role)
  where status = 'approved';
