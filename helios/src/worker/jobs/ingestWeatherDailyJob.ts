import { z } from 'zod'

import {
  HELIOS_WEATHER_SITES,
  type ConfigWorkersWeatherDailyIngestJobPayload,
  type HeliosWeatherSiteCoord,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// ============================================================================
// Daily weather ingest worker (FreshlyBakedNYC/automation#26).
//
// One scheduler tick = one job. For each operating site (ZIP -> lat/long
// in HELIOS_WEATHER_SITES) we:
//
//   1. **Trailing-window pull** — fetch the trailing N days
//      (payload.trailingDays, default 7) from Open-Meteo's free
//      Historical Weather API, upsert into `weather_daily` keyed on
//      `(site_zip, date)`. Re-pulls intentionally OVERWRITE earlier
//      values so Open-Meteo's slow-arriving ERA5 reanalysis
//      corrections land naturally on the next tick.
//
//   2. **Cold-start backfill** — if `weather_daily` has zero rows for
//      this site, also pull from the earlier of (min(sweed_orders
//      .pay_time)::date, '2024-01-01') through today, all in one
//      Open-Meteo call. Operators can force a re-pull of any
//      historical range via `payload.backfillStartIsoDate`.
//
// Open-Meteo's Historical API is free, no key, no rate limit at
// our volume — single HTTPS GET per (site, day-range), JSON
// response, ECMWF/ERA5 reanalysis. See open-meteo.com/en/docs.
// ============================================================================

const NY_TZ = 'America/New_York'
const COLD_START_FLOOR_ISO = '2024-01-01'
const OPEN_METEO_BASE_URL = 'https://archive-api.open-meteo.com/v1/archive'
const FETCH_TIMEOUT_MS = 60_000

// ----- Open-Meteo response schema -----
//
// The daily endpoint returns parallel arrays: `daily.time[i]` is the
// ISO date for the i-th element of every other `daily.*` array.
// We coerce numeric fields defensively (Open-Meteo occasionally
// returns nulls for individual days, especially near the trailing
// edge of the reanalysis window).
const OpenMeteoDailySchema = z.object({
  time: z.array(z.string()),
  temperature_2m_max: z.array(z.number().nullable()),
  temperature_2m_min: z.array(z.number().nullable()),
  precipitation_sum: z.array(z.number().nullable()),
})

const OpenMeteoResponseSchema = z
  .object({
    daily: OpenMeteoDailySchema,
  })
  .passthrough()

interface DailyRow {
  date: string // YYYY-MM-DD
  highTempF: number | null
  lowTempF: number | null
  precipIn: number | null
  raw: unknown
}

// ----- Job entry point -----

export async function runIngestWeatherDailyJob(
  context: JobHandlerContext,
  payload: ConfigWorkersWeatherDailyIngestJobPayload,
): Promise<void> {
  const today = nyDateString(new Date())
  const trailingStart = subtractIsoDays(today, Math.max(payload.trailingDays - 1, 0))

  const perSite: Array<{
    siteZip: string
    label: string
    trailingFetched: number
    trailingUpserted: number
    backfillRangeStart: string | null
    backfillFetched: number
    backfillUpserted: number
    error: string | null
  }> = []

  for (const site of HELIOS_WEATHER_SITES) {
    try {
      const trailing = await fetchAndUpsert(site, trailingStart, today)

      // Decide cold-start or operator-forced backfill range.
      let backfillStart: string | null = payload.backfillStartIsoDate ?? null
      if (backfillStart === null) {
        const hasRows = await siteHasAnyRows(site.siteZip)
        if (!hasRows) {
          backfillStart = await deriveColdStartAnchor()
        }
      }

      let backfillFetched = 0
      let backfillUpserted = 0
      if (backfillStart !== null && backfillStart < trailingStart) {
        // Backfill covers [backfillStart, day-before-trailingStart].
        // The trailing-window pull above already covers
        // [trailingStart, today], so we don't refetch those days.
        const backfillEnd = subtractIsoDays(trailingStart, 1)
        const result = await fetchAndUpsert(site, backfillStart, backfillEnd)
        backfillFetched = result.fetched
        backfillUpserted = result.upserted
      }

      perSite.push({
        siteZip: site.siteZip,
        label: site.siteLabel,
        trailingFetched: trailing.fetched,
        trailingUpserted: trailing.upserted,
        backfillRangeStart: backfillStart,
        backfillFetched,
        backfillUpserted,
        error: null,
      })
    } catch (e) {
      perSite.push({
        siteZip: site.siteZip,
        label: site.siteLabel,
        trailingFetched: 0,
        trailingUpserted: 0,
        backfillRangeStart: null,
        backfillFetched: 0,
        backfillUpserted: 0,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.weather_daily_ingest.completed',
      module: 'config',
      payload: {
        jobId: context.id,
        trigger: payload.trigger,
        trailingDays: payload.trailingDays,
        trailingStartIsoDate: trailingStart,
        backfillStartIsoDateOverride: payload.backfillStartIsoDate,
        perSite,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

// ----- Fetch + upsert one site over [startIso, endIso] inclusive. -----

interface FetchAndUpsertResult {
  fetched: number
  upserted: number
}

async function fetchAndUpsert(
  site: HeliosWeatherSiteCoord,
  startIso: string,
  endIso: string,
): Promise<FetchAndUpsertResult> {
  if (startIso > endIso) {
    return { fetched: 0, upserted: 0 }
  }
  const rows = await fetchOpenMeteoDaily(site, startIso, endIso)
  let upserted = 0
  await withTransaction(async (db) => {
    for (const r of rows) {
      const result = await db.query(
        `
          insert into weather_daily (
            site_zip, date, high_temp_f, low_temp_f, precip_in, source,
            ingested_at, raw_json
          ) values (
            $1, $2, $3, $4, $5, 'open-meteo', now(), $6::jsonb
          )
          on conflict (site_zip, date) do update set
            high_temp_f = excluded.high_temp_f,
            low_temp_f = excluded.low_temp_f,
            precip_in = excluded.precip_in,
            source = excluded.source,
            ingested_at = excluded.ingested_at,
            raw_json = excluded.raw_json
        `,
        [
          site.siteZip,
          r.date,
          r.highTempF,
          r.lowTempF,
          r.precipIn,
          JSON.stringify(r.raw),
        ],
      )
      if ((result.rowCount ?? 0) > 0) upserted++
    }
  })
  return { fetched: rows.length, upserted }
}

async function fetchOpenMeteoDaily(
  site: HeliosWeatherSiteCoord,
  startIso: string,
  endIso: string,
): Promise<DailyRow[]> {
  const url = new URL(OPEN_METEO_BASE_URL)
  url.searchParams.set('latitude', String(site.latitude))
  url.searchParams.set('longitude', String(site.longitude))
  url.searchParams.set('start_date', startIso)
  url.searchParams.set('end_date', endIso)
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum')
  url.searchParams.set('timezone', NY_TZ)
  url.searchParams.set('temperature_unit', 'fahrenheit')
  url.searchParams.set('precipitation_unit', 'inch')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let body: unknown
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable body>')
      throw new Error(
        `Open-Meteo fetch failed for site ${site.siteZip} (${startIso}..${endIso}): HTTP ${response.status} ${response.statusText} body=${text.slice(0, 500)}`,
      )
    }
    body = await response.json()
  } finally {
    clearTimeout(timeout)
  }

  const parsed = OpenMeteoResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new Error(
      `Open-Meteo response for site ${site.siteZip} failed schema validation: ${parsed.error.message}`,
    )
  }
  const daily = parsed.data.daily
  const len = daily.time.length
  if (
    daily.temperature_2m_max.length !== len ||
    daily.temperature_2m_min.length !== len ||
    daily.precipitation_sum.length !== len
  ) {
    throw new Error(
      `Open-Meteo response for site ${site.siteZip} had mismatched daily array lengths`,
    )
  }
  const rows: DailyRow[] = []
  for (let i = 0; i < len; i++) {
    rows.push({
      date: daily.time[i]!,
      highTempF: daily.temperature_2m_max[i],
      lowTempF: daily.temperature_2m_min[i],
      precipIn: daily.precipitation_sum[i],
      raw: {
        date: daily.time[i],
        temperature_2m_max: daily.temperature_2m_max[i],
        temperature_2m_min: daily.temperature_2m_min[i],
        precipitation_sum: daily.precipitation_sum[i],
      },
    })
  }
  return rows
}

async function siteHasAnyRows(siteZip: string): Promise<boolean> {
  const result = await getPool().query<{ exists: boolean }>(
    `select exists(select 1 from weather_daily where site_zip = $1) as exists`,
    [siteZip],
  )
  return result.rows[0]?.exists === true
}

/** Cold-start anchor = earlier of (min(sweed_orders.pay_time)::date, '2024-01-01'). */
async function deriveColdStartAnchor(): Promise<string> {
  const result = await getPool().query<{ min_iso_date: string | null }>(
    `select to_char(min(pay_time) at time zone $1, 'YYYY-MM-DD') as min_iso_date from sweed_orders`,
    [NY_TZ],
  )
  const minIso = result.rows[0]?.min_iso_date ?? null
  if (minIso !== null && minIso < COLD_START_FLOOR_ISO) {
    return minIso
  }
  return COLD_START_FLOOR_ISO
}

// ----- ET-day helpers -----

function partsInNY(d: Date): { y: number; m: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const map: Record<string, string> = {}
  for (const p of fmt.formatToParts(d)) map[p.type] = p.value
  return {
    y: Number(map.year),
    m: Number(map.month),
    day: Number(map.day),
  }
}

/** "YYYY-MM-DD" of the given UTC instant interpreted in NY. */
function nyDateString(d: Date): string {
  const { y, m, day } = partsInNY(d)
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Subtract `n` days from a "YYYY-MM-DD" string (UTC arithmetic — safe for ISO calendar dates). */
function subtractIsoDays(iso: string, n: number): string {
  if (n === 0) return iso
  const [yStr, mStr, dStr] = iso.split('-')
  const t = Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr)) - n * 24 * 60 * 60 * 1000
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
