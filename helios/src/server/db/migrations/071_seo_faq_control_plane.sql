-- Migration 071: seo_faq_control_plane
--
-- Helios-driven SEO widgets — FAQ MVP control plane (parent epic
-- virusdave/top-level#15, child epic FreshlyBakedNYC/automation#44,
-- phase P3).
--
-- P0/P1 froze the SEO bundle contracts (helios/src/server/seo/contracts.ts)
-- and shipped a dry-run publisher/validator/CLI that built from JSON
-- fixtures. P3 stands up the FIRST control-plane DB tables so an operator
-- can author / generate / review / APPROVE FAQ sets in Helios, and so the
-- bundle build can pull *approved* FAQ content from the DB (dry-run only;
-- prod publish stays operator-only, canon §1).
--
-- Two tables:
--
--   seo_approvals   — append-only human-approval ledger. THE record that
--                     satisfies the IRONCLAD human-approval gate (canon §1):
--                     a row exists iff a human approver signed off on a
--                     SPECIFIC content payload, identified by its
--                     `content_sha256`. Nothing reaches a published bundle
--                     without a matching ledger row.
--
--   seo_faq_sets    — control-plane authoring rows for FAQ sets. Each row
--                     carries the current content fingerprint
--                     (`content_sha256`) and, once approved, the
--                     `approval_id` of the ledger row that approved THAT
--                     exact fingerprint. Any edit recomputes the
--                     fingerprint and resets the row to `draft`
--                     (approval_id NULL), so an approval can never silently
--                     cover edited content.
--
-- The `content_sha256` is a hex sha256 over a canonical, versioned payload
-- of the PUBLIC content identity + both raw/sanitized variants — see
-- helios/src/server/seo/faqContent.ts (`faqSetContentSha256`). The server
-- approve path and the DB→bundle loader both recompute and verify it.
--
-- DB-cost note (canon §3): these are small, operator-write-rate
-- control-plane tables (single-digit GB/year at current scale, parent
-- EPIC_PLAN §9). There is NO recurring/background workload here —
-- generation and approval are operator-triggered — so the P5 high-risk-DB
-- gate does not apply to P3. Indexes: PK + unique(faq_set_id) +
-- unique(approval_id) + status filter + a content_ref lookup on the
-- ledger.
--
-- Idempotent: every `create` is `if not exists`. Safe to re-run.

\echo 'Running migration 071: seo_faq_control_plane...'

-- ── human-approval ledger ─────────────────────────────────────────────
create table if not exists seo_approvals (
  approval_id          text        primary key,
  -- P3 only mints faq_set approvals; the check keeps the ledger honest
  -- until later phases extend it (post/image/related/head approvals).
  content_kind         text        not null,
  -- The control-plane id of the approved content (e.g. the faq_set_id).
  content_ref          text        not null,
  -- Hex sha256 of the EXACT approved canonical content payload.
  content_sha256       text        not null,
  approved_by_user_id  bigint      not null,
  approved_at          timestamptz not null default now(),
  note                 text,

  constraint seo_approvals_content_kind_check
    check (content_kind in ('faq_set')),
  constraint seo_approvals_content_sha256_check
    check (content_sha256 ~ '^[0-9a-f]{64}$')
);

-- "What approved content_ref X, most recent first" (audit trail).
create index if not exists seo_approvals_content_ref_idx
  on seo_approvals (content_kind, content_ref, approved_at desc);

-- ── FAQ-set authoring rows ────────────────────────────────────────────
create table if not exists seo_faq_sets (
  id                   bigserial   primary key,
  -- Stable public id used by widgets + the bundle (FaqSetSchema.faq_set_id).
  faq_set_id           text        not null unique,
  -- Concrete site id OR the reserved global 'all' token (consistency.ts
  -- rejects a physical 'all' site).
  scope                text        not null,
  status               text        not null default 'draft',
  -- Array of { question, answer_raw, answer_sanitized } (FaqItemSchema).
  items                jsonb       not null,
  -- How the row was authored.
  source               text        not null default 'manual',
  -- Compact provenance for generated drafts (model ref, prompt, etc.).
  generation_meta      jsonb,
  -- Current content fingerprint (recomputed on every save/generate).
  content_sha256       text        not null,
  -- Set iff status = 'approved'; the ledger row that approved THIS
  -- exact fingerprint.
  approval_id          text        references seo_approvals (approval_id),
  created_by_user_id   bigint,
  updated_by_user_id   bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint seo_faq_sets_status_check
    check (status in ('draft', 'needs_review', 'approved', 'rejected')),
  constraint seo_faq_sets_source_check
    check (source in ('manual', 'generated')),
  constraint seo_faq_sets_content_sha256_check
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- approval_id present iff approved — the structural half of the
  -- IRONCLAD gate (the loader additionally verifies the ledger join).
  constraint seo_faq_sets_approval_consistency_check
    check (
      (status = 'approved' and approval_id is not null)
      or
      (status <> 'approved' and approval_id is null)
    ),
  -- One approval row can back at most one FAQ set.
  constraint seo_faq_sets_approval_id_unique
    unique (approval_id)
);

-- List/filter by review status (the control-plane list view + the
-- approved-only bundle loader both filter on status).
create index if not exists seo_faq_sets_status_idx
  on seo_faq_sets (status);
