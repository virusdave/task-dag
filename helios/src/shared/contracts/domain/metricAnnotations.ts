import { z } from 'zod'

// `scope` is either the literal 'global' (annotation visible on every
// metric chart on the page) or `metric:<metric_id>` (visible only on
// the chart whose MetricDef.id matches).
//
// We deliberately do NOT validate against the in-memory metric
// registry here — the registry is a server-side concept, the same
// schema is used in the browser, and a metric file can be renamed or
// removed without losing the historical annotation. The check is
// purely structural.
export const MetricAnnotationScopeSchema = z
  .string()
  .min(1)
  .refine((value) => value === 'global' || /^metric:.+/.test(value), {
    message: "scope must be 'global' or 'metric:<id>'",
  })
export type MetricAnnotationScope = z.infer<typeof MetricAnnotationScopeSchema>

export const MetricAnnotationRecordSchema = z.object({
  id: z.string().uuid(),
  author: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  tStart: z.string(),
  // Null = point annotation.
  tEnd: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  tag: z.string().nullable(),
  scope: MetricAnnotationScopeSchema,
  deletedAt: z.string().nullable(),
})
export type MetricAnnotationRecord = z.infer<typeof MetricAnnotationRecordSchema>
