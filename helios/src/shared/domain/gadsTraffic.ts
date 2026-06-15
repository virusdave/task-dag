// GAds → Landing-pages analytics: the locked "paid GAds traffic"
// predicate (parent epic virusdave/top-level#18, child #47, phase P2).
//
// This is the single biggest correctness risk of the whole surface
// (P0 audit §2): which `lp_events` rows count as paid Google Ads
// traffic and therefore anchor the `gads_lp_rollup` rollup.
//
// LOCKED definition (P0 §2):
//
//   A row is paid GAds traffic iff
//     assignment_key_type IN ('gclid','gbraid','wbraid')   -- Google click ids
//       OR traffic_flags ? 'paid_google'                   -- runtime-tagged paid Google
//   AND it is NOT bot-suspected
//       AND NOT (traffic_flags ? 'bot_suspected')          -- unconditional exclusion
//
// `cookie` / `session` / `default` key types are fallbacks and are NOT
// Google-click-attributable; they only enter the paid set via an
// explicit `paid_google` flag. `bot_suspected` overrides everything.
//
// ⚠️ LOCK-STEP: this TS predicate is the unit-tested mirror
// (gadsTraffic.test.ts encodes the P0 §2.2 truth table) of the SQL
// predicate embedded in the rollup refresh query
// (helios/src/server/db/queries/gadsLpRollupQueries.ts,
// GADS_PAID_TRAFFIC_SQL). Keep the two in lock-step: any change here
// MUST be mirrored in that SQL fragment and vice-versa.

/** Google-click-identifier key types (always paid GAds, absent a bot flag). */
export const GADS_PAID_KEY_TYPES: ReadonlyArray<string> = ['gclid', 'gbraid', 'wbraid']

/** The runtime traffic flag that marks a row as paid Google traffic. */
export const GADS_PAID_GOOGLE_FLAG = 'paid_google'

/** The traffic flag that unconditionally excludes a row (bot/abuse). */
export const GADS_BOT_SUSPECTED_FLAG = 'bot_suspected'

/**
 * `lp_events.traffic_flags` is a JSONB array of strings (P0 §1.1).
 * Normalise whatever shape we are handed (array, null, or a stray
 * non-array) to a Set membership test so callers can pass the raw
 * decoded JSON value defensively.
 */
function hasFlag(trafficFlags: readonly string[] | null | undefined, flag: string): boolean {
  if (!Array.isArray(trafficFlags)) return false
  return trafficFlags.includes(flag)
}

/**
 * The locked paid-GAds-traffic predicate. Returns true iff the row
 * counts toward the GAds landing-pages rollup (and, downstream, the
 * cost/CPA denominator).
 *
 * @param assignmentKeyType `lp_events.assignment_key_type` (nullable).
 * @param trafficFlags      `lp_events.traffic_flags` decoded array (nullable).
 */
export function isPaidGadsTraffic(
  assignmentKeyType: string | null | undefined,
  trafficFlags: readonly string[] | null | undefined,
): boolean {
  // Bot suspicion is an unconditional veto — it overrides both a
  // gclid-family key and an explicit paid_google tag.
  if (hasFlag(trafficFlags, GADS_BOT_SUSPECTED_FLAG)) return false

  const keyIsGoogleClick =
    typeof assignmentKeyType === 'string' && GADS_PAID_KEY_TYPES.includes(assignmentKeyType)

  return keyIsGoogleClick || hasFlag(trafficFlags, GADS_PAID_GOOGLE_FLAG)
}
