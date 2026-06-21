-- Migration 094: pending_purchase_hint_bundles + pending_purchase_hint_documents
--
-- Prospective pending-purchase classifier — HINT BUNDLE STORAGE (child epic
-- FreshlyBakedNYC/automation#54, parent virusdave/top-level#33, task C2).
--
-- Optional side-channel hint material (a distributor's wholesale menu, a
-- sibling store's purchase order, a free-text operator note) is the single
-- biggest accuracy lever for the prospective classifier — and the biggest
-- injection risk. These tables are the durable, audited STORAGE for that
-- material; they treat every document as UNTRUSTED DATA, never instructions.
--
-- v1 scope (operator decision 2): pasted arbitrary hint TEXT only. File
-- uploads (CSV/PDF/manifests/POs/vendor catalogs/scrapings) are a near-term
-- follow-up (epic FT-1) and intentionally out of scope here.
--
-- DOCUMENT BYTES LIVE OUT-OF-BAND (operator requirement). The DB does NOT
-- store the hint text; it stores only a POINTER to a content-addressed,
-- append-only blob on the `/cloud` storage box (see
-- server/pendingPurchases/pendingPurchaseHintStore.ts), plus the small
-- extracted facts (C3) that are worth keeping for history. The pointer is
-- (content_sha256, storage_backend, storage_uri, byte_size); the same bytes
-- are physically stored once and may be referenced by multiple bundles.
--
-- This migration is STORAGE + admin CRUD + a hintBundleId the generate
-- job/route carries. The two-step extract pipeline that fills
-- hint_intent / extraction_status / extracted_facts is task C3, and the
-- classifier that consumes a bundle is C4 — those columns are pre-created
-- here (nullable / defaulted) so C3 needs no second manual migration.
--
-- Two tables:
--
--   pending_purchase_hint_bundles    — one operator-curated bundle of hint
--                                      documents, attached to a generate run
--                                      by its public hint_bundle_id. Archive,
--                                      don't delete (status='archived').
--
--   pending_purchase_hint_documents  — one row per hint document = a POINTER
--                                      to the out-of-band blob plus per-row
--                                      provenance (kind, source label). Each
--                                      carries a content_sha256 (the blob's
--                                      address) with a per-bundle UNIQUE
--                                      constraint, so re-pasting identical
--                                      text into the same bundle is an
--                                      idempotent no-op rather than a
--                                      duplicate. on delete cascade drops only
--                                      the pointer rows; the append-only blob
--                                      is never deleted.
--
-- DB-cost note (canon §3): small, operator-write-rate control-plane tables
-- (a handful of pointer rows per generate run; the bytes never touch the DB).
-- There is NO recurring/background/scheduled workload here — the extraction
-- pass (C3) is bundle-scoped and operator/job-triggered, not a global
-- scanner — so the high-risk-DB gate does not apply and no JSONB GIN /
-- normalized-fact tables are warranted yet.
-- Indexes: PK + unique(public id) on both; (status, created_at desc) for the
-- bundle list; (bundle_id, created_at desc) for the per-bundle document list;
-- unique(bundle_id, content_sha256) for paste dedup.
--
-- Idempotent: every create is `if not exists`; constraint adds are guarded.
-- Safe to re-run.

\set ON_ERROR_STOP on

\echo 'Running migration 094: pending_purchase_hint_bundles...'

-- ── hint bundles ──────────────────────────────────────────────────────
create table if not exists pending_purchase_hint_bundles (
  id                   bigserial   primary key,
  -- Stable public id `pphint_YYYY-MM-DD_HHMMSS_<6hex>`; the API surface,
  -- the generate route/job payload, and the dedupe key all use this, never
  -- the bigserial.
  hint_bundle_id       text        not null unique,
  label                text        not null,
  note                 text,
  -- active bundles are attachable to a generate run; archived ones are kept
  -- for provenance but rejected at enqueue time.
  status               text        not null default 'active',
  created_by_user_id   bigint,
  updated_by_user_id   bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint pending_purchase_hint_bundles_status_check
    check (status in ('active', 'archived')),
  constraint pending_purchase_hint_bundles_hint_bundle_id_check
    check (hint_bundle_id ~ '^pphint_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$'),
  constraint pending_purchase_hint_bundles_label_nonempty_check
    check (btrim(label) <> '')
);

-- ── hint documents ────────────────────────────────────────────────────
create table if not exists pending_purchase_hint_documents (
  id                   bigserial   primary key,
  -- Stable public id `pphdoc_YYYY-MM-DD_HHMMSS_<6hex>`.
  hint_document_id     text        not null unique,
  bundle_id            bigint      not null,
  -- How the operator says this document helps (decision 2). DB-mirrored by
  -- the kind check; the app exposes the same enum.
  kind                 text        not null,
  -- Optional human label for the source ("Curaleaf wholesale menu 6/20").
  source_label         text,
  -- ── out-of-band blob POINTER (the bytes never touch the DB) ──────────
  -- content_sha256 = sha256 of the normalized UTF-8 hint text = the blob's
  -- content address AND the per-bundle dedup key.
  content_sha256       text        not null,
  -- Which blob backend holds the bytes ('fs' on /cloud today; 's3' later).
  storage_backend      text        not null default 'fs',
  -- Logical key the backend resolves, e.g.
  -- 'fs://pending-purchase-hints/ab/cd/<sha>.txt'. NEVER an absolute path,
  -- so a crafted/legacy uri can't escape the storage root.
  storage_uri          text        not null,
  -- Size of the stored blob in bytes (the API rejects empty text, so > 0).
  byte_size            bigint      not null,
  -- ── filled by C3 (intent classify + extract); nullable/defaulted here ──
  -- LLM-detected hint intent (canonical_sku_list / ordered_items_expectation
  -- / free_text_description / line_item_list). Left UNCONSTRAINED so C3 can
  -- evolve the taxonomy without a widening migration.
  hint_intent          text,
  extraction_status    text        not null default 'pending',
  -- Compact failure reason when extraction_status='failed' (operator UI).
  extraction_error     text,
  -- Inert cited facts the classifier (C4) reasons over.
  extracted_facts      jsonb,
  created_by_user_id   bigint,
  updated_by_user_id   bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint pending_purchase_hint_documents_kind_check
    check (kind in (
      'distributor_menu', 'sibling_purchase_order', 'operator_note', 'other'
    )),
  constraint pending_purchase_hint_documents_extraction_status_check
    check (extraction_status in ('pending', 'extracted', 'failed', 'skipped')),
  constraint pending_purchase_hint_documents_hint_document_id_check
    check (hint_document_id ~ '^pphdoc_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$'),
  constraint pending_purchase_hint_documents_content_sha256_check
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint pending_purchase_hint_documents_storage_backend_check
    check (storage_backend in ('fs', 's3')),
  constraint pending_purchase_hint_documents_storage_uri_nonempty_check
    check (btrim(storage_uri) <> ''),
  -- For the fs backend the logical key is fully derived from the content
  -- address, so the DB can reject a pointer whose uri doesn't match its sha
  -- (a buggy/manual insert with an absolute path, wrong shard, or mismatched
  -- sha). The store enforces the same shape on read; this is the write-time
  -- backstop. Non-fs backends (future s3) are exempt from the fs key shape.
  constraint pending_purchase_hint_documents_fs_uri_matches_sha_check
    check (
      storage_backend <> 'fs'
      or storage_uri =
        'fs://pending-purchase-hints/'
        || substring(content_sha256 from 1 for 2) || '/'
        || substring(content_sha256 from 3 for 2) || '/'
        || content_sha256 || '.txt'
    ),
  -- Empty hint text is rejected by the API, so a stored blob is always > 0 B.
  constraint pending_purchase_hint_documents_byte_size_positive_check
    check (byte_size > 0),
  -- extracted_facts (C3) is meant to hold SMALL cited facts only — never the
  -- raw document text or a full LLM transcript (those belong out-of-band).
  -- Cap it at 256 KiB so a future C3 bug can't recreate the DB-bloat problem
  -- through this column. Bump deliberately (with a reason) if C3 needs more.
  constraint pending_purchase_hint_documents_extracted_facts_small_check
    check (
      extracted_facts is null
      or octet_length(extracted_facts::text) <= 262144
    ),
  -- Re-pasting identical text into the same bundle is an idempotent no-op.
  constraint pending_purchase_hint_documents_bundle_content_sha256_key
    unique (bundle_id, content_sha256),
  -- Explicitly named FK (instead of relying on the auto-generated name) so
  -- the pendingMigrations sentinel can probe it by a stable name.
  constraint pending_purchase_hint_documents_bundle_id_fkey
    foreign key (bundle_id)
    references pending_purchase_hint_bundles (id) on delete cascade
);

-- Bundle list view ("active first, newest first").
create index if not exists pending_purchase_hint_bundles_status_created_idx
  on pending_purchase_hint_bundles (status, created_at desc, id desc);

-- Per-bundle document list, deterministic order.
create index if not exists pending_purchase_hint_documents_bundle_created_idx
  on pending_purchase_hint_documents (bundle_id, created_at desc, id desc);

\echo 'Migration 094 complete.'
