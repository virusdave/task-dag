// DB write + aggregation layer for the SEO GA4/GSC metric importer
// (migration 075; P5 first slice — parent epic virusdave/top-level#15,
// child epic FreshlyBakedNYC/automation#44).
//
// Idempotency / write-on-change (canon §3): the daily fact upserts key on
// the deterministic `row_key` and only UPDATE when a metric actually
// changed (`… is distinct from excluded.…`), so an unchanged re-import of
// an overlapping date range writes ZERO rows — no WAL, no dead tuples. We
// distinguish insert vs update via the `xmax = 0` idiom and count
// "unchanged" as (sent − returned). Upserts are CHUNKED (≤500 rows/stmt)
// to stay under the 125ms per-interaction budget. Every aggregation query
// is bounded by site + a date window + LIMIT and served by the
// (site, bucket_date_ny) / (site, page_url, bucket_date_ny) indexes.

import type { Queryable } from '../pool.js'
import type { GscDailyInput, Ga4DailyInput, MetricSource } from '../../seo/metricsImport.js'

/** Max rows per upsert statement (DB-interaction budget guardrail). */
export const UPSERT_CHUNK_SIZE = 500

export interface UpsertCounts {
  readonly inserted: number
  readonly updated: number
  readonly unchanged: number
}

export interface ImportBatchInput {
  readonly import_batch_id: string
  readonly source: MetricSource
  readonly property: string
  readonly site: string
  readonly source_timezone: string
  readonly source_file_name: string
  readonly source_file_sha256: string
  readonly export_start_date: string | null
  readonly export_end_date: string | null
  readonly imported_by: string | null
}

/** Insert a fresh import batch in the `running` state. */
export async function createImportBatch(db: Queryable, batch: ImportBatchInput): Promise<void> {
  await db.query(
    `
      insert into seo_metric_import_batches (
        import_batch_id, source, property, site, source_timezone,
        source_file_name, source_file_sha256, export_start_date,
        export_end_date, imported_by, status
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running')
    `,
    [
      batch.import_batch_id,
      batch.source,
      batch.property,
      batch.site,
      batch.source_timezone,
      batch.source_file_name,
      batch.source_file_sha256,
      batch.export_start_date,
      batch.export_end_date,
      batch.imported_by,
    ],
  )
}

/** Mark a batch completed and record its row counts. */
export async function completeImportBatch(
  db: Queryable,
  importBatchId: string,
  counts: { rowsSeen: number; inserted: number; updated: number; unchanged: number; rejected: number },
): Promise<void> {
  await db.query(
    `
      update seo_metric_import_batches
         set status = 'completed',
             rows_seen = $2,
             rows_inserted = $3,
             rows_updated = $4,
             rows_unchanged = $5,
             rows_rejected = $6,
             completed_at = now()
       where import_batch_id = $1
    `,
    [
      importBatchId,
      counts.rowsSeen,
      counts.inserted,
      counts.updated,
      counts.unchanged,
      counts.rejected,
    ],
  )
}

/** Mark a batch failed with an error message. */
export async function failImportBatch(
  db: Queryable,
  importBatchId: string,
  error: string,
): Promise<void> {
  await db.query(
    `
      update seo_metric_import_batches
         set status = 'failed', error = $2, completed_at = now()
       where import_batch_id = $1
    `,
    [importBatchId, error.slice(0, 4000)],
  )
}

// ── GSC daily upsert ──────────────────────────────────────────────────

const GSC_COLUMNS = [
  'row_key',
  'first_import_batch_id',
  'last_import_batch_id',
  'property',
  'site',
  'source_date',
  'source_timezone',
  'bucket_date_ny',
  'search_type',
  'device',
  'country',
  'query',
  'page_url',
  'clicks',
  'impressions',
  'position',
] as const

function gscParams(row: GscDailyInput, batchId: string): unknown[] {
  return [
    row.row_key,
    batchId, // first_import_batch_id (kept on insert only)
    batchId, // last_import_batch_id
    row.property,
    row.site,
    row.source_date,
    row.source_timezone,
    row.bucket_date_ny,
    row.search_type,
    row.device,
    row.country,
    row.query,
    row.page_url,
    row.clicks,
    row.impressions,
    row.position,
  ]
}

/**
 * Upsert a batch of GSC daily fact rows. Caller MUST have de-duped row_keys
 * within the batch first (ON CONFLICT cannot touch a row twice). Writes are
 * chunked; an unchanged row produces no write thanks to the IS DISTINCT
 * FROM guard.
 */
export async function bulkUpsertGscDailyRows(
  db: Queryable,
  importBatchId: string,
  rows: readonly GscDailyInput[],
): Promise<UpsertCounts> {
  let inserted = 0
  let updated = 0
  let unchanged = 0
  for (let start = 0; start < rows.length; start += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + UPSERT_CHUNK_SIZE)
    const params: unknown[] = []
    const tuples: string[] = []
    for (const row of chunk) {
      const base = params.length
      tuples.push(`(${GSC_COLUMNS.map((_, i) => `$${base + i + 1}`).join(',')})`)
      params.push(...gscParams(row, importBatchId))
    }
    const res = await db.query<{ inserted: boolean }>(
      `
        insert into seo_gsc_daily (${GSC_COLUMNS.join(', ')})
        values ${tuples.join(', ')}
        on conflict (row_key) do update set
          clicks = excluded.clicks,
          impressions = excluded.impressions,
          position = excluded.position,
          last_import_batch_id = excluded.last_import_batch_id,
          updated_at = now()
        where seo_gsc_daily.clicks is distinct from excluded.clicks
           or seo_gsc_daily.impressions is distinct from excluded.impressions
           or seo_gsc_daily.position is distinct from excluded.position
        returning (xmax = 0) as inserted
      `,
      params,
    )
    for (const r of res.rows) {
      if (r.inserted) inserted++
      else updated++
    }
    unchanged += chunk.length - res.rows.length
  }
  return { inserted, updated, unchanged }
}

// ── GA4 daily upsert ──────────────────────────────────────────────────

const GA4_COLUMNS = [
  'row_key',
  'first_import_batch_id',
  'last_import_batch_id',
  'property',
  'site',
  'source_date',
  'source_timezone',
  'bucket_date_ny',
  'page_url',
  'traffic_scope',
  'sessions',
  'active_users',
  'screen_page_views',
  'engaged_sessions',
  'key_events',
] as const

function ga4Params(row: Ga4DailyInput, batchId: string): unknown[] {
  return [
    row.row_key,
    batchId,
    batchId,
    row.property,
    row.site,
    row.source_date,
    row.source_timezone,
    row.bucket_date_ny,
    row.page_url,
    row.traffic_scope,
    row.sessions,
    row.active_users,
    row.screen_page_views,
    row.engaged_sessions,
    row.key_events,
  ]
}

export async function bulkUpsertGa4DailyRows(
  db: Queryable,
  importBatchId: string,
  rows: readonly Ga4DailyInput[],
): Promise<UpsertCounts> {
  let inserted = 0
  let updated = 0
  let unchanged = 0
  for (let start = 0; start < rows.length; start += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + UPSERT_CHUNK_SIZE)
    const params: unknown[] = []
    const tuples: string[] = []
    for (const row of chunk) {
      const base = params.length
      tuples.push(`(${GA4_COLUMNS.map((_, i) => `$${base + i + 1}`).join(',')})`)
      params.push(...ga4Params(row, importBatchId))
    }
    const res = await db.query<{ inserted: boolean }>(
      `
        insert into seo_ga4_daily (${GA4_COLUMNS.join(', ')})
        values ${tuples.join(', ')}
        on conflict (row_key) do update set
          sessions = excluded.sessions,
          active_users = excluded.active_users,
          screen_page_views = excluded.screen_page_views,
          engaged_sessions = excluded.engaged_sessions,
          key_events = excluded.key_events,
          last_import_batch_id = excluded.last_import_batch_id,
          updated_at = now()
        where seo_ga4_daily.sessions is distinct from excluded.sessions
           or seo_ga4_daily.active_users is distinct from excluded.active_users
           or seo_ga4_daily.screen_page_views is distinct from excluded.screen_page_views
           or seo_ga4_daily.engaged_sessions is distinct from excluded.engaged_sessions
           or seo_ga4_daily.key_events is distinct from excluded.key_events
        returning (xmax = 0) as inserted
      `,
      params,
    )
    for (const r of res.rows) {
      if (r.inserted) inserted++
      else updated++
    }
    unchanged += chunk.length - res.rows.length
  }
  return { inserted, updated, unchanged }
}

// ── aggregation queries ───────────────────────────────────────────────
//
// All bounded by site + [startDate, endDate) + LIMIT. CTR is aggregated as
// sum(clicks)/sum(impressions); position as the impression-weighted average
// sum(position*impressions)/sum(impressions) — never a simple average.

export interface DateWindow {
  readonly site: string
  readonly startDate: string // inclusive, YYYY-MM-DD
  readonly endDate: string // exclusive, YYYY-MM-DD
}

export interface GscQueryAggregate {
  readonly query: string
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly avgPosition: number | null
}

export async function getTopGscQueries(
  db: Queryable,
  w: DateWindow & { limit: number },
): Promise<GscQueryAggregate[]> {
  const res = await db.query<{
    query: string
    clicks: string
    impressions: string
    ctr: string
    avg_position: string | null
  }>(
    `
      select
        query,
        sum(clicks)        as clicks,
        sum(impressions)   as impressions,
        case when sum(impressions) = 0 then 0
             else sum(clicks)::numeric / sum(impressions) end as ctr,
        case when sum(impressions) = 0 then null
             else sum(position * impressions)::numeric / sum(impressions) end as avg_position
      from seo_gsc_daily
      where site = $1 and bucket_date_ny >= $2 and bucket_date_ny < $3
      group by query
      order by sum(impressions) desc
      limit $4
    `,
    [w.site, w.startDate, w.endDate, w.limit],
  )
  return res.rows.map((r) => ({
    query: r.query,
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    ctr: Number(r.ctr),
    avgPosition: r.avg_position === null ? null : Number(r.avg_position),
  }))
}

export interface GscQueryGap {
  readonly query: string
  readonly pageUrl: string
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly avgPosition: number | null
}

/**
 * Query-gap candidates: high-impression, low-CTR (query,page) pairs whose
 * average position is salvageable. Returns CANDIDATES only — no
 * recommendation is created here (canon §1: human gate). Callers should pass
 * an endDate that excludes the freshest ~3 Google days (GSC restates them).
 */
export async function getGscQueryGaps(
  db: Queryable,
  w: DateWindow & {
    minImpressions: number
    maxCtr: number
    maxPosition: number
    limit: number
  },
): Promise<GscQueryGap[]> {
  const res = await db.query<{
    query: string
    page_url: string
    clicks: string
    impressions: string
    ctr: string
    avg_position: string | null
  }>(
    `
      select
        query,
        page_url,
        sum(clicks)      as clicks,
        sum(impressions) as impressions,
        sum(clicks)::numeric / nullif(sum(impressions), 0) as ctr,
        sum(position * impressions)::numeric / nullif(sum(impressions), 0) as avg_position
      from seo_gsc_daily
      where site = $1 and bucket_date_ny >= $2 and bucket_date_ny < $3
      group by query, page_url
      having sum(impressions) >= $4
         and sum(clicks)::numeric / nullif(sum(impressions), 0) <= $5
         and sum(position * impressions)::numeric / nullif(sum(impressions), 0) <= $6
      order by sum(impressions) desc
      limit $7
    `,
    [w.site, w.startDate, w.endDate, w.minImpressions, w.maxCtr, w.maxPosition, w.limit],
  )
  return res.rows.map((r) => ({
    query: r.query,
    pageUrl: r.page_url,
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    ctr: Number(r.ctr),
    avgPosition: r.avg_position === null ? null : Number(r.avg_position),
  }))
}

export interface LowCtrPageAggregate {
  readonly pageUrl: string
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly avgPosition: number | null
}

/**
 * High-impression / low-CTR PAGE candidates (title/meta-revision feeders for
 * the recommendation engine). Returns CANDIDATES only — no recommendation is
 * created here (canon §1). Callers should pass an endDate that excludes the
 * freshest ~3 Google days (GSC restates them).
 */
export async function getLowCtrPages(
  db: Queryable,
  w: DateWindow & {
    minImpressions: number
    maxCtr: number
    maxPosition: number
    limit: number
  },
): Promise<LowCtrPageAggregate[]> {
  const res = await db.query<{
    page_url: string
    clicks: string
    impressions: string
    ctr: string
    avg_position: string | null
  }>(
    `
      select
        page_url,
        sum(clicks)      as clicks,
        sum(impressions) as impressions,
        sum(clicks)::numeric / nullif(sum(impressions), 0) as ctr,
        sum(position * impressions)::numeric / nullif(sum(impressions), 0) as avg_position
      from seo_gsc_daily
      where site = $1 and bucket_date_ny >= $2 and bucket_date_ny < $3
      group by page_url
      having sum(impressions) >= $4
         and sum(clicks)::numeric / nullif(sum(impressions), 0) <= $5
         and sum(position * impressions)::numeric / nullif(sum(impressions), 0) <= $6
      order by sum(impressions) desc
      limit $7
    `,
    [w.site, w.startDate, w.endDate, w.minImpressions, w.maxCtr, w.maxPosition, w.limit],
  )
  return res.rows.map((r) => ({
    pageUrl: r.page_url,
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    ctr: Number(r.ctr),
    avgPosition: r.avg_position === null ? null : Number(r.avg_position),
  }))
}

export interface UrlDailyPerformance {
  readonly bucketDateNy: string
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly avgPosition: number | null
}

/** Daily Search-performance series for one page URL (dashboard drill-in). */
export async function getUrlSearchPerformance(
  db: Queryable,
  w: DateWindow & { pageUrl: string },
): Promise<UrlDailyPerformance[]> {
  const res = await db.query<{
    bucket_date_ny: string
    clicks: string
    impressions: string
    ctr: string
    avg_position: string | null
  }>(
    `
      select
        bucket_date_ny::text as bucket_date_ny,
        sum(clicks)      as clicks,
        sum(impressions) as impressions,
        case when sum(impressions) = 0 then 0
             else sum(clicks)::numeric / sum(impressions) end as ctr,
        case when sum(impressions) = 0 then null
             else sum(position * impressions)::numeric / sum(impressions) end as avg_position
      from seo_gsc_daily
      where site = $1 and page_url = $2
        and bucket_date_ny >= $3 and bucket_date_ny < $4
      group by bucket_date_ny
      order by bucket_date_ny asc
    `,
    [w.site, w.pageUrl, w.startDate, w.endDate],
  )
  return res.rows.map((r) => ({
    bucketDateNy: r.bucket_date_ny,
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    ctr: Number(r.ctr),
    avgPosition: r.avg_position === null ? null : Number(r.avg_position),
  }))
}
