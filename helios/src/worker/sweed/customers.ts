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
// `store.*`. The original A4 implementation guessed at the CRM
// method strings (`store.client.list`, `store.client.add`,
// `store.marketing.segment.member.{add,delete}`) — those guesses
// did not match the live RPC surface and every production drawing
// entry came back with "Action is not available" on the very
// first call. We probed Sweed exhaustively (helios/scripts/
// probe-sweed-customer-rpcs*.ts) and corrected what we could
// verify; the rest are marked NEEDS_OPERATOR_VERIFICATION below.
//
// VERIFIED via live probe against prime.sweedpos.com under a
// pool-claimed dealer-210705 session:
//   - store.customer.list          : exists; returns paginated
//                                    metadata + an empty `data`
//                                    array regardless of search/
//                                    filter we tried (the "in-
//                                    store / takesShopping" page
//                                    surface, not the CRM search).
//   - store.customer.add           : exists but ALL payload shapes
//                                    we tried returned "Parameters
//                                    validation error" — required
//                                    field shape unknown.
//   - store.customer.get           : exists; expects `{ id }`.
//   - store.customer.edit          : exists.
//   - store.marketing.segment.list : exists; returns real segments
//                                    (totalCustomers, type, etc.).
//   - store.marketing.segment.get  : exists; expects `{ id }`.
//   - store.marketing.segment.edit : exists; param shape for
//                                    "set static members" unknown
//                                    — every shape we tried was a
//                                    silent no-op.
//
// NEEDS_OPERATOR_VERIFICATION (still failing in production):
//   - The customer find-by-phone-or-email RPC.
//     `store.customer.list` doesn't surface arbitrary CRM rows;
//     `store.customer.{search,find,lookup,by.phone,…}` all return
//     "Action is not available".
//   - The "add customer to a static marketing segment" RPC.
//     `store.marketing.segment.member.{add,delete}` etc. all
//     return "Action is not available"; segment.edit silently
//     accepts member-list-shaped params without mutating
//     totalCustomers. The operator needs to capture the real RPC
//     name + payload from Sweed's admin-UI network tab when they
//     manually add a customer to a Static segment, and update the
//     constants below.
// =====================================================================

// Verified: store.customer.list exists. Note: returns 0 rows in
// every probe we ran; appears to be the POS "current-shoppers"
// surface, not a CRM phone/email search. Kept here so that the
// orchestrator at least gets a structured empty response (with
// totalCount=0) instead of a "Action is not available" failure,
// which lets us cleanly fall through to the create path.
export const SWEED_RPC_CLIENT_LIST = 'store.customer.list'
// store.customer.get exists and expects { id } (operator-verified
// via live probe — see the file header notes). Used by the
// customer-of-record address enrichment job
// (helios/src/worker/jobs/enrichCustomerAddressJob.ts, task A5
// of FreshlyBakedNYC/automation#25) to pull the address sub-
// object on each Sweed client we've seen on an order. The
// caller MUST be inside a `withSweedSession` block.
export const SWEED_RPC_CLIENT_GET = 'store.customer.get'
// store.customer.add exists; payload shape NOT YET VERIFIED. Every
// attempted shape returns "Parameters validation error". The
// orchestrator will continue to fail-and-log here until the
// correct payload is identified.
export const SWEED_RPC_CLIENT_ADD = 'store.customer.add'
// NEEDS_OPERATOR_VERIFICATION. `store.marketing.segment.member.add`
// returns "Action is not available" on live prod. Static-segment
// member management appears to go through a different RPC we
// haven't been able to identify by probing. Leaving the old value
// here so failures are still recorded with a recognizable trail —
// retire this once the real method name is captured from the
// Sweed admin UI.
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

// =====================================================================
// store.customer.get — fetch one Sweed CRM customer (incl. address)
// =====================================================================
//
// Used by the customer-of-record address enrichment job
// (helios/src/worker/jobs/enrichCustomerAddressJob.ts, task A5 of
// FreshlyBakedNYC/automation#25). Sweed's `store.customer.list`
// does not surface CRM rows reliably (see the long file header
// note above), but `store.customer.get` with `{ id }` does — that
// was confirmed via live probe under a pool-claimed session.
//
// Response shape — we pin only the postal-address fields we use;
// everything else passes through as `raw` so we can re-derive
// later without an additional Sweed call. The known shape (from
// the same probe) carries the address under either `address` or
// `primaryAddress`; we accept either name and fall back to a
// nested `addresses` array if present.
//
// Privacy: we deliberately ignore name / phone / email / DOB /
// any other field beyond the postal address. The address-
// persistence layer (FreshlyBakedNYC/automation#25) is scoped
// to postal address only.

const CustomerAddressSchema = z
  .object({
    line1: z.string().nullable().optional(),
    line2: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    zip: z.string().nullable().optional(),
  })
  .passthrough()

const CustomerGetResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    address: CustomerAddressSchema.nullable().optional(),
    primaryAddress: CustomerAddressSchema.nullable().optional(),
    addresses: z.array(CustomerAddressSchema).nullable().optional(),
  })
  .passthrough()

export interface SweedCustomerAddressDetail {
  line1: string | null
  line2: string | null
  city: string | null
  state: string | null
  zip: string | null
}

export interface SweedCustomerDetail {
  customerId: number
  /** null when Sweed returns the customer record but it has no
   *  address sub-object. The enrichment job records that fact so
   *  the same customer isn't re-polled forever. */
  address: SweedCustomerAddressDetail | null
  raw: unknown
}

function trimToNullable(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function normaliseCustomerAddress(
  raw: z.infer<typeof CustomerAddressSchema> | null | undefined,
): SweedCustomerAddressDetail | null {
  if (raw === null || raw === undefined) return null
  const detail: SweedCustomerAddressDetail = {
    line1: trimToNullable(raw.line1),
    line2: trimToNullable(raw.line2),
    city: trimToNullable(raw.city),
    state: trimToNullable(raw.state),
    zip: trimToNullable(raw.zip),
  }
  const anyPresent =
    detail.line1 !== null ||
    detail.line2 !== null ||
    detail.city !== null ||
    detail.state !== null ||
    detail.zip !== null
  return anyPresent ? detail : null
}

function pickFirstNonEmpty(
  ...candidates: Array<z.infer<typeof CustomerAddressSchema> | null | undefined>
): SweedCustomerAddressDetail | null {
  for (const c of candidates) {
    const detail = normaliseCustomerAddress(c)
    if (detail !== null) return detail
  }
  return null
}

/**
 * Fetch one Sweed CRM customer envelope and return the normalised
 * postal address (or null if Sweed has none on file). Caller MUST
 * already be inside a `withSweedSession` block.
 *
 * Throws on transport / auth errors; defensive Zod parse so a
 * schema mismatch degrades to "no address" rather than crashing
 * the calling job.
 */
export async function getSweedCustomer(args: {
  dealerId: number
  customerId: number
}): Promise<SweedCustomerDetail> {
  const raw = await callSweedRpc<unknown>(args.dealerId, SWEED_RPC_CLIENT_GET, {
    id: args.customerId,
  })
  const parsed = CustomerGetResponseSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      customerId: args.customerId,
      address: null,
      raw,
    }
  }
  const arr = parsed.data.addresses ?? []
  const fromArray = arr.length > 0 ? arr[0] : null
  return {
    customerId: args.customerId,
    address: pickFirstNonEmpty(
      parsed.data.address ?? null,
      parsed.data.primaryAddress ?? null,
      fromArray,
    ),
    raw,
  }
}
