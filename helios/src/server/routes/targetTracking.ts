import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  TargetTrackingConfigPutBodySchema,
  TargetTrackingConfigSchema,
  TargetTrackingResponseSchema,
  type TargetTrackingAgg,
  type TargetTrackingConfig,
  type TargetTrackingPeriod,
} from '../../shared/contracts/index.js'
import { requireMetricsGrant, requireSessionUser } from '../auth/requireSession.js'
import {
  deleteAppSetting,
  getAppSetting,
  upsertAppSetting,
} from '../db/queries/appSettingsQueries.js'
import { getPool } from '../db/pool.js'
import { queryGrossMarginDollars } from '../metrics/_real/sweedPackageSnapshotsQueries.js'
import { advanceBucketStart, floorToBucketStart, previousBucketStart } from '../metrics/timeBuckets.js'

const TARGET_TRACKING_CONFIG_KEY = 'target_tracking_config'

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

export async function registerTargetTrackingRoutes(server: FastifyInstance): Promise<void> {
  // Read: gated identically to the sales/margin metrics ('explore').
  server.get('/api/target-tracking', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, 'explore')
    if (!user) return
    const query = (request.query ?? {}) as Record<string, unknown>
    const agg = parseAgg(query.agg)
    const sites = parseSites(query.sites)
    const count = parsePeriods(query.periods, agg)
    try {
      const row = await getAppSetting(getPool(), TARGET_TRACKING_CONFIG_KEY)
      const parsed = row ? TargetTrackingConfigSchema.safeParse(row.value) : null
      const config = parsed && parsed.success ? parsed.data : null
      const periods = config
        ? await computePeriods({ config, agg, sites, count, now: new Date() })
        : []
      return reply.send(
        TargetTrackingResponseSchema.parse({
          config,
          resolved: { agg, sites },
          periods,
          updatedBy: row?.updatedBy ?? null,
          updatedAt: row?.updatedAt ?? null,
        }),
      )
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  // Write: admin only. Replaces the whole config blob.
  server.put('/api/target-tracking/config', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    const body = TargetTrackingConfigPutBodySchema.parse(request.body)
    try {
      const row = await upsertAppSetting(
        getPool(),
        TARGET_TRACKING_CONFIG_KEY,
        body,
        user.email,
      )
      return reply.send(
        TargetTrackingResponseSchema.parse({
          config: body,
          resolved: { agg: 'week', sites: [] },
          periods: await computePeriods({
            config: body,
            agg: 'week',
            sites: [],
            count: 8,
            now: new Date(),
          }),
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
        }),
      )
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  // Reset: admin only. Drop the config row. Idempotent.
  server.delete('/api/target-tracking/config', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    try {
      await deleteAppSetting(getPool(), TARGET_TRACKING_CONFIG_KEY)
      return reply.status(204).send()
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })
}
