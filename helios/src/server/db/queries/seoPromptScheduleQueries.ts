// Query layer for the SEO auto-blog prompt-schedule config (migration 092).
//
// Helios-driven SEO widgets — auto-blog PROMPT-SCHEDULE + TOPIC-MIX config
// (parent EPIC_PLAN §7.2, child FreshlyBakedNYC/automation#44, P4,
// Satisfies: virusdave/top-level#15).
//
// Backs the /api/seo/prompt-schedules routes. This is operator config, not
// approval-gated content — no ledger, no fingerprint. The route validates
// the config (validatePromptScheduleConfig) before any write.

import type {
  SeoGenerationMode,
  SeoPromptScheduleRecord,
  SeoPromptTemplates,
  SeoTopicMixEntry,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

interface SeoPromptScheduleRow {
  schedule_key: string
  scope: string
  label: string
  enabled: boolean
  posts_per_week: number
  mode: string
  topic_mix: unknown
  prompt_templates: unknown
  notes: string
  created_by_user_id: string | number | null
  updated_by_user_id: string | number | null
  created_at: Date | string
  updated_at: Date | string
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) {
    return null
  }
  return typeof value === 'number' ? value : Number.parseInt(value, 10)
}

function parseTopicMix(raw: unknown): SeoTopicMixEntry[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.flatMap((e): SeoTopicMixEntry[] => {
    if (
      typeof e === 'object' &&
      e !== null &&
      typeof (e as { category?: unknown }).category === 'string' &&
      typeof (e as { weight?: unknown }).weight === 'number'
    ) {
      const entry = e as { category: string; weight: number }
      return [{ category: entry.category as SeoTopicMixEntry['category'], weight: entry.weight }]
    }
    return []
  })
}

function parsePromptTemplates(raw: unknown): SeoPromptTemplates {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {}
  }
  return raw as SeoPromptTemplates
}

function mapRow(row: SeoPromptScheduleRow): SeoPromptScheduleRecord {
  return {
    scheduleKey: row.schedule_key,
    scope: row.scope,
    label: row.label,
    enabled: row.enabled === true,
    postsPerWeek: row.posts_per_week,
    mode: row.mode as SeoGenerationMode,
    topicMix: parseTopicMix(row.topic_mix),
    promptTemplates: parsePromptTemplates(row.prompt_templates),
    notes: row.notes,
    createdByUserId: toNumberOrNull(row.created_by_user_id),
    updatedByUserId: toNumberOrNull(row.updated_by_user_id),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

const SELECT_SCHEDULE = `
  select schedule_key, scope, label, enabled, posts_per_week, mode, topic_mix,
         prompt_templates, notes, created_by_user_id, updated_by_user_id,
         created_at, updated_at
    from seo_prompt_schedules
`

export async function listPromptSchedules(db: Queryable): Promise<SeoPromptScheduleRecord[]> {
  const result = await db.query<SeoPromptScheduleRow>(
    `${SELECT_SCHEDULE} order by schedule_key asc`,
  )
  return result.rows.map(mapRow)
}

export async function getPromptSchedule(
  db: Queryable,
  scheduleKey: string,
): Promise<SeoPromptScheduleRecord | null> {
  const result = await db.query<SeoPromptScheduleRow>(
    `${SELECT_SCHEDULE} where schedule_key = $1`,
    [scheduleKey],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export interface UpsertPromptScheduleInput {
  readonly scheduleKey: string
  readonly scope: string
  readonly label: string
  readonly enabled: boolean
  readonly postsPerWeek: number
  readonly mode: SeoGenerationMode
  readonly topicMix: readonly SeoTopicMixEntry[]
  readonly promptTemplates: SeoPromptTemplates
  readonly notes: string
  readonly userId: number
}

/**
 * Create or update a prompt schedule. Keyed on schedule_key; an update keeps
 * the original creator and stamps the editor. The route validates the config
 * (validatePromptScheduleConfig) before calling this.
 */
export async function upsertPromptSchedule(
  db: Queryable,
  input: UpsertPromptScheduleInput,
): Promise<SeoPromptScheduleRecord> {
  const result = await db.query<SeoPromptScheduleRow>(
    `
      insert into seo_prompt_schedules (
        schedule_key, scope, label, enabled, posts_per_week, mode, topic_mix,
        prompt_templates, notes, created_by_user_id, updated_by_user_id
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $10)
      on conflict (schedule_key) do update
         set scope = excluded.scope,
             label = excluded.label,
             enabled = excluded.enabled,
             posts_per_week = excluded.posts_per_week,
             mode = excluded.mode,
             topic_mix = excluded.topic_mix,
             prompt_templates = excluded.prompt_templates,
             notes = excluded.notes,
             updated_by_user_id = excluded.updated_by_user_id,
             updated_at = now()
      returning schedule_key, scope, label, enabled, posts_per_week, mode,
                topic_mix, prompt_templates, notes, created_by_user_id,
                updated_by_user_id, created_at, updated_at
    `,
    [
      input.scheduleKey,
      input.scope,
      input.label,
      input.enabled,
      input.postsPerWeek,
      input.mode,
      JSON.stringify(input.topicMix),
      JSON.stringify(input.promptTemplates),
      input.notes,
      input.userId,
    ],
  )
  return mapRow(result.rows[0]!)
}
