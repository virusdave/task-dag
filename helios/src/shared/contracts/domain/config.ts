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
  'workers.scheduling.litalerts',
  'workers.scheduling.stock',
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
    implemented: false,
    summary: 'Periodic state-level catalog taxonomy snapshot (product, variant, brand, category, subcategory, strain, prevalence, size, distributor). TODO: implement before turning the schedule on.',
  },
  {
    key: 'workers.scheduling.litalerts',
    label: 'Litalerts',
    slug: 'litalerts',
    implemented: true,
    summary: 'Drains the pending Lit Alerts refresh queue (one job per queued variant) by capturing competitor listings for each variant whose stock just transitioned out-of-stock to in-stock.',
  },
  {
    key: 'workers.scheduling.stock',
    label: 'Stock',
    slug: 'stock',
    implemented: true,
    summary: 'Periodic full per-site stock scan including out-of-stock items. Variant transitions from out-of-stock to in-stock auto-enqueue a Lit Alerts refresh for that variant.',
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
