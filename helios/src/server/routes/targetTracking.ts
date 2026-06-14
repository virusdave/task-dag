import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  TargetTrackingConfigPutBodySchema,
  TargetTrackingConfigSchema,
  TargetTrackingResponseSchema,
  type TargetTrackingAgg,
  type TargetTrackingConfig,
  type TargetTrackingPerSiteConfig,
  type TargetTrackingPeriod,
} from '../../shared/contracts/index.js'
import { requireMetricsGrant, requireSessionUser } from '../auth/requireSession.js'
import {
  deleteAppSetting,
  getAppSettings,
  upsertAppSetting,
} from '../db/queries/appSettingsQueries.js'
import { getPool } from '../db/pool.js'
import { queryGrossMarginDollars } from '../metrics/_real/sweedPackageSnapshotsQueries.js'
import { advanceBucketStart, floorToBucketStart, previousBucketStart } from '../metrics/timeBuckets.js'

// Per-site config keys: `target_tracking_config:<siteKey>`. (The legacy
// pre-per-site global key `target_tracking_config` is intentionally NOT
// read — falling back to it would silently mask a site's missing config.)
const TARGET_TRACKING_CONFIG_KEY_PREFIX = 'target_tracking_config'
function configKey(siteKey: string): string {
  return `${TARGET_TRACKING_CONFIG_KEY_PREFIX}:${siteKey}`
}

const KNOWN_SITES: ReadonlyArray<{ siteKey: string; siteLabel: string }> =
  HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => ({
    siteKey: d.siteKey,
    siteLabel: d.siteLabel,
  }))
const SITE_BY_KEY = new Map(KNOWN_SITES.map((s) => [s.siteKey, s]))

const DAY_MS = 24 * 60 * 60 * 1000
const AVG_DAYS_PER_MONTH = 365.25 / 12

const MIGRATION_MISSING_RE = /relation .*app_settings.* does not exist/i
function isMigrationMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return MIGRATION_MISSING_RE.test(message)
}
function sendMigrationMissing(reply: FastifyReply): void {
  reply
    .status(503)
    .send({ error: 'app_settings table is missing. Apply migration 069_app_settings.sql.' })
}

function parseSites(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Resolve the requested `sites` query param to a deduped list of known
 * site keys. Empty ⇒ all known sites. Throws on any unknown site key so
 * the caller can return a 400 rather than silently dropping it.
 */
function resolveSites(raw: unknown): string[] {
  const requested = [...new Set(parseSites(raw))]
  const sites = requested.length > 0 ? requested : KNOWN_SITES.map((s) => s.siteKey)
  const unknown = sites.filter((s) => !SITE_BY_KEY.has(s))
  if (unknown.length > 0) throw new UnknownSiteError(unknown)
  return sites
}

/** Parse a single required `site` query param (PUT/DELETE). Null if invalid. */
function parseSingleSite(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const siteKey = raw.trim()
  return SITE_BY_KEY.has(siteKey) ? siteKey : null
}

class UnknownSiteError extends Error {
  constructor(public readonly sites: string[]) {
    super(`Unknown target-tracking site(s): ${sites.join(', ')}`)
    this.name = 'UnknownSiteError'
  }
}

/**
 * Build the aggregate `config` used for the cost breakdown + break-even
 * math across a multi-site selection. A single configured site returns
 * its own config verbatim; multiple sites collapse to per-site
 * fixed-cost subtotals plus a staffing-weighted blended labour rate so
 * the prorated totals (monthly fixed + weekly labour) are preserved
 * exactly. Returns null when no resolved site is configured.
 */
export function mergeConfigsForResponse(
  perSite: readonly TargetTrackingPerSiteConfig[],
): TargetTrackingConfig | null {
  const configured = perSite.filter(
    (s): s is TargetTrackingPerSiteConfig & { config: TargetTrackingConfig } =>
      s.config !== null,
  )
  if (configured.length === 0) return null
  if (configured.length === 1) return configured[0]!.config

  const fixedCosts = configured.map((s) => ({
    label: `${s.siteLabel} fixed costs`,
    monthlyDollars: s.config.fixedCosts.reduce((sum, c) => sum + c.monthlyDollars, 0),
  }))
  const weeklyStaffedHours = configured.reduce((sum, s) => sum + s.config.weeklyStaffedHours, 0)
  const weeklyLaborDollars = configured.reduce(
    (sum, s) => sum + s.config.laborRateDollarsPerHour * s.config.weeklyStaffedHours,
    0,
  )
  return {
    version: 1,
    fixedCosts,
    laborRateDollarsPerHour: weeklyStaffedHours > 0 ? weeklyLaborDollars / weeklyStaffedHours : 0,
    weeklyStaffedHours,
  }
}

function parseAgg(raw: unknown): TargetTrackingAgg {
  return raw === 'month' ? 'month' : 'week'
}

function parsePeriods(raw: unknown, agg: TargetTrackingAgg): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN
  if (Number.isFinite(n) && n >= 1 && n <= 24) return Math.floor(n)
  return agg === 'month' ? 6 : 8
}

/** Short label for a period, e.g. "Jun 8–14" (week) or "Jun 2026" (month). */
function periodLabel(start: Date, end: Date, agg: TargetTrackingAgg): string {
  const NY = 'America/New_York'
  if (agg === 'month') {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: NY,
      month: 'short',
      year: 'numeric',
    }).format(start)
  }
  const md = new Intl.DateTimeFormat('en-US', { timeZone: NY, month: 'short', day: 'numeric' })
  // Inclusive last day = end - 1ms.
  const lastDay = new Date(end.getTime() - 1)
  const dayOnly = new Intl.DateTimeFormat('en-US', { timeZone: NY, day: 'numeric' })
  return `${md.format(start)}\u2013${dayOnly.format(lastDay)}`
}

/**
 * Compute the target-tracking periods for `agg`, summing the actual
 * gross margin $ per period from a single metric query over the full
 * window. Costs are prorated by day-count so month length / partial
 * weeks are handled uniformly.
 */
async function computePeriods(args: {
  config: TargetTrackingConfig
  agg: TargetTrackingAgg
  sites: string[]
  count: number
  now: Date
}): Promise<TargetTrackingPeriod[]> {
  const { config, agg, sites, count, now } = args

  // Enumerate period starts: current period back `count-1` priors.
  const currentStart = floorToBucketStart(new Date(now.getTime() - 1), agg)
  const starts: Date[] = []
  let s = currentStart
  for (let i = 0; i < count; i++) {
    starts.push(s)
    s = previousBucketStart(s, agg)
  }
  starts.reverse() // oldest → newest
  const oldestStart = starts[0]!

  // One metric query over the whole window at the period grain.
  const marginRows = await queryGrossMarginDollars({
    sites,
    from: oldestStart,
    to: now,
    agg,
    categoryIds: [],
    subcategoryIds: [],
    brandIds: [],
    sizes: [],
  })
  const marginByStartMs = new Map<number, number>()
  for (const row of marginRows) {
    const ms = Date.parse(row.t)
    const v = row.gm_dollars
    if (!Number.isNaN(ms) && typeof v === 'number') marginByStartMs.set(ms, v)
  }

  const monthlyFixedTotal = config.fixedCosts.reduce((acc, c) => acc + c.monthlyDollars, 0)
  const dailyFixed = monthlyFixedTotal / AVG_DAYS_PER_MONTH
  const dailyLabor = (config.laborRateDollarsPerHour * config.weeklyStaffedHours) / 7

  return starts.map((start) => {
    const end = advanceBucketStart(start, agg)
    const daysInPeriod = (end.getTime() - start.getTime()) / DAY_MS
    const fixedDollars = round2(dailyFixed * daysInPeriod)
    const laborDollars = round2(dailyLabor * daysInPeriod)
    const breakEvenDollars = round2(fixedDollars + laborDollars)
    const actualMarginDollars = round2(marginByStartMs.get(start.getTime()) ?? 0)
    const isCurrent = end.getTime() > now.getTime()
    const elapsedMs = Math.min(now.getTime(), end.getTime()) - start.getTime()
    const fractionElapsed = isCurrent
      ? Math.max(0, Math.min(1, elapsedMs / (end.getTime() - start.getTime())))
      : 1
    const projectedMarginDollars =
      isCurrent && fractionElapsed > 0.02
        ? round2(actualMarginDollars / fractionElapsed)
        : null
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: periodLabel(start, end, agg),
      isCurrent,
      fractionElapsed,
      fixedDollars,
      laborDollars,
      breakEvenDollars,
      actualMarginDollars,
      projectedMarginDollars,
    }
  })
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Load per-site configs for the resolved `sites` in a single KV read and
 * assemble the full response: per-site editable configs, an aggregate
 * `config` for break-even, the computed periods (one margin query), and
 * the latest update among configured sites.
 */
async function buildResponse(args: {
  sites: string[]
  agg: TargetTrackingAgg
  count: number
  now: Date
}): Promise<unknown> {
  const { sites, agg, count, now } = args
  const settings = await getAppSettings(getPool(), sites.map(configKey))

  const perSite: TargetTrackingPerSiteConfig[] = sites.map((siteKey) => {
    const site = SITE_BY_KEY.get(siteKey)!
    const row = settings.get(configKey(siteKey))
    const parsed = row ? TargetTrackingConfigSchema.safeParse(row.value) : null
    const config = parsed && parsed.success ? parsed.data : null
    return {
      siteKey,
      siteLabel: site.siteLabel,
      config,
      updatedBy: config && row ? row.updatedBy : null,
      updatedAt: config && row ? row.updatedAt : null,
    }
  })

  const merged = mergeConfigsForResponse(perSite)
  const periods = merged ? await computePeriods({ config: merged, agg, sites, count, now }) : []

  // Top-level provenance = the most-recently-updated configured site.
  let latest: TargetTrackingPerSiteConfig | null = null
  for (const s of perSite) {
    if (s.config === null || s.updatedAt === null) continue
    if (latest === null || (latest.updatedAt !== null && s.updatedAt > latest.updatedAt)) latest = s
  }

  return {
    config: merged,
    perSite,
    resolved: { agg, sites },
    periods,
    updatedBy: latest?.updatedBy ?? null,
    updatedAt: latest?.updatedAt ?? null,
  }
}

export async function registerTargetTrackingRoutes(server: FastifyInstance): Promise<void> {
  // Read: gated identically to the sales/margin metrics ('explore').
  server.get('/api/target-tracking', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, 'explore')
    if (!user) return
    const query = (request.query ?? {}) as Record<string, unknown>
    const agg = parseAgg(query.agg)
    let sites: string[]
    try {
      sites = resolveSites(query.sites)
    } catch (error) {
      if (error instanceof UnknownSiteError) return reply.status(400).send({ error: error.message })
      throw error
    }
    const count = parsePeriods(query.periods, agg)
    try {
      const response = await buildResponse({ sites, agg, count, now: new Date() })
      return reply.send(TargetTrackingResponseSchema.parse(response))
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  // Write: admin only. Replaces one site's config blob (?site=<siteKey>).
  server.put('/api/target-tracking/config', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    const query = (request.query ?? {}) as Record<string, unknown>
    const siteKey = parseSingleSite(query.site)
    if (siteKey === null) {
      return reply
        .status(400)
        .send({ error: `site query param required (one of: ${KNOWN_SITES.map((s) => s.siteKey).join(', ')})` })
    }
    const body = TargetTrackingConfigPutBodySchema.parse(request.body)
    try {
      await upsertAppSetting(getPool(), configKey(siteKey), body, user.email)
      const response = await buildResponse({
        sites: [siteKey],
        agg: 'week',
        count: 8,
        now: new Date(),
      })
      return reply.send(TargetTrackingResponseSchema.parse(response))
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  // Reset: admin only. Drop one site's config row (?site=<siteKey>). Idempotent.
  server.delete('/api/target-tracking/config', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    const query = (request.query ?? {}) as Record<string, unknown>
    const siteKey = parseSingleSite(query.site)
    if (siteKey === null) {
      return reply
        .status(400)
        .send({ error: `site query param required (one of: ${KNOWN_SITES.map((s) => s.siteKey).join(', ')})` })
    }
    try {
      await deleteAppSetting(getPool(), configKey(siteKey))
      return reply.status(204).send()
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })
}
