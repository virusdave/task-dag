import { z } from 'zod'

export const WORKER_CAPACITY_CONFIG_VERSION = 1 as const
export const WORKER_CAPACITY_SETTINGS_KEY = 'worker_capacity'

export const WorkerCapacityConfigSchema = z.object({
  version: z.literal(WORKER_CAPACITY_CONFIG_VERSION),
  generalSlots: z.number().int().nonnegative(),
  liveRequestedReservedSlots: z.number().int().nonnegative(),
  urgentReservedSlots: z.number().int().nonnegative(),
}).superRefine((value, context) => {
  const total = value.generalSlots + value.liveRequestedReservedSlots + value.urgentReservedSlots
  if (total < 1 || total > 32) {
    context.addIssue({ code: 'custom', message: 'Total worker capacity must be between 1 and 32 slots.' })
  }
})

export type WorkerCapacityConfig = z.infer<typeof WorkerCapacityConfigSchema>
export const DEFAULT_WORKER_CAPACITY_CONFIG: WorkerCapacityConfig = {
  version: WORKER_CAPACITY_CONFIG_VERSION,
  generalSlots: 1,
  liveRequestedReservedSlots: 2,
  urgentReservedSlots: 1,
}

export const WorkerCapacityResponseSchema = z.object({
  config: WorkerCapacityConfigSchema,
  updatedBy: z.string(),
  updatedAt: z.string(),
})
export type WorkerCapacityResponse = z.infer<typeof WorkerCapacityResponseSchema>
