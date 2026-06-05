import { z } from 'zod'

/**
 * Background-task keys live under the Config module. Three task families
 * are exposed in the Workers > Scheduling subtree to start:
 *   - workers.scheduling.catalog   (TODO placeholder)
 *   - workers.scheduling.litalerts (TODO placeholder)
 *   - workers.scheduling.stock     (active full-stock refresh)
 *
 * The shared task-key naming makes the future migrations (catalog and
 * litalerts) drop into the same schedule/run rows without a schema change.
 */
export const CONFIG_BACKGROUND_TASK_KEYS = [
  'workers.scheduling.catalog',
  'workers.scheduling.edible_thc_clamp',
  'workers.scheduling.enrich_customer_address',
  'workers.scheduling.litalerts',
  'workers.scheduling.litalerts_retailer_backfill',
  'workers.scheduling.litalerts_rolling',
  'workers.scheduling.market_evidence_alarm',
  'workers.scheduling.stock',
  'workers.scheduling.sweed_orders_ingest',
  'workers.scheduling.sweed_package_snapshots',
  'workers.scheduling.sweed_purchases_ingest',
  'workers.scheduling.weather_daily_ingest',
  'workers.scheduling.sweed_shifts_ingest',
  'workers.scheduling.enrich_delivery_address',
  'workers.scheduling.enrich_visitor_scan_address',
  'workers.scheduling.sweed_orders_raw_json_drain',
] as const
export const ConfigBackgroundTaskKeySchema = z.enum(CONFIG_BACKGROUND_TASK_KEYS)
export type ConfigBackgroundTaskKey = z.infer<typeof ConfigBackgroundTaskKeySchema>

export interface ConfigBackgroundTaskDefinition {
  key: ConfigBackgroundTaskKey
  label: string
  /** Path segment inside `/config/workers/scheduling/<slug>`. */
  slug: string
  /** When false the task page renders a TODO placeholder rather than an editor. */
  implemented: boolean
  summary: string
}

export const CONFIG_BACKGROUND_TASKS: ReadonlyArray<ConfigBackgroundTaskDefinition> = [
  {
    key: 'workers.scheduling.catalog',
    label: 'Catalog',
    slug: 'catalog',
    implemented: true,
    summary: 'Periodic state-level catalog taxonomy snapshot (product, variant, brand, category, subcategory, strain, prevalence, size, distributor) so downstream Helios surfaces stay aligned with live Sweed taxonomy.',
  },
  {
    key: 'workers.scheduling.edible_thc_clamp',
    label: 'Edible THC clamp',
    slug: 'edible-thc-clamp',
    implemented: true,
    summary: 'Periodically scans Bronx + Midtown edibles (category 7459) and clamps each in-stock variant\'s Total THC (labDataAttributeId=1) lab data at 100mg/package — fixes Sweed\'s daily-purchase-limit calc when name-derived totals exceed the legal cap.',
  },
  {
    key: 'workers.scheduling.litalerts',
    label: 'Litalerts',
    slug: 'litalerts',
    implemented: true,
    summary: 'Drains the pending Lit Alerts refresh queue (one job per queued variant) by capturing competitor listings for each variant whose stock just transitioned out-of-stock to in-stock.',
  },
  {
    key: 'workers.scheduling.litalerts_retailer_backfill',
    label: 'Litalerts Retailer Backfill',
    slug: 'litalerts-retailer-backfill',
    implemented: true,
    summary: 'Daily slow refresh of Lit Alerts /v1/retailers/{id}/products for every NY competitor within our pricing distance bands (≤50mi). Resume-aware (skips retailers already refreshed in the last 12h), uses sub-exponential backoff on 5xx, and runs deferred-retry passes so transient upstream failures eventually drain.',
  },
  {
    key: 'workers.scheduling.litalerts_rolling',
    label: 'Litalerts Rolling',
    slug: 'litalerts-rolling',
    implemented: true,
    summary: 'Rolling 24h ± 2h market-data sweep: scans every catalog product for stale or absent Lit Alerts evidence and drops batches of stale variants back onto the Lit Alerts refresh queue with a deterministic per-product jitter so the load spreads evenly.',
  },
  {
    key: 'workers.scheduling.market_evidence_alarm',
    label: 'Market Evidence Alarm',
    slug: 'market-evidence-alarm',
    implemented: true,
    summary: 'Scans vw_pricing_evidence_freshness every 15 minutes for in-stock / pending-purchase / brand-match products whose competitor evidence is missing, expired, or about to expire; re-enqueues a market-data refresh at priority=0 and pages Dave when a class fires.',
  },
  {
    key: 'workers.scheduling.stock',
    label: 'Stock',
    slug: 'stock',
    implemented: true,
    summary: 'Periodic full per-site stock scan including out-of-stock items. Variant transitions from out-of-stock to in-stock auto-enqueue a Lit Alerts refresh for that variant.',
  },
  {
    key: 'workers.scheduling.sweed_orders_ingest',
    label: 'Sweed orders ingest',
    slug: 'sweed-orders-ingest',
    implemented: true,
    summary: 'Polls store.sale.invoice.list every 5 minutes per dealer, materialising completed invoices into the helios-owned sweed_orders table. Maintains a per-dealer highwater mark so worker crashes do not lose rows, and concurrently walks each dealer\'s history day-by-day back to the store-opening date. Backs the real-data implementations of every P2–P6 metric on the /metrics page tree.',
  },
  {
    key: 'workers.scheduling.sweed_package_snapshots',
    label: 'Sweed package snapshots',
    slug: 'sweed-package-snapshots',
    implemented: true,
    summary: 'Polls store.inventory.item.list.grouped (with isOnStock:false so sold-through packages remain visible) every 5 minutes per dealer during 08:00–02:00 ET. Versioned snapshot per (dealer, inventory_item_id): inserts a new row whenever the observed shape changes (wholesale cost, qty, lab, expiration, location), otherwise bumps observed_at_max. Unblocks the COGS / margin / inventory metrics on the /metrics page tree because wholesale cost is a per-PACKAGE attribute that Sweed does NOT expose on the invoice envelope. See automation#24.',
  },
  {
    key: 'workers.scheduling.sweed_purchases_ingest',
    label: 'Sweed purchases ingest',
    slug: 'sweed-purchases-ingest',
    implemented: true,
    summary: 'Polls store.purchase.order.list every 15 minutes per dealer, then fetches store.purchase.order.get for each non-pending PO and upserts a row into sweed_purchases + the per-line sweed_purchase_line_items. Direct-matches each line item to a sweed_package_snapshots row via externalTrackCode (Metrc tag) so the Catalog → Purchase Sell-Through page family can join purchase line items to sweed_orders.raw_json.items[] and report what we have actually paid for what has actually sold so far. Maintains a per-dealer highwater on delivery_date and walks history one day at a time toward the dealer\'s store-opening date.',
  },
  {
    key: 'workers.scheduling.weather_daily_ingest',
    label: 'Weather daily ingest',
    slug: 'weather-daily-ingest',
    implemented: true,
    summary: 'Pulls daily high/low temperature and precipitation from Open-Meteo\'s free Historical Weather API (ERA5 reanalysis) for each operating site (ZIPs 10019 / 10458). One scheduler tick per day re-fetches a trailing 7-day window per site so late-arriving reanalysis corrections land naturally. Cold-start backfill is self-derived from the earlier of (min(sweed_orders.pay_time)::date, 2024-01-01) on the first run. Backs the three real weather.scatter_* metrics on the /metrics page tree. See automation#26.',
  },
  {
    key: 'workers.scheduling.sweed_shifts_ingest',
    label: 'Sweed shifts ingest',
    slug: 'sweed-shifts-ingest',
    implemented: true,
    summary: 'Polls store.sale.shift.list every 15 minutes per dealer, materialising open + closed DRAWER/till shifts (one per hardware terminal, with a nested sessions[] array of cashier users that worked that drawer) into the helios-owned sweed_drawer_shifts + sweed_drawer_shift_sessions tables. Maintains a per-dealer highwater mark so worker crashes do not lose rows, walks each dealer\'s history day-by-day back to the store-opening date, and re-upserts open drawer-shifts so their close time + final shape land on a later poll. Unblocks the cashier.transactions_per_hour real metric on /metrics. See automation#27 (Option A redesign).',
  },
  {
    key: 'workers.scheduling.enrich_customer_address',
    label: 'Enrich customer address',
    slug: 'enrich-customer-address',
    implemented: true,
    summary: 'Every 5 minutes, pulls store.customer.get for distinct (dealer, customer) pairs observed on sweed_orders that do not yet have a primary address row in sweed_customer_addresses, upserting the result via the shared addresses table. The Census geocoder drains addresses with status=pending separately. Backs customers.origin_map (geocode-hierarchy roll-ups) for the non-delivery purchaser path Dave called out on automation#25.',
  },
  {
    key: 'workers.scheduling.enrich_delivery_address',
    label: 'Delivery address enrichment',
    slug: 'enrich-delivery-address',
    implemented: true,
    summary: 'Two-phase per tick: (1) walks delivery-typed sweed_orders rows whose delivery address is not yet resolved, calls store.sale.invoice.get per row, and upserts the returned address into the shared addresses table (linking the order + appending a delivery_seen row for the customer when present); (2) drains the addresses geocode queue via the free US Census Geocoder (≈ 1 RPS). Unblocks the customers.origin_map and delivery.order_count_by_zone metrics on /metrics. See FreshlyBakedNYC/automation#25.',
  },
  {
    key: 'workers.scheduling.enrich_visitor_scan_address',
    label: 'Visitor-scan address enrichment',
    slug: 'enrich-visitor-scan-address',
    implemented: true,
    summary: 'Two-phase per tick at backfill priority: (1) links up to batchSize (default 5000) visitor_scans rows that have address text but no address_id to a row in the shared addresses table; (2) drains the addresses geocode queue via the free US Census Geocoder (≈ 1 RPS, so the per-tick drain is naturally rate-limited). Customer-of-record geocodes back the /admin/customers/map customer-origin map. Webhook handlers also enqueue a single follow-up of this job per incoming scan whose VeriScan lat/lng is missing or within 500ft of either store (i.e. is actually the scanner kiosk location, not a real home).',
  },
  {
    key: 'workers.scheduling.sweed_orders_raw_json_drain',
    label: 'Sweed orders raw_json drain',
    slug: 'sweed-orders-raw-json-drain',
    implemented: true,
    summary: 'DB-cost maintenance (epic phase F5): nulls sweed_orders.raw_json for orders older than 30 days in bounded DB batches (default 500 rows/batch, ≤10 batches per tick, each its own short transaction with FOR UPDATE SKIP LOCKED). All request-time readers were migrated onto sweed_order_items_flat (items) and the cashier_user_id column (creatorId) in phases D1/F5, so the historical blob is pure dead weight — it was the single largest TOAST contributor on sweed_orders. Disk is reclaimed by autovacuum after the drain. Runs off-hours by default.',
  },
]

export function getConfigBackgroundTaskDefinition(key: ConfigBackgroundTaskKey): ConfigBackgroundTaskDefinition {
  const definition = CONFIG_BACKGROUND_TASKS.find((candidate) => candidate.key === key)
  if (!definition) {
    throw new Error(`Unknown Helios config background task: ${key}`)
  }
  return definition
}

export function getConfigBackgroundTaskBySlug(slug: string): ConfigBackgroundTaskDefinition | null {
  return CONFIG_BACKGROUND_TASKS.find((candidate) => candidate.slug === slug) ?? null
}

/** 7-bit weekday mask: bit 0 = Sunday, ..., bit 6 = Saturday. */
export const WEEKDAY_MASK_ALL = 0b1111111

export const ConfigWorkerScheduleWindowSchema = z.object({
  id: z.number().int().positive().optional(),
  weekdayMask: z.number().int().min(0).max(WEEKDAY_MASK_ALL),
  windowStartMinute: z.number().int().min(0).max(1440),
  windowEndMinute: z.number().int().min(0).max(1440),
  intervalMinutes: z.number().int().min(1).max(1440),
  paused: z.boolean(),
  notes: z.string().nullable(),
})
export type ConfigWorkerScheduleWindow = z.infer<typeof ConfigWorkerScheduleWindowSchema>

export const ConfigWorkerScheduleSchema = z.object({
  taskKey: ConfigBackgroundTaskKeySchema,
  taskLabel: z.string(),
  taskSummary: z.string(),
  implemented: z.boolean(),
  windows: z.array(ConfigWorkerScheduleWindowSchema),
  lastEnqueuedAt: z.string().nullable(),
  lastEnqueuedJobId: z.number().int().positive().nullable(),
})
export type ConfigWorkerSchedule = z.infer<typeof ConfigWorkerScheduleSchema>

/**
 * Default schedule rows used the first time a task_key is materialized.
 * The user's stock-refresh ask is "every 2 minutes between 8am and 2am,
 * every 15 minutes 2am to 8am". That is two windows on the same task_key
 * with a 7-day weekday mask each.
 */
export const STOCK_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<Omit<ConfigWorkerScheduleWindow, 'id'>> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 8 * 60, // 08:00
    windowEndMinute: 2 * 60,   // 02:00 next day (wraps)
    intervalMinutes: 2,
    paused: false,
    notes: 'Daytime cadence (08:00 -> 02:00).',
  },
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 2 * 60, // 02:00
    windowEndMinute: 8 * 60,   // 08:00
    intervalMinutes: 15,
    paused: false,
    notes: 'Off-hours cadence (02:00 -> 08:00).',
  },
]

/**
 * Default schedule for the Lit Alerts refresh drainer. Modest cadence
 * because the queue refills only when a variant transitions out-of-stock
 * to in-stock, and each scheduler tick may enqueue many per-variant jobs
 * in one batch.
 */
export const LITALERTS_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<Omit<ConfigWorkerScheduleWindow, 'id'>> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 5,
    paused: false,
    notes: 'Drain pending Lit Alerts refresh queue every 5 minutes.',
  },
]

/**
 * Default schedule for the rolling 24h ± 2h Lit Alerts market-data
 * sweep. The scheduler scans the freshness view and re-enqueues any
 * product whose `next_refresh_at` has elapsed, capped at 100 products
 * per tick — so a 5-minute cadence is fast enough to roll a few
 * thousand products through within ~an hour while staying well below
 * partner-API rate ceilings.
 */
export const LITALERTS_ROLLING_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<Omit<ConfigWorkerScheduleWindow, 'id'>> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 5,
    paused: false,
    notes: 'Rolling 24h ± 2h market-data sweep tick (every 5 minutes, capped at 100 products).',
  },
]

/**
 * Default schedule for the market-evidence alarm scanner. Runs every
 * 15 minutes; the scanner is cheap (one read against the freshness view
 * plus an idempotent per-product enqueue) so the cadence is bounded only
 * by how quickly we want alarm conditions to surface in the queue.
 */
export const MARKET_EVIDENCE_ALARM_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<Omit<ConfigWorkerScheduleWindow, 'id'>> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 15,
    paused: false,
    notes: 'Scan freshness view for alarm-class products with stale/expired/absent evidence every 15 minutes.',
  },
]

/**
 * Default schedule for the edible THC clamp sweep. Runs every 15 minutes;
 * the scan is bounded (only category 7459 in two site dealers, only
 * in-stock lots) and the worker dedupes per item against the current
 * lab data, so consecutive ticks are cheap noops once the catalog has
 * been corrected.
 */
export const EDIBLE_THC_CLAMP_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<Omit<ConfigWorkerScheduleWindow, 'id'>> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 15,
    paused: false,
    notes: 'Clamp every in-stock edible variant\'s THC lab data to <=100 mg/package every 15 minutes.',
  },
]

/**
 * Default schedule for the Lit Alerts nearby-retailer products
 * backfill. Runs once per day in the small hours; the job itself is
 * resume-aware (any retailer with a `litalerts_products` row newer
 * than the skip window is left alone), so the daily tick naturally
 * focuses on retailers that 5xx'd or otherwise missed the previous
 * pass. The 02:00 wake-up is paired with the worker's deferred-retry
 * passes so any retailer that fails the first pass is re-attempted
 * with progressively slower fanout before the job exits.
 */
export const LITALERTS_RETAILER_BACKFILL_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<Omit<ConfigWorkerScheduleWindow, 'id'>> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 2 * 60, // 02:00
    windowEndMinute: 2 * 60 + 30, // narrow 30-min wake window
    intervalMinutes: 1440,
    paused: false,
    notes: 'Daily slow refresh of <=50mi NY competitor product listings (02:00).',
  },
]

/**
 * Default schedule for the Catalog state-level taxonomy refresh worker.
 * Daytime cadence is brisk; off-hours falls back to a lighter cadence to
 * keep the state catalog dealer free of unnecessary churn.
 */
export const CATALOG_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<Omit<ConfigWorkerScheduleWindow, 'id'>> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 8 * 60, // 08:00
    windowEndMinute: 2 * 60,   // 02:00 next day (wraps)
    intervalMinutes: 5,
    paused: false,
    notes: 'Daytime cadence (08:00 -> 02:00).',
  },
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 2 * 60, // 02:00
    windowEndMinute: 8 * 60,   // 08:00
    intervalMinutes: 15,
    paused: false,
    notes: 'Off-hours cadence (02:00 -> 08:00).',
  },
]

/**
 * Default schedule for the Sweed orders ingest worker. Runs every 5
 * minutes around the clock; each tick does a short forward poll from
 * the per-dealer highwater AND one day of backwards backfill until
 * the dealer's store-opening date is reached. See
 * FreshlyBakedNYC/automation#22.
 */
export const SWEED_ORDERS_INGEST_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<Omit<ConfigWorkerScheduleWindow, 'id'>> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 5,
    paused: false,
    notes: 'Forward-poll Sweed for new completed invoices + one day of historical backfill, every 5 minutes.',
  },
]

/**
 * Per-dealer store-opening dates, used by the Sweed orders ingest
 * worker as the hard floor for the backwards-backfill cursor. Stored
 * as ISO local-date strings (no time component); the worker
 * interprets these in America/New_York to compute the day boundary
 * UTC instants when calling `store.sale.invoice.list`.
 *
 * Sourced from operator (Dave) on 2026-05-26:
 *   * Bronx   opened in Sweed on 2025-07-15
 *   * Midtown opened on            2026-04-01
 *
 * If a new dealer is onboarded, add its entry here; the ingest
 * worker will pick it up on its next tick (it inserts a highwater
 * row with `min_pay_time` = this date if none exists).
 */
export const HELIOS_SWEED_DEALER_OPENING_DATES: Readonly<Record<number, string>> = {
  210249: '2025-07-15', // Bronx
  210705: '2026-04-01', // Midtown
}

/**
 * Default schedule for the Sweed package-snapshot worker.
 *
 * Operator-directed cadence (2026-05-26):
 *   "If done on a 5-minute cadence from 8am to 2am, and versioned per-
 *    package for historical record, then this should be trivial to
 *    join as needed."
 *
 * We honour that as one wrap-across-midnight window: `[08:00, 02:00)`
 * ET, every 5 minutes. The 02:00–08:00 quiet block intentionally
 * leaves Sweed RPC budget for overnight historical-backfill jobs.
 *
 * See FreshlyBakedNYC/automation#24.
 */
export const SWEED_PACKAGE_SNAPSHOTS_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<
  Omit<ConfigWorkerScheduleWindow, 'id'>
> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 8 * 60,   // 08:00
    windowEndMinute: 2 * 60,     // 02:00 (next day; wrapping window)
    intervalMinutes: 5,
    paused: false,
    notes: 'Per-dealer package-snapshot sweep via store.inventory.item.list.grouped (isOnStock:false). Quiet 02:00–08:00 ET leaves Sweed budget for overnight historical backfills.',
  },
]

/**
 * Per-site (ZIP) lat/long lookup used by the daily weather ingest
 * worker. v1 is hard-coded for the two operating sites; if a third
 * site opens this becomes an operator surface (see automation#26).
 *
 * Coordinates pulled from the issue spec (Midtown Manhattan and
 * Bronx / Fordham centroids).
 */
export interface HeliosWeatherSiteCoord {
  readonly siteZip: string
  readonly siteLabel: string
  /** Sweed dealer id; used for the dealer → zip lookup on the metrics-join side. */
  readonly dealerId: number
  readonly latitude: number
  readonly longitude: number
}

export const HELIOS_WEATHER_SITES: ReadonlyArray<HeliosWeatherSiteCoord> = [
  {
    siteZip: '10019',
    siteLabel: 'Midtown',
    dealerId: 210705,
    latitude: 40.7647,
    longitude: -73.9842,
  },
  {
    siteZip: '10458',
    siteLabel: 'Bronx',
    dealerId: 210249,
    latitude: 40.8623,
    longitude: -73.887,
  },
]

/** Dealer → site ZIP lookup used by the weather-correlation metric joins. */
export const HELIOS_SITE_ZIP_BY_DEALER: Readonly<Record<number, string>> =
  Object.fromEntries(HELIOS_WEATHER_SITES.map((s) => [s.dealerId, s.siteZip]))

/**
 * Default schedule for the daily weather ingest worker.
 *
 * Operator-directed cadence (2026-05-26): "Daily at 06:00 ET".
 * Helios's clock runs in America/Panama (UTC-05:00, no DST), so a
 * narrow [06:00, 07:00) wall-clock window on the server fires once
 * per day at ~06:00 EST / ~07:00 EDT in NY. Open-Meteo's ERA5
 * reanalysis updates with a multi-day lag, so the exact wall-clock
 * hour does not matter for data freshness; the worker re-pulls a
 * trailing 7-day window each tick to absorb late corrections.
 *
 * See FreshlyBakedNYC/automation#26.
 */
export const WEATHER_DAILY_INGEST_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<
  Omit<ConfigWorkerScheduleWindow, 'id'>
> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 6 * 60,   // 06:00 server local
    windowEndMinute: 7 * 60,     // 07:00 server local
    intervalMinutes: 1440,        // once per day
    paused: false,
    notes: 'Daily Open-Meteo pull for the two operating sites (~06:00 EST / 07:00 EDT in NY).',
  },
]

/**
 * Default schedule for the Sweed shifts ingest worker.
 *
 * Shifts mutate far less frequently than invoices (one open/close
 * pair per employee per day at typical staffing), so a 15-minute
 * cadence around the clock is sufficient to land both the open and
 * (eventual) close edges within one polling window of when they
 * happen at the POS. Each tick also walks one historical day of
 * backfill until the per-dealer min_open_time is reached.
 *
 * See FreshlyBakedNYC/automation#27.
 */
export const SWEED_SHIFTS_INGEST_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<
  Omit<ConfigWorkerScheduleWindow, 'id'>
> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 15,
    paused: false,
    notes: 'Forward-poll Sweed for new/updated shifts + one day of historical backfill, every 15 minutes.',
  },
]

/**
 * Default schedule for the Sweed purchases (PO) ingest worker that
 * backs the Catalog → Purchase Sell-Through page family. Runs every
 * 15 minutes; each tick does a short forward poll from the per-dealer
 * highwater AND 30 days of backwards backfill until the dealer's
 * store-opening date is reached. PO volume per dealer is small
 * (10–30 POs/day) so 30 days/tick is comfortably under any RPC limit
 * and walks ~1 year of history in ~13 ticks.
 */
export const SWEED_PURCHASES_INGEST_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<
  Omit<ConfigWorkerScheduleWindow, 'id'>
> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 15,
    paused: false,
    notes:
      'Forward-poll Sweed for new/updated POs + 30 days of historical backfill, every 15 minutes.',
  },
]

/**
 * Default schedule for the customer-of-record address enrichment worker
 * (A5 of FreshlyBakedNYC/automation#25).
 *
 * One job per scheduler tick walks distinct (dealer, customer) pairs
 * surfaced on sweed_orders that do not yet have a primary
 * sweed_customer_addresses row, capping the per-tick RPC budget at
 * `batchSize` (default 60). At 60/tick * 12 ticks/h = ~720 customers/h
 * per dealer; trailing-90-day non-guest customer counts on the two
 * operating sites are well under 24h of catch-up at that rate.
 */
export const ENRICH_CUSTOMER_ADDRESS_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<
  Omit<ConfigWorkerScheduleWindow, 'id'>
> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 5,
    paused: false,
    notes: 'Drain unseen customer ids -> store.customer.get -> addresses upsert, every 5 minutes (rate-limited per tick).',
  },
]

/**
 * Default schedule for the delivery-address enrichment worker
 * (FreshlyBakedNYC/automation#25).
 *
 * Two phases per tick (Sweed RPCs + Census geocodes), batchSize=60
 * by default → wall-clock budget around two minutes per tick. A
 * 5-minute cadence comfortably absorbs that and matches the
 * sibling sweed_orders_ingest worker so newly-ingested delivery
 * orders surface on the map within ~10 minutes of pay time.
 */
export const ENRICH_DELIVERY_ADDRESS_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<
  Omit<ConfigWorkerScheduleWindow, 'id'>
> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 5,
    paused: false,
    notes: 'Per-invoice delivery-address pull + Census geocode drain, every 5 minutes.',
  },
]

/**
 * Default schedule for the visitor-scan address enrichment worker.
 *
 * Phase 1 (linking) is a pure SQL upsert sweep and is bounded by
 * batchSize=5000; phase 2 (Census geocode drain) is bounded by the
 * shared Census client's ~1 RPS rate limit. A 5-minute cadence
 * matches the other Census-draining workers so the queue stays
 * level instead of bursty.
 */
export const ENRICH_VISITOR_SCAN_ADDRESS_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<
  Omit<ConfigWorkerScheduleWindow, 'id'>
> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 5,
    paused: false,
    notes: 'Visitor-scan address linking (batch=5000) + Census geocode drain, every 5 minutes at backfill priority.',
  },
]

export const SWEED_ORDERS_RAW_JSON_DRAIN_DEFAULT_SCHEDULE_WINDOWS: ReadonlyArray<
  Omit<ConfigWorkerScheduleWindow, 'id'>
> = [
  {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 2 * 60, // 02:00 server local (off-hours)
    windowEndMinute: 8 * 60, // 08:00 server local
    intervalMinutes: 15,
    paused: false,
    notes: 'Null sweed_orders.raw_json for orders older than 30 days in bounded DB batches (≤500 rows/batch, ≤10 batches/tick). Off-hours so the candidate scan + dead-tuple churn never competes with daytime serving (DB-cost epic phase F5).',
  },
]
