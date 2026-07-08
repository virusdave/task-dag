import { z } from 'zod'

import { PermissionSetSchema, SessionUserSchema } from '../domain/auth.js'

export const RuntimeDependencyCodeSchema = z.enum(['bedrock', 'google_oauth', 'litalerts', 'sweed'])
export type RuntimeDependencyCode = z.infer<typeof RuntimeDependencyCodeSchema>

export const RuntimeDependencyStatusSchema = z.object({
  code: RuntimeDependencyCodeSchema,
  label: z.string(),
  status: z.enum(['configured', 'missing', 'optional_missing']),
  summary: z.string(),
})
export type RuntimeDependencyStatus = z.infer<typeof RuntimeDependencyStatusSchema>

// Server-side schema-drift signal: any helios SQL migration that the
// shipped server code expects to find applied but the live database
// does not. The SPA surfaces these in an all-pages banner so an
// operator notices before a user trips into a raw SQL error. The
// banner is a drift warning only; the actual apply happens via the
// admin-gated /config/pending-migrations "Apply Now" flow (no operator
// psql copy-paste), so no per-migration apply command is exposed here.
export const PendingMigrationSchema = z.object({
  migrationId: z.string(),
  label: z.string(),
})
export type PendingMigration = z.infer<typeof PendingMigrationSchema>

export const SessionEnvelopeSchema = z.object({
  authMode: z.enum(['anonymous', 'session']),
  localDevSignInAvailable: z.boolean(),
  pendingMigrations: z.array(PendingMigrationSchema),
  permissions: PermissionSetSchema,
  runtimeDependencies: z.array(RuntimeDependencyStatusSchema),
  user: SessionUserSchema.nullable(),
})
export type SessionEnvelope = z.infer<typeof SessionEnvelopeSchema>
