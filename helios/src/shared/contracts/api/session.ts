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

export const SessionEnvelopeSchema = z.object({
  authMode: z.enum(['anonymous', 'session']),
  localDevSignInAvailable: z.boolean(),
  permissions: PermissionSetSchema,
  runtimeDependencies: z.array(RuntimeDependencyStatusSchema),
  user: SessionUserSchema.nullable(),
})
export type SessionEnvelope = z.infer<typeof SessionEnvelopeSchema>
