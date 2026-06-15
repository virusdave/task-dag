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
//
// RESOLVED (operator-verified 2026-06, captured from the Sweed
// admin-UI network tab while manually adding a customer to static
// segment 10282 under the Bronx dealer context):
//   - The "add customer to a static marketing segment" RPC is
//     `store.marketing.segment.result.add` with params
//     `{ id: "<segmentId>", customerIds: ["<customerId>", …] }`
//     (BOTH the segment id and the customer ids are STRINGS, and
//     `customerIds` is an array — the call is batch-capable). It
//     must run under the segment-owning dealer context (e.g.
//     dealer 210249 for Bronx-owned segments). The earlier
//     `store.marketing.segment.member.add` guess is retired below.
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
// OPERATOR-VERIFIED (2026-06). Add one or more customers to a static
// marketing segment. Captured live from the Sweed admin UI:
//   {"name":"store.marketing.segment.result.add",
//    "params":{"id":"10282","customerIds":["428378"]}}
// `id` (segment) and each `customerIds` entry are STRINGS; the call
// is batch-capable. Must run under the segment-owning dealer context.
export const SWEED_RPC_SEGMENT_MEMBER_ADD = 'store.marketing.segment.result.add'
// NEEDS_OPERATOR_VERIFICATION. The remove counterpart was NOT captured
// alongside the add; `store.marketing.segment.result.delete` is the
// strong same-family hypothesis (the old `…member.delete` value
// definitely returned "Action is not available"). Mirrors the verified
// add param shape. Confirm from the admin UI before relying on it.
export const SWEED_RPC_SEGMENT_MEMBER_DELETE = 'store.marketing.segment.result.delete'

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

// =====================================================================
// store.customer.list — search by driver's-license document number
// (Sweed-link-on-check-in pipeline, virusdave/top-level#12 /
// FreshlyBakedNYC/automation#40).
// =====================================================================
//
// Unlike phone/email — which our earlier probing could not get
// `store.customer.list` to honor — the operator-supplied RPC body
//
//   {"auth":"...","name":"store.customer.list",
//    "params":{"documentNumber":"326QY7698907","page":1,"pageSize":50}}
//
// IS understood by Sweed and returns the matching CRM customer row.
// (Confirmed by the operator from the live Sweed admin-UI network
// tab; same RPC name, distinct param key.)
//
// This helper is used by the per-scan
// `linkVisitorScanToSweedJob` to resolve a freshly-arrived
// VeriScan id_num to a Sweed customer_id immediately on check-in,
// so the operator-facing visitor-scans list / details page can
// surface purchase history without an operator hand-search.
//
// Privacy: we deliberately do NOT log the documentNumber payload at
// info level; it goes into `visitor_scan_links.lookup_terms` for
// provenance under the existing operator-access gate that the
// table is already covered by.

const CustomerListRowSchema = z
  .object({
    id: z.coerce.number().int().nullable().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    documentNumber: z.string().nullable().optional(),
  })
  .passthrough()

const CustomerListByDocumentResponseSchema = z
  .object({
    data: z.array(CustomerListRowSchema).optional().default([]),
    totalCount: z.coerce.number().int().nullable().optional(),
  })
  .passthrough()

export interface SweedCustomerListByDocumentResult {
  /** Best (exact-match) customer id, or null when Sweed returned 0 rows. */
  customerId: number | null
  /** Number of total rows Sweed returned, surfaced so the caller can
   *  set `link_status = 'ambiguous'` when >1 and no exact match. */
  totalCount: number
  /** Raw envelope captured for `visitor_scan_links.raw_match`. */
  raw: unknown
}

/**
 * Look up a Sweed CRM customer by driver's-license document number.
 * Returns `customerId=null` when Sweed has 0 matches; the caller is
 * responsible for transitioning the link row to 'no_match' /
 * 'ambiguous' / 'linked' based on `totalCount` + match selection.
 *
 * Caller MUST already be inside a `withSweedSession` block.
 */
export async function findSweedCustomerByDocumentNumber(args: {
  dealerId: number
  documentNumber: string
}): Promise<SweedCustomerListByDocumentResult> {
  const raw = await callSweedRpc<unknown>(args.dealerId, SWEED_RPC_CLIENT_LIST, {
    documentNumber: args.documentNumber,
    page: 1,
    pageSize: 50,
  })
  const parsed = CustomerListByDocumentResponseSchema.safeParse(raw)
  if (!parsed.success) {
    return { customerId: null, totalCount: 0, raw }
  }
  const rows = parsed.data.data ?? []
  const totalCount =
    typeof parsed.data.totalCount === 'number' ? parsed.data.totalCount : rows.length

  // Prefer an exact documentNumber match when Sweed returned >1 row,
  // otherwise take row[0]. Sweed's matching is case-insensitive but
  // returns the canonical string, so a raw `===` is fine.
  let chosen: z.infer<typeof CustomerListRowSchema> | undefined
  if (rows.length === 1) {
    chosen = rows[0]
  } else if (rows.length > 1) {
    chosen = rows.find(
      (r) =>
        typeof r.documentNumber === 'string' &&
        r.documentNumber.trim().toLowerCase() === args.documentNumber.trim().toLowerCase(),
    )
  }
  const id = chosen !== undefined && typeof chosen.id === 'number' ? chosen.id : null
  return { customerId: id, totalCount, raw }
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

/**
 * Add one customer to a static marketing segment. Convenience wrapper
 * around the batch RPC (see `addSegmentMembers`). Caller MUST be inside
 * a `withSweedSession` block, and `dealerId` MUST be the dealer that
 * owns the segment (e.g. 210249 for Bronx-owned segments).
 */
export async function addSegmentMember(args: {
  dealerId: number
  segmentId: number
  customerId: number
}): Promise<unknown> {
  return addSegmentMembers({
    dealerId: args.dealerId,
    segmentId: args.segmentId,
    customerIds: [args.customerId],
  })
}

/**
 * Add a batch of customers to a static marketing segment in one RPC.
 * `store.marketing.segment.result.add` accepts an array of customer
 * ids (operator-verified). Both the segment id and the customer ids
 * are sent as strings. Caller MUST be inside a `withSweedSession`
 * block under the segment-owning dealer context.
 */
export async function addSegmentMembers(args: {
  dealerId: number
  segmentId: number
  customerIds: ReadonlyArray<number>
}): Promise<unknown> {
  return callSweedRpc<unknown>(args.dealerId, SWEED_RPC_SEGMENT_MEMBER_ADD, {
    id: String(args.segmentId),
    customerIds: args.customerIds.map((id) => String(id)),
  })
}

export async function removeSegmentMember(args: {
  dealerId: number
  segmentId: number
  customerId: number
}): Promise<unknown> {
  return callSweedRpc<unknown>(args.dealerId, SWEED_RPC_SEGMENT_MEMBER_DELETE, {
    id: String(args.segmentId),
    customerIds: [String(args.customerId)],
  })
}

// =====================================================================
// store.customer.segment.list — read a customer's segment membership
// =====================================================================
//
// VERIFIED (live probe, 2026-06): `store.customer.segment.list
// { id: <customerId>, page, pageSize }` returns the customer's FULL
// marketing-segment membership regardless of which dealer context is
// pinned. The response is a BARE ARRAY (not the usual
// `{ data, totalCount }` envelope). Each row:
//
//   { id, name, description, type: { id, name },
//     dealer: { id, name }, enabled, dateOnEnter }
//
// `dealer.id` is the segment's owning scope: 210248 = state / all
// stores, 210705 = Midtown, 210249 = Bronx. This wrapper is read-only
// and MUST run inside a `withSweedSession` block.
export const SWEED_RPC_CUSTOMER_SEGMENT_LIST = 'store.customer.segment.list'
// VERIFIED: `store.marketing.segment.list { page, pageSize }` returns
// the `{ data, totalCount }` catalog of segments visible from the
// calling dealer context. Called against the state dealer it returns
// every segment across stores (site-specific ones carry their store in
// `targetStoreNames`). Each row: { id, name, type: { id, name },
// enabled, totalCustomers, targetStoreNames: string[] }.
export const SWEED_RPC_MARKETING_SEGMENT_LIST = 'store.marketing.segment.list'

const CustomerSegmentTypeSchema = z
  .object({ id: z.coerce.number().int().nullable().optional(), name: z.string().nullable().optional() })
  .passthrough()

const CustomerSegmentRowSchema = z
  .object({
    id: z.coerce.string(),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    type: CustomerSegmentTypeSchema.nullable().optional(),
    dealer: z
      .object({
        id: z.coerce.number().int().nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    enabled: z.boolean().nullable().optional(),
    dateOnEnter: z.string().nullable().optional(),
  })
  .passthrough()
export type SweedCustomerSegmentRow = z.infer<typeof CustomerSegmentRowSchema>

/**
 * Read all marketing segments the given Sweed customer belongs to.
 * Pages through the (rarely >50) results. Caller MUST be inside a
 * `withSweedSession` block. `dealerId` only fixes the call context;
 * the result is the same from any dealer.
 */
export async function listSweedCustomerSegments(args: {
  dealerId: number
  customerId: number
}): Promise<SweedCustomerSegmentRow[]> {
  const pageSize = 100
  const out: SweedCustomerSegmentRow[] = []
  for (let page = 1; page <= 10; page++) {
    const raw = await callSweedRpc<unknown>(args.dealerId, SWEED_RPC_CUSTOMER_SEGMENT_LIST, {
      id: String(args.customerId),
      page,
      pageSize,
    })
    // Bare-array response; tolerate a `{ data }` envelope just in case.
    const arr = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { data?: unknown[] })?.data)
        ? (raw as { data: unknown[] }).data
        : []
    const parsed = z.array(CustomerSegmentRowSchema).safeParse(arr)
    const rows = parsed.success ? parsed.data : []
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}

const MarketingSegmentRowSchema = z
  .object({
    id: z.coerce.string(),
    name: z.string().nullable().optional(),
    type: CustomerSegmentTypeSchema.nullable().optional(),
    enabled: z.boolean().nullable().optional(),
    totalCustomers: z.coerce.number().int().nullable().optional(),
    targetStoreNames: z.array(z.string()).nullable().optional(),
  })
  .passthrough()
export type SweedMarketingSegmentRow = z.infer<typeof MarketingSegmentRowSchema>

/**
 * Read the marketing-segment catalog from ONE dealer context. Note that
 * `store.marketing.segment.list` is dealer-SCOPED: the static segments
 * (delivery zones, imports, etc.) only appear under the SITE dealer that
 * owns them. Callers that want the full catalog should use
 * `listSweedMarketingSegmentsCatalogForDealers`. MUST run inside a
 * `withSweedSession` block.
 */
export async function listSweedMarketingSegmentsCatalog(args: {
  dealerId: number
}): Promise<SweedMarketingSegmentRow[]> {
  const pageSize = 200
  const out: SweedMarketingSegmentRow[] = []
  for (let page = 1; page <= 20; page++) {
    const raw = await callSweedRpc<unknown>(args.dealerId, SWEED_RPC_MARKETING_SEGMENT_LIST, {
      page,
      pageSize,
    })
    const arr = Array.isArray((raw as { data?: unknown[] })?.data)
      ? (raw as { data: unknown[] }).data
      : Array.isArray(raw)
        ? raw
        : []
    const parsed = z.array(MarketingSegmentRowSchema).safeParse(arr)
    const rows = parsed.success ? parsed.data : []
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}

export interface ScopedMarketingSegmentRow extends SweedMarketingSegmentRow {
  /** The dealer context this segment was observed under (its scope). */
  scopeDealerId: number
}

/**
 * Read the full marketing-segment catalog by fanning the list call out
 * across the given dealers (state + both sites), tagging each row with
 * the dealer it was seen under and deduping by segment id (first dealer
 * in the list wins, so pass the state dealer first to keep org-wide
 * segments state-scoped). MUST run inside a `withSweedSession` block.
 */
export async function listSweedMarketingSegmentsCatalogForDealers(args: {
  dealerIds: number[]
}): Promise<ScopedMarketingSegmentRow[]> {
  const byId = new Map<string, ScopedMarketingSegmentRow>()
  for (const dealerId of args.dealerIds) {
    const rows = await listSweedMarketingSegmentsCatalog({ dealerId })
    for (const r of rows) {
      if (!byId.has(r.id)) byId.set(r.id, { ...r, scopeDealerId: dealerId })
    }
  }
  return [...byId.values()]
}

// =====================================================================
// store.marketing.segment.result.list — BULK read a segment's members
// =====================================================================
//
// The inverse of `store.customer.segment.list`: instead of one RPC per
// customer to learn that customer's segments, this returns every
// customer IN a segment (paginated), so whole-segment membership
// population is O(#segments × pages) Sweed calls instead of
// O(#customers) — the only affordable way to keep the cache COMPLETE.
//
// IMPORTANT: `store.marketing.segment.get { id }` is NOT the member
// list — it returns the segment DEFINITION (rule `ruleData`, type,
// `totalCustomers`, etc.). The member list is the "result" family,
// sibling of the verified add RPC `store.marketing.segment.result.add`.
//
// VERIFIED (live probe, segment 1532 @ state dealer 210248, 2026-06):
//   store.marketing.segment.result.list { id, page, pageSize } returns
//   { total, withEmail, withPhone, lastUpdated,
//     customers: { page, pageSize, totalCount,
//                  data: [ { customerId: "<str>", customerName,
//                            dateOfBirth, age, dateOnEnter,
//                            genderType?, hasEmail, hasPhone }, … ] } }
//   `customerId` is a STRING; `dateOnEnter` is the join timestamp. The
//   call works for DYNAMIC (rule) segments too — Sweed materialises the
//   result set. Other guesses (segment.result.get / segment.customer.
//   list / segment.member.list) all return "Action is not available".
//
// We pull ONLY the join key (+ dateOnEnter); name/DOB/contact are PII we
// neither need nor cache. The page parser is FAIL-CLOSED: it throws on
// an unrecognised envelope so a bulk snapshot can never wipe a
// segment's membership and re-insert zero rows from a shape drift.
export const SWEED_RPC_SEGMENT_RESULT_LIST = 'store.marketing.segment.result.list'

export interface SweedSegmentMember {
  /** Sweed customer id (the join key into `sweed_customer_segments`). */
  customerId: number
  /** When the customer entered the segment, if exposed, else null. */
  dateOnEnter: string | null
}

interface SegmentResultPage {
  members: SweedSegmentMember[]
  /** Total members across all pages, if the envelope reports it. */
  totalCount: number | null
  /** Members on THIS page before dedup (drives the paginate-until). */
  pageRowCount: number
}

function coerceStrOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Pure FAIL-CLOSED parser for ONE page of a
 * `store.marketing.segment.result.list` response. Exported for unit
 * testing. Throws on an unrecognised envelope; returns an empty page
 * (members: []) only when the recognised `customers.data` array is
 * present and empty, or `customers.totalCount` / top-level `total` is 0.
 */
export function parseSegmentResultPage(raw: unknown, segmentId: number): SegmentResultPage {
  const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  const customers =
    root && root.customers && typeof root.customers === 'object'
      ? (root.customers as Record<string, unknown>)
      : null

  // The verified path is `customers.data`. Tolerate a bare top-level
  // `data` array as a defensive fallback.
  let data: unknown[] | null = Array.isArray(customers?.data)
    ? (customers!.data as unknown[])
    : Array.isArray(root?.data)
      ? (root!.data as unknown[])
      : null

  const totalCount =
    Number.isFinite(Number(customers?.totalCount))
      ? Number(customers!.totalCount)
      : Number.isFinite(Number(root?.total))
        ? Number(root!.total)
        : null

  if (data === null) {
    // No recognised member array: only treat an explicit zero count as a
    // genuinely empty segment; otherwise fail closed.
    if (totalCount === 0) return { members: [], totalCount: 0, pageRowCount: 0 }
    throw new Error(
      `store.marketing.segment.result.list { id: ${segmentId} } returned an unrecognised shape ` +
        `(top-level keys: ${root ? Object.keys(root).join(',') : typeof raw}). ` +
        `Run scripts/probe-sweed-segment-members.ts ${segmentId} and update parseSegmentResultPage.`,
    )
  }

  const members: SweedSegmentMember[] = []
  for (const row of data) {
    if (row === null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const customerId = Number(r.customerId)
    if (!Number.isFinite(customerId) || customerId <= 0) continue
    members.push({ customerId, dateOnEnter: coerceStrOrNull(r.dateOnEnter) })
  }

  // A non-empty page that yielded zero parseable ids means the member-id
  // field name drifted — fail closed rather than under-count a segment.
  if (members.length === 0 && data.length > 0) {
    throw new Error(
      `store.marketing.segment.result.list { id: ${segmentId} } returned ${data.length} ` +
        `member rows but none had a parseable customerId. ` +
        `Run scripts/probe-sweed-segment-members.ts ${segmentId} and update parseSegmentResultPage.`,
    )
  }
  return { members, totalCount, pageRowCount: data.length }
}

/**
 * BULK-read every customer in one marketing segment via
 * `store.marketing.segment.result.list`, paginating until exhausted.
 * Dedups by customer id. Caller MUST be inside a `withSweedSession`
 * block. `dealerId` should be the segment's owning (scope) dealer
 * (state segments are visible from the state dealer 210248).
 */
export async function getSweedMarketingSegmentMembers(args: {
  dealerId: number
  segmentId: number
}): Promise<SweedSegmentMember[]> {
  const pageSize = 500
  const out: SweedSegmentMember[] = []
  const seen = new Set<number>()
  for (let page = 1; page <= 1000; page++) {
    const raw = await callSweedRpc<unknown>(args.dealerId, SWEED_RPC_SEGMENT_RESULT_LIST, {
      id: String(args.segmentId),
      page,
      pageSize,
    })
    const parsed = parseSegmentResultPage(raw, args.segmentId)
    for (const m of parsed.members) {
      if (seen.has(m.customerId)) continue
      seen.add(m.customerId)
      out.push(m)
    }
    // Stop when this page was short (last page) or we've collected the
    // full reported total.
    if (parsed.pageRowCount < pageSize) break
    if (parsed.totalCount != null && out.length >= parsed.totalCount) break
  }
  return out
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
