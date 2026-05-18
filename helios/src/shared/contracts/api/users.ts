import { z } from 'zod'

import { RoleSchema } from '../domain/auth.js'

// User management API contracts. Backed by the `users` table.
//
// All three routes are admin-only on the server (see
// `routes/users.ts`). The client surfaces them under
// /config/users behind `permissions.canManageUsers`.

export const UserRecordSchema = z.object({
  active: z.boolean(),
  createdAt: z.iso.datetime().nullable(),
  email: z.string().email(),
  googleSubClaimed: z.boolean(),
  id: z.number().int().positive(),
  lastLoginAt: z.iso.datetime().nullable(),
  name: z.string().min(1),
  role: RoleSchema,
  updatedAt: z.iso.datetime().nullable(),
})
export type UserRecord = z.infer<typeof UserRecordSchema>

export const UsersListResponseSchema = z.object({
  users: z.array(UserRecordSchema),
})
export type UsersListResponse = z.infer<typeof UsersListResponseSchema>

export const UsersCreateBodySchema = z.object({
  active: z.boolean().optional(),
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(120),
  role: RoleSchema,
})
export type UsersCreateBody = z.infer<typeof UsersCreateBodySchema>

export const UsersUpdateBodySchema = z
  .object({
    active: z.boolean().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    role: RoleSchema.optional(),
  })
  .refine(
    (body) => body.active !== undefined || body.name !== undefined || body.role !== undefined,
    { message: 'At least one of role, active, or name must be provided.' },
  )
export type UsersUpdateBody = z.infer<typeof UsersUpdateBodySchema>

export const UsersMutationResponseSchema = z.object({
  user: UserRecordSchema,
})
export type UsersMutationResponse = z.infer<typeof UsersMutationResponseSchema>

export const UsersRouteParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
})
export type UsersRouteParams = z.infer<typeof UsersRouteParamsSchema>
