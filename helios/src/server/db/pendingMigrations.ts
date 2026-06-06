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

export interface MigrationSentinel {
  readonly migrationId: string
  readonly label: string
  readonly check: (db: Queryable) => Promise<boolean>
}

export interface PendingMigration {
  readonly migrationId: string
  readonly label: string
  readonly applyCommand: string
}

function makeApplyCommand(migrationId: string): string {
  // The shipped helper invocation an operator can copy-paste. The
  // exact `psql` invocation will depend on how they've configured
  // their credentials (TIGERDATA_CREDENTIALS_FILE, DATABASE_URL,
  // etc.); we surface the file path and leave the connection string
  // to the operator.
  return `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f helios/src/server/db/migrations/${migrationId}.sql`
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
    // Phase F5 prerequisite of the Helios DB-cost epic
    // (virusdave/top-level#11). Migration 061 backfills
    // sweed_orders.cashier_user_id from raw_json->>'creatorId' so the
    // budtender analytics queries can stop reading
    // sweed_orders.raw_json->>'creatorId' as a fallback — the last
    // server callsite that touches sweed_orders.raw_json. The sentinel
    // is true once no order still has a NULL cashier_user_id that could
    // be recovered from a (still-present) raw_json creatorId. New rows
    // never trip this (ingest writes the column) and the later F5 drain
    // nulls raw_json, so it stays true once 061 has run.
    migrationId: '061_sweed_orders_cashier_user_id_backfill',
    label:
      'sweed_orders.cashier_user_id backfilled from raw_json ' +
      '(DB-cost epic phase F5 prerequisite) — budtender analytics ' +
      'reads the column directly, no raw_json fallback.',
    check: async (db) => {
      const result = await db.query<{ pending: boolean }>(
        `select exists (
           select 1 from sweed_orders
            where cashier_user_id is null
              and (raw_json->>'creatorType') = '1'
              and nullif(raw_json->>'creatorId', '') ~ '^\\d+$'
         ) as pending`,
      )
      return result.rows[0]?.pending === false
    },
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
      const result = await db.query<{ ok: boolean }>(
        `select not exists(
           select 1
           from catalog_taxonomy_snapshot_rows r
           join catalog_taxonomy_snapshots s on s.id = r.snapshot_id
           where s.started_at < now() - interval '48 hours'
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
]

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
            applyCommand: makeApplyCommand(sentinel.migrationId),
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
