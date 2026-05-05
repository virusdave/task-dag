import { z } from 'zod'

export const RoleSchema = z.enum(['viewer', 'editor', 'approver', 'admin'])
export type Role = z.infer<typeof RoleSchema>

export const PermissionSetSchema = z.object({
  canApprove: z.boolean(),
  canEditProposals: z.boolean(),
  canForceReconcile: z.boolean(),
  canManageUsers: z.boolean(),
  canUndo: z.boolean(),
})
export type PermissionSet = z.infer<typeof PermissionSetSchema>

export const SessionUserSchema = z.object({
  active: z.boolean(),
  email: z.string().email(),
  id: z.number().int().positive(),
  name: z.string().min(1),
  role: RoleSchema,
})
export type SessionUser = z.infer<typeof SessionUserSchema>
