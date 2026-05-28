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
//                       customer (capped); sweed_orders intentionally
//                       does NOT carry line items today, see
//                       limitations.lineItemsNote
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
})
export type CustomerVisitorPurchaseInvoice = z.infer<
  typeof CustomerVisitorPurchaseInvoiceSchema
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
  // Identity rollup for the OTHER-visits joins (count is across the
  // matched person, NOT just this one scan).
  identity: VisitorScanIdentitySchema,
  limitations: z.object({
    // sweed_orders today persists invoice headers only — see the
    // comment in helios/src/server/db/schema/sweedOrders.sql. Item
    // history requires net-new Sweed RPC infrastructure.
    lineItemsAvailable: z.literal(false),
    lineItemsNote: z.string(),
  }),
})
export type CustomerVisitorDetailsResponse = z.infer<
  typeof CustomerVisitorDetailsResponseSchema
>
