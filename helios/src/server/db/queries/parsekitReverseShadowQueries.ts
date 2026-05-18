/**
 * Queries for the `parsekit_reverse_shadow_events` table.
 *
 * Writers: the reverse-shadow harness in
 *   helios/src/worker/jobs/generatePendingPurchasePacketJob.ts
 * Readers: the Helios server route
 *   GET /api/config/parsing/pending-purchases
 * which backs the Config -> Parsing -> Purchases UI page.
 */

import { getPool, type Queryable } from '../pool.js'

export type ParsekitReverseShadowEventKind =
  | 'regression_unmatched'
  | 'regression_diff'
  | 'legacy_threw'

export interface ParsekitReverseShadowEventRow {
  id: string // bigint -> string
  createdAt: Date
  kind: ParsekitReverseShadowEventKind
  input: string
  parserId: string | null
  ruleId: string | null
  snapshotSha: string | null
  diffFields: string[] | null
  parsekitOutput: unknown | null
  legacyOutput: unknown | null
  parsekitFailureReason: string | null
  legacyError: string | null
}

export interface ParsekitReverseShadowInsert {
  kind: ParsekitReverseShadowEventKind
  input: string
  parserId?: string | null
  ruleId?: string | null
  snapshotSha?: string | null
  diffFields?: string[] | null
  parsekitOutput?: unknown | null
  legacyOutput?: unknown | null
  parsekitFailureReason?: string | null
  legacyError?: string | null
}

export async function insertParsekitReverseShadowEvent(
  rec: ParsekitReverseShadowInsert,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `insert into parsekit_reverse_shadow_events (
       kind, input, parser_id, rule_id, snapshot_sha,
       diff_fields, parsekit_output, legacy_output,
       parsekit_failure_reason, legacy_error
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
    [
      rec.kind,
      rec.input,
      rec.parserId ?? null,
      rec.ruleId ?? null,
      rec.snapshotSha ?? null,
      rec.diffFields == null ? null : JSON.stringify(rec.diffFields),
      rec.parsekitOutput == null ? null : JSON.stringify(rec.parsekitOutput),
      rec.legacyOutput == null ? null : JSON.stringify(rec.legacyOutput),
      rec.parsekitFailureReason ?? null,
      rec.legacyError ?? null,
    ],
  )
}

export async function loadRecentParsekitReverseShadowEvents(
  limit: number,
  db: Queryable = getPool(),
): Promise<ParsekitReverseShadowEventRow[]> {
  const result = await db.query<{
    id: string
    created_at: Date
    kind: string
    input: string
    parser_id: string | null
    rule_id: string | null
    snapshot_sha: string | null
    diff_fields: string[] | null
    parsekit_output: unknown | null
    legacy_output: unknown | null
    parsekit_failure_reason: string | null
    legacy_error: string | null
  }>(
    `select id::text as id,
            created_at,
            kind,
            input,
            parser_id,
            rule_id,
            snapshot_sha,
            diff_fields,
            parsekit_output,
            legacy_output,
            parsekit_failure_reason,
            legacy_error
       from parsekit_reverse_shadow_events
      order by created_at desc, id desc
      limit $1`,
    [limit],
  )
  return result.rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    kind: r.kind as ParsekitReverseShadowEventKind,
    input: r.input,
    parserId: r.parser_id,
    ruleId: r.rule_id,
    snapshotSha: r.snapshot_sha,
    diffFields: r.diff_fields,
    parsekitOutput: r.parsekit_output,
    legacyOutput: r.legacy_output,
    parsekitFailureReason: r.parsekit_failure_reason,
    legacyError: r.legacy_error,
  }))
}

export interface ParsekitReverseShadowCountsByKind {
  regression_unmatched: number
  regression_diff: number
  legacy_threw: number
}

export async function loadParsekitReverseShadowCounts(
  windowSeconds: number,
  db: Queryable = getPool(),
): Promise<ParsekitReverseShadowCountsByKind> {
  const result = await db.query<{ kind: string; n: string }>(
    `select kind, count(*)::text as n
       from parsekit_reverse_shadow_events
      where created_at >= now() - make_interval(secs => $1)
      group by kind`,
    [windowSeconds],
  )
  const out: ParsekitReverseShadowCountsByKind = {
    regression_unmatched: 0,
    regression_diff: 0,
    legacy_threw: 0,
  }
  for (const row of result.rows) {
    if (row.kind === 'regression_unmatched') out.regression_unmatched = Number(row.n)
    else if (row.kind === 'regression_diff') out.regression_diff = Number(row.n)
    else if (row.kind === 'legacy_threw') out.legacy_threw = Number(row.n)
  }
  return out
}
