// VeriScan webhook envelope shape + reshape utilities.
//
// The wire-level shape of a VeriScan check-in webhook is documented at
// https://docs.idscan.net/veriscan-online/webhook/payloads.html — an
// envelope (Type / EventId / WebHookId / Created / Sent) wrapping a
// `Data` object that contains the actual identity, address, and
// device fields.
//
// We capture the **whole envelope** verbatim in
// `visitor_scans.raw_envelope` JSONB. Below we additionally pull the
// fields we want as first-class columns for filtering / display.
// Casing is preserved (VeriScan ships PascalCase keys) so a future
// payload-shape change is easy to spot in a diff.
//
// This module is also reused by the backfill CLI
// (helios/scripts/visitor-scans-backfill.ts). The backfill file is a
// flat row dump rather than wire envelopes, so the CLI synthesises an
// envelope per row and feeds it through the same mapping path —
// guaranteeing that a backfilled scan and a webhook-delivered scan
// produce identical column values.

import { z } from 'zod'

// We deliberately use `passthrough`-shaped schemas: VeriScan can
// (and will) add fields. The webhook handler stores the *raw* JSON
// blob, so unknown future fields survive on the row even if we never
// teach this schema about them.

export const VeriScanDataSchema = z
  .object({
    HashId: z.string().min(1),
    HistoryLogId: z.union([z.number().int(), z.string()]).nullish(),
    Scanned: z.string().nullish(),
    IdNum: z.string().nullish(),
    FirstName: z.string().nullish(),
    MiddleName: z.string().nullish(),
    LastName: z.string().nullish(),
    BirthDate: z.string().nullish(),
    ExpDate: z.string().nullish(),
    Gender: z.string().nullish(),
    Phone: z.string().nullish(),
    Email: z.string().nullish(),
    Address: z.string().nullish(),
    City: z.string().nullish(),
    State: z.string().nullish(),
    PostalCode: z.string().nullish(),
    Country: z.string().nullish(),
    CountryCode: z.string().nullish(),
    JurisdictionCode: z.string().nullish(),
    Latitude: z.union([z.number(), z.string()]).nullish(),
    Longitude: z.union([z.number(), z.string()]).nullish(),
    ScanLatitude: z.union([z.number(), z.string()]).nullish(),
    ScanLongitude: z.union([z.number(), z.string()]).nullish(),
    DeviceId: z.union([z.number().int(), z.string()]).nullish(),
    DeviceName: z.string().nullish(),
    DeviceLogin: z.string().nullish(),
    LocationId: z.union([z.number().int(), z.string()]).nullish(),
    LocationName: z.string().nullish(),
    GroupId: z.union([z.number().int(), z.string()]).nullish(),
    GroupName: z.string().nullish(),
    GroupComment: z.string().nullish(),
    DocumentType: z.string().nullish(),
    DocumentIsValid: z.union([z.boolean(), z.string(), z.number()]).nullish(),
    AuthenticationStatus: z.string().nullish(),
    ScanStatus: z.string().nullish(),
    Comments: z.string().nullish(),
    ProfileComments: z.string().nullish(),
    Tags: z.string().nullish(),
    UserAgent: z.string().nullish(),
    ImageLink: z.string().nullish(),
    SignatureLink: z.string().nullish(),
    AttachmentLinks: z.array(z.string()).nullish(),
  })
  .loose()

export const VeriScanEnvelopeSchema = z
  .object({
    Type: z.string().min(1),
    EventId: z.union([z.number().int(), z.string()]),
    WebHookId: z.union([z.number().int(), z.string()]),
    WebHookTypeId: z.union([z.number().int(), z.string()]).nullish(),
    Created: z.string().nullish(),
    Sent: z.string().nullish(),
    Data: VeriScanDataSchema,
  })
  .loose()

export type VeriScanEnvelope = z.infer<typeof VeriScanEnvelopeSchema>
export type VeriScanData = z.infer<typeof VeriScanDataSchema>

// Normalised, insert-shaped row we hand to the insert helper. Column
// names mirror the snake_case DB columns.
export interface VisitorScanRowInput {
  ingestSource: 'webhook' | 'backfill'
  siteSlug: string
  provider: string
  rawEnvelope: unknown

  eventId: bigint | null
  webhookId: bigint | null
  webhookType: string | null
  webhookTypeId: number | null
  createdAt: string | null
  sentAt: string | null

  hashId: string
  historyLogId: bigint | null
  scannedAt: string | null

  idNum: string | null
  firstName: string | null
  middleName: string | null
  lastName: string | null
  birthDate: string | null
  expDate: string | null
  gender: string | null
  phone: string | null
  email: string | null

  address: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  country: string | null
  countryCode: string | null
  jurisdictionCode: string | null

  latitude: number | null
  longitude: number | null
  scanLatitude: number | null
  scanLongitude: number | null

  deviceId: bigint | null
  deviceName: string | null
  deviceLogin: string | null
  locationId: bigint | null
  locationName: string | null
  groupId: bigint | null
  groupName: string | null
  groupComment: string | null
  documentType: string | null
  documentIsValid: boolean | null
  authenticationStatus: string | null
  scanStatus: string | null
  comments: string | null
  profileComments: string | null
  tags: string | null
  userAgent: string | null

  imageLink: string | null
  signatureLink: string | null
  attachmentLinks: string[] | null
}

function trimOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string') {
    return String(value)
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function toBigIntOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  try {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null
      return BigInt(Math.trunc(value))
    }
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length === 0) return null
      return BigInt(trimmed)
    }
    if (typeof value === 'bigint') {
      return value
    }
  } catch {
    return null
  }
  return null
}

function toIntOrNull(value: unknown): number | null {
  const asBig = toBigIntOrNull(value)
  if (asBig === null) return null
  return Number(asBig)
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    const parsed = Number.parseFloat(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toBoolOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y'].includes(lower)) return true
    if (['false', '0', 'no', 'n'].includes(lower)) return false
  }
  return null
}

// VeriScan timestamps arrive as ISO 8601 strings (sometimes with
// trailing 'Z', sometimes without). Postgres `timestamptz` happily
// parses both, so we forward the string as-is after a trim/empty
// check.
function isoOrNull(value: unknown): string | null {
  return trimOrNull(value)
}

// VeriScan ships birth/exp as `YYYY-MM-DD`. We forward as a string;
// Postgres will coerce on insert. Null on missing.
function dateOrNull(value: unknown): string | null {
  return trimOrNull(value)
}

/**
 * Build the normalised insert-row from a validated VeriScan envelope
 * plus the per-request `site_slug` (route binding). Both webhook and
 * backfill paths go through here, guaranteeing identical column
 * values for the same `Data` payload.
 */
export function envelopeToRowInput(args: {
  envelope: VeriScanEnvelope
  ingestSource: 'webhook' | 'backfill'
  siteSlug: string
  provider: string
  rawEnvelope: unknown
}): VisitorScanRowInput {
  const { envelope, ingestSource, siteSlug, provider, rawEnvelope } = args
  const data = envelope.Data
  return {
    ingestSource,
    siteSlug,
    provider,
    rawEnvelope,

    eventId: toBigIntOrNull(envelope.EventId),
    webhookId: toBigIntOrNull(envelope.WebHookId),
    webhookType: trimOrNull(envelope.Type),
    webhookTypeId: toIntOrNull(envelope.WebHookTypeId),
    createdAt: isoOrNull(envelope.Created),
    sentAt: isoOrNull(envelope.Sent),

    hashId: data.HashId.trim(),
    historyLogId: toBigIntOrNull(data.HistoryLogId),
    scannedAt: isoOrNull(data.Scanned),

    idNum: trimOrNull(data.IdNum),
    firstName: trimOrNull(data.FirstName),
    middleName: trimOrNull(data.MiddleName),
    lastName: trimOrNull(data.LastName),
    birthDate: dateOrNull(data.BirthDate),
    expDate: dateOrNull(data.ExpDate),
    gender: trimOrNull(data.Gender),
    phone: trimOrNull(data.Phone),
    email: trimOrNull(data.Email),

    address: trimOrNull(data.Address),
    city: trimOrNull(data.City),
    state: trimOrNull(data.State),
    postalCode: trimOrNull(data.PostalCode),
    country: trimOrNull(data.Country),
    countryCode: trimOrNull(data.CountryCode),
    jurisdictionCode: trimOrNull(data.JurisdictionCode),

    latitude: toNumberOrNull(data.Latitude),
    longitude: toNumberOrNull(data.Longitude),
    scanLatitude: toNumberOrNull(data.ScanLatitude),
    scanLongitude: toNumberOrNull(data.ScanLongitude),

    deviceId: toBigIntOrNull(data.DeviceId),
    deviceName: trimOrNull(data.DeviceName),
    deviceLogin: trimOrNull(data.DeviceLogin),
    locationId: toBigIntOrNull(data.LocationId),
    locationName: trimOrNull(data.LocationName),
    groupId: toBigIntOrNull(data.GroupId),
    groupName: trimOrNull(data.GroupName),
    groupComment: trimOrNull(data.GroupComment),
    documentType: trimOrNull(data.DocumentType),
    documentIsValid: toBoolOrNull(data.DocumentIsValid),
    authenticationStatus: trimOrNull(data.AuthenticationStatus),
    scanStatus: trimOrNull(data.ScanStatus),
    comments: trimOrNull(data.Comments),
    profileComments: trimOrNull(data.ProfileComments),
    tags: trimOrNull(data.Tags),
    userAgent: trimOrNull(data.UserAgent),

    imageLink: trimOrNull(data.ImageLink),
    signatureLink: trimOrNull(data.SignatureLink),
    attachmentLinks:
      Array.isArray(data.AttachmentLinks) && data.AttachmentLinks.length > 0
        ? data.AttachmentLinks.map((value) => String(value))
        : null,
  }
}
