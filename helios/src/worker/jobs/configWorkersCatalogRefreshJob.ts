import type { QueryResultRow } from 'pg'
import { z } from 'zod'

import type { ConfigWorkersCatalogRefreshJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { getWorkerEnv } from '../config/env.js'
import { callSweedRpcForDealer } from '../sweed/client.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

const LIST_PAGE_SIZE = 200

// Retention window for `catalog_taxonomy_snapshot_rows`. Each refresh
// writes one row per product / group / strain / brand / category /
// subcategory / prevalence / size / distributor — at the time this
// retention was added that was ~7,500 rows per snapshot — and the
// scheduler runs the refresh on the order of 200×/day, so without a
// retention sweep the table grows ~55 MB/day forever. Production had
// accumulated 15 GB / 32M rows of these before the F1 phase of the
// DB-cost epic (virusdave/top-level#11) was filed.
//
// The application reads exactly ZERO rows from
// `catalog_taxonomy_snapshot_rows` — only the parent
// `catalog_taxonomy_snapshots` summary row is read, and only by
// `loadRecentCatalogTaxonomySnapshots`. So aggressive pruning is
// safe: the row payload is purely a write-only audit trail of "what
// did the Sweed state catalog look like at time T". 24 h is more
// than enough to support a "what changed between two recent
// snapshots" diagnostic workflow if one is ever wanted, and
// matches the F1 plan's default.
//
// The window is overridable via the `CATALOG_SNAPSHOT_ROW_RETENTION_HOURS`
// env var (set to `0` to disable pruning entirely — escape hatch
// for forensic operator work; not intended for steady-state use).
// A future C2 / operator-tunable retention surface will replace
// the env var with a knob on `/config/workers`.
const DEFAULT_SNAPSHOT_ROW_RETENTION_HOURS = 24

function snapshotRowRetentionHours(): number {
  const raw = process.env.CATALOG_SNAPSHOT_ROW_RETENTION_HOURS
  if (raw === undefined || raw === '') {
    return DEFAULT_SNAPSHOT_ROW_RETENTION_HOURS
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SNAPSHOT_ROW_RETENTION_HOURS
  }
  return parsed
}

type EntityType =
  | 'product'
  | 'group'
  | 'category'
  | 'subcategory'
  | 'brand'
  | 'strain'
  | 'prevalence'
  | 'size'
  | 'distributor'

interface CatalogEntityRow {
  entityType: EntityType
  entityId: number
  entityName: string | null
  payload: unknown
}

interface SnapshotInsertRow extends QueryResultRow {
  id: number
}

const RawListRowSchema = z
  .object({
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough()

const PagedListResponseSchema = z
  .object({
    data: z.array(RawListRowSchema).default([]),
    totalCount: z.coerce.number().int().min(0).optional(),
  })
  .passthrough()

const FlatListResponseSchema = z.array(RawListRowSchema)

const CategoryRowSchema = z
  .object({
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
    subcategories: z
      .array(
        z
          .object({
            id: z.coerce.number().int(),
            name: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

const CategoryListResponseSchema = z.union([
  z.array(CategoryRowSchema),
  z.object({ data: z.array(CategoryRowSchema).default([]) }).passthrough().transform((value) => value.data),
])

export async function runConfigWorkersCatalogRefreshJob(
  context: JobHandlerContext,
  payload: ConfigWorkersCatalogRefreshJobPayload,
): Promise<void> {
  const env = getWorkerEnv()
  const stateDealerId = env.sweedStateDealerId

  const startedAt = new Date()
  const snapshotId = await withTransaction(async (db) => {
    const result = await db.query<SnapshotInsertRow>(
      `
        insert into catalog_taxonomy_snapshots (
          state_dealer_id, job_id, status, trigger, started_at, metadata_json
        ) values ($1, $2, 'running', $3, $4, $5::jsonb)
        returning id
      `,
      [
        stateDealerId,
        context.id,
        payload.trigger,
        startedAt,
        JSON.stringify({ trigger: payload.trigger, jobId: context.id }),
      ],
    )
    return result.rows[0].id
  })

  try {
    const collected = await collectAllStateCatalog(stateDealerId)

    const counts = countByEntityType(collected)

    await persistSnapshotRows(snapshotId, collected, counts)

    await withTransaction(async (db) => {
      await appendAuditEvent(db, {
        actorType: payload.requestedByUserId ? 'user' : 'system',
        actorUserId: payload.requestedByUserId ?? null,
        entityId: String(context.id),
        entityType: 'job',
        eventType: 'config.workers.catalog_refresh.completed',
        module: 'config',
        payload: {
          counts: { ...counts },
          snapshotId,
          stateDealerId,
          trigger: payload.trigger,
        },
        requestId: null,
        scope: null,
        undoPayload: null,
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown catalog refresh error.'
    await withTransaction(async (db) => {
      await db.query(
        `
          update catalog_taxonomy_snapshots
          set status = 'failed',
              finished_at = now(),
              error = $2
          where id = $1
        `,
        [snapshotId, message],
      )
    })
    throw error
  }
}

interface CollectedCatalog {
  rows: CatalogEntityRow[]
}

async function collectAllStateCatalog(stateDealerId: number): Promise<CollectedCatalog> {
  const rows: CatalogEntityRow[] = []

  rows.push(...(await collectPagedListShort(stateDealerId, 'store.product.list.short', 'product')))
  rows.push(...(await collectPagedListShort(stateDealerId, 'store.product.group.list', 'group')))
  rows.push(...(await collectCategoriesAndSubcategories(stateDealerId)))
  rows.push(...(await collectFlatList(stateDealerId, 'store.product.brand.list', 'brand')))
  rows.push(...(await collectFlatList(stateDealerId, 'store.product.strain.list', 'strain')))
  rows.push(...(await collectFlatList(stateDealerId, 'store.product.strain.prevalence.list', 'prevalence')))
  rows.push(...(await collectFlatList(stateDealerId, 'store.product.size.list', 'size')))
  rows.push(...(await collectDistributors(stateDealerId)))

  return { rows }
}

async function collectPagedListShort(
  stateDealerId: number,
  rpcName: string,
  entityType: EntityType,
): Promise<CatalogEntityRow[]> {
  const rows: CatalogEntityRow[] = []
  const seenIds = new Set<number>()
  let page = 1
  while (true) {
    const raw = await callSweedRpcForDealer(stateDealerId, rpcName, {
      page,
      pageSize: LIST_PAGE_SIZE,
    })
    const parsed = PagedListResponseSchema.parse(raw)
    let newRowsThisPage = 0
    for (const row of parsed.data) {
      if (seenIds.has(row.id)) {
        continue
      }
      seenIds.add(row.id)
      newRowsThisPage += 1
      rows.push({
        entityType,
        entityId: row.id,
        entityName: row.name ?? null,
        payload: row,
      })
    }
    // Stop when the page is short OR the page returns no rows we have not
    // already seen (e.g. an RPC that ignores `page` and returns the same
    // payload every call). Without this, a non-paginating endpoint would
    // loop forever.
    if (parsed.data.length < LIST_PAGE_SIZE || newRowsThisPage === 0) {
      break
    }
    page += 1
  }
  return rows
}

async function collectFlatList(
  stateDealerId: number,
  rpcName: string,
  entityType: EntityType,
): Promise<CatalogEntityRow[]> {
  const rows: CatalogEntityRow[] = []
  const seenIds = new Set<number>()
  let page = 1
  while (true) {
    const raw = await callSweedRpcForDealer(stateDealerId, rpcName, {
      page,
      pageSize: LIST_PAGE_SIZE,
    })
    const parsedRows = parseFlexibleListResponse(raw)
    let newRowsThisPage = 0
    for (const row of parsedRows) {
      if (seenIds.has(row.id)) {
        continue
      }
      seenIds.add(row.id)
      newRowsThisPage += 1
      rows.push({
        entityType,
        entityId: row.id,
        entityName: row.name ?? null,
        payload: row,
      })
    }
    if (parsedRows.length < LIST_PAGE_SIZE || newRowsThisPage === 0) {
      break
    }
    page += 1
  }
  return rows
}

async function collectCategoriesAndSubcategories(stateDealerId: number): Promise<CatalogEntityRow[]> {
  // Category list does not paginate; the response is the entire taxonomy.
  const raw = await callSweedRpcForDealer(stateDealerId, 'store.product.category.list', {})
  const parsed = CategoryListResponseSchema.parse(raw)
  const rows: CatalogEntityRow[] = []
  for (const category of parsed) {
    rows.push({
      entityType: 'category',
      entityId: category.id,
      entityName: category.name ?? null,
      payload: category,
    })
    for (const subcategory of category.subcategories ?? []) {
      rows.push({
        entityType: 'subcategory',
        entityId: subcategory.id,
        entityName: subcategory.name ?? null,
        payload: { ...subcategory, categoryId: category.id, categoryName: category.name ?? null },
      })
    }
  }
  return rows
}

async function collectDistributors(stateDealerId: number): Promise<CatalogEntityRow[]> {
  const rows: CatalogEntityRow[] = []
  const seenIds = new Set<number>()
  let page = 1
  while (true) {
    const raw = await callSweedRpcForDealer(stateDealerId, 'store.distributor.search', {
      enabled: true,
      page,
      pageSize: LIST_PAGE_SIZE,
    })
    const parsedRows = parseFlexibleListResponse(raw)
    let newRowsThisPage = 0
    for (const row of parsedRows) {
      if (seenIds.has(row.id)) {
        continue
      }
      seenIds.add(row.id)
      newRowsThisPage += 1
      rows.push({
        entityType: 'distributor',
        entityId: row.id,
        entityName: row.name ?? null,
        payload: row,
      })
    }
    if (parsedRows.length < LIST_PAGE_SIZE || newRowsThisPage === 0) {
      break
    }
    page += 1
  }
  return rows
}

function parseFlexibleListResponse(raw: unknown): Array<{ id: number; name: string | null }> {
  const flat = FlatListResponseSchema.safeParse(raw)
  if (flat.success) {
    return flat.data.map((row) => ({ id: row.id, name: row.name ?? null }))
  }
  const paged = PagedListResponseSchema.parse(raw)
  return paged.data.map((row) => ({ id: row.id, name: row.name ?? null }))
}

interface EntityCounts {
  productCount: number
  groupCount: number
  categoryCount: number
  subcategoryCount: number
  brandCount: number
  strainCount: number
  prevalenceCount: number
  sizeCount: number
  distributorCount: number
}

function countByEntityType(collected: CollectedCatalog): EntityCounts {
  const counts: EntityCounts = {
    productCount: 0,
    groupCount: 0,
    categoryCount: 0,
    subcategoryCount: 0,
    brandCount: 0,
    strainCount: 0,
    prevalenceCount: 0,
    sizeCount: 0,
    distributorCount: 0,
  }
  for (const row of collected.rows) {
    switch (row.entityType) {
      case 'product':
        counts.productCount += 1
        break
      case 'group':
        counts.groupCount += 1
        break
      case 'category':
        counts.categoryCount += 1
        break
      case 'subcategory':
        counts.subcategoryCount += 1
        break
      case 'brand':
        counts.brandCount += 1
        break
      case 'strain':
        counts.strainCount += 1
        break
      case 'prevalence':
        counts.prevalenceCount += 1
        break
      case 'size':
        counts.sizeCount += 1
        break
      case 'distributor':
        counts.distributorCount += 1
        break
    }
  }
  return counts
}

async function persistSnapshotRows(
  snapshotId: number,
  collected: CollectedCatalog,
  counts: EntityCounts,
): Promise<void> {
  const seenKeys = new Set<string>()
  const uniqueRows: CatalogEntityRow[] = []
  for (const row of collected.rows) {
    const key = `${row.entityType}:${row.entityId}`
    if (seenKeys.has(key)) {
      continue
    }
    seenKeys.add(key)
    uniqueRows.push(row)
  }

  await withTransaction(async (db) => {
    if (uniqueRows.length > 0) {
      // Insert in chunks so a single huge insert does not blow past pg's
      // bind-parameter limit on large state catalogs.
      const chunkSize = 500
      for (let start = 0; start < uniqueRows.length; start += chunkSize) {
        const slice = uniqueRows.slice(start, start + chunkSize)
        const values: string[] = []
        const args: unknown[] = []
        let argIndex = 1
        for (const row of slice) {
          values.push(`($${argIndex++}, $${argIndex++}, $${argIndex++}, $${argIndex++}, $${argIndex++}::jsonb)`)
          args.push(snapshotId, row.entityType, row.entityId, row.entityName, JSON.stringify(row.payload))
        }
        await db.query(
          `
            insert into catalog_taxonomy_snapshot_rows (
              snapshot_id, entity_type, entity_id, entity_name, payload
            ) values ${values.join(', ')}
          `,
          args,
        )
      }
    }

    await db.query(
      `
        update catalog_taxonomy_snapshots
        set status = 'succeeded',
            finished_at = now(),
            product_count = $2,
            group_count = $3,
            category_count = $4,
            subcategory_count = $5,
            brand_count = $6,
            strain_count = $7,
            prevalence_count = $8,
            size_count = $9,
            distributor_count = $10
        where id = $1
      `,
      [
        snapshotId,
        counts.productCount,
        counts.groupCount,
        counts.categoryCount,
        counts.subcategoryCount,
        counts.brandCount,
        counts.strainCount,
        counts.prevalenceCount,
        counts.sizeCount,
        counts.distributorCount,
      ],
    )

    // Retention prune in the SAME transaction as the snapshot insert,
    // so a crash between insert and prune leaves the table
    // consistent (either we have the new snapshot AND the old rows
    // are gone, or neither happened). See the
    // DEFAULT_SNAPSHOT_ROW_RETENTION_HOURS comment for the rationale.
    //
    // The delete excludes the snapshot we just wrote (`snapshot_id
    // != $1`) defensively — at retention windows ≥ 1 minute that
    // exclusion is redundant (the just-written rows are seconds
    // old), but it keeps the prune robust against an operator who
    // sets the window to 0 hours for a one-off forensic sweep
    // without wiping the snapshot they just took.
    //
    // We delete by `snapshot_id` rather than `WHERE inserted_at <
    // ...` because the rows table has no time column of its own;
    // age is carried by the parent `catalog_taxonomy_snapshots.started_at`.
    // The subquery is small (`catalog_taxonomy_snapshots` is in the
    // low thousands of rows total) and the delete is index-scanned
    // by the PK.
    const retentionHours = snapshotRowRetentionHours()
    if (retentionHours > 0) {
      await db.query(
        `
          delete from catalog_taxonomy_snapshot_rows
          where snapshot_id != $1
            and snapshot_id in (
              select id
              from catalog_taxonomy_snapshots
              where started_at < now() - ($2 || ' hours')::interval
            )
        `,
        [snapshotId, String(retentionHours)],
      )
    }
  })
}
