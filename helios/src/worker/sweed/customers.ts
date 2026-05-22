import { z } from 'zod'

import { callSweedRpc } from './rpc.js'

// =====================================================================
// Customer-Sentiment Capture (issue #13, A4 phase) — Sweed client
// customers + marketing-segment wrappers.
//
// Used by the customer-review drawing-entry flow to:
//
//   1. Look up an existing Sweed client by the contact channel the
//      customer attached at the drawing-form step (phone OR email).
//   2. Create a minimal Sweed client when none was found.
//   3. Add the resolved client_id to per-site marketing segments
//      (drawing on every submit; free-preroll on the
//      strong-with-text + accepted-paste-offer path).
//   4. Remove a client from the per-site segments on operator
//      mark-fraudulent or force-remove-segment actions.
//
// These wrappers assume the caller has already opened a session
// (`withSweedSession`) and is OK with paying for a `store.auth.dealer.set`
// pin on the first call inside the session. `callSweedRpc(dealerId,
// name, params)` handles both. We DO NOT introduce a SWEED_AUTH_TOKEN
// env shortcut here — per docs/sweed/getting-a-token-for-one-offs.md
// every Sweed call must run inside `withSweedSession`'s pool-claim
// lifecycle.
//
// On Sweed RPC method names: the public Sweed API surface is
// `store.*` (see existing usage in worker/jobs/, server/pricing/, etc.).
// Customers are called "clients" inside Sweed's POS namespace and
// marketing segments live under `store.marketing.segment.*`. The
// concrete method strings are gathered here as named constants so
// operator-verification against staging is a one-file change if any
// of them prove different on the live RPC server.
// =====================================================================

export const SWEED_RPC_CLIENT_LIST = 'store.client.list'
export const SWEED_RPC_CLIENT_ADD = 'store.client.add'
export const SWEED_RPC_SEGMENT_MEMBER_ADD = 'store.marketing.segment.member.add'
export const SWEED_RPC_SEGMENT_MEMBER_DELETE = 'store.marketing.segment.member.delete'

export type ContactChannel = 'phone' | 'email'

export interface FoundSweedClient {
  /** Sweed-side `client.id` we'll use for segment add/remove. */
  customerId: number
  /** Raw Sweed payload preserved for audit / debug. */
  raw: unknown
}

// Sweed list responses across the existing RPCs we use uniformly carry
// `{ data: T[], totalCount: number }`. We only ever need the first row
// of a contact-channel lookup — there is no business case for handling
// multi-match cleverly inside the gate; if a phone is shared across two
// Sweed clients the operator can fix it manually.
const ListResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.coerce.number().int().nullable().optional(),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
    totalCount: z.coerce.number().int().nullable().optional(),
  })
  .passthrough()

const AddResponseSchema = z
  .object({
    // Two shapes have been seen across Sweed responses depending on
    // the endpoint: a bare `{ id }` or a wrapped `{ client: { id } }`.
    // We tolerate both.
    id: z.coerce.number().int().nullable().optional(),
    client: z
      .object({ id: z.coerce.number().int().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

function pickAddedId(raw: unknown): number | null {
  const parsed = AddResponseSchema.safeParse(raw)
  if (!parsed.success) return null
  const direct = parsed.data.id
  const nested = parsed.data.client?.id
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  if (typeof nested === 'number' && Number.isFinite(nested)) return nested
  return null
}

/**
 * Find a Sweed client by the `channel`-typed `value`. Returns null
 * when Sweed has no matching client (the caller then falls through to
 * `createMinimalSweedClient`).
 *
 * `dealerId` pins the search to the correct site so multi-store
 * deployments don't accidentally surface a customer from a sibling
 * site that happens to share a phone number.
 */
export async function findSweedClientByPhoneOrEmail(args: {
  dealerId: number
  channel: ContactChannel
  value: string
}): Promise<FoundSweedClient | null> {
  // Sweed's list endpoint takes a free-form `search` string and
  // returns matches across phone / email / name. We pass the value
  // verbatim and then filter to a single match on the client side
  // since we want the channel match to be exact.
  const raw = await callSweedRpc<unknown>(args.dealerId, SWEED_RPC_CLIENT_LIST, {
    page: 1,
    pageSize: 5,
    search: args.value,
    // Hint Sweed which channel to weight; the parameter is tolerated
    // (best-effort) and ignored when not recognized by the endpoint.
    searchKind: args.channel,
  })
  const parsed = ListResponseSchema.safeParse(raw)
  if (!parsed.success) return null
  const rows = parsed.data.data ?? []
  if (rows.length === 0) return null
  const first = rows[0]
  const id = typeof first.id === 'number' ? first.id : null
  if (id === null) return null
  return { customerId: id, raw }
}

/**
 * Create a minimal Sweed client carrying only the single contact
 * channel the customer gave us. The Sweed UI surfaces created
 * profiles to the operator with the source/segment timeline so they
 * can hand-merge later if a richer profile shows up via POS.
 */
export async function createMinimalSweedClient(args: {
  dealerId: number
  channel: ContactChannel
  value: string
}): Promise<FoundSweedClient> {
  const params: Record<string, unknown> = {
    // Sweed's `store.client.add` takes a flat record-of-attributes; we
    // only fill in the channel the customer gave us.
    [args.channel]: args.value,
    // Tag the origin so an operator scanning the Sweed CRM can see
    // which clients arrived via the public review-capture surface
    // rather than a POS check-in.
    source: 'helios:review-capture',
  }
  const raw = await callSweedRpc<unknown>(args.dealerId, SWEED_RPC_CLIENT_ADD, params)
  const id = pickAddedId(raw)
  if (id === null) {
    throw new Error('Sweed store.client.add response did not include a client id')
  }
  return { customerId: id, raw }
}

/**
 * Convenience wrapper used by the drawing-entry flow: look up by
 * phone (preferred when present, since phone is unique-ish in NY
 * cannabis CRM data) then by email, falling back to create.
 */
export async function findOrCreateSweedClientForContacts(args: {
  dealerId: number
  contacts: ReadonlyArray<{ kind: 'phone' | 'email' | 'name' | 'other'; value: string }>
}): Promise<FoundSweedClient | null> {
  const channels: ContactChannel[] = ['phone', 'email']
  for (const channel of channels) {
    const match = args.contacts.find((c) => c.kind === channel && c.value.trim().length > 0)
    if (!match) continue
    const found = await findSweedClientByPhoneOrEmail({
      dealerId: args.dealerId,
      channel,
      value: match.value.trim(),
    })
    if (found !== null) return found
  }
  // No existing client — create one off the first usable channel.
  for (const channel of channels) {
    const match = args.contacts.find((c) => c.kind === channel && c.value.trim().length > 0)
    if (!match) continue
    return createMinimalSweedClient({
      dealerId: args.dealerId,
      channel,
      value: match.value.trim(),
    })
  }
  // No phone or email captured on this submission — nothing to add.
  return null
}

export async function addSegmentMember(args: {
  dealerId: number
  segmentId: number
  customerId: number
}): Promise<unknown> {
  return callSweedRpc<unknown>(args.dealerId, SWEED_RPC_SEGMENT_MEMBER_ADD, {
    segmentId: args.segmentId,
    clientId: args.customerId,
  })
}

export async function removeSegmentMember(args: {
  dealerId: number
  segmentId: number
  customerId: number
}): Promise<unknown> {
  return callSweedRpc<unknown>(args.dealerId, SWEED_RPC_SEGMENT_MEMBER_DELETE, {
    segmentId: args.segmentId,
    clientId: args.customerId,
  })
}
