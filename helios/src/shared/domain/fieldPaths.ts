import { z } from 'zod'

export const FieldPathSchema = z.enum(['description', 'products.price'])
export type FieldPath = z.infer<typeof FieldPathSchema>
