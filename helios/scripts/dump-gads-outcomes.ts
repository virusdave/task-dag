// dump-gads-outcomes.ts
//
// Emits aggregated outcome data from `gads_ad_attempts` as JSON to
// stdout. Invoked by `ads/google/scripts/run-l3-analysis.ts` to feed
// real ad-attempt outcome history into the L3 addenda — replacing
// the old `// TODO: query Helios` mocks.
//
// Output shape:
//   {
//     "totals": { "attempts": N, "observed": M, "open": K },
//     "byActionType":
//       [{ "action_type": "pause", "total": 61, "observed": 6,
//          "outcomes": { "no_change": 3, "superseded": 3 } }, ...],
//     "byFamily":
//       [{ "family_key": {...}, "action_type": "repair",
//          "total": N, "observed": M,
//          "outcomes": { "success": ..., "no_change": ... } }, ...]
//   }
//
// Reads the dedicated read-only connection string. It never falls back to the
// write-capable Helios DATABASE_URL. Exits 0 with the JSON on success; exits non-zero
// with a structured `{ "error": "..." }` on stdout if the DB is
// unreachable / table is missing. L3 treats both empty data and
// non-zero exits as "no outcome signal — fall back to deterministic
// observations only", so this script is intentionally tolerant.

import { Pool } from 'pg'
import { readRequiredReadOnlyDatabaseUrl } from '../src/shared/config/runtimeEnv.js'

interface ActionTypeRow {
  action_type: string
  total: string | number
  observed: string | number
  outcomes_json: string | null
}

interface FamilyRow {
  family_key: Record<string, unknown> | null
  action_type: string
  total: string | number
  observed: string | number
  outcomes_json: string | null
}

interface TotalsRow {
  total: string | number
  observed: string | number
  open: string | number
}

async function main(): Promise<void> {
  let dbUrl: string
  try {
    dbUrl = readRequiredReadOnlyDatabaseUrl()
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }) + '\n',
    )
    process.exit(2)
  }
  // Look back 30 days by default — enough to see how recent L2
  // proposals played out without including ancient history.
  const lookbackDays = Number(process.env.GADS_OUTCOMES_LOOKBACK_DAYS ?? '30')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })

  try {
    const totalsQ = await pool.query<TotalsRow>(
      `SELECT
         COUNT(*)::bigint                              AS total,
         COUNT(outcome)::bigint                        AS observed,
         COUNT(*) FILTER (WHERE outcome IS NULL)::bigint AS open
       FROM gads_ad_attempts
       WHERE created_at >= NOW() - ($1 || ' days')::interval`,
      [lookbackDays],
    )
    const totals = {
      attempts: Number(totalsQ.rows[0]?.total ?? 0),
      observed: Number(totalsQ.rows[0]?.observed ?? 0),
      open: Number(totalsQ.rows[0]?.open ?? 0),
    }

    const byActionQ = await pool.query<ActionTypeRow>(
      `SELECT
         action_type,
         SUM(oc)::bigint                                   AS total,
         SUM(oc) FILTER (WHERE outcome IS NOT NULL)::bigint AS observed,
         jsonb_object_agg(outcome, oc) FILTER (WHERE outcome IS NOT NULL)::text AS outcomes_json
       FROM (
         SELECT action_type, outcome, COUNT(*)::bigint AS oc
         FROM gads_ad_attempts
         WHERE created_at >= NOW() - ($1 || ' days')::interval
         GROUP BY action_type, outcome
       ) x
       GROUP BY action_type
       ORDER BY total DESC`,
      [lookbackDays],
    )
    const byActionType = byActionQ.rows.map((r) => ({
      action_type: r.action_type,
      total: Number(r.total),
      observed: Number(r.observed),
      outcomes: r.outcomes_json ? (JSON.parse(r.outcomes_json) as Record<string, number>) : {},
    }))

    const byFamilyQ = await pool.query<FamilyRow>(
      `SELECT
         family_key,
         action_type,
         SUM(oc)::bigint                                   AS total,
         SUM(oc) FILTER (WHERE outcome IS NOT NULL)::bigint AS observed,
         jsonb_object_agg(outcome, oc) FILTER (WHERE outcome IS NOT NULL)::text AS outcomes_json
       FROM (
         SELECT family_key, action_type, outcome, COUNT(*)::bigint AS oc
         FROM gads_ad_attempts
         WHERE created_at >= NOW() - ($1 || ' days')::interval
           AND family_key IS NOT NULL
         GROUP BY family_key, action_type, outcome
       ) x
       GROUP BY family_key, action_type
       ORDER BY total DESC
       LIMIT 200`,
      [lookbackDays],
    )
    const byFamily = byFamilyQ.rows.map((r) => ({
      family_key: r.family_key,
      action_type: r.action_type,
      total: Number(r.total),
      observed: Number(r.observed),
      outcomes: r.outcomes_json ? (JSON.parse(r.outcomes_json) as Record<string, number>) : {},
    }))

    process.stdout.write(
      JSON.stringify({
        generated_at: new Date().toISOString(),
        lookback_days: lookbackDays,
        totals,
        byActionType,
        byFamily,
      }) + '\n',
    )
    process.exit(0)
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }) + '\n',
    )
    process.exit(3)
  } finally {
    await pool.end().catch(() => undefined)
  }
}

main().catch((err) => {
  process.stderr.write(`dump-gads-outcomes: fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
