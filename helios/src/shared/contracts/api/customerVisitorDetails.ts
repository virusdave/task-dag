// Contracts for the customer / visitor details page
// (`/admin/customers/visitors/:scanId`).
//
// Phase-2 successor to the A4 stub in
// helios/src/client/routes/customers/CustomerVisitorDetailsPage.tsx.
// Backed by the dedicated endpoint
// `GET /api/admin/customers/visitors/:scanId` (server route in
// helios/src/server/routes/visitorScans.ts, query in
// visitorScansQueries.ts).
//
// The endpoint replaces the prior list-fetch-and-filter approach
// with a single focused payload:
//
//   - anchorScan        the full scan row (including PII fields not
//                       in the table-row VisitorScanItem)
//   - linkedCustomer    Sweed CRM link + best-known display fields
//   - priorVisits       every other visitor_scans row matching this
//                       person by id_num and/or person_key, each
//                       carrying its same-day purchase summary when
//                       a Sweed link is known
//   - purchaseInvoices  full invoice-header history for the Sweed
//                       customer (capped), each carrying a
//                       lineItemCount; the line items themselves are
//                       fetched lazily per invoice on expand from the
//                       materialised sweed_order_items_flat table via
//                       GET .../invoices/:invoiceId/items
//   - mapPoints         a few markers worth rendering on the full
//                       MapLibre canvas: document address, scan
//                       location, Sweed primary address(es),
//                       and seen-delivery destinations

import { z } from 'zod'

import {
  VisitorScanIdentitySchema,
  VisitorScanItemSchema,
  VisitorScanLinkStatusSchema,
  VisitorScanSweedLinkSchema,
  VisitorScanSweedPurchaseSummarySchema,
} from './visitorScans.js'

// ---------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------

export const CustomerVisitorAddressSchema = z.object({
  addressId: z.number().int().nullable(),
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  normalized: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  geocodeStatus: z.string().nullable(),
})
export type CustomerVisitorAddress = z.infer<typeof CustomerVisitorAddressSchema>

// ---------------------------------------------------------------------
// Anchor scan (the scan we're showing the details page for)
// ---------------------------------------------------------------------

// Extends the table-row VisitorScanItem with the additional PII /
// device / location fields that the table doesn't carry. The details
// page is where an operator wants the full set.
export const CustomerVisitorAnchorScanSchema = VisitorScanItemSchema.extend({
  idNum: z.string().nullable(),
  birthDate: z.string().nullable(),
  expDate: z.string().nullable(),
  gender: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  countryCode: z.string().nullable(),
  jurisdictionCode: z.string().nullable(),
  documentIsValid: z.boolean().nullable(),
  deviceId: z.number().int().nullable(),
  deviceName: z.string().nullable(),
  deviceLogin: z.string().nullable(),
  locationId: z.number().int().nullable(),
  locationName: z.string().nullable(),
  comments: z.string().nullable(),
  profileComments: z.string().nullable(),
  tags: z.string().nullable(),
  userAgent: z.string().nullable(),
  imageLink: z.string().nullable(),
  signatureLink: z.string().nullable(),
})
export type CustomerVisitorAnchorScan = z.infer<typeof CustomerVisitorAnchorScanSchema>

// ---------------------------------------------------------------------
// Sweed linked customer (best-known display info from any candidate)
// ---------------------------------------------------------------------

export const CustomerVisitorLinkedCustomerSchema = z.object({
  dealerId: z.number().int(),
  customerId: z.number().int().nullable(),
  status: VisitorScanLinkStatusSchema,
  method: z.string().nullable(),
  confidence: z.number().nullable(),
  linkedAt: z.string().nullable(),
  // Best display fields pulled from the link's candidate row when
  // present. May be null when the worker hasn't cached any.
  displayName: z.string().nullable(),
  displayAddress: z.string().nullable(),
  displayPhone: z.string().nullable(),
  displayEmail: z.string().nullable(),
  rawMatch: z.unknown().nullable(),
})
export type CustomerVisitorLinkedCustomer = z.infer<
  typeof CustomerVisitorLinkedCustomerSchema
>

// ---------------------------------------------------------------------
// Prior visit (other visitor_scans rows for this same person)
// ---------------------------------------------------------------------

export const CustomerVisitorVisitPurchaseSummarySchema = z.object({
  orderCount: z.number().int().nonnegative(),
  grandTotalDollars: z.number(),
  firstPayTime: z.string().nullable(),
  latestPayTime: z.string().nullable(),
})
export type CustomerVisitorVisitPurchaseSummary = z.infer<
  typeof CustomerVisitorVisitPurchaseSummarySchema
>

export const CustomerVisitorPriorVisitSchema = z.object({
  id: z.number().int(),
  customerUrl: z.string(),
  siteSlug: z.string(),
  ingestSource: z.string(),
  scannedAt: z.string().nullable(),
  ingestedAt: z.string(),
  visitAt: z.string(),
  // How we matched this row back to the anchor: by exact id_num, by
  // person_key (looser), or both at once.
  matchKind: z.enum(['id_num', 'person_key', 'both']),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  documentType: z.string().nullable(),
  scanStatus: z.string().nullable(),
  authenticationStatus: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  scanLatitude: z.number().nullable(),
  scanLongitude: z.number().nullable(),
  // Same-business-day (America/New_York) purchase rollup against the
  // linked Sweed customer. Null when the anchor is not linked, OR
  // when no purchases fell on the visit's local date.
  purchaseSummary: CustomerVisitorVisitPurchaseSummarySchema.nullable(),
})
export type CustomerVisitorPriorVisit = z.infer<typeof CustomerVisitorPriorVisitSchema>

// ---------------------------------------------------------------------
// Purchase invoice header (sweed_orders row)
// ---------------------------------------------------------------------

export const CustomerVisitorPurchaseInvoiceSchema = z.object({
  dealerId: z.number().int(),
  invoiceId: z.string(),
  payTime: z.string(),
  grandTotalDollars: z.number(),
  subtotalDollars: z.number().nullable(),
  taxDollars: z.number().nullable(),
  discountDollars: z.number().nullable(),
  fulfillmentType: z.string().nullable(),
  paymentMethod: z.string().nullable(),
  deliveryZip: z.string().nullable(),
  deliveryAddress: CustomerVisitorAddressSchema.nullable(),
  // Count of materialised line items for this invoice (from
  // sweed_order_items_flat). Lets the table show "N items" + an
  // expander without fetching the items themselves. Note: the flat
  // table only carries items that have an inventory_item_id, so this
  // can be 0 for an otherwise-valid invoice (e.g. fee-only tickets).
  lineItemCount: z.number().int().nonnegative(),
})
export type CustomerVisitorPurchaseInvoice = z.infer<
  typeof CustomerVisitorPurchaseInvoiceSchema
>

// ---------------------------------------------------------------------
// Purchase invoice line item (one row of sweed_order_items_flat, the
// materialised expansion of sweed_orders.raw_json->'items' built by
// the #39 DB-cost epic phase D1). Lazily fetched per invoice on expand
// via GET /api/admin/customers/visitors/:scanId/invoices/:invoiceId/items
// so the main details payload stays header-only.
// ---------------------------------------------------------------------

export const CustomerVisitorLineItemSchema = z.object({
  itemOrdinal: z.number().int().nonnegative(),
  inventoryItemId: z.string().nullable(),
  productId: z.number().int().nullable(),
  productName: z.string().nullable(),
  shortName: z.string().nullable(),
  category: z.string().nullable(),
  qty: z.number().nullable(),
  revenueDollars: z.number().nullable(),
  imageUrl: z.string().nullable(),
  status: z.string().nullable(),
})
export type CustomerVisitorLineItem = z.infer<typeof CustomerVisitorLineItemSchema>

export const CustomerVisitorInvoiceItemsResponseSchema = z.object({
  dealerId: z.number().int(),
  invoiceId: z.string(),
  lineItems: z.array(CustomerVisitorLineItemSchema),
})
export type CustomerVisitorInvoiceItemsResponse = z.infer<
  typeof CustomerVisitorInvoiceItemsResponseSchema
>

// ---------------------------------------------------------------------
// Map points
// ---------------------------------------------------------------------

export const CustomerVisitorMapPointSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'document_address',
    'scan_location',
    'sweed_primary_address',
    'sweed_delivery_destination',
  ]),
  label: z.string(),
  lat: z.number(),
  lng: z.number(),
  address: CustomerVisitorAddressSchema.nullable(),
  firstSeenAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  orderCount: z.number().int().nonnegative().nullable(),
  totalSpendDollars: z.number().nullable(),
})
export type CustomerVisitorMapPoint = z.infer<typeof CustomerVisitorMapPointSchema>

// ---------------------------------------------------------------------
// Sweed marketing segments (virusdave/top-level#12)
// ---------------------------------------------------------------------
//
// Scope tells the operator whether a segment spans both stores
// (state-level) or targets a single site. Derived server-side from the
// segment's owning dealer / target stores so the client never hardcodes
// dealer ids.

export const SweedSegmentScopeLevelSchema = z.enum(['state', 'site'])
export type SweedSegmentScopeLevel = z.infer<typeof SweedSegmentScopeLevelSchema>

export const SweedSegmentTypeSchema = z.enum(['static', 'dynamic', 'unknown'])
export type SweedSegmentType = z.infer<typeof SweedSegmentTypeSchema>

// A segment the linked customer currently belongs to.
export const CustomerVisitorSegmentMembershipSchema = z.object({
  segmentId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: SweedSegmentTypeSchema,
  scopeLevel: SweedSegmentScopeLevelSchema,
  // Human label for the scope ("All stores" or the store name).
  scopeLabel: z.string(),
  enabled: z.boolean().nullable(),
  dateOnEnter: z.string().nullable(),
})
export type CustomerVisitorSegmentMembership = z.infer<
  typeof CustomerVisitorSegmentMembershipSchema
>

// A static segment the customer is NOT already in, offered in the
// "add to a static segment" picker. Programmatic add is currently
// blocked by Sweed's API (every member-add RPC returns "Action is not
// available"), so each entry carries a deep link into Sweed Prime where
// the operator completes the add by hand.
export const CustomerVisitorAddableSegmentSchema = z.object({
  segmentId: z.string(),
  name: z.string(),
  scopeLevel: SweedSegmentScopeLevelSchema,
  scopeLabel: z.string(),
  enabled: z.boolean().nullable(),
  sweedPrimeUrl: z.string(),
})
export type CustomerVisitorAddableSegment = z.infer<
  typeof CustomerVisitorAddableSegmentSchema
>

// Freshness / status of the cached segment data for this customer.
export const CustomerVisitorSegmentsStateSchema = z.object({
  // null when the customer is not linked (no Sweed customer id).
  sweedCustomerId: z.number().int().nullable(),
  // 'never' until the first successful or attempted refresh.
  status: z.enum(['never', 'pending', 'ok', 'failed']),
  refreshedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  // Whether the operator can write segment membership through Helios.
  // Always false today — surfaced so the client renders the honest
  // "add manually in Sweed Prime" affordance instead of a fake button.
  programmaticAddSupported: z.literal(false),
})
export type CustomerVisitorSegmentsState = z.infer<
  typeof CustomerVisitorSegmentsStateSchema
>

// ---------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------

export const CustomerVisitorDetailsResponseSchema = z.object({
  anchorScan: CustomerVisitorAnchorScanSchema,
  linkedCustomer: CustomerVisitorLinkedCustomerSchema.nullable(),
  priorVisits: z.array(CustomerVisitorPriorVisitSchema),
  purchaseInvoices: z.array(CustomerVisitorPurchaseInvoiceSchema),
  purchaseInvoicesTruncated: z.boolean(),
  // Lifetime rollup across `purchaseInvoices` (server-side so the
  // page can show the totals without paginating client-side). Same
  // shape as VisitorScanSweedPurchaseSummary minus the anchor-
  // specific `priorPurchaseCount` / `hasPriorPurchaseBeforeScan`.
  purchaseLifetime: VisitorScanSweedPurchaseSummarySchema.nullable(),
  mapPoints: z.array(CustomerVisitorMapPointSchema),
  // Sweed marketing-segment membership for the linked customer, read
  // from the cache tables (never a live Sweed call on page load).
  // Empty array when the customer is not linked or has no cached
  // membership — distinguish via `segmentsState.status`.
  segments: z.array(CustomerVisitorSegmentMembershipSchema),
  // Static segments the customer is NOT already in, grouped-ready for
  // the "add to a static segment" picker. Empty when the catalog cache
  // is cold or the customer is unlinked.
  addableStaticSegments: z.array(CustomerVisitorAddableSegmentSchema),
  segmentsState: CustomerVisitorSegmentsStateSchema,
  // Identity rollup for the OTHER-visits joins (count is across the
  // matched person, NOT just this one scan).
  identity: VisitorScanIdentitySchema,
  limitations: z.object({
    // Per-item history IS available: it is materialised in
    // sweed_order_items_flat (the #39 DB-cost epic phase D1 expansion
    // of sweed_orders.raw_json->'items') and fetched lazily per
    // invoice. `lineItemsNote` is a non-null string only when the
    // server wants to surface a caveat (e.g. the flat table missing).
    lineItemsAvailable: z.boolean(),
    lineItemsNote: z.string().nullable(),
  }),
})
export type CustomerVisitorDetailsResponse = z.infer<
  typeof CustomerVisitorDetailsResponseSchema
>
