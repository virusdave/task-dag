import { z } from 'zod'

// Operator-pasted Sweed session tokens. Mirrors the schema in
// migrations/014_sweed_session_tokens.sql +
// migrations/015_sweed_session_tokens_pool.sql. Workers claim a
// row exclusively for the duration of one job (see
// claimAvailableSweedSessionToken) and release it back to the pool
// when done. The operator UI at /config/sweed/sessions manages
// history + paste-new.

export const SweedSessionTokenSchema = z.object({
  id: z.coerce.number().int(),
  createdAt: z.string(),
  // Operator-visible only on the response of the immediate paste-
  // confirmation step (so they can verify the round-trip) and for
  // the auto-fill of new bookmarklet flows. Otherwise the API masks
  // the token to its first 8 chars (`tokenPrefix`).
  token: z.string().nullable(),
  tokenPrefix: z.string(),
  label: z.string().nullable(),
  source: z.string(),
  createdByUserId: z.coerce.number().int().nullable(),
  createdByLabel: z.string().nullable(),
  markedExpiredAt: z.string().nullable(),
  expiredReason: z.string().nullable(),
  initialDealerId: z.coerce.number().int().nullable(),
  // Pool claim status — null for available / never-claimed rows.
  // `claimedBy` is an opaque worker/job tag the worker writes when
  // it takes the row out of the pool; `claimExpiresAt` is the lease
  // deadline (after which another worker is allowed to reclaim).
  claimedAt: z.string().nullable(),
  claimedBy: z.string().nullable(),
  claimExpiresAt: z.string().nullable(),
  // Convenience flags derived server-side:
  //   isActive       — row is not marked_expired
  //   isClaimed      — claim is held AND lease hasn't lapsed
  //   isAvailable    — pool would hand this row out next claim
  isActive: z.boolean(),
  isClaimed: z.boolean(),
  isAvailable: z.boolean(),
})
export type SweedSessionToken = z.infer<typeof SweedSessionTokenSchema>

export const SweedSessionsResponseSchema = z.object({
  items: z.array(SweedSessionTokenSchema),
  active: SweedSessionTokenSchema.nullable(),
})
export type SweedSessionsResponse = z.infer<typeof SweedSessionsResponseSchema>

export const PasteSweedSessionRequestSchema = z.object({
  // The raw `auth=...` UUID copied from the operator's logged-in
  // Sweed browser session. Accepts either bare UUID or the full
  // `auth=...` cookie value (we strip the prefix).
  token: z.string().trim().min(8),
  label: z.string().trim().max(200).optional(),
  source: z.enum(['bookmarklet', 'paste', 'api']).default('paste'),
  // When true (default), the server immediately validates the
  // token by issuing a no-op `store.auth.initial.data.get` and
  // rejects 4xx/auth-error responses BEFORE the row is committed
  // active. The operator gets a clear "this token is dead" error
  // instead of marking it active and silently expiring it on the
  // first worker pickup.
  validate: z.boolean().default(true),
})
export type PasteSweedSessionRequest = z.infer<typeof PasteSweedSessionRequestSchema>

export const PasteSweedSessionResponseSchema = z.object({
  ok: z.literal(true),
  active: SweedSessionTokenSchema,
})
export type PasteSweedSessionResponse = z.infer<typeof PasteSweedSessionResponseSchema>

export const ExpireSweedSessionRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})
export type ExpireSweedSessionRequest = z.infer<typeof ExpireSweedSessionRequestSchema>
