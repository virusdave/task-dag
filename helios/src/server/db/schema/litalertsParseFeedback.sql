-- litalerts_parse_feedback
--
-- INERT operator-feedback inbox for the brand-categorical-family market-match
-- audit panel (issue #59, task T3). From a mis-parsed LitAlerts competitor
-- listing the operator can (A) correct that listing's extracted structured
-- fields and (B) optionally record the retailer's naming convention.
--
-- Cardinal rule: this is NOT a second, live parser. Unpromoted feedback must
-- NEVER change production scoring/matching, `fuzzy_skus`, market aggregates, or
-- IQR. It only improves the OPERATOR WORKFLOW (show saved feedback on rows,
-- prefill future corrections, "convention exists" hints). Nothing in the
-- production scorer / market-match read path joins this table — it is read only
-- by the dedicated parse-feedback endpoint and, later, by the agent/reviewer
-- promotion export (T5). Promotion into parsekit / `helios-parser-configs` is an
-- agent/reviewer task, never a web-side git write.
--
-- One normalized table with a discriminated `kind`:
--   listing_correction  — corrected structured fields for ONE listing.
--   convention_proposal — an optional retailer naming-convention hint, linked
--                         back to the correction that spawned it via
--                         `source_feedback_id`.
--
-- Provenance columns (`source_listing_id`, `retailer_id`, `input_hash`,
-- `input_snapshot`, `raw_listing_name`) are derived SERVER-SIDE from the
-- referenced `fuzzy_skus` row, never trusted from the browser. `retailer_id` is
-- the STABLE identifier — the display name is not.
--
-- The kind-specific structured payload (corrected fields / issue chips /
-- convention note+scope+examples+pattern chips) lives in `details jsonb`,
-- validated by a Zod discriminated union at the app boundary. The details are
-- always fully consumed (drawer prefill + T5 export) and never filtered on in
-- SQL, so a narrow table + jsonb payload is the right shape (vs. ~15 sparse
-- nullable columns).
--
-- Idempotent: every `create` is `if not exists`.

create table if not exists litalerts_parse_feedback (
  id                          uuid primary key default gen_random_uuid(),

  -- Discriminated kind + upstream source.
  kind                        text not null,
  use_case                    text not null default 'litalerts',

  -- Provenance (derived server-side from fuzzy_skus; retailer_id is STABLE).
  source_listing_id           text,
  fuzzy_sku_id                bigint references fuzzy_skus(id),
  retailer_id                 bigint,
  raw_listing_name            text,
  input_hash                  text,
  input_snapshot              jsonb,

  -- Family context (echoed from the panel; not a live matcher key).
  family_key                  text,
  brand_key                   text,
  matched_catalog_product_id  bigint,

  -- A convention_proposal points back to the listing_correction it came from.
  source_feedback_id          uuid references litalerts_parse_feedback(id),

  -- Kind-specific structured payload (Zod-validated at the app boundary).
  details                     jsonb not null default '{}'::jsonb,

  -- Lifecycle. Web writes only ever produce `draft`; promotion transitions are
  -- driven by the agent/reviewer promotion path (T5).
  status                      text not null default 'draft',
  status_changed_by           text,
  status_changed_at           timestamptz,

  -- Actor / audit.
  created_by                  text not null,
  created_at                  timestamptz not null default now(),
  updated_by                  text not null,
  updated_at                  timestamptz not null default now(),

  constraint litalerts_parse_feedback_kind_ok
    check (kind in ('listing_correction', 'convention_proposal')),
  constraint litalerts_parse_feedback_use_case_ok
    check (use_case in ('litalerts', 'competitor-ecom')),
  constraint litalerts_parse_feedback_status_ok
    check (status in ('draft', 'promotion_requested', 'promoted', 'rejected', 'superseded')),
  constraint litalerts_parse_feedback_details_object_ok
    check (jsonb_typeof(details) = 'object'),
  constraint litalerts_parse_feedback_snapshot_object_ok
    check (input_snapshot is null or jsonb_typeof(input_snapshot) = 'object'),
  -- A listing correction must carry its source listing provenance.
  constraint litalerts_parse_feedback_correction_provenance_ok
    check (
      kind <> 'listing_correction'
      or (fuzzy_sku_id is not null and source_listing_id is not null and input_hash is not null)
    ),
  -- Only convention proposals may reference a parent correction.
  constraint litalerts_parse_feedback_source_kind_ok
    check (source_feedback_id is null or kind = 'convention_proposal')
);

-- Fetch feedback for the visible candidates (by fuzzy_sku_id).
create index if not exists litalerts_parse_feedback_fuzzy_idx
  on litalerts_parse_feedback (fuzzy_sku_id, created_at desc)
  where fuzzy_sku_id is not null;

-- Fetch feedback / convention hints for a retailer.
create index if not exists litalerts_parse_feedback_retailer_idx
  on litalerts_parse_feedback (use_case, retailer_id, created_at desc)
  where retailer_id is not null;

-- Promotion export (T5) + status filtering.
create index if not exists litalerts_parse_feedback_status_idx
  on litalerts_parse_feedback (status, created_at desc);

-- Fetch by the raw source listing id.
create index if not exists litalerts_parse_feedback_source_listing_idx
  on litalerts_parse_feedback (use_case, source_listing_id, created_at desc)
  where source_listing_id is not null;

-- Walk from a correction to its convention proposals (and back).
create index if not exists litalerts_parse_feedback_source_feedback_idx
  on litalerts_parse_feedback (source_feedback_id)
  where source_feedback_id is not null;
