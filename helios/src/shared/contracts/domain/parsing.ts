/**
 * Contracts for the Config -> Parsing -> Purchases page.
 *
 * Backed by the reverse-shadow event log
 * (parsekit_reverse_shadow_events table) and the live in-process
 * ParserRegistry status on the server.
 */

import { z } from 'zod'

export const ParsekitReverseShadowEventKindSchema = z.enum([
  'regression_unmatched',
  'regression_diff',
  'legacy_threw',
])
export type ParsekitReverseShadowEventKind = z.infer<typeof ParsekitReverseShadowEventKindSchema>

export const ParsekitReverseShadowEventSchema = z.object({
  id: z.string(),
  createdAt: z.string(), // ISO-8601
  kind: ParsekitReverseShadowEventKindSchema,
  input: z.string(),
  parserId: z.string().nullable(),
  ruleId: z.string().nullable(),
  snapshotSha: z.string().nullable(),
  diffFields: z.array(z.string()).nullable(),
  parsekitOutput: z.unknown().nullable(),
  legacyOutput: z.unknown().nullable(),
  parsekitFailureReason: z.string().nullable(),
  legacyError: z.string().nullable(),
})
export type ParsekitReverseShadowEvent = z.infer<typeof ParsekitReverseShadowEventSchema>

export const ParsekitReverseShadowCountsSchema = z.object({
  regression_unmatched: z.number().int().nonnegative(),
  regression_diff: z.number().int().nonnegative(),
  legacy_threw: z.number().int().nonnegative(),
})
export type ParsekitReverseShadowCounts = z.infer<typeof ParsekitReverseShadowCountsSchema>

export const ParsekitRegistryStatusSchema = z.object({
  initialized: z.boolean(),
  sha: z.string().nullable(),
  loadedAtMs: z.number().nullable(),
  parsersLoaded: z.number().int().nonnegative(),
  lastAttemptAtMs: z.number().nullable(),
  successfulLoads: z.number().int().nonnegative(),
  failedLoads: z.number().int().nonnegative(),
  /** Most recent error messages from the snapshot loader, if any. */
  lastErrors: z.array(z.string()),
  /** Detect-prefix dispatch table used by the reverse-shadow harness. */
  parsers: z.array(
    z.object({
      parserId: z.string(),
      tenantId: z.string(),
      useCase: z.string(),
      prefixes: z.array(z.string()),
    }),
  ),
})
export type ParsekitRegistryStatus = z.infer<typeof ParsekitRegistryStatusSchema>

export const ConfigParsingPendingPurchasesResponseSchema = z.object({
  registry: ParsekitRegistryStatusSchema,
  /** Counters from the last 24h. */
  countsLast24h: ParsekitReverseShadowCountsSchema,
  /** Counters from the last 1h. */
  countsLast1h: ParsekitReverseShadowCountsSchema,
  /** Counters from the all-time table. */
  countsAllTime: ParsekitReverseShadowCountsSchema,
  /** Most recent events (newest first), capped server-side. */
  recent: z.array(ParsekitReverseShadowEventSchema),
})
export type ConfigParsingPendingPurchasesResponse = z.infer<
  typeof ConfigParsingPendingPurchasesResponseSchema
>
