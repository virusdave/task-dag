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
      const pending: PendingMigration[] = []
      for (const sentinel of SENTINELS) {
        let isApplied = false
        try {
          isApplied = await sentinel.check(db)
        } catch (error) {
          // A sentinel that throws (e.g. underlying table itself
          // doesn't exist yet) means the migration definitely isn't
          // applied. Treat as pending rather than blowing up the
          // whole session response.
          isApplied = false
          console.warn(
            `[pendingMigrations] sentinel for ${sentinel.migrationId} threw; treating as pending:`,
            error,
          )
        }
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
