-- Migration 072: seo_post_control_plane
--
-- Helios-driven SEO widgets — auto-blog MVP control plane (parent epic
-- virusdave/top-level#15, child epic FreshlyBakedNYC/automation#44,
-- phase P4).
--
-- P3 (migration 071) stood up the FIRST SEO control-plane tables
-- (seo_approvals ledger + seo_faq_sets) and the IRONCLAD human-approval
-- gate for FAQ content. P4 adds the auto-blog spine: an operator can
-- author / generate / review / APPROVE blog posts ("What's new"), and the
-- bundle build can pull *approved* posts from the DB into the WhatsNewFeed
-- + BlogPost widgets (dry-run only; prod publish stays operator-only,
-- canon §1).
--
-- This migration:
--
--   1. EXTENDS the seo_approvals ledger's content_kind check to also allow
--      'post' approvals (071 only minted 'faq_set'). The append-only
--      ledger remains the single record that satisfies the human-approval
--      gate: a row exists iff a human approved a SPECIFIC content payload,
--      identified by its content_sha256.
--
--   2. ADDS seo_posts — control-plane authoring rows for blog posts. Each
--      row carries the current content fingerprint (content_sha256) and,
--      once approved, the approval_id of the ledger row that approved THAT
--      exact fingerprint. Any edit recomputes the fingerprint and resets
--      the row to 'draft' (approval_id NULL), so an approval can never
--      silently cover edited content.
--
-- The content_sha256 is a hex sha256 over a canonical, versioned payload of
-- the PUBLIC content identity + the operator-authored, publicly-visible
-- fields — see helios/src/server/seo/postContent.ts (postContentSha256).
-- The server approve path and the DB→bundle loader both recompute + verify
-- it; the loader additionally re-verifies the append-only ledger join.
--
-- DB-cost note (canon §3): like the P3 FAQ tables, these are small,
-- operator-write-rate control-plane tables (single-digit GB/year at
-- current scale, parent EPIC_PLAN §9). There is NO recurring/background
-- workload here — generation and approval are operator-triggered — so the
-- P5 high-risk-DB gate does not apply to P4. Indexes: PK + unique(post_id)
-- + unique(approval_id) + status filter + a partial unique(scope, slug)
-- over APPROVED rows that keeps /sites/<id>/whats-new/<slug> routes
-- collision-free among bundle-eligible posts.
--
-- Idempotent: every create is `if not exists`; the check-constraint swap is
-- drop-if-exists + add. Safe to re-run.

\echo 'Running migration 072: seo_post_control_plane...'

-- ── 1. extend the approval ledger to cover 'post' approvals ────────────
alter table seo_approvals
  drop constraint if exists seo_approvals_content_kind_check;
alter table seo_approvals
  add constraint seo_approvals_content_kind_check
    check (content_kind in ('faq_set', 'post'));

-- ── 2. blog-post authoring rows ───────────────────────────────────────
create table if not exists seo_posts (
  id                   bigserial   primary key,
  -- Stable public id used by widgets + the bundle (BlogPostContent.post_id).
  post_id              text        not null unique,
  -- Concrete site id OR the reserved global 'all' token (consistency.ts
  -- rejects a physical 'all' site).
  scope                text        not null,
  -- Lowercase kebab-case; (scope, slug) -> /sites/<scope>/whats-new/<slug>.
  slug                 text        not null default '',
  status               text        not null default 'draft',
  -- Shared (rendered on BOTH hosts) public fields → must be sanitized-safe.
  title                text        not null default '',
  meta_description     text        not null default '',
  excerpt              text        not null default '',
  author               text        not null default 'Freshly Baked Editorial',
  tags                 text[]      not null default '{}',
  -- Body carries a raw (FB.nyc) + sanitized (FB.us) variant pair.
  body_raw             text        not null default '',
  body_sanitized       text        not null default '',
  -- Force noindex even when otherwise index-worthy (thin/preview posts).
  noindex              boolean     not null default false,
  -- Publish timestamp surfaced in the bundle (defaults to row creation).
  published_at         timestamptz not null default now(),
  -- How the row was authored.
  source               text        not null default 'manual',
  -- Compact provenance for generated drafts (model ref, prompt, etc.).
  generation_meta      jsonb,
  -- Current content fingerprint (recomputed on every save/generate).
  content_sha256       text        not null,
  -- Set iff status = 'approved'; the ledger row that approved THIS exact
  -- fingerprint.
  approval_id          text        references seo_approvals (approval_id),
  -- The approver's display name, stamped at approval time (BlogPost.reviewer).
  reviewer             text,
  created_by_user_id   bigint,
  updated_by_user_id   bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint seo_posts_status_check
    check (status in ('draft', 'needs_review', 'approved', 'rejected')),
  constraint seo_posts_source_check
    check (source in ('manual', 'generated')),
  constraint seo_posts_content_sha256_check
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- approval_id present iff approved — the structural half of the IRONCLAD
  -- gate (the loader additionally verifies the ledger join). An approved
  -- post must also carry a reviewer (stamped at approval).
  constraint seo_posts_approval_consistency_check
    check (
      (status = 'approved' and approval_id is not null and reviewer is not null)
      or
      (status <> 'approved' and approval_id is null)
    ),
  -- One approval row can back at most one post.
  constraint seo_posts_approval_id_unique
    unique (approval_id)
);

-- List/filter by review status (the control-plane list view + the
-- approved-only bundle loader both filter on status).
create index if not exists seo_posts_status_idx
  on seo_posts (status);

-- Keep /sites/<scope>/whats-new/<slug> collision-free among APPROVED posts
-- — the route-uniqueness invariant only binds content that can reach the
-- bundle. Drafts/needs_review/rejected rows may freely share a slug (e.g.
-- two competing drafts for the same story), so they are excluded; the
-- compiler's consistency layer is the second, bundle-wide guard.
create unique index if not exists seo_posts_scope_slug_approved_uidx
  on seo_posts (scope, slug)
  where status = 'approved';
