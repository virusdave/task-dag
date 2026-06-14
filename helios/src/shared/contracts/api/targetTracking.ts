import { z } from 'zod'

// ---------------------------------------------------------------------------
// Target tracking — break-even progress per aggregation period.
//
// The operator configures the business's known costs (fixed monthly costs
// like rent / electricity, plus a blended labour rate × general staffing
// schedule). Helios prorates those to each period (week / month) to derive
// the break-even GROSS MARGIN $ the business must earn to cover costs, then
// charts the actual margin $ (net sales − COGS) earned each period against
// that target — with a pace projection for the in-progress current period.
//
// Config is persisted PER SITE in `app_settings` under the
// `target_tracking_config:<siteKey>` key — admins edit one site at a
// time, everyone reads. Actual margin $ is summed across the selected
// sites (default all). For a multi-site selection the server returns an
// aggregate `config` (site fixed-cost subtotals + a staffing-weighted
// blended labour rate) for the cost breakdown / break-even math, plus a
// `perSite` array carrying each site's exact editable config.
// ---------------------------------------------------------------------------

/** A single recurring fixed cost line (monthly basis). */
export const TargetTrackingFixedCostSchema = z.object({
  label: z.string().trim().min(1).max(60),
  monthlyDollars: z.number().finite().min(0),
})
export type TargetTrackingFixedCost = z.infer<typeof TargetTrackingFixedCostSchema>

/** The persisted, admin-editable cost configuration. */
export const TargetTrackingConfigSchema = z
  .object({
    version: z.literal(1),
    /** Recurring fixed costs (rent, electricity, insurance, …). */
    fixedCosts: z.array(TargetTrackingFixedCostSchema).max(40).default([]),
    /** Blended fully-loaded employee cost per staffed hour. */
    laborRateDollarsPerHour: z.number().finite().min(0).default(0),
    /** Total staffed employee-hours in a typical WEEK (across the schedule). */
    weeklyStaffedHours: z.number().finite().min(0).default(0),
  })
  .strict()
export type TargetTrackingConfig = z.infer<typeof TargetTrackingConfigSchema>

/** Aggregation periods supported by the target-tracking page. */
export const TargetTrackingAggSchema = z.enum(['week', 'month'])
export type TargetTrackingAgg = z.infer<typeof TargetTrackingAggSchema>

/** Per-period cost + actuals row. */
export const TargetTrackingPeriodSchema = z.object({
  /** ISO start instant of the period (business-day boundary). */
  start: z.string(),
  /** ISO end instant of the period (exclusive). */
  end: z.string(),
  /** Display label, e.g. "Jun 8–14" or "Jun 2026". */
  label: z.string().min(1),
  /** True for the single in-progress current period. */
  isCurrent: z.boolean(),
  /** 0..1 fraction of the period elapsed (1 for completed periods). */
  fractionElapsed: z.number().min(0).max(1),
  /** Prorated fixed cost for this period. */
  fixedDollars: z.number().finite(),
  /** Prorated labour cost for this period. */
  laborDollars: z.number().finite(),
  /** Break-even target = fixedDollars + laborDollars. */
  breakEvenDollars: z.number().finite(),
  /** Actual gross margin $ earned so far this period (net sales − COGS). */
  actualMarginDollars: z.number().finite(),
  /**
   * Pace-projected full-period margin $ for the CURRENT period
   * (actual / fractionElapsed). Null for completed periods (and when
   * fractionElapsed is ~0).
   */
  projectedMarginDollars: z.number().finite().nullable(),
})
export type TargetTrackingPeriod = z.infer<typeof TargetTrackingPeriodSchema>

/** One resolved site's saved config (null when that site is unconfigured). */
export const TargetTrackingPerSiteConfigSchema = z.object({
  siteKey: z.string().min(1),
  siteLabel: z.string().min(1),
  config: TargetTrackingConfigSchema.nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export type TargetTrackingPerSiteConfig = z.infer<typeof TargetTrackingPerSiteConfigSchema>

export const TargetTrackingResponseSchema = z.object({
  /**
   * Effective config for the resolved site selection. For a single site
   * it is that site's config; for a multi-site selection it is a
   * server-built aggregate (per-site fixed-cost subtotals + a
   * staffing-weighted blended labour rate) used only for display +
   * break-even math. Null when NONE of the resolved sites is configured
   * (page renders an empty state). Never edit this directly — use the
   * matching `perSite[].config`.
   */
  config: TargetTrackingConfigSchema.nullable(),
  /** One entry per resolved site, with that site's exact editable config. */
  perSite: z.array(TargetTrackingPerSiteConfigSchema),
  resolved: z.object({
    agg: TargetTrackingAggSchema,
    /** The resolved site keys (an empty request resolves to all sites). */
    sites: z.array(z.string()),
  }),
  /** Oldest → newest; the last entry is the in-progress current period. */
  periods: z.array(TargetTrackingPeriodSchema),
  /** Latest update among configured resolved sites (exact for one site). */
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export type TargetTrackingResponse = z.infer<typeof TargetTrackingResponseSchema>

export const TargetTrackingConfigPutBodySchema = TargetTrackingConfigSchema
export type TargetTrackingConfigPutBody = z.infer<typeof TargetTrackingConfigPutBodySchema>
