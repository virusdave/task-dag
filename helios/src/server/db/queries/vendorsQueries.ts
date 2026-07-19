import type {
  Vendor,
  VendorBrandAssociation,
  VendorBrandAssociationInput,
  VendorCreateRequest,
  VendorObservedDistributor,
  VendorUpdateRequest,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

// Low-frequency operator directory cost budget:
// - one vendor read plus parallel association/history reads per list request;
// - hard caps of 500 vendors, 300 associations/vendor, and 20 observed
//   distributors/vendor keep response and aggregation work bounded;
// - vendors_name_lower_uidx supplies list ordering, the association unique
//   index begins with vendor_id, sweed_purchase_lines_brand_idx supplies the
//   brand join, and the purchase PK supplies the final header join.
// There is no polling/background load. Production plan measurement must follow
// migration 104's separately approved apply; until then to_regclass reports
// both vendor tables absent, so this leaf deliberately performs no schema write.

interface VendorRow {
  id: number | string
  name: string
  is_mso: boolean
  is_micro: boolean
  cod_only: boolean
  created_at: Date | string
  updated_at: Date | string
}

interface AssociationRow {
  id: number | string
  vendor_id: number | string
  brand_name: string
  is_primary: boolean
  target_days_on_hand: number | null
  asset_url: string | null
  cod_required: boolean | null
  cod_discount_source: string | null
  minimum_order_dollars: number | string | null
  comments: string | null
}

interface DistributorHistoryRow {
  vendor_id: number | string
  distributor_name: string
  purchase_count: number | string
  last_delivery_date: Date | string | null
  site_keys: string[]
}

const VENDOR_COLUMNS = 'id, name, is_mso, is_micro, cod_only, created_at, updated_at'

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapAssociation(row: AssociationRow): VendorBrandAssociation {
  return {
    id: Number(row.id),
    brandName: row.brand_name,
    isPrimary: row.is_primary,
    targetDaysOnHand: row.target_days_on_hand,
    assetUrl: row.asset_url,
    codRequired: row.cod_required,
    codDiscountSource: row.cod_discount_source,
    minimumOrderDollars:
      row.minimum_order_dollars === null ? null : Number(row.minimum_order_dollars),
    comments: row.comments,
  }
}

function mapHistory(row: DistributorHistoryRow): VendorObservedDistributor {
  return {
    name: row.distributor_name,
    purchaseCount: Number(row.purchase_count),
    lastDeliveryDate:
      row.last_delivery_date === null
        ? null
        : row.last_delivery_date instanceof Date
          ? row.last_delivery_date.toISOString().slice(0, 10)
          : String(row.last_delivery_date).slice(0, 10),
    siteKeys: row.site_keys,
  }
}

function mapVendor(
  row: VendorRow,
  associations: VendorBrandAssociation[],
  observedDistributors: VendorObservedDistributor[],
): Vendor {
  return {
    id: Number(row.id),
    name: row.name,
    isMso: row.is_mso,
    isMicro: row.is_micro,
    codOnly: row.cod_only,
    associations,
    observedDistributors,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export async function listVendors(db: Queryable): Promise<Vendor[]> {
  const vendorsResult = await db.query<VendorRow>(
    `select ${VENDOR_COLUMNS} from vendors order by lower(name), id limit 500`,
  )
  const vendorIds = vendorsResult.rows.map((row) => Number(row.id))
  if (vendorIds.length === 0) return []

  const [associationsResult, historyRows] = await Promise.all([
    db.query<AssociationRow>(
      `select id, vendor_id, brand_name, is_primary, target_days_on_hand,
              asset_url, cod_required, cod_discount_source,
              minimum_order_dollars, comments
         from vendor_brand_associations
        where vendor_id = any($1::bigint[])
        order by vendor_id, lower(brand_name), id
        limit 150000`,
      [vendorIds],
    ),
    loadDistributorHistory(db, vendorIds),
  ])

  const associations = new Map<number, VendorBrandAssociation[]>()
  for (const row of associationsResult.rows) {
    const vendorId = Number(row.vendor_id)
    const values = associations.get(vendorId) ?? []
    values.push(mapAssociation(row))
    associations.set(vendorId, values)
  }
  const history = new Map<number, VendorObservedDistributor[]>()
  for (const row of historyRows) {
    const vendorId = Number(row.vendor_id)
    const values = history.get(vendorId) ?? []
    values.push(mapHistory(row))
    history.set(vendorId, values)
  }

  return vendorsResult.rows.map((row) => {
    const id = Number(row.id)
    return mapVendor(row, associations.get(id) ?? [], history.get(id) ?? [])
  })
}

export async function getVendorById(db: Queryable, vendorId: number): Promise<Vendor | null> {
  const vendors = await listVendorRows(db, vendorId)
  return vendors[0] ?? null
}

async function listVendorRows(db: Queryable, vendorId: number): Promise<Vendor[]> {
  const row = await db.query<VendorRow>(
    `select ${VENDOR_COLUMNS} from vendors where id = $1`,
    [vendorId],
  )
  if (!row.rows[0]) return []
  const [associationRows, historyRows] = await Promise.all([
    db.query<AssociationRow>(
      `select id, vendor_id, brand_name, is_primary, target_days_on_hand,
              asset_url, cod_required, cod_discount_source, minimum_order_dollars, comments
         from vendor_brand_associations
        where vendor_id = $1
        order by lower(brand_name), id
        limit 300`,
      [vendorId],
    ),
    loadDistributorHistory(db, [vendorId]),
  ])
  return [
    mapVendor(
      row.rows[0],
      associationRows.rows.map(mapAssociation),
      historyRows.map(mapHistory),
    ),
  ]
}

async function loadDistributorHistory(
  db: Queryable,
  vendorIds: number[],
): Promise<DistributorHistoryRow[]> {
  const result = await db.query<DistributorHistoryRow>(
    `with history as (
       select a.vendor_id, p.distributor_name,
              count(distinct (p.dealer_id, p.po_id))::int as purchase_count,
              max(p.delivery_date) as last_delivery_date,
              array_agg(distinct p.site_key order by p.site_key) as site_keys
         from vendor_brand_associations a
         join sweed_purchase_line_items l on l.brand_name = a.brand_name
         join sweed_purchases p using (dealer_id, po_id)
        where a.vendor_id = any($1::bigint[])
          and p.distributor_name is not null
          and btrim(p.distributor_name) <> ''
        group by a.vendor_id, p.distributor_name
     ), ranked as (
       select history.*,
              row_number() over (
                partition by vendor_id
                order by last_delivery_date desc nulls last, purchase_count desc, lower(distributor_name)
              ) as history_rank
         from history
     )
     select vendor_id, distributor_name, purchase_count, last_delivery_date, site_keys
       from ranked
      where history_rank <= 20
      order by vendor_id, history_rank
      limit 10000`,
    [vendorIds],
  )
  return result.rows
}

export async function createVendor(db: Queryable, input: VendorCreateRequest): Promise<number> {
  const result = await db.query<{ id: number | string }>(
    `insert into vendors (name, is_mso, is_micro, cod_only)
     values ($1, $2, $3, $4) returning id`,
    [input.name, input.isMso, input.isMicro, input.codOnly],
  )
  const vendorId = Number(result.rows[0]!.id)
  await replaceVendorAssociations(db, vendorId, input.associations)
  return vendorId
}

export async function updateVendor(
  db: Queryable,
  vendorId: number,
  input: VendorUpdateRequest,
): Promise<boolean> {
  const existing = await db.query<VendorRow>(
    `select ${VENDOR_COLUMNS} from vendors where id = $1 for update`,
    [vendorId],
  )
  const row = existing.rows[0]
  if (!row) return false

  const next = {
    name: input.name ?? row.name,
    isMso: input.isMso ?? row.is_mso,
    isMicro: input.isMicro ?? row.is_micro,
    codOnly: input.codOnly ?? row.cod_only,
  }
  await db.query(
    `update vendors
        set name = $2, is_mso = $3, is_micro = $4, cod_only = $5, updated_at = now()
      where id = $1
        and (name, is_mso, is_micro, cod_only)
            is distinct from ($2::text, $3::boolean, $4::boolean, $5::boolean)`,
    [vendorId, next.name, next.isMso, next.isMicro, next.codOnly],
  )
  if (input.associations !== undefined) {
    await replaceVendorAssociations(db, vendorId, input.associations)
  }
  return true
}

export async function replaceVendorAssociations(
  db: Queryable,
  vendorId: number,
  associations: VendorBrandAssociationInput[],
): Promise<void> {
  const names = associations.map((item) => item.brandName)
  if (associations.length > 0) {
    await db.query(
      `insert into vendor_brand_associations
         (vendor_id, brand_name, is_primary, target_days_on_hand, asset_url,
          cod_required, cod_discount_source, minimum_order_dollars, comments)
       select $1, input.*
         from unnest(
           $2::text[], $3::boolean[], $4::integer[], $5::text[], $6::boolean[],
           $7::text[], $8::numeric[], $9::text[]
         ) as input(
           brand_name, is_primary, target_days_on_hand, asset_url, cod_required,
           cod_discount_source, minimum_order_dollars, comments
         )
       on conflict (vendor_id, lower(brand_name)) do update set
         brand_name = excluded.brand_name,
         is_primary = excluded.is_primary,
         target_days_on_hand = excluded.target_days_on_hand,
         asset_url = excluded.asset_url,
         cod_required = excluded.cod_required,
         cod_discount_source = excluded.cod_discount_source,
         minimum_order_dollars = excluded.minimum_order_dollars,
         comments = excluded.comments,
         updated_at = now()
       where (vendor_brand_associations.brand_name, vendor_brand_associations.is_primary,
              vendor_brand_associations.target_days_on_hand, vendor_brand_associations.asset_url,
              vendor_brand_associations.cod_required, vendor_brand_associations.cod_discount_source,
              vendor_brand_associations.minimum_order_dollars, vendor_brand_associations.comments)
             is distinct from
             (excluded.brand_name, excluded.is_primary, excluded.target_days_on_hand,
              excluded.asset_url, excluded.cod_required, excluded.cod_discount_source,
              excluded.minimum_order_dollars, excluded.comments)`,
      [
        vendorId,
        names,
        associations.map((item) => item.isPrimary),
        associations.map((item) => item.targetDaysOnHand),
        associations.map((item) => item.assetUrl),
        associations.map((item) => item.codRequired),
        associations.map((item) => item.codDiscountSource),
        associations.map((item) => item.minimumOrderDollars),
        associations.map((item) => item.comments),
      ],
    )
  }
  await db.query(
    `delete from vendor_brand_associations
      where vendor_id = $1
        and not (lower(brand_name) = any($2::text[]))`,
    [vendorId, names.map((name) => name.toLocaleLowerCase('en-US'))],
  )
}
