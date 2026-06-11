// P6 revenue guardrail (parent EPIC_PLAN §10 P6): "auto-revert pointer
// if conversion rate drops >15% vs baseline for 5 min".
//
// This module is the PURE decision logic only. It takes already-computed
// conversion aggregates (the caller supplies them from the lp_events
// sink) and returns a decision. It performs NO database I/O and NO
// pointer writes itself, so it ships zero recurring DB cost.
//
// Wiring this into a periodic job that (a) queries lp_events and (b)
// actually flips the live pointer is an OPERATOR-gated step: per canon §3
// any new recurring/background DB workload needs a written cost budget +
// an Oracle DB-efficiency review before deploy, and per canon §1 an
// auto-revert that writes `current.json` only runs against prod with
// operator authorization. Until then `autoRevertEnabled` defaults to
// false and the strongest action this returns is `would-revert` (alert).

export interface GuardrailWindow {
  readonly impressions: number
  readonly conversions: number
}

export interface RevenueGuardrailConfig {
  /** Relative conversion-rate drop that trips the guardrail, in bps (1500 = 15%). */
  readonly maxConversionDropBps: number
  /** Minimum canary impressions before a decision is statistically meaningful. */
  readonly minCanaryImpressions: number
  /** Minimum baseline impressions before a decision is meaningful. */
  readonly minBaselineImpressions: number
  /** Reject data older than this (seconds); stale telemetry must not trigger a revert. */
  readonly maxDataAgeSeconds: number
  /** When false (default), a breach yields `would-revert` (alert only), never `revert`. */
  readonly autoRevertEnabled: boolean
}

export const DEFAULT_REVENUE_GUARDRAIL_CONFIG: RevenueGuardrailConfig = {
  maxConversionDropBps: 1500, // 15%
  minCanaryImpressions: 500,
  minBaselineImpressions: 500,
  maxDataAgeSeconds: 20 * 60, // 20 min: > the 15-min batch flush interval
  autoRevertEnabled: false,
}

export interface GuardrailInput {
  readonly baseline: GuardrailWindow
  readonly canary: GuardrailWindow
  /** Age of the freshest data point feeding these windows, in seconds. */
  readonly dataAgeSeconds: number
  readonly config?: Partial<RevenueGuardrailConfig>
}

export type GuardrailAction =
  | 'hold' // canary healthy
  | 'insufficient-data' // not enough sample yet
  | 'stale-data' // telemetry too old to trust
  | 'would-revert' // breach, but auto-revert disabled → alert only
  | 'revert' // breach + auto-revert enabled

export interface GuardrailDecision {
  readonly action: GuardrailAction
  readonly baselineRateBps: number
  readonly canaryRateBps: number
  /** Relative drop of canary vs baseline, in bps (positive = canary worse). */
  readonly relativeDropBps: number
  readonly reason: string
}

function rateBps(w: GuardrailWindow): number {
  if (w.impressions <= 0) return 0
  return Math.round((w.conversions / w.impressions) * 10000)
}

/**
 * Evaluate one window of canary-vs-baseline conversion data. Fail-safe:
 * stale or thin data never returns a revert; only a confirmed relative
 * drop beyond the threshold, with adequate sample and fresh data, does.
 * The "for 5 min" sustained requirement is the caller's responsibility
 * (require N consecutive breaching windows before acting).
 */
export function evaluateRevenueGuardrail(input: GuardrailInput): GuardrailDecision {
  const config = { ...DEFAULT_REVENUE_GUARDRAIL_CONFIG, ...input.config }
  const baselineRateBps = rateBps(input.baseline)
  const canaryRateBps = rateBps(input.canary)
  const relativeDropBps =
    baselineRateBps > 0
      ? Math.round(((baselineRateBps - canaryRateBps) / baselineRateBps) * 10000)
      : 0

  const base = { baselineRateBps, canaryRateBps, relativeDropBps }

  if (input.dataAgeSeconds > config.maxDataAgeSeconds) {
    return {
      ...base,
      action: 'stale-data',
      reason: `data age ${input.dataAgeSeconds}s exceeds max ${config.maxDataAgeSeconds}s; not acting on stale telemetry`,
    }
  }

  if (
    input.canary.impressions < config.minCanaryImpressions ||
    input.baseline.impressions < config.minBaselineImpressions
  ) {
    return {
      ...base,
      action: 'insufficient-data',
      reason:
        `sample too small (canary ${input.canary.impressions}/${config.minCanaryImpressions}, ` +
        `baseline ${input.baseline.impressions}/${config.minBaselineImpressions})`,
    }
  }

  if (baselineRateBps <= 0) {
    return {
      ...base,
      action: 'insufficient-data',
      reason: 'baseline conversion rate is zero; relative drop undefined',
    }
  }

  if (relativeDropBps > config.maxConversionDropBps) {
    const breach =
      `canary conversion ${canaryRateBps}bps is ${relativeDropBps}bps below baseline ` +
      `${baselineRateBps}bps (threshold ${config.maxConversionDropBps}bps)`
    return config.autoRevertEnabled
      ? { ...base, action: 'revert', reason: `${breach}; auto-revert enabled` }
      : { ...base, action: 'would-revert', reason: `${breach}; auto-revert disabled → alert only` }
  }

  return {
    ...base,
    action: 'hold',
    reason: `canary within tolerance (drop ${relativeDropBps}bps ≤ ${config.maxConversionDropBps}bps)`,
  }
}
