import { z } from 'zod'

const OptionalTextSchema = (max: number) => z.string().trim().min(1).max(max).nullable()

export const VendorBrandAssociationInputSchema = z
  .object({
    brandName: z.string().trim().min(1).max(200),
    isPrimary: z.boolean().default(true),
    targetDaysOnHand: z.number().int().positive().max(3_650).nullable().default(null),
    assetUrl: z.url().max(2_000).nullable().default(null),
    codRequired: z.boolean().nullable().default(null),
    codDiscountSource: OptionalTextSchema(500).default(null),
    minimumOrderDollars: z.number().nonnegative().max(100_000_000).nullable().default(null),
    comments: OptionalTextSchema(2_000).default(null),
  })
  .strict()
export type VendorBrandAssociationInput = z.infer<typeof VendorBrandAssociationInputSchema>

const VendorAssociationsInputSchema = z
  .array(VendorBrandAssociationInputSchema)
  .max(300)
  .superRefine((items, ctx) => {
    const seen = new Set<string>()
    items.forEach((item, index) => {
      const key = item.brandName.toLocaleLowerCase('en-US')
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'brandName'],
          message: 'A vendor cannot contain the same brand more than once.',
        })
      }
      seen.add(key)
    })
  })

export const VendorBrandAssociationSchema = VendorBrandAssociationInputSchema.extend({
  id: z.number().int().positive(),
})
export type VendorBrandAssociation = z.infer<typeof VendorBrandAssociationSchema>

export const VendorObservedDistributorSchema = z.object({
  name: z.string(),
  purchaseCount: z.number().int().nonnegative(),
  lastDeliveryDate: z.iso.date().nullable(),
  siteKeys: z.array(z.string()).max(20),
})
export type VendorObservedDistributor = z.infer<typeof VendorObservedDistributorSchema>

export const VendorSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  isMso: z.boolean(),
  isMicro: z.boolean(),
  codOnly: z.boolean(),
  associations: z.array(VendorBrandAssociationSchema).max(300),
  observedDistributors: z.array(VendorObservedDistributorSchema).max(20),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Vendor = z.infer<typeof VendorSchema>

export const VendorsListResponseSchema = z.object({
  vendors: z.array(VendorSchema).max(500),
})

export const VendorResponseSchema = z.object({ vendor: VendorSchema })

export const VendorCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    isMso: z.boolean().default(false),
    isMicro: z.boolean().default(false),
    codOnly: z.boolean().default(false),
    associations: VendorAssociationsInputSchema.default([]),
  })
  .strict()
export type VendorCreateRequest = z.infer<typeof VendorCreateRequestSchema>

export const VendorUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    isMso: z.boolean().optional(),
    isMicro: z.boolean().optional(),
    codOnly: z.boolean().optional(),
    associations: VendorAssociationsInputSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'At least one vendor field is required.')
export type VendorUpdateRequest = z.infer<typeof VendorUpdateRequestSchema>

export const VendorRouteParamsSchema = z.object({
  vendorId: z.coerce.number().int().positive(),
})
