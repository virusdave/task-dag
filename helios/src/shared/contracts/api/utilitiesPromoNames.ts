import { z } from 'zod'

// Utilities → Promo Names is a thin Sweed wrapper that lets an
// operator set the `shortName` on a Sweed promo action without the
// length/character limits the Sweed UI enforces. (Sweed's
// "Discounts" form caps short name input at ~16-20 chars; the
// underlying RPC accepts longer values, and several long
// already-shipped names like "ConcentratesHappyHour25%" prove it.)

export const PromoNamesDealerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  dealerTypeName: z.string().nullable().optional(),
})
export type PromoNamesDealer = z.infer<typeof PromoNamesDealerSchema>

export const PromoNamesDealerListResponseSchema = z.object({
  dealers: z.array(PromoNamesDealerSchema),
})
export type PromoNamesDealerListResponse = z.infer<typeof PromoNamesDealerListResponseSchema>

export const PromoNamesActionSchema = z.object({
  id: z.string(),
  dealerId: z.number().int(),
  name: z.string(),
  shortName: z.string().nullable(),
  enabled: z.boolean(),
  campaignId: z.string().nullable(),
  campaignName: z.string().nullable(),
})
export type PromoNamesAction = z.infer<typeof PromoNamesActionSchema>

export const PromoNamesActionResponseSchema = z.object({
  action: PromoNamesActionSchema,
})
export type PromoNamesActionResponse = z.infer<typeof PromoNamesActionResponseSchema>

export const PromoNamesShortNameUpdateSchema = z.object({
  // Sweed's RPC accepts a long string but ultimately writes to a
  // database column. 200 chars is well past anything that would
  // render usefully on a register UI; keep it as an upper-bound
  // sanity guard so we don't paste a novel by accident.
  shortName: z.string().min(1).max(200),
})
export type PromoNamesShortNameUpdate = z.infer<typeof PromoNamesShortNameUpdateSchema>
