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

// Per-user grants for individual subpages under the top-level
// Metrics navbar branch. One key per direct child of the Metrics
// branch (explore, brands, distributors, staff, reordering). The
// admin role implicitly holds ALL grants; non-admins see ONLY the
// grants stored on their users row. Grants gate both the sidebar
// rendering (client) and the analytics API endpoints (server),
// with the server as the authority.
//
// Adding a new key is a three-step change:
//   1. Append it to the enum + ALL_METRIC_GRANT_KEYS below.
//   2. Decide which routes/APIs check it (server side).
//   3. Surface it as a checkbox in /config/users.
export const MetricGrantKeySchema = z.enum([
  'explore',
  'brands',
  'distributors',
  'staff',
  'reordering',
])
export type MetricGrantKey = z.infer<typeof MetricGrantKeySchema>
export const ALL_METRIC_GRANT_KEYS: ReadonlyArray<MetricGrantKey> = [
  'explore',
  'brands',
  'distributors',
  'staff',
  'reordering',
]

export const SessionUserSchema = z.object({
  active: z.boolean(),
  email: z.string().email(),
  id: z.number().int().positive(),
  // Per-user metric subpage grants. Admins always carry the full
  // set (populated server-side at session-build time so client code
  // can read this list uniformly without re-checking role).
  metricGrants: z.array(MetricGrantKeySchema),
  name: z.string().min(1),
  role: RoleSchema,
})
export type SessionUser = z.infer<typeof SessionUserSchema>
