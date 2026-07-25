// Runtime check: are any of helios's known SQL migrations still
// unapplied against the live database?
//
// Helios's migrations live as `src/server/db/migrations/NNN_*.sql`
// files that are applied **manually** (`psql -f …`) by an operator —
// there is no boot-time runner. That makes it easy for a deploy to
// ship server code that depends on a column or table the production
// DB doesn't have yet, which then surfaces only at first request
// (e.g. `column "needs_reanalysis_at" does not exist`).
//
// To make that failure mode visible *before* a user trips into it,
// we maintain a hand-curated registry of `{ migrationId, sentinel }`
// pairs below. Each sentinel is the cheapest query we can run that
// returns 0 rows iff the migration hasn't landed. We surface the
// pending list on the session envelope so the SPA can render an
// all-pages banner explaining what the operator has to run.
//
// When you add a new migration NNN_foo.sql, ALSO add an entry here.
// (If you forget, the new code will simply fail with a raw SQL error
// when it tries to use the missing schema — same as today.) Drop the
// entries here only once you're confident every long-lived
// environment has the migration applied; until then the entry is
// effectively a sentinel that the prod DB and the source tree are in
// sync.

import type { Queryable } from './pool.js'
import { pendingPurchaseRefinementSchemaApplied } from './pendingPurchaseRefinementSchema.js'

/**
 * Transaction handling of a migration artifact, recorded from the reviewed
 * blessing so the apply engine can label the attempt without parsing SQL.
 *   - `transactional`        — the file wraps its own `begin;`/`commit;`.
 *   - `nontransactional-cic` — contains `CREATE INDEX CONCURRENTLY` (or another
 *                              statement that cannot run inside a txn) and is
 *                              intentionally NOT wrapped.
 *   - `mixed`                — a combination (rare; blessing must justify it).
 */
export type MigrationTransactionMode = 'transactional' | 'nontransactional-cic' | 'mixed'

/**
 * Oracle-blessing + operator-provenance bound to a migration artifact
 * (automation#62; see DESIGN.md "Data model" / "Gating / safety model").
 * A migration is apply-eligible ONLY when it carries a complete blessing AND
 * the deployed artifact-closure digest still equals `artifactSha256` — a later
 * edit to a shared `schema/*.sql` include changes the recomputed digest and
 * invalidates the stale blessing rather than silently running unblessed SQL.
 * The blessing is recorded in git by the migration author when it lands, so
 * provenance is version-controlled, not a mutable DB flag. It is intentionally
 * absent until a migration has completed that review, so the apply engine fails
 * closed for every unreviewed artifact.
 */
export interface MigrationBlessing {
  /** Human-referenceable Oracle blessing ref (thread URL / review id). */
  readonly ref: string
  /** The reviewed source SHA the blessing was granted against. */
  readonly reviewedSha: string
  /**
   * sha256 over the reviewed unit: the main migration file PLUS its full
   * `\i`/`\ir` include closure, exactly as {@link resolveMigrationArtifact}
   * computes it. Lowercase hex.
   */
  readonly artifactSha256: string
  /** How the artifact handles transactions (recorded onto the attempt row). */
  readonly transactionMode: MigrationTransactionMode
  /** Digest-bound, Oracle-reviewed explanation shown before the raw SQL. */
  readonly operatorExplanation: string
  /** Optional free-text note (non-transactional caveats, etc). */
  readonly note?: string
}

export interface MigrationSentinel {
  readonly migrationId: string
  readonly label: string
  readonly check: (db: Queryable) => Promise<boolean>
  /**
   * Present ONLY once the migration has been Oracle-blessed + is
   * operator-approvable via the admin "Apply Now" flow (automation#62). Absent
   * ⇒ the migration is not apply-eligible and the worker refuses it.
   */
  readonly blessing?: MigrationBlessing
}

export interface PendingMigration {
  readonly migrationId: string
  readonly label: string
}

async function columnExists(db: Queryable, tableName: string, columnName: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name = $1
          and column_name = $2
     ) as exists`,
    [tableName, columnName],
  )
  return result.rows[0]?.exists === true
}

async function tableExists(db: Queryable, tableName: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1
         from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
     ) as exists`,
    [tableName],
  )
  return result.rows[0]?.exists === true
}

async function constraintExists(
  db: Queryable,
  tableName: string,
  constraintName: string,
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname = $1
          and c.conname = $2
     ) as exists`,
    [tableName, constraintName],
  )
  return result.rows[0]?.exists === true
}

async function indexExists(db: Queryable, indexName: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1
         from pg_indexes
        where schemaname = 'public'
          and indexname = $1
     ) as exists`,
    [indexName],
  )
  return result.rows[0]?.exists === true
}

// Like indexExists, but only true for an index that is VALID and READY.
// A cancelled/failed `CREATE INDEX CONCURRENTLY` leaves behind an
// invalid index that still shows up in pg_indexes; treating that as
// "applied" would be wrong, so sentinels for concurrently-built indexes
// must use this stricter check.
async function validIndexExists(db: Queryable, indexName: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_index i on i.indexrelid = c.oid
        where n.nspname = 'public'
          and c.relname = $1
          and i.indisvalid
          and i.indisready
     ) as exists`,
    [indexName],
  )
  return result.rows[0]?.exists === true
}

async function hypertableCompressionEnabled(
  db: Queryable,
  hypertableName: string,
): Promise<boolean> {
  // `compression_enabled` flips to true when ALTER TABLE … SET
  // (timescaledb.compress, …) has been applied; it is independent
  // of whether any chunks have actually been compressed yet. That
  // is exactly what we want as a migration sentinel — the policy
  // setup is what migration 056/057-style files perform.
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1
         from timescaledb_information.hypertables
        where hypertable_schema = 'public'
          and hypertable_name = $1
          and compression_enabled = true
     ) as exists`,
    [hypertableName],
  )
  return result.rows[0]?.exists === true
}

async function compressionPolicyCompressAfterIs(
  db: Queryable,
  hypertableName: string,
  compressAfter: string,
): Promise<boolean> {
  // Unlike `hypertableCompressionEnabled`, this inspects the actual
  // compression POLICY threshold. Migration 058 only changes the
  // `compress_after` of an already-enabled policy, so the
  // "compression enabled" sentinel would report it as applied even
  // before it runs. We compare the policy job's config value
  // (e.g. {"hypertable_id": 3, "compress_after": "45 days"}) instead.
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1
         from timescaledb_information.jobs
        where hypertable_schema = 'public'
          and hypertable_name = $1
          and proc_name like '%compression%'
          and config->>'compress_after' = $2
     ) as exists`,
    [hypertableName, compressAfter],
  )
  return result.rows[0]?.exists === true
}

async function hypertableExists(db: Queryable, hypertableName: string): Promise<boolean> {
  // TimescaleDB tracks hypertables in `timescaledb_information.hypertables`.
  // The view exists on every database that has the timescaledb
  // extension installed (which Helios's prod DB does); we still wrap
  // the query in a try/catch at the call site (the sentinel runner
  // already does that) so a missing extension in some hypothetical
  // dev environment surfaces as "migration pending" rather than a
  // 500. The view exposes both the hypertable schema and name; we
  // restrict to `public` to match the rest of the helpers.
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1
         from timescaledb_information.hypertables
        where hypertable_schema = 'public'
          and hypertable_name = $1
     ) as exists`,
    [hypertableName],
  )
  return result.rows[0]?.exists === true
}

async function reviewTransactionAttributionSchemaApplied(db: Queryable): Promise<boolean> {
  // One bounded catalog round-trip verifies the exact migration 105 contract.
  // Keep these definitions synchronized with schema/customerReviews.sql.
  const result = await db.query<{ applied: boolean }>(`
    with expected_columns(name, type, not_null, default_expr) as (values
      ('invoice_match_status', 'text', true, '''not_attempted''::text'),
      ('matched_invoice_id', 'text', false, null),
      ('matched_cashier_user_id', 'bigint', false, null),
      ('matched_at', 'timestamp with time zone', false, null)
    ), actual_columns as (
      select a.attname as name,
             format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as not_null,
             pg_get_expr(d.adbin, d.adrelid) as default_expr
        from pg_attribute a
        join pg_class t on t.oid = a.attrelid
        join pg_namespace n on n.oid = t.relnamespace
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where n.nspname = 'public'
         and t.relname = 'review_submissions'
         and a.attname in (
           'invoice_match_status', 'matched_invoice_id',
           'matched_cashier_user_id', 'matched_at'
         )
         and a.attnum > 0 and not a.attisdropped
    ), expected_constraints(name, type, definition) as (values
      ('review_submissions_invoice_match_status_check', 'c', 'CHECK ((invoice_match_status = ANY (ARRAY[''not_attempted''::text, ''matched''::text, ''unmatched''::text])))'),
      ('review_submissions_invoice_match_state_check', 'c', 'CHECK ((((invoice_match_status = ANY (ARRAY[''not_attempted''::text, ''unmatched''::text])) AND (matched_invoice_id IS NULL) AND (matched_cashier_user_id IS NULL) AND (matched_at IS NULL)) OR ((invoice_match_status = ''matched''::text) AND (matched_invoice_id IS NOT NULL) AND (matched_cashier_user_id IS NOT NULL) AND (matched_at IS NOT NULL))))')
    ), actual_constraints as (
      select c.conname as name, c.contype::text as type,
             pg_get_constraintdef(c.oid) as definition, c.convalidated
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'public'
         and t.relname = 'review_submissions'
         and c.conname in (
           'review_submissions_invoice_match_status_check',
           'review_submissions_invoice_match_state_check'
         )
    )
    select
      not exists (
        select 1 from expected_columns e
        left join actual_columns a using (name, type, not_null)
        where a.name is null or a.default_expr is distinct from e.default_expr
      )
      and (select count(*) from actual_columns) = (select count(*) from expected_columns)
      and not exists (
        select 1 from expected_constraints e
        left join actual_constraints a using (name, type, definition)
        where a.name is null or not a.convalidated
      )
      and (select count(*) from actual_constraints) = (select count(*) from expected_constraints)
      as applied
  `)
  return result.rows[0]?.applied === true
}

export async function vendorBrandAssociationsSchemaApplied(db: Queryable): Promise<boolean> {
  // One bounded catalog round-trip verifies the exact schema contract. Seed
  // rows are deliberately excluded because operators may edit them later.
  const result = await db.query<{ applied: boolean }>(`
    with expected_columns(table_name, name, type, not_null, identity_kind, default_expr) as (values
      ('vendors', 'id', 'bigint', true, 'a', null),
      ('vendors', 'name', 'text', true, '', null),
      ('vendors', 'is_mso', 'boolean', true, '', 'false'),
      ('vendors', 'is_micro', 'boolean', true, '', 'false'),
      ('vendors', 'cod_only', 'boolean', true, '', 'false'),
      ('vendors', 'created_at', 'timestamp with time zone', true, '', 'now()'),
      ('vendors', 'updated_at', 'timestamp with time zone', true, '', 'now()'),
      ('vendor_brand_associations', 'id', 'bigint', true, 'a', null),
      ('vendor_brand_associations', 'vendor_id', 'bigint', true, '', null),
      ('vendor_brand_associations', 'brand_name', 'text', true, '', null),
      ('vendor_brand_associations', 'is_primary', 'boolean', true, '', 'true'),
      ('vendor_brand_associations', 'target_days_on_hand', 'integer', false, '', null),
      ('vendor_brand_associations', 'asset_url', 'text', false, '', null),
      ('vendor_brand_associations', 'cod_required', 'boolean', false, '', null),
      ('vendor_brand_associations', 'cod_discount_source', 'text', false, '', null),
      ('vendor_brand_associations', 'minimum_order_dollars', 'numeric(12,2)', false, '', null),
      ('vendor_brand_associations', 'comments', 'text', false, '', null),
      ('vendor_brand_associations', 'created_at', 'timestamp with time zone', true, '', 'now()'),
      ('vendor_brand_associations', 'updated_at', 'timestamp with time zone', true, '', 'now()')
    ), actual_columns as (
      select t.relname as table_name, a.attname as name,
             format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as not_null, a.attidentity::text as identity_kind,
             pg_get_expr(d.adbin, d.adrelid) as default_expr
      from pg_attribute a
      join pg_class t on t.oid = a.attrelid
      join pg_namespace n on n.oid = t.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = 'public'
        and t.relname in ('vendors', 'vendor_brand_associations')
        and t.relkind in ('r', 'p')
        and a.attnum > 0 and not a.attisdropped
    ), expected_constraints(table_name, name, type, definition) as (values
      ('vendors', 'vendors_pkey', 'p', 'PRIMARY KEY (id)'),
      ('vendors', 'vendors_name_trimmed_nonempty_check', 'c', 'CHECK (((name = btrim(name)) AND (name <> ''''::text)))'),
      ('vendor_brand_associations', 'vendor_brand_associations_pkey', 'p', 'PRIMARY KEY (id)'),
      ('vendor_brand_associations', 'vendor_brand_associations_vendor_id_fkey', 'f', 'FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE'),
      ('vendor_brand_associations', 'vendor_brand_associations_brand_trimmed_nonempty_check', 'c', 'CHECK (((brand_name = btrim(brand_name)) AND (brand_name <> ''''::text)))'),
      ('vendor_brand_associations', 'vendor_brand_associations_target_days_check', 'c', 'CHECK (((target_days_on_hand IS NULL) OR (target_days_on_hand > 0)))'),
      ('vendor_brand_associations', 'vendor_brand_associations_asset_url_check', 'c', 'CHECK (((asset_url IS NULL) OR ((asset_url = btrim(asset_url)) AND (asset_url <> ''''::text))))'),
      ('vendor_brand_associations', 'vendor_brand_associations_cod_discount_source_check', 'c', 'CHECK (((cod_discount_source IS NULL) OR ((cod_discount_source = btrim(cod_discount_source)) AND (cod_discount_source <> ''''::text))))'),
      ('vendor_brand_associations', 'vendor_brand_associations_minimum_order_check', 'c', 'CHECK (((minimum_order_dollars IS NULL) OR (minimum_order_dollars >= (0)::numeric)))'),
      ('vendor_brand_associations', 'vendor_brand_associations_comments_check', 'c', 'CHECK (((comments IS NULL) OR ((comments = btrim(comments)) AND (comments <> ''''::text))))')
    ), actual_constraints as (
      select t.relname as table_name, c.conname as name, c.contype::text as type,
             pg_get_constraintdef(c.oid) as definition, c.convalidated
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and t.relname in ('vendors', 'vendor_brand_associations')
        -- PostgreSQL 18 exposes NOT NULL constraints in pg_constraint as
        -- contype = 'n'. Column metadata above verifies each valid NOT NULL
        -- property; retain every other kind (and invalid NOT NULL constraints)
        -- so the exact-count check still rejects unexpected schema objects.
        and not (c.contype = 'n' and c.convalidated)
    ), expected_indexes(name, definition, predicate) as (values
      ('vendors_name_lower_uidx', 'CREATE UNIQUE INDEX vendors_name_lower_uidx ON public.vendors USING btree (lower(name))', null),
      ('vendor_brand_associations_vendor_brand_lower_uidx', 'CREATE UNIQUE INDEX vendor_brand_associations_vendor_brand_lower_uidx ON public.vendor_brand_associations USING btree (vendor_id, lower(brand_name))', null),
      ('vendor_brand_associations_one_primary_brand_uidx', 'CREATE UNIQUE INDEX vendor_brand_associations_one_primary_brand_uidx ON public.vendor_brand_associations USING btree (lower(brand_name)) WHERE is_primary', 'is_primary')
    ), actual_indexes as (
      select i.relname as name, pg_get_indexdef(i.oid) as definition,
             pg_get_expr(x.indpred, x.indrelid) as predicate,
             x.indisunique, x.indisvalid, x.indisready
      from pg_class i
      join pg_namespace n on n.oid = i.relnamespace
      join pg_index x on x.indexrelid = i.oid
      where n.nspname = 'public'
        and i.relname in (
          'vendors_name_lower_uidx',
          'vendor_brand_associations_vendor_brand_lower_uidx',
          'vendor_brand_associations_one_primary_brand_uidx'
        )
    )
    select
      not exists (
        select 1 from expected_columns e
        left join actual_columns a using
          (table_name, name, type, not_null, identity_kind)
        where a.name is null or a.default_expr is distinct from e.default_expr
      )
      and (select count(*) from actual_columns) = (select count(*) from expected_columns)
      and not exists (
        select 1 from expected_constraints e
        left join actual_constraints a using (table_name, name, type, definition)
        where a.name is null or not a.convalidated
      )
      and (select count(*) from actual_constraints) = (select count(*) from expected_constraints)
      and not exists (
        select 1 from expected_indexes e
        left join actual_indexes a
          on a.name = e.name
         and a.definition = e.definition
         and a.predicate is not distinct from e.predicate
        where a.name is null or not a.indisunique or not a.indisvalid or not a.indisready
      ) as applied
  `)
  return result.rows[0]?.applied === true
}

const SENTINELS: MigrationSentinel[] = [
  {
    migrationId: '007_pending_purchases',
    label: 'Pending Purchases tables',
    check: (db) => tableExists(db, 'pending_purchase_packets'),
  },
  {
    migrationId: '008_catalog_maintenance_cached_inputs',
    label: 'Catalog Maintenance cached inputs (catalog_groups.needs_reanalysis_at, stock_variant_state.metrc_tags_json)',
    check: async (db) => {
      const [hasCol, hasTagsCol] = await Promise.all([
        columnExists(db, 'catalog_groups', 'needs_reanalysis_at'),
        columnExists(db, 'stock_variant_state', 'metrc_tags_json'),
      ])
      return hasCol && hasTagsCol
    },
  },
  {
    migrationId: '009_market_data_sweep_columns',
    label:
      'Market Data Sweep columns (pending_litalerts_refresh_queue.priority, ' +
      'litalerts_competitor_observations.expires_at, …)',
    check: (db) => columnExists(db, 'pending_litalerts_refresh_queue', 'priority'),
  },
  {
    migrationId: '010_market_data_sweep_view',
    label: 'Market Data Sweep view (vw_pricing_evidence_freshness)',
    check: async (db) => {
      const result = await db.query<{ exists: boolean }>(
        `select to_regclass('public.vw_pricing_evidence_freshness') is not null as exists`,
      )
      return result.rows[0]?.exists === true
    },
  },
  {
    migrationId: '011_sweed_auth_events',
    label: 'Sweed auth event log (sweed_auth_events table) — required for worker auth diagnostics + UI surface',
    check: (db) => tableExists(db, 'sweed_auth_events'),
  },
  {
    migrationId: '012_market_data_brand_expiry_overrides',
    label: 'Brand expiry overrides (brand_expiry_overrides table) — operator-managed per-brand market-evidence freshness windows',
    check: (db) => tableExists(db, 'brand_expiry_overrides'),
  },
  {
    migrationId: '013_market_data_view_per_brand_expiry',
    label: 'vw_pricing_evidence_freshness honors brand_expiry_overrides — re-declares the view',
    // We detect the post-013 shape by probing whether the view's
    // freshness calc references brand_expiry_overrides at all. Simple
    // smoke: select 1 from the view filtered through the overrides
    // table; if the post-013 view is installed the planner will
    // resolve the join correctly. We can't easily introspect the
    // view body cross-version, so we just check the table exists +
    // the view exists (the orchestrator applies 013 right after
    // 012, so they go together).
    check: async (db) => {
      const [hasTable, hasView] = await Promise.all([
        tableExists(db, 'brand_expiry_overrides'),
        db
          .query<{ exists: boolean }>(
            `select exists(
               select 1
                 from information_schema.views
                where table_schema = 'public'
                  and table_name = 'vw_pricing_evidence_freshness'
             ) as exists`,
          )
          .then((r) => r.rows[0]?.exists === true),
      ])
      return hasTable && hasView
    },
  },
  {
    migrationId: '014_sweed_session_tokens',
    label: 'Sweed session tokens (sweed_session_tokens table) — required for the operator paste-token flow that replaces the legacy SWEED_AUTH_TOKEN env var',
    check: (db) => tableExists(db, 'sweed_session_tokens'),
  },
  {
    migrationId: '015_sweed_session_tokens_pool',
    label:
      'Sweed session tokens pool columns (claimed_at, claimed_by, claim_expires_at) — required so workers can claim/release Sweed sessions exclusively from the pool',
    check: async (db) => {
      const [hasClaimedAt, hasClaimedBy, hasClaimExpiresAt] = await Promise.all([
        columnExists(db, 'sweed_session_tokens', 'claimed_at'),
        columnExists(db, 'sweed_session_tokens', 'claimed_by'),
        columnExists(db, 'sweed_session_tokens', 'claim_expires_at'),
      ])
      return hasClaimedAt && hasClaimedBy && hasClaimExpiresAt
    },
  },
  {
    migrationId: '045_sweed_session_tokens_prolong',
    label:
      'sweed_session_tokens.last_prolonged_at column — highwater mark of the daily Sweed keep-alive (store.auth.dealer.list); required so withSweedSession can prolong a claimed token at most once per 24h and persist when it last did so',
    check: (db) => columnExists(db, 'sweed_session_tokens', 'last_prolonged_at'),
  },
  {
    migrationId: '016_job_queue_priority',
    label:
      'job_queue.priority column + lease ordering — required so operator-initiated jobs jump ahead of system-generated background backlog',
    check: (db) => columnExists(db, 'job_queue', 'priority'),
  },
  {
    migrationId: '017_parsekit_reverse_shadow_events',
    label:
      'parsekit_reverse_shadow_events table — required so the worker can persist parsekit-vs-legacy regressions and the Config -> Parsing -> Purchases page can render them',
    check: (db) => tableExists(db, 'parsekit_reverse_shadow_events'),
  },
  {
    migrationId: '020_rename_whitelabel_to_whiteglove',
    label:
      'whiteglove_pricing_snapshots table — required so Catalog -> WhiteGlove -> Pricing can save reviewer-approved bulk-flower menus and the public /api/whiteglove/public/bulk-flower endpoint can serve them. (Migration 018 created the table as whitelabel_pricing_snapshots; 020 renames it to whiteglove_pricing_snapshots.)',
    check: (db) => tableExists(db, 'whiteglove_pricing_snapshots'),
  },
  {
    migrationId: '019_staff_inclusion',
    label:
      'staff_directory_cache + staff_inclusion tables — required so Utilities -> Staff can cache the Sweed state-dealer employee list and persist approve/reject decisions for the public Meet The Team surface',
    check: async (db) =>
      (await tableExists(db, 'staff_directory_cache')) && tableExists(db, 'staff_inclusion'),
  },
  {
    migrationId: '022_customer_reviews_capture',
    label:
      'site_review_settings + review_submissions + review_contact_info + review_drawing_entries + review_emails tables — required so the Customer-Sentiment Capture (issue #13) A1 surface (POST /v1/reviews/submit, POST /v1/reviews/<id>/drawing-entry, and the /reviews read-only list) can accept and display public submissions',
    check: async (db) =>
      (await tableExists(db, 'site_review_settings')) &&
      (await tableExists(db, 'review_submissions')) &&
      (await tableExists(db, 'review_contact_info')) &&
      (await tableExists(db, 'review_drawing_entries')) &&
      tableExists(db, 'review_emails'),
  },
  {
    migrationId: '023_customer_reviews_llm_gate',
    label:
      'review_submissions LLM-gate columns (llm_verdict, degraded_pass, llm_raw, llm_model_ref, llm_at, review_provider_url) — required so the Customer-Sentiment Capture (issue #13) A2 LLM gate can persist its classification + the resolved per-site paste-text URL on each capture POST',
    check: async (db) => {
      const [hasVerdict, hasDegraded, hasProviderUrl] = await Promise.all([
        columnExists(db, 'review_submissions', 'llm_verdict'),
        columnExists(db, 'review_submissions', 'degraded_pass'),
        columnExists(db, 'review_submissions', 'review_provider_url'),
      ])
      return hasVerdict && hasDegraded && hasProviderUrl
    },
  },
  {
    migrationId: '024_customer_reviews_sweed_integration',
    label:
      'review_drawing_entries A4 columns (accepted_paste_offer, sweed_customer_id, drawing_segment_id, free_preroll_segment_id, fraudulent, fraudulent_marked_at, fraudulent_marked_by) — required so the Customer-Sentiment Capture (issue #13) A4 Sweed integration can persist per-segment add/remove outcomes plus the operator force-add/remove + mark-fraudulent actions',
    check: async (db) => {
      const [hasAccepted, hasCustomer, hasFraudulent] = await Promise.all([
        columnExists(db, 'review_drawing_entries', 'accepted_paste_offer'),
        columnExists(db, 'review_drawing_entries', 'sweed_customer_id'),
        columnExists(db, 'review_drawing_entries', 'fraudulent'),
      ])
      return hasAccepted && hasCustomer && hasFraudulent
    },
  },
  {
    migrationId: '025_gads_ad_attempts',
    label:
      'gads_ad_attempts (per-ad L2 attempt history) — required so the Google Ads automation can finally close its feedback loop: today\'s morning bundle queries past attempts + their outcomes for each ad_id and injects them into the L2 prompt as policy_experiences instead of running blind every day.',
    check: (db) => tableExists(db, 'gads_ad_attempts'),
  },
  {
    migrationId: '026_catalog_market_matches',
    label:
      'fuzzy_skus + catalog_market_matches — persisted FuzzySku records (one immutable row per source-listing × parser-version × raw-input tuple) and the verdict table that links catalog entries to those FuzzySku rows for the Catalog → Market Data review workflow (issue #18).',
    check: async (db) =>
      (await tableExists(db, 'fuzzy_skus')) && (await tableExists(db, 'catalog_market_matches')),
  },
  {
    migrationId: '027_litalerts_retailer_geo',
    label:
      'helios_store_locations + litalerts_retailer_locations — geocoded lat/lng for our stores and for every NY retailer in LitAlerts /v1/retailers. Powers the min-distance-to-our-stores sort on /config/parsing/litalerts (issue #19).',
    check: async (db) =>
      (await tableExists(db, 'helios_store_locations')) &&
      (await tableExists(db, 'litalerts_retailer_locations')),
  },
  {
    migrationId: '030_metric_annotations',
    label:
      'metric_annotations table — required so the /metrics page tree (automation#21, satisfying virusdave/top-level#7) can persist operator-authored annotations on metric charts (point + range, soft-deleted, scope=global|metric:<id>).',
    check: (db) => tableExists(db, 'metric_annotations'),
  },
  {
    migrationId: '031_sweed_orders',
    label:
      'sweed_orders + sweed_orders_ingest_highwater — backs the periodic Sweed orders ingest worker (automation#22, sibling of automation#21). Without this the /metrics page tree continues to render stubs and the worker will fail to start.',
    check: async (db) =>
      (await tableExists(db, 'sweed_orders')) &&
      (await tableExists(db, 'sweed_orders_ingest_highwater')),
  },
  {
    migrationId: '032_sweed_package_snapshots',
    label:
      'sweed_package_snapshots + sweed_package_snapshots_ingest_state — backs the per-package versioned snapshot worker (automation#24, sibling of automation#22, unblocker of #21 COGS / margin / inventory metrics). Without this the per-PACKAGE wholesale cost data does not exist in helios and the worker will fail to start.',
    check: async (db) =>
      (await tableExists(db, 'sweed_package_snapshots')) &&
      (await tableExists(db, 'sweed_package_snapshots_ingest_state')),
  },
  {
    migrationId: '033_litalerts_product_images',
    label:
      'litalerts_product_images — per-product primary image URLs captured from the LitAlerts dashboard backend (POST /Products/menulistings). Needed for image embedding on Catalog → Market Data review rows and proposed catalog entries on Pending Purchases.',
    check: async (db) => tableExists(db, 'litalerts_product_images'),
  },
  {
    migrationId: '036_sweed_package_cost_as_of_fallback',
    label:
      'sweed_package_cost_as_of_or_earliest() — fall-back cost lookup function used by the COGS / margin / inventory metrics (automation#24 wire-up). Without this the /metrics page tree`s margin charts read zero on every pre-2026-05-26 order.',
    check: async (db) => {
      const result = await db.query<{ exists: boolean }>(
        `select exists(
           select 1 from pg_proc
            where proname = 'sweed_package_cost_as_of_or_earliest'
         ) as exists`,
      )
      return result.rows[0]?.exists === true
    },
  },
  {
    migrationId: '034_fuzzy_skus_partner_product_idx',
    label:
      'fuzzy_skus_partner_brand_category_idx — partial covering index that turns the per-(brand, category) aggregate the Catalog → Market Data list page runs on every request into an index-only scan. Without it, GET /api/catalog/market-matches takes ~500ms; with it, ~50ms.',
    check: async (db) => indexExists(db, 'fuzzy_skus_partner_brand_category_idx'),
  },
  {
    migrationId: '035_weather_daily',
    label:
      'weather_daily — per-site (ZIP) daily weather observations (high/low °F, precipitation in.) backing the three real weather.scatter_* metrics on the /metrics page tree (automation#26, unblocks the P5 weather-correlation stubs from #21). Without this the new daily-ingest worker fails to start and the metrics keep rendering as MISSING DATA placeholders.',
    check: async (db) => tableExists(db, 'weather_daily'),
  },
  {
    // 036 originally created sweed_shifts + sweed_shifts_ingest_highwater
    // (later dropped by 038 — see below) and added the still-useful
    // `sweed_orders.cashier_user_id` column. Only the cashier_user_id
    // column survives 038, so this sentinel narrows to that one
    // effect; without it the future v2 cashier-throughput metric
    // (per-transaction attribution) cannot be built.
    migrationId: '036_sweed_shifts',
    label:
      'sweed_orders.cashier_user_id column — added by migration 036 and retained after 038\'s drawer-shift redesign; needed so a future v2 of `cashier.transactions_per_hour` can do per-transaction cashier attribution. (The other artefacts of 036 — sweed_shifts / sweed_shifts_ingest_highwater — were intentionally dropped by 038.)',
    check: (db) => columnExists(db, 'sweed_orders', 'cashier_user_id'),
  },
  {
    migrationId: '038_sweed_drawer_shifts',
    label:
      'sweed_drawer_shifts + sweed_drawer_shift_sessions + sweed_drawer_shifts_ingest_highwater — supersedes 036\'s `sweed_shifts` shape after the first live ingest revealed that `store.sale.shift.list` returns DRAWER/till shifts with a nested `sessions[]` cashier-user array, not per-employee shifts (FreshlyBakedNYC/automation#27, Option A). Without this the redesigned shifts ingest worker fails to start and `cashier.transactions_per_hour` stays a stub.',
    check: async (db) =>
      (await tableExists(db, 'sweed_drawer_shifts')) &&
      (await tableExists(db, 'sweed_drawer_shift_sessions')) &&
      (await tableExists(db, 'sweed_drawer_shifts_ingest_highwater')),
  },
  {
    migrationId: '037_addresses',
    label:
      'addresses + sweed_customer_addresses + sweed_orders.delivery_address_id / invoice_get_status — reusable postal-address + Census-geocode persistence layer that backs the Sweed per-invoice + per-customer address enrichment epic (FreshlyBakedNYC/automation#25). Without this the delivery-address enrichment job (A4) and customer-of-record enrichment job (A5) cannot start, and `customers.origin_map` / `delivery.order_count_by_zone` continue to render the `other` catch-all.',
    check: async (db) =>
      (await tableExists(db, 'addresses')) &&
      (await tableExists(db, 'sweed_customer_addresses')) &&
      (await columnExists(db, 'sweed_orders', 'delivery_address_id')) &&
      (await columnExists(db, 'sweed_orders', 'invoice_get_status')),
  },
  {
    // visitor_scans + indices — Customer / Visitor Address Ingestion
    // (virusdave/top-level#9 child FreshlyBakedNYC/automation#31, A1).
    // Without this the webhook handlers at POST /wh/{bx,mh}/veriscan/checkin
    // and the helios visitor-scans-backfill CLI both fail at the insert
    // step, and the /admin/visitors/scans operator page renders empty
    // forever.
    migrationId: '039_visitor_scans',
    label:
      'visitor_scans table + (provider, hash_id) idempotency unique + scanned_at / site / postal / state indices — backs the VeriScan webhook handler at POST /wh/{bx,mh}/veriscan/checkin, the helios visitor-scans-backfill CLI, and the /admin/visitors/scans operator page (FreshlyBakedNYC/automation#31, virusdave/top-level#9).',
    check: (db) => tableExists(db, 'visitor_scans'),
  },
  {
    // Covering indexes for the /metrics/budtenders endpoint
    // (virusdave/top-level#7). Without these the per-cashier
    // aggregate CTE in /api/budtender-analytics falls back to
    // heap-fetching every order row — visibly slow at the
    // 90-day default window. Sentinel checks the covering
    // (dealer_id, cashier_user_id, pay_time) index by name.
    migrationId: '040_budtender_perf_indexes',
    label:
      'sweed_orders_budtender_* + sweed_drawer_shift_sessions_user_join_cover_idx covering indexes — keep the /metrics/budtenders endpoint snappy under default 90-day windows.',
    check: async (db) =>
      indexExists(db, 'sweed_orders_budtender_cashier_range_cover_idx'),
  },
  {
    // pending_purchase_rows.edited_structured_fields (FreshlyBakedNYC/automation#35).
    // Without this column the PATCH /api/catalog/pending-purchases/:rowId
    // endpoint can't persist the new editable-taxonomy overrides
    // (targetBrand / targetGroupName / expectedCategory /
    // expectedSubcategory / targetSize / targetPackCount /
    // targetVariantName / targetVariantTab / targetStrainName), and
    // applyPendingPurchaseRequestJob keeps writing the parser's
    // misclassified taxonomy to Sweed even after the reviewer fixes
    // it inline.
    migrationId: '041_pending_purchase_edited_structured_fields',
    label:
      'pending_purchase_rows.edited_structured_fields (JSONB) — reviewer ' +
      'overrides for LLM/parser-misclassified taxonomy on pending-purchase ' +
      'rows; consumed by the apply worker\'s effectiveStructuredFields ' +
      'helper. See issue #35.',
    check: (db) => columnExists(db, 'pending_purchase_rows', 'edited_structured_fields'),
  },
  {
    // visitor_scans.address_id (FK -> addresses.id) plus a partial
    // reverse index. Without this column the customer-origin map's
    // server query (customersMapQueries.ts) can't pull the real
    // geocoded customer-home lat/lng — it falls back to plotting
    // every dot at the store. See chat thread that landed the
    // backfill-visitor-scan-geocodes.ts script.
    migrationId: '042_visitor_scan_address_link',
    label:
      'visitor_scans.address_id (FK → addresses.id) + reverse index — wires ' +
      'each scan into the shared Census-geocoder pipeline so the customer-origin ' +
      'map can plot real customer-home coords instead of the scanner-location ' +
      'data we were mistakenly treating as document coords.',
    check: (db) => columnExists(db, 'visitor_scans', 'address_id'),
  },
  {
    // Customer Value analytics covering index on sweed_orders for the
    // per-customer ROW_NUMBER() partition. Without this, the LTV
    // CTEs do a sequential heap scan over every known-customer order.
    migrationId: '043_customer_value_perf_indexes',
    label:
      'sweed_orders_dealer_customer_pay_invoice_idx — covering index for ' +
      'the /metrics/customer-value endpoint\'s per-customer purchase-ordinal ' +
      'window function.',
    check: (db) => indexExists(db, 'sweed_orders_dealer_customer_pay_invoice_idx'),
  },
  {
    // Google Ads -> landing-page observations for mostly-static-sites.
    // This table intentionally stores the evidence/performance scope
    // alongside each signal because Ads Editor exports do not always
    // include ad/final-URL-level metrics. Consumers must not treat
    // campaign-level context as landing-page conversion proof.
    migrationId: '044_landingpage_ad_outcomes',
    label:
      'landingpage_ad_outcomes table — source-scoped Google Ads policy / ' +
      'landing-page observations for MSS landing-page evolution jobs.',
    check: (db) => tableExists(db, 'landingpage_ad_outcomes'),
  },
  {
    // Per-user metric subpage grants. The auth path reads
    // users.metric_grants on every session build; without this
    // column every authenticated request 500s on `select … from
    // users` and the SPA can't log anyone in.
    migrationId: '045_user_metric_grants',
    label:
      'users.metric_grants (text[]) + users_metric_grants_gin_idx — ' +
      'per-user grants for individual Metrics → subpages (Explore, ' +
      'Brands, Distributors, Staff, Reordering). Admins implicitly ' +
      'hold every grant; non-admin operators see only what is stored ' +
      'here. Without this column, session build fails and ' +
      '/api/users + /api/catalog-analytics + /api/budtender-analytics ' +
      'reject every request.',
    check: (db) => columnExists(db, 'users', 'metric_grants'),
  },
  {
    // Real Sweed POs (sweed_purchases + sweed_purchase_line_items +
    // sweed_purchases_ingest_state) backing the Catalog →
    // Purchase Sell-Through page family. Distinct from
    // pending_purchase_* (which is the proposal/catalog-enrichment
    // workflow): these tables mirror actual completed POs so we can
    // join purchase line items to sweed_orders.raw_json.items[] for
    // per-line sell-through math.
    migrationId: '046_sweed_purchases',
    label:
      'sweed_purchases + sweed_purchase_line_items + ' +
      'sweed_purchases_ingest_state — real Sweed PO mirror backing ' +
      'Catalog → Purchase Sell-Through page family.',
    check: (db) => tableExists(db, 'sweed_purchases'),
  },
  {
    migrationId: '048_sweed_order_items_flat',
    label:
      'sweed_order_items_flat — materialised expansion of ' +
      "sweed_orders.raw_json->'items'. Without this Catalog → " +
      'Purchase Sell-Through queries fall back to a per-request ' +
      'jsonb_array_elements lateral that takes 15-50s and times out ' +
      'the page.',
    check: (db) => tableExists(db, 'sweed_order_items_flat'),
  },
  {
    // Phase D1 (step 1) of the Helios DB-cost epic
    // (virusdave/top-level#11). Migration 060 enriches
    // sweed_order_items_flat with typed product_id /
    // product_category_name columns (backfilled from raw_item and
    // populated by the ingest job going forward) so the
    // catalog-analytics / metrics readers can stop unrolling
    // sweed_orders.raw_json->'items' at request time.
    migrationId: '060_sweed_order_items_flat_typed_columns',
    label:
      'sweed_order_items_flat — typed product_id / ' +
      'product_category_name columns (DB-cost epic phase D1).',
    check: (db) => columnExists(db, 'sweed_order_items_flat', 'product_id'),
  },
  {
    // Phase F5 of the Helios DB-cost epic (virusdave/top-level#11).
    // Migration 062 drops the NOT NULL constraint on
    // sweed_orders.raw_json so the drain worker
    // (config.workers.sweed_orders_raw_json_drain) can null it for
    // orders older than 30 days. The sentinel is true once the column
    // is nullable.
    migrationId: '062_sweed_orders_raw_json_drop_not_null',
    label:
      'sweed_orders.raw_json is nullable (DB-cost epic phase F5) — ' +
      'required before the raw_json drain worker can run.',
    check: async (db) => {
      const result = await db.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
          where table_name = 'sweed_orders' and column_name = 'raw_json'`,
      )
      return result.rows[0]?.is_nullable === 'YES'
    },
  },
  {
    // Phase F2 of the Helios DB-cost epic (virusdave/top-level#11).
    // Migration 064 drops four operator backup / pre-migration
    // snapshot tables (~52 MB) after a verified off-box pg_dump. The
    // sentinel is true once all four are gone.
    migrationId: '064_drop_operator_backup_tables',
    label:
      'operator backup/snapshot tables dropped (DB-cost epic phase F2) — ' +
      'pos_payment_matches_* / payment_transactions_* one-off backups removed.',
    check: async (db) => {
      const present = await Promise.all([
        tableExists(db, 'pos_payment_matches_backup_20260303'),
        tableExists(db, 'pos_payment_matches_snapshot_20260310_pre_remainder_backfill'),
        tableExists(db, 'payment_transactions_snapshot_20260310_pre_remainder_backfill'),
        tableExists(db, 'payment_transactions_snapshot_20260310_overpayment_fix'),
      ])
      return present.every((exists) => !exists)
    },
  },
  {
    // Phase F3 of the Helios DB-cost epic (virusdave/top-level#11).
    // Migration 065 adds litalerts_products.image_url and drops the
    // NOT NULL constraint on raw_config_json / raw_product_json so the
    // drain worker (config.workers.litalerts_products_raw_json_drain)
    // can null those redundant blobs for observations older than 7
    // days. The pricing-cache reader + steady-state ingest now read
    // /write the typed columns (incl. image_url) instead of the raw
    // JSON. The sentinel is true once the image_url column exists.
    migrationId: '065_litalerts_products_drop_raw_not_null',
    label:
      'litalerts_products.image_url added + raw_config_json / ' +
      'raw_product_json nullable (DB-cost epic phase F3) — required ' +
      'before the litalerts raw_json drain worker can run.',
    check: (db) => columnExists(db, 'litalerts_products', 'image_url'),
  },
  {
    // Phase F4 of the Helios DB-cost epic (virusdave/top-level#11).
    // Migration 066 adds the fuzzy_skus_created_at_idx btree so the
    // retention worker (config.workers.fuzzy_skus_retention) can find
    // the oldest rows past the cutoff via an index range scan instead
    // of a multi-second full seq scan of the ~1.67 GB table on every
    // tick. The sentinel is true once the index exists.
    migrationId: '066_fuzzy_skus_created_at_idx',
    label:
      'fuzzy_skus_created_at_idx created (DB-cost epic phase F4) — ' +
      'required before the fuzzy_skus retention worker can run cheaply.',
    check: (db) => indexExists(db, 'fuzzy_skus_created_at_idx'),
  },
  {
    // Phase C1 of the Helios DB-cost epic (virusdave/top-level#11):
    // convert parsekit_reverse_shadow_events to a Timescale
    // hypertable as a low-risk validator for the conversion pattern
    // (tiny table, no FKs, no triggers). The sentinel asks Timescale
    // whether the table is a hypertable; if it isn't, the operator
    // needs to apply 050.
    migrationId: '050_parsekit_reverse_shadow_events_hypertable',
    label:
      'parsekit_reverse_shadow_events — Timescale hypertable ' +
      'conversion (DB-cost epic phase C1, no app-visible behaviour ' +
      'change).',
    check: (db) => hypertableExists(db, 'parsekit_reverse_shadow_events'),
  },
  {
    // Phase C1 of the Helios DB-cost epic (virusdave/top-level#11):
    // convert sweed_auth_events to a Timescale hypertable. This is
    // the first real-volume conversion in the cost-reduction work
    // (~167k rows / 81 MB at apply time). The Sweed-auth worker
    // pipeline appends to this table; no live customer scan/checkin
    // path reads or writes it.
    migrationId: '051_sweed_auth_events_hypertable',
    label:
      'sweed_auth_events — Timescale hypertable conversion ' +
      '(DB-cost epic phase C1, no app-visible behaviour change).',
    check: (db) => hypertableExists(db, 'sweed_auth_events'),
  },
  {
    // Pre-conversion prep for the C1 hypertable conversion of
    // litalerts_competitor_observations (virusdave/top-level#11,
    // phase C1). Adds (a) the partial latest-succeeded index that
    // the rolling scheduler + refresh job will rely on after
    // conversion, and (b) re-runs the freshness view to surface
    // `next_refresh_at` so the scheduler stops joining back to
    // the base table by `id` alone. The sentinel checks the
    // index because indexExists is cheap; the view rename change
    // ships in the same commit as the schedulers that consume it.
    migrationId: '054_litalerts_competitor_observations_c1_prep',
    label:
      'litalerts_competitor_observations C1 prep — partial latest-' +
      "succeeded index + freshness view exposes next_refresh_at " +
      '(DB-cost epic phase C1 prep).',
    check: (db) =>
      indexExists(db, 'litalerts_competitor_observations_latest_succeeded_idx'),
  },
  {
    // Phase C1 of the Helios DB-cost epic (virusdave/top-level#11).
    // Migration 055 converts litalerts_competitor_observations to
    // a Timescale hypertable on `captured_at` with 14-day chunks.
    // Prep landed in 054. No app-visible behaviour change beyond
    // the planner picking ChunkAppend over per-chunk indexes for
    // recency queries; UPDATEs already use the chunk-aware
    // (id, captured_at) shape after the 054 scheduler change.
    migrationId: '055_litalerts_competitor_observations_hypertable',
    label:
      'litalerts_competitor_observations — Timescale hypertable ' +
      'conversion (DB-cost epic phase C1, no app-visible behaviour ' +
      'change).',
    check: (db) => hypertableExists(db, 'litalerts_competitor_observations'),
  },
  {
    // Phase C2 of the Helios DB-cost epic (virusdave/top-level#11).
    // Migration 056 enables Timescale compression on
    // `sweed_auth_events` with segmentby = outcome and a 30-day
    // `compress_after` policy aligned with the observed job_queue
    // retention horizon (so ON DELETE SET NULL from job_queue
    // rarely targets a compressed chunk). The sentinel only
    // observes that compression is configured on the hypertable;
    // it does not require any chunks to have been compressed yet
    // (the background policy job handles that lazily).
    migrationId: '056_sweed_auth_events_compression',
    label:
      'sweed_auth_events — enable Timescale compression ' +
      '(segmentby=outcome, compress_after=30d, DB-cost epic phase C2).',
    check: (db) => hypertableCompressionEnabled(db, 'sweed_auth_events'),
  },
  {
    // Phase C2 of the Helios DB-cost epic (virusdave/top-level#11).
    // Migration 057 enables Timescale compression on
    // `litalerts_competitor_observations`. segmentby = status,
    // orderby = (product_id, captured_at DESC, id DESC),
    // compress_after = 60 days — comfortably larger than the
    // worst-case "latest succeeded observation" age (~30 days)
    // so the rolling scheduler's UPDATE of next_refresh_at never
    // hits a compressed chunk.
    migrationId: '057_litalerts_competitor_observations_compression',
    label:
      'litalerts_competitor_observations — enable Timescale ' +
      'compression (segmentby=status, compress_after=60d, ' +
      'DB-cost epic phase C2).',
    check: (db) =>
      hypertableCompressionEnabled(db, 'litalerts_competitor_observations'),
  },
  {
    // Phase C3 of the Helios DB-cost epic (virusdave/top-level#11).
    // Migration 058 lowers the litalerts_competitor_observations
    // compression policy threshold from compress_after=60d (set in
    // 057) down to 45d, so the growing uncompressed evidence_json
    // window is bounded while staying clear of the rolling
    // scheduler's mutable latest-row window (max observed age ~30d).
    // The sentinel inspects the policy's compress_after value, not
    // just "compression enabled", because the latter is already true.
    migrationId: '058_litalerts_competitor_observations_compress_after_45d',
    label:
      'litalerts_competitor_observations — lower compression ' +
      'compress_after 60d→45d (DB-cost epic phase C3).',
    check: (db) =>
      compressionPolicyCompressAfterIs(
        db,
        'litalerts_competitor_observations',
        '45 days',
      ),
  },
  {
    // Phase F1 of the Helios DB-cost epic (virusdave/top-level#11).
    // Migration 052 TRUNCATEs the historical 15 GB / 32M-row
    // backlog of `catalog_taxonomy_snapshot_rows`; the new in-job
    // TTL prune in `configWorkersCatalogRefreshJob` keeps the
    // table bounded going forward (default 24 h retention).
    //
    // "Migration applied" is observationally identical to "the
    // new TTL prune has run a few times": both leave the table
    // free of rows whose parent snapshot is older than the
    // retention window. The sentinel asserts that invariant
    // directly: `pass` iff no surviving row references a snapshot
    // older than 48 h (the 24 h target plus 24 h of grace, since
    // the prune only runs when a refresh succeeds). If the
    // operator deploys the new code but never applies migration
    // 052 against a database that still has the historical
    // backlog, the sentinel sees rows referencing snapshots
    // weeks old and surfaces the pending banner. Once the
    // TRUNCATE (or enough in-job prunes) has caught up, the
    // sentinel goes quiet.
    migrationId: '052_catalog_taxonomy_snapshot_rows_truncate',
    label:
      'catalog_taxonomy_snapshot_rows — one-shot historical ' +
      'TRUNCATE (DB-cost epic phase F1; pairs with the new in-job ' +
      'TTL prune to drop a 15 GB write-only audit backlog).',
    check: async (db) => {
      // Drive the existence check from the small snapshots table, not the
      // ~1M-row rows table. The naive `rows JOIN snapshots WHERE started_at<48h`
      // form forces a full seq scan of catalog_taxonomy_snapshot_rows every
      // time the sentinel runs (~per minute via the pending-migrations banner):
      // ~470ms / ~88k buffers just to confirm "none old". Flipping to a
      // snapshots-first semijoin probes the rows PK (snapshot_id leading) per
      // old snapshot and short-circuits on the first hit via LIMIT 1 — ~8ms /
      // index-only scans, identical boolean result. (DB-cost epic follow-up.)
      const result = await db.query<{ ok: boolean }>(
        `select not exists(
           select 1
           from catalog_taxonomy_snapshots s
           where s.started_at < now() - interval '48 hours'
             and exists (
               select 1
               from catalog_taxonomy_snapshot_rows r
               where r.snapshot_id = s.id
             )
           limit 1
         ) as ok`,
      )
      return result.rows[0]?.ok === true
    },
  },
  {
    // Phase D2 of the cashier-tablet / check-ins enrichment epic
    // (virusdave/top-level#12, FreshlyBakedNYC/automation#40).
    // Covers the per-row "favorite category" / "favorite product"
    // subquery on /admin/customers/check-ins and its cashier-tablet
    // twin so we don't re-sort every snapshot version per inventory
    // item per request. Without this index the list page still
    // works, but each request burns the snapshot history for every
    // line item of every visible customer.
    migrationId: '053_sweed_package_snapshots_dealer_item_observed_idx',
    label:
      'sweed_package_snapshots_dealer_item_observed_max_idx — covering ' +
      'index for the /admin/customers/check-ins favorite-category / ' +
      'favorite-product lateral subquery (DB-cost hard requirement, ' +
      'D2 of #12 / #40).',
    check: (db) =>
      indexExists(db, 'sweed_package_snapshots_dealer_item_observed_max_idx'),
  },
  {
    // Sweed marketing-segment caches for the customer/check-in
    // details page segment surface (virusdave/top-level#12,
    // FreshlyBakedNYC/automation#40). Without these tables the
    // details endpoint's segment read fails and the link worker's
    // best-effort segment refresh has nowhere to write. The
    // sentinel checks the per-customer membership cache table; the
    // sibling catalog/refresh tables ship in the same migration.
    migrationId: '059_sweed_customer_segments',
    label:
      'sweed_customer_segments (+ _refresh, sweed_marketing_segments, ' +
      '_refresh) — cache tables backing the customer-details Sweed ' +
      'segment-membership display + "add to static segment" picker.',
    check: (db) => tableExists(db, 'sweed_customer_segments'),
  },
  {
    // Distributor-keyed brand aliases for the pending-purchase parser.
    // Migration 063 widens the pending_purchase_brand_aliases.alias_type
    // CHECK to allow 'distributor' (plus a partial unique index). The
    // generation worker pins a brand deterministically when a row's
    // distributor matches an active 'distributor' alias; without the
    // widened CHECK, inserting/seeding such an alias fails and the
    // worker's distributor-override lookup never matches.
    migrationId: '063_pending_purchase_distributor_brand_alias',
    label:
      "pending_purchase_brand_aliases.alias_type accepts 'distributor' " +
      '— distributor-keyed brand pinning for catalog/pending-purchases.',
    check: async (db) => {
      const result = await db.query<{ ok: boolean }>(
        `select pg_get_constraintdef(oid) like '%distributor%' as ok
           from pg_constraint
          where conrelid = 'pending_purchase_brand_aliases'::regclass
            and conname = 'pending_purchase_brand_aliases_alias_type_check'`,
      )
      return result.rows[0]?.ok === true
    },
  },
  {
    migrationId: '067_warehouse_location_assignments',
    label:
      'warehouse_location_assignments table created — required by the ' +
      'catalog/warehouse-locations packing page (location <-> package codes).',
    check: (db) => tableExists(db, 'warehouse_location_assignments'),
  },
  {
    migrationId: '068_warehouse_location_one_to_many',
    label:
      'warehouse_location_assignments: dropped the (dealer, location) primary ' +
      'key so a location can hold many packages (1-to-many); added the ' +
      '(dealer, location) lookup index.',
    check: (db) => indexExists(db, 'warehouse_location_assignments_dealer_location_idx'),
  },
  {
    migrationId: '069_app_settings',
    label:
      'app_settings key/value table — required by the /metrics page-wide ' +
      'view defaults (admin "Update defaults" / "Reset defaults").',
    check: (db) => tableExists(db, 'app_settings'),
  },
  {
    migrationId: '070_lp_events',
    label:
      'lp_events sink — required by the unified-landing-engine event ' +
      'ingest (POST /v1/lp-events/batch). Without it the ingest route ' +
      '503s and the mostly-static-sites runtime spools events locally.',
    check: (db) => tableExists(db, 'lp_events'),
  },
  {
    migrationId: '071_seo_faq_control_plane',
    label:
      'SEO FAQ control plane (seo_approvals + seo_faq_sets) — required by ' +
      'the /api/seo/faq-sets control plane and the approved-FAQ bundle ' +
      'loader. Without it the FAQ authoring/approval pages 500.',
    check: async (db) => {
      const [hasApprovals, hasFaqSets] = await Promise.all([
        tableExists(db, 'seo_approvals'),
        tableExists(db, 'seo_faq_sets'),
      ])
      return hasApprovals && hasFaqSets
    },
  },
  {
    migrationId: '072_seo_post_control_plane',
    label:
      'SEO auto-blog control plane (seo_posts + post approvals) — required ' +
      'by the /api/seo/posts control plane and the approved-post bundle ' +
      'loader. Without it the post authoring/approval pages 500.',
    check: (db) => tableExists(db, 'seo_posts'),
  },
  {
    migrationId: '073_seo_post_scheduling',
    label:
      'SEO auto-blog scheduling (seo_posts.scheduled_publish_at) — required ' +
      'by the post /schedule route and the schedule-gated bundle loader. ' +
      'Without it scheduling a post 500s.',
    check: (db) => columnExists(db, 'seo_posts', 'scheduled_publish_at'),
  },
  {
    migrationId: '074_seo_image_asset_control_plane',
    label:
      'SEO image-asset control plane (seo_image_assets + image approvals) — ' +
      'required by the /api/seo/image-assets control plane and the ' +
      'approved-asset bundle loader. Without it the image authoring/approval ' +
      'pages 500.',
    check: (db) => tableExists(db, 'seo_image_assets'),
  },
  {
    migrationId: '075_seo_posts_list_index',
    label:
      'SEO posts list index (updated_at desc, id desc) — backs the lean, ' +
      'paginated /api/seo/posts list. Without it the list still works but ' +
      'sorts the whole table per request.',
    check: (db) => indexExists(db, 'seo_posts_updated_at_id_desc_idx'),
  },
  {
    migrationId: '076_seo_ga_gsc_imports',
    label:
      'SEO GA4/GSC metric import (seo_metric_import_batches + seo_gsc_daily ' +
      '+ seo_ga4_daily) — required by the batch metric importer and the ' +
      'feedback-loop aggregation queries. Without it the import CLI 500s.',
    check: (db) => tableExists(db, 'seo_gsc_daily'),
  },
  {
    migrationId: '077_seo_recommendations',
    label:
      'SEO recommendation engine (seo_recommendations) — required by the ' +
      'GA4/GSC feedback-loop recommendation generate/list/accept/dismiss ' +
      'routes. Without it the recommendations page 500s.',
    check: (db) => tableExists(db, 'seo_recommendations'),
  },
  {
    migrationId: '078_catalog_group_products',
    label:
      'Catalog per-product live-state projection (catalog_group_products) — ' +
      'required by the family-grouped review queue (Phase B): the narrow ' +
      'family-page query reads product size from this table to group/sort ' +
      'by size without cracking live_state_json. Without it the ' +
      '/catalog/review queue 500s.',
    check: (db) => tableExists(db, 'catalog_group_products'),
  },
  {
    migrationId: '079_geo_segment_rules',
    label:
      'Geographic (scan-location-based) segment-assignment engine ' +
      '(geo_segment_rules + geo_segment_rule_applications) — required by ' +
      'the on-scan geo-segment eval job (config.workers.geo_segment_rule_eval) ' +
      'and its enqueue hooks in the visitor-scan link / address-enrich ' +
      'workers. Without it those best-effort enqueues + the eval handler ' +
      'error on the missing tables (caught/logged, but no assignments happen).',
    check: (db) => tableExists(db, 'geo_segment_rules'),
  },
  {
    migrationId: '080_sweed_customer_segments_segment_idx',
    label:
      'sweed_customer_segments(segment_id, sweed_customer_id) index — backs ' +
      'the per-segment bulk membership diff/delete (snapshotSegmentMembers). ' +
      'Without it that DELETE/diff WHERE segment_id seq-scans the whole table, ' +
      'so bulk population is O(segments × table size). Code still works ' +
      'without it, just slower as the table grows.',
    check: (db) => indexExists(db, 'sweed_customer_segments_segment_customer_idx'),
  },
  {
    migrationId: '080_geo_segment_rules_predicates',
    label:
      'Composable predicate AST for the geo-segment engine ' +
      '(geo_segment_rules.predicate_json + relaxed geofence columns) — ' +
      'required by the on-scan evaluator and the rule builder, which read/' +
      'write the AST. Without it those reads error on the missing column ' +
      '(caught/logged, but no composable rules can be authored or matched).',
    check: (db) => columnExists(db, 'geo_segment_rules', 'predicate_json'),
  },
  {
    migrationId: '081_sweed_segment_membership_refresh',
    label:
      'Per-segment membership-refresh highwater (sweed_segment_membership_refresh) ' +
      '— backs the "Refresh membership cache" button + truthful last-refreshed ' +
      'line on the Helios segment details page. Without it that page 503s on ' +
      'refresh and shows a fallback last-refreshed time.',
    check: (db) => tableExists(db, 'sweed_segment_membership_refresh'),
  },
  {
    migrationId: '082_reword_geo_rule_seed_note',
    label:
      'Reword the seeded Bronx geo-rule note (drop the "Seeded with migration ' +
      '079." provenance drivel shown to operators). Cosmetic; no code depends ' +
      'on it.',
    check: async (db) => {
      const res = await db.query<{ stale: boolean }>(
        `select exists(
           select 1 from geo_segment_rules where note like '%Seeded with migration 079.%'
         ) as stale`,
      )
      return res.rows[0]?.stale !== true
    },
  },
  {
    migrationId: '083_seo_faq_source_key',
    label:
      'FBUS FAQ source-key persistence (seo_faq_sets.source_key) — lets the ' +
      'IRONCLAD approval gate identify FBUS (.us) sanitized-mode sets and ' +
      'hold them to the STRICTER FBUS denylist (CI gate 2). Without it, ' +
      'FBUS sets fall back to the host-agnostic raw-only check.',
    // Require BOTH the column and its grammar check constraint, so a
    // partial/manual schema (column present, constraint missing) is not
    // reported as applied.
    check: async (db) => {
      const [hasColumn, hasConstraint] = await Promise.all([
        columnExists(db, 'seo_faq_sets', 'source_key'),
        constraintExists(db, 'seo_faq_sets', 'seo_faq_sets_source_key_check'),
      ])
      return hasColumn && hasConstraint
    },
  },
  {
    migrationId: '084_sweed_order_items_flat_product_id_backfill',
    label:
      'Backfill sweed_order_items_flat.product_id from raw_item for ' +
      'historical rows (migration 060 added the column but the one-time ' +
      'backfill did not stick — ~459/62.7k rows were typed). The CRM ' +
      'Segment Analysis subcategory-affinity cut maps order lines to ' +
      'catalog_groups.subcategory_name via catalog_group_products(product_id) ' +
      'and needs the typed column on the hot read path.',
    // Applied iff no rows remain with a null typed product_id while
    // raw_item carries a numeric product id (the backfill predicate).
    check: async (db) => {
      const res = await db.query<{ pending: boolean }>(
        `select exists(
           select 1 from sweed_order_items_flat
            where product_id is null
              and nullif(raw_item #>> '{product,id}', '') ~ '^\\d+$'
            limit 1
         ) as pending`,
      )
      return res.rows[0]?.pending !== true
    },
  },
  {
    migrationId: '085_analytics_invoice_margin_facts',
    label:
      'Invoice-grain margin rollup (analytics_invoice_margin_facts) that ' +
      'precomputes per-line COGS once so CRM Segment Analysis can show ' +
      'margin/customer + gross-margin% via a trivial PK join instead of ' +
      'the ~333ms-per-call cost function on the read path. Kept fresh by ' +
      'the order-ingest job; backfilled by the migration.',
    check: (db) => tableExists(db, 'analytics_invoice_margin_facts'),
  },
  {
    migrationId: '086_seed_bronx_review_settings',
    label:
      'Bronx (dealer 210249) site_review_settings launch row, required so ' +
      'the public /go/bx/review page works end to end. Without it, POST ' +
      '/v1/reviews/submit returns 404 ("Unknown site dealer_id") for every ' +
      'Bronx submission. Apply this BEFORE flipping the mostly-static-sites ' +
      'bx.reviewPageEnabled flag (two-phase rollout).',
    // Pass only when the Bronx row is actually launch-ready: it exists,
    // is a google provider pointing at the operator-supplied URL, has
    // the two behavioral flags on (drawing + LLM gate, matching live
    // Midtown), and carries the two Bronx Sweed segment ids.
    // Intentionally does NOT assert review_free_preroll_enabled (a no-op
    // flag the route logic never reads; mirrors Midtown's false) nor the
    // exact email addresses, so operator edits to either don't re-trip
    // the banner.
    check: async (db) => {
      const result = await db.query<{ ok: boolean }>(
        `select exists(
           select 1 from site_review_settings
            where dealer_id = 210249
              and review_provider_kind = 'google'
              and review_provider_url_template = 'https://g.page/r/CVvrYxFQkCZDEAE/review'
              and review_drawing_enabled = true
              and review_llm_gate_enabled = true
              and sweed_drawing_segment_id = 10291
              and sweed_free_preroll_segment_id = 10292
         ) as ok`,
      )
      return result.rows[0]?.ok === true
    },
  },
  {
    migrationId: '087_gads_lp_rollup',
    label:
      'GAds landing-pages rollup (gads_lp_rollup + gads_lp_rollup_refresh_state) ' +
      'recomputed hourly by the config.workers.gads_lp_rollup_refresh worker from ' +
      'the append-only lp_events sink. The GAds → Landing pages analytics surface ' +
      '(automation#47) reads only this rollup; without it the refresh job fails and ' +
      'the dashboard renders no data.',
    // Probe BOTH tables and the grain unique index so a partial apply
    // (e.g. the first table created but a later statement failed — the
    // migration is not wrapped in one transaction) is reported pending
    // rather than silently "applied". Re-running the idempotent
    // migration completes the missing objects.
    check: async (db) => {
      const [hasRollup, hasState, hasGrainIndex] = await Promise.all([
        tableExists(db, 'gads_lp_rollup'),
        tableExists(db, 'gads_lp_rollup_refresh_state'),
        indexExists(db, 'gads_lp_rollup_grain_idx'),
      ])
      return hasRollup && hasState && hasGrainIndex
    },
  },
  {
    migrationId: '088_gads_lp_rollup_dq',
    label:
      'GAds landing-pages rollup data-quality counters (assignments_missing_id, ' +
      'unattributed_stage_events on gads_lp_rollup_refresh_state). The refresh job ' +
      'records them so the serving endpoint (automation#47 P3) can surface data ' +
      'quality WITHOUT scanning lp_events; without these columns the refresh ' +
      "update fails and the dashboard's data-quality figures stay zero.",
    check: async (db) => {
      const [hasMissingId, hasUnattributed] = await Promise.all([
        columnExists(db, 'gads_lp_rollup_refresh_state', 'assignments_missing_id'),
        columnExists(db, 'gads_lp_rollup_refresh_state', 'unattributed_stage_events'),
      ])
      return hasMissingId && hasUnattributed
    },
  },
  {
    migrationId: '089_sweed_marketing_segment_retirement',
    label:
      'Helios-local marketing-segment retirement (sweed_marketing_segment_retirement) — ' +
      'backs the /config/marketing/segments directory + details "Retire" control that ' +
      'semi-permanently hides test/junk Sweed segments from every Helios surface. Without ' +
      'it the directory list and the retire/unretire endpoints 503 and the segment-listing ' +
      'queries cannot anti-join the retirement set.',
    check: async (db) => {
      const [hasTable, hasRetiredAt] = await Promise.all([
        tableExists(db, 'sweed_marketing_segment_retirement'),
        columnExists(db, 'sweed_marketing_segment_retirement', 'retired_at'),
      ])
      return hasTable && hasRetiredAt
    },
  },
  {
    migrationId: '090_job_queue_scope_lookup_reindex',
    label:
      'Re-key the job_queue scope-lookup index: create the immutable-keyed ' +
      'job_queue_scope_created_at_idx (scope_entity_type, scope_entity_id, ' +
      'created_at desc, id desc) that serves the scheduling-run debug query ' +
      'as a pure seek, and drop the mis-keyed, write-amplifying original ' +
      'job_queue_scope_status_run_at_idx (led with module_code, included ' +
      'mutable status/run_at). End state: replacement present, original gone.',
    // Applied iff the re-keyed index exists, is VALID/READY, AND the old
    // one is gone. validIndexExists guards against a cancelled CREATE
    // INDEX CONCURRENTLY leaving an invalid same-name index that a
    // retry would then skip; a partial run (new created, old not yet
    // dropped) is also not reported done.
    check: async (db) => {
      const [hasNew, hasOld] = await Promise.all([
        validIndexExists(db, 'job_queue_scope_created_at_idx'),
        indexExists(db, 'job_queue_scope_status_run_at_idx'),
      ])
      return hasNew && !hasOld
    },
  },
  {
    migrationId: '091_seo_source_items',
    label:
      'SEO auto-blog source ingestion (seo_source_allowlist + seo_source_items) ' +
      '— required by the /api/seo/source-allowlist + /api/seo/source-items ' +
      'control plane (parent EPIC §7.1 source intake, #44 P4). Without it the ' +
      'source-allowlist + source-item routes 500.',
    // Probe the live END-STATE the routes depend on, not just table
    // existence: a partial/drifted apply (tables present but the dedup
    // unique constraint, FK, or list indexes missing) would break ingest
    // (`on conflict (dedup_hash)`) or the FK gate, so report it pending.
    check: async (db) => {
      const checks = await Promise.all([
        tableExists(db, 'seo_source_allowlist'),
        tableExists(db, 'seo_source_items'),
        columnExists(db, 'seo_source_items', 'dedup_hash'),
        columnExists(db, 'seo_source_items', 'status'),
        // Inline `unique` constraints + the FK Postgres auto-names.
        constraintExists(db, 'seo_source_allowlist', 'seo_source_allowlist_source_key_key'),
        constraintExists(db, 'seo_source_items', 'seo_source_items_dedup_hash_key'),
        constraintExists(db, 'seo_source_items', 'seo_source_items_source_key_fkey'),
        constraintExists(db, 'seo_source_items', 'seo_source_items_status_check'),
        indexExists(db, 'seo_source_items_status_idx'),
        indexExists(db, 'seo_source_items_source_key_idx'),
      ])
      return checks.every(Boolean)
    },
  },
  {
    migrationId: '092_seo_prompt_schedules',
    label:
      'SEO auto-blog prompt-schedule + topic-mix config (seo_prompt_schedules) ' +
      '— required by the /api/seo/prompt-schedules control plane (parent EPIC ' +
      '§7.2, #44 P4). Without it the prompt-schedule routes 500.',
    check: (db) => tableExists(db, 'seo_prompt_schedules'),
  },
  {
    migrationId: '093_gads_evolver_site_scope',
    label:
      'GAds evolver introspection per-attempt site scope (gads_ad_attempts.site ' +
      '+ landingpage_ad_outcomes.site) — derived bronx/midtown/null scope the ' +
      'per-site /metrics/gads-<site>/{evolution,iteration} pages (automation#51 ' +
      'P3+) filter on with a server-derived predicate. Without it the Evolution/' +
      'Iteration endpoints cannot scope per site and the write path insert fails ' +
      'on the missing column.',
    // Both columns are added by the one migration; probe both so a
    // partial apply (one ALTER ran, the other failed) reports pending.
    check: async (db) => {
      const [hasAttemptsSite, hasOutcomesSite] = await Promise.all([
        columnExists(db, 'gads_ad_attempts', 'site'),
        columnExists(db, 'landingpage_ad_outcomes', 'site'),
      ])
      return hasAttemptsSite && hasOutcomesSite
    },
  },
  {
    // Prospective pending-purchase classifier HINT BUNDLE storage
    // (pending_purchase_hint_bundles + pending_purchase_hint_documents,
    // child FreshlyBakedNYC/automation#54, task C2). Without these tables the
    // /api/catalog/pending-purchases/hint-bundles admin routes 500 and the
    // generate route's hintBundleId validation can't resolve a bundle.
    migrationId: '094_pending_purchase_hint_bundles',
    label:
      'pending_purchase_hint_bundles + pending_purchase_hint_documents — ' +
      'storage + admin API for the prospective classifier\'s untrusted hint ' +
      'material (v1 pasted text; bytes stored out-of-band, DB holds a pointer). ' +
      'Without it the hint-bundle routes 500 and generate can\'t validate a ' +
      'hintBundleId. See child #54 (C2).',
    // Both tables, the out-of-band POINTER columns, the C3-forward columns,
    // the dedup unique constraint, the FK, and both list indexes — so a
    // partial manual apply reports pending rather than "safe".
    check: async (db) => {
      const checks = await Promise.all([
        tableExists(db, 'pending_purchase_hint_bundles'),
        tableExists(db, 'pending_purchase_hint_documents'),
        columnExists(db, 'pending_purchase_hint_documents', 'content_sha256'),
        columnExists(db, 'pending_purchase_hint_documents', 'storage_backend'),
        columnExists(db, 'pending_purchase_hint_documents', 'storage_uri'),
        columnExists(db, 'pending_purchase_hint_documents', 'byte_size'),
        columnExists(db, 'pending_purchase_hint_documents', 'hint_intent'),
        columnExists(db, 'pending_purchase_hint_documents', 'extraction_status'),
        columnExists(db, 'pending_purchase_hint_documents', 'extraction_error'),
        columnExists(db, 'pending_purchase_hint_documents', 'extracted_facts'),
        constraintExists(
          db,
          'pending_purchase_hint_documents',
          'pending_purchase_hint_documents_bundle_content_sha256_key',
        ),
        constraintExists(
          db,
          'pending_purchase_hint_documents',
          'pending_purchase_hint_documents_bundle_id_fkey',
        ),
        indexExists(db, 'pending_purchase_hint_bundles_status_created_idx'),
        indexExists(db, 'pending_purchase_hint_documents_bundle_created_idx'),
      ])
      return checks.every(Boolean)
    },
  },
  {
    migrationId: '095_purchase_inventory_lifecycle',
    label:
      'Purchase inventory pricing-safety lifecycle L1 ' +
      '(purchase_inventory_lifecycle_runs / _items tables + the ' +
      "'purchase-lifecycle' enqueue_reason value on " +
      'pending_litalerts_refresh_queue) — backs the per-PO ' +
      'quarantine → market-refresh → reprice gates on the Catalog → ' +
      'Purchase detail page (automation#54). Without it the lifecycle ' +
      'routes error and the market-refresh enqueue violates the ' +
      'enqueue_reason check.',
    // Probe all three artifacts: a partial apply (e.g. the tables
    // landed but the constraint widening did not) must report pending.
    check: async (db) => {
      const [hasRuns, hasItems, enqueueReasonWidened] = await Promise.all([
        tableExists(db, 'purchase_inventory_lifecycle_runs'),
        tableExists(db, 'purchase_inventory_lifecycle_items'),
        db
          .query<{ widened: boolean }>(
            `select coalesce(
               pg_get_constraintdef(
                 (select oid from pg_constraint
                   where conname = 'pending_litalerts_refresh_queue_enqueue_reason_check')
               ) like '%purchase-lifecycle%',
               false
             ) as widened`,
          )
          .then((r) => r.rows[0]?.widened === true),
      ])
      return hasRuns && hasItems && enqueueReasonWidened
    },
  },
  {
    migrationId: '096_purchase_inventory_lifecycle_release',
    label:
      'Purchase inventory pricing-safety lifecycle L2 — gated RELEASE ' +
      '(widens the purchase_inventory_lifecycle_runs state CHECK to allow ' +
      "'release_in_progress' / 'released' and adds the release columns + " +
      'execution-lease fields on the runs/items tables). Backs the bulk ' +
      'quarantine-repair + reverse/release-to-FOR-SALE controls on the ' +
      'Catalog → Purchase detail page (automation#54, L2). Without it the ' +
      'release routes report releaseMigrationPending and refuse to record a ' +
      'release.',
    // Probe the widened state CHECK AND a representative release column on
    // each table, so a partial apply (constraint swapped but a column ALTER
    // failed, or vice versa) reports pending rather than "safe".
    check: async (db) => {
      const [stateWidened, hasRunRelease, hasItemRelease] = await Promise.all([
        db
          .query<{ widened: boolean }>(
            `select coalesce(
               pg_get_constraintdef(
                 (select oid from pg_constraint
                   where conname = 'purchase_inventory_lifecycle_runs_state_check')
               ) like '%release_in_progress%',
               false
             ) as widened`,
          )
          .then((r) => r.rows[0]?.widened === true),
        columnExists(db, 'purchase_inventory_lifecycle_runs', 'release_attempt_id'),
        columnExists(db, 'purchase_inventory_lifecycle_items', 'release_verified_at'),
      ])
      return stateWidened && hasRunRelease && hasItemRelease
    },
  },
  {
    migrationId: '097_litalerts_parse_feedback',
    label:
      'litalerts_parse_feedback table — INERT operator parse-correction feedback ' +
      'inbox for the brand-categorical-family market-match audit panel ' +
      '(automation#59, T3). Without it the /catalog family-explorer ' +
      'parse-feedback endpoints report the missing table (503) and the operator ' +
      'cannot save listing corrections / retailer naming conventions. Read only ' +
      'by that endpoint (+ the T5 promotion export) — nothing in the production ' +
      'scorer / market-match read path joins it, so it never affects matching, ' +
      'scoring, fuzzy_skus, market aggregates, or IQR.',
    // Probe the table AND a representative constraint + the two hot read indexes,
    // so a partial manual apply (table created but an index/constraint failed)
    // reports pending rather than "safe".
    check: async (db) => {
      const [hasTable, hasDetailsCheck, hasFuzzyIdx, hasRetailerIdx] = await Promise.all([
        tableExists(db, 'litalerts_parse_feedback'),
        constraintExists(
          db,
          'litalerts_parse_feedback',
          'litalerts_parse_feedback_details_object_ok',
        ),
        indexExists(db, 'litalerts_parse_feedback_fuzzy_idx'),
        indexExists(db, 'litalerts_parse_feedback_retailer_idx'),
      ])
      return hasTable && hasDetailsCheck && hasFuzzyIdx && hasRetailerIdx
    },
  },
  {
    migrationId: '098_litalerts_parse_feedback_promotion',
    label:
      'litalerts_parse_feedback promotion provenance (promoted_parser_id / ' +
      'promoted_rule_id / promoted_config_sha + coupling CHECK) — automation#59, ' +
      'T5. Without it the promotion export + the `promoted` status transition on ' +
      'the /catalog family-explorer parse-feedback endpoints report the missing ' +
      'columns (503). Provenance-only; nothing in the production scorer / ' +
      'market-match read path joins it.',
    // Probe the three columns AND the coupling constraint, so a partial manual
    // apply reports pending rather than "safe".
    check: async (db) => {
      const [hasParserId, hasRuleId, hasConfigSha, hasCheck] = await Promise.all([
        columnExists(db, 'litalerts_parse_feedback', 'promoted_parser_id'),
        columnExists(db, 'litalerts_parse_feedback', 'promoted_rule_id'),
        columnExists(db, 'litalerts_parse_feedback', 'promoted_config_sha'),
        constraintExists(
          db,
          'litalerts_parse_feedback',
          'litalerts_parse_feedback_promotion_meta_ok',
        ),
      ])
      return hasParserId && hasRuleId && hasConfigSha && hasCheck
    },
  },
  {
    migrationId: '099_migration_apply_attempts',
    label:
      'migration_apply_attempts lifecycle table (automation#62, leaf 2) — ' +
      'the audit/record table that backs the admin "Apply Now" pending-' +
      'migrations flow. Additive + admin-only; nothing in the production read ' +
      'path joins it. Bootstrapped via the manual/canon apply path (the ' +
      'feature cannot apply its own bootstrap).',
    check: (db) => tableExists(db, 'migration_apply_attempts'),
  },
  {
    // Issue #70 schema-only foundation for turn-based packet refinement. This
    // sentinel checks the durable root/turn tables plus representative packet
    // and row lineage fields and invariant indexes; later behavior leaves must
    // add their own sentinels if they require additional schema.
    migrationId: '102_pending_purchase_refinement_lineage',
    label:
      'pending_purchase_packet_roots + pending_purchase_refinement_turns and ' +
      'packet/row lineage columns — schema-only foundation for issue #70\'s ' +
      'turn-based pending-purchase packet refinement workflow. Adds current/' +
      'candidate revision metadata, stable row_lineage_id fields, row snapshot ' +
      'hash/provenance columns, and one-active-refinement-per-root indexes; no ' +
      'LLM/UI/apply behavior is enabled by this migration.',
    blessing: {
      ref: 'https://ampcode.com/threads/T-019f4a59-c436-7431-b37c-9b86e7355b74',
      reviewedSha: 'cc147f13a2c34902679f6ce656db10ac9ffd4755',
      artifactSha256: 'fb9c15eff6d26d78ed95fe9fb7dd8fd324d5f4d155986cafaa66e0b160564b4b',
      transactionMode: 'transactional',
      operatorExplanation:
        'This migration adds the durable lineage needed to refine a pending-purchase packet over multiple turns without losing its history. It creates root and refinement-turn tables, links packets and rows to stable lineage identifiers, records snapshot hashes and provenance, and adds indexes that allow only one active refinement per root. It also backfills the small existing packet and row population so old records participate in the same model. It does not enable any LLM, user-interface, or automatic apply behavior; it only adds the schema foundation those later changes require.',
      note:
        'Oracle-approved schema-only expand migration for pending-purchase refinement ' +
        'lineage; no includes and no CREATE INDEX CONCURRENTLY. Self-wrapped in ' +
        'begin/commit with 5s lock_timeout; small one-time backfills at reviewed ' +
        'prod scale (~70 packets/~945 rows). Down file is destructive and not part ' +
        'of admin apply.',
    },
    check: pendingPurchaseRefinementSchemaApplied,
  },
  {
    migrationId: '104_vendor_brand_associations',
    label:
      'vendors + vendor_brand_associations normalized purchasing directory ' +
      '(automation#79), including case-insensitive vendor/brand uniqueness ' +
      'and the at-most-one-primary-vendor rule.',
    blessing: {
      ref: 'https://ampcode.com/threads/T-019f77d2-749e-7558-a11d-186d0ad3ca69',
      reviewedSha: 'ecfe5087ea7f8566bcb87c8ea80844829b378252',
      artifactSha256: 'e3723c9583a630ee8696ef0f72e189ac5ba09d7769bcdbf1e7ee1422f8b1a9af',
      transactionMode: 'transactional',
      operatorExplanation:
        'This migration adds the vendor directory that Helios needs to treat ' +
        'vendors, rather than shared distributors, as the ordering identity. ' +
        'It creates normalized vendor and vendor-to-brand association tables, ' +
        'loads 84 vendors and 232 primary brand associations from the reviewed ' +
        'seed, and enforces case-insensitive uniqueness plus at most one primary ' +
        'vendor per brand. It does not rewrite existing application tables or ' +
        'start any recurring workload.',
      note:
        'Oracle-approved additive migration. Self-wrapped in begin/commit with ' +
        '5s lock_timeout and no CREATE INDEX CONCURRENTLY. The down migration is ' +
        'destructive and is not part of the admin apply flow.',
    },
    check: vendorBrandAssociationsSchemaApplied,
  },
  {
    migrationId: '105_review_transaction_attribution',
    label:
      'Capture-time inferred review-to-transaction attribution columns. ' +
      'Until applied, review submissions cannot snapshot an originating ' +
      'invoice/cashier and budtender rating metrics remain unavailable.',
    blessing: {
      ref: 'https://ampcode.com/threads/T-019f96d4-b6a0-70a7-bc7f-08947ea92044',
      reviewedSha: 'e09100ccb9dc26d759416bbcbba0c24d33d866b0',
      artifactSha256: 'b7495b0f6d72cf870909ef88307a76dff59932c35fd6a0018567afd2a3f5f03b',
      transactionMode: 'transactional',
      operatorExplanation:
        'This migration adds four columns that let each newly accepted customer ' +
        'review preserve its capture-time inferred invoice and cashier. Existing ' +
        'reviews remain not_attempted; no historical attribution is guessed. It ' +
        'adds two consistency checks but no index, backfill, scheduled workload, ' +
        'or unrelated customer-review schema.',
      note:
        'Oracle-approved exact 1,291-byte single-file closure. Self-wrapped in ' +
        'begin/commit with a 5s lock_timeout; no include, CREATE INDEX ' +
        'CONCURRENTLY, heap rewrite, or attribution backfill. The two checks ' +
        'validate 57 existing rows. The down migration is destructive and is ' +
        'not part of normal rollback. Any artifact edit invalidates this blessing.',
    },
    check: reviewTransactionAttributionSchemaApplied,
  },
  {
    migrationId: '106_sweed_orders_invoice_status',
    label:
      'sweed_orders.invoice_status_name typed projection and v2 dealer/time ' +
      'covering index — removes recurring cancellation filters from the large ' +
      'raw_json envelope while preserving status after the envelope drain.',
    blessing: {
      ref: 'https://ampcode.com/threads/T-019f7e40-7edf-7439-b6ca-50848e7bec27',
      reviewedSha: '706cd75aa92219e4987759b542562a94f16f3085',
      artifactSha256: 'fc60961aec7b1564f1891a6996f64583da7052a34a5644080d02af72c488dfde',
      transactionMode: 'mixed',
      operatorExplanation:
        'This migration copies Sweed invoice status into a narrow typed order ' +
        'column, backfills the retained recent envelope tail, and replaces the ' +
        'dealer/time covering index so cancellation filtering no longer reads ' +
        'the large raw invoice JSON. It also reasserts the already-applied ' +
        'cashier projection. It does not change order totals or recover status ' +
        'from envelopes that were already drained.',
      note:
        'Oracle-approved mixed migration: short transactions add/backfill the ' +
        'column, then CREATE/DROP INDEX CONCURRENTLY replaces the covering ' +
        'index outside a transaction. Lock and statement waits are bounded. ' +
        'The down migration restores the old index before dropping the column; ' +
        'status loss after later envelope draining makes rollback destructive.',
    },
    check: async (db) => {
      const [hasColumn, hasValidCoveringIndex, oldIndex] = await Promise.all([
        columnExists(db, 'sweed_orders', 'invoice_status_name'),
        validIndexExists(db, 'sweed_orders_budtender_range_cover_v2_idx'),
        db.query<{ exists: boolean }>(
          `select exists (
             select 1
               from pg_class c
               join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public'
                and c.relname = 'sweed_orders_budtender_range_cover_idx'
           ) as exists`,
        ),
      ])
      return hasColumn && hasValidCoveringIndex && oldIndex.rows[0]?.exists === false
    },
  },
  // NOTE (automation#62 leaf 9): migrations 100_migration_flow_smoketest and
  // 101_migration_flow_smoketest_drop were a throwaway create+drop PAIR used to
  // exercise the admin "Apply Now" psql apply flow end-to-end for the first
  // time in prod (both applied successfully via the button: real psql run,
  // sentinel_before=false → sentinel_after=true, net-zero schema). Their
  // sentinels + migration files were intentionally removed in this cleanup
  // commit — 100's tableExists sentinel would otherwise report perpetually
  // "pending" once 101 dropped the table. The durable evidence lives in the
  // prod migration_apply_attempts + audit_events rows.
]

// The allowlist of known migrationIds, derived from the sentinel registry so
// it can never drift from the source of truth. The migration-artifact resolver
// (migrationArtifacts.ts) validates an incoming migrationId against this set
// before touching the filesystem, so the "Apply Now" flow can only ever run a
// registered migration — never an arbitrary path from a request.
export const MIGRATION_SENTINEL_IDS: ReadonlySet<string> = new Set(
  SENTINELS.map((sentinel) => sentinel.migrationId),
)

const SENTINELS_BY_ID: ReadonlyMap<string, MigrationSentinel> = new Map(
  SENTINELS.map((sentinel) => [sentinel.migrationId, sentinel]),
)

/**
 * Look up a single sentinel by its migrationId, or null if unregistered.
 * The apply engine (automation#62, leaf 4) uses this to run one sentinel's
 * `check` directly against a live client — bypassing the ~30s
 * {@link getPendingMigrations} cache — for its before/after verification.
 */
export function getMigrationSentinel(migrationId: string): MigrationSentinel | null {
  return SENTINELS_BY_ID.get(migrationId) ?? null
}

/**
 * Run one migration's sentinel LIVE (cache bypassed) against `db`, returning
 * true iff the migration is applied. Unlike {@link getPendingMigrations} this
 * never reads or writes the module cache, so the apply engine's
 * before/after sentinel verification always reflects the real current schema.
 * A throwing sentinel (e.g. the underlying table doesn't exist yet) is treated
 * as "not applied" — identical to the batch path — so a missing dependency
 * surfaces as pending rather than an exception.
 */
export async function isMigrationAppliedLive(
  db: Queryable,
  migrationId: string,
): Promise<boolean> {
  const sentinel = getMigrationSentinel(migrationId)
  if (sentinel === null) {
    return false
  }
  try {
    return await sentinel.check(db)
  } catch (error) {
    console.warn(
      `[pendingMigrations] live sentinel for ${migrationId} threw; treating as not-applied:`,
      error,
    )
    return false
  }
}

/** A live-pending migration row (id + label), as returned by the admin API. */
export interface LivePendingMigration {
  readonly migrationId: string
  readonly label: string
}

/**
 * List every migration whose sentinel reports NOT applied, computed LIVE
 * (cache bypassed) against `db`. Unlike {@link getPendingMigrations} this never
 * reads or writes the ~30s module cache, so the admin pending-migrations API
 * (automation#62, leaf 5) always reflects the real current schema — the
 * operator must never act on a stale row. Sentinels run in parallel (they are
 * independent information_schema / pg_indexes lookups); a throwing sentinel is
 * treated as pending, identical to the cached batch path.
 */
export async function listPendingMigrationsLive(db: Queryable): Promise<LivePendingMigration[]> {
  const results = await Promise.all(
    SENTINELS.map(async (sentinel) => {
      try {
        return { sentinel, isApplied: await sentinel.check(db) }
      } catch (error) {
        console.warn(
          `[pendingMigrations] live sentinel for ${sentinel.migrationId} threw; treating as pending:`,
          error,
        )
        return { sentinel, isApplied: false }
      }
    }),
  )
  const pending: LivePendingMigration[] = []
  for (const { sentinel, isApplied } of results) {
    if (!isApplied) {
      pending.push({ migrationId: sentinel.migrationId, label: sentinel.label })
    }
  }
  return pending
}

interface CacheEntry {
  readonly pending: PendingMigration[]
  readonly checkedAt: number
}

const CACHE_TTL_MS = 30_000
let cache: CacheEntry | null = null
let inflight: Promise<PendingMigration[]> | null = null

export async function getPendingMigrations(db: Queryable): Promise<PendingMigration[]> {
  const now = Date.now()
  if (cache !== null && now - cache.checkedAt < CACHE_TTL_MS) {
    return cache.pending
  }
  if (inflight !== null) {
    return inflight
  }

  inflight = (async () => {
    try {
      // Run every sentinel in parallel. The sentinels are independent
      // information_schema / pg_indexes lookups against unrelated
      // tables; serializing them (as the original implementation did)
      // turned the cold-cache refresh into ~33 sequential DB round
      // trips. On Tiger Cloud that's ~1.5–2s of network latency that
      // every authenticated request paid every 30s (the cache TTL),
      // dominating endpoints like GET /api/catalog/groups whose own
      // SQL is sub-100ms. Promise.all collapses the same 33 lookups
      // into a single ~30–80ms parallel round-trip.
      const results = await Promise.all(
        SENTINELS.map(async (sentinel) => {
          try {
            return { sentinel, isApplied: await sentinel.check(db) }
          } catch (error) {
            // A sentinel that throws (e.g. underlying table itself
            // doesn't exist yet) means the migration definitely
            // isn't applied. Treat as pending rather than blowing up
            // the whole session response.
            console.warn(
              `[pendingMigrations] sentinel for ${sentinel.migrationId} threw; treating as pending:`,
              error,
            )
            return { sentinel, isApplied: false }
          }
        }),
      )
      const pending: PendingMigration[] = []
      for (const { sentinel, isApplied } of results) {
        if (!isApplied) {
          pending.push({
            migrationId: sentinel.migrationId,
            label: sentinel.label,
          })
        }
      }
      cache = { pending, checkedAt: Date.now() }
      return pending
    } finally {
      inflight = null
    }
  })()

  return inflight
}

// Test helper.
export function resetPendingMigrationsCache(): void {
  cache = null
  inflight = null
}
