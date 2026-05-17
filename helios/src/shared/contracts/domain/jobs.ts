import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'
import { HeliosModuleCodeSchema, HeliosModuleScopeSchema } from './modules.js'
import { ScopeKindSchema, ScopeRefSchema } from './scopeRef.js'
import {
  ScreensBannerRefreshJobPayloadSchema,
  ScreensBannerHealthMaintenanceJobPayloadSchema,
  ScreensBronxMidtownImageCloneJobPayloadSchema,
  ScreensEnableHealthyBannersJobPayloadSchema,
  ScreensImageBannerSyncJobPayloadSchema,
  ScreensMidtownFreshAndIntensePromoRebindJobPayloadSchema,
  ScreensMidtownPricedToMovePromoRebindJobPayloadSchema,
} from './screens.js'
import {
  SchedulingExtractConstraintsJobPayloadSchema,
  SchedulingGenerateCandidatesJobPayloadSchema,
} from './scheduling.js'

export const JobTypeSchema = z.enum([
  'catalog.sync.full_summary',
  'catalog.sync.group_detail',
  'catalog.sync.discover_orphan_groups',
  'catalog.pending_purchases.generate',
  'catalog.pending_purchases.apply',
  'catalog.pending_purchases.import_json',
  'proposal.import.review_json',
  'proposal.generate.description_batch',
  'proposal.generate.pricing_batch',
  'reconcile.group',
  'screens.banner_refresh',
  'screens.banner_health_maintenance',
  'screens.enable_healthy_banners',
  'screens.bronx_midtown_image_clone',
  'screens.midtown_priced_to_move_promo_rebind',
  'screens.midtown_fresh_and_intense_promo_rebind',
  'screens.image_banner_sync',
  'scheduling.extract_constraints',
  'scheduling.generate_candidates',
  'undo.execute',
  'llm.debug.rerun',
  'catalog.review.rerun_row',
  'config.workers.stock_refresh',
  'config.workers.litalerts_refresh.variant',
  'config.workers.catalog_refresh',
])
export type JobType = z.infer<typeof JobTypeSchema>

export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'dead_letter'])
export type JobStatus = z.infer<typeof JobStatusSchema>

export const JobModuleMetadataSchema = z.object({
  module: HeliosModuleCodeSchema,
  scope: HeliosModuleScopeSchema.nullable(),
})
export type JobModuleMetadata = z.infer<typeof JobModuleMetadataSchema>

export const JobProgressSchema = z
  .object({
    completed: z.number().int().min(0).nullable(),
    message: z.string().trim().min(1),
    phase: z.string().trim().min(1),
    phaseCount: z.number().int().min(1),
    phaseIndex: z.number().int().min(1),
    total: z.number().int().positive().nullable(),
  })
  .refine((value) => value.phaseIndex <= value.phaseCount, {
    message: 'phaseIndex must be less than or equal to phaseCount.',
    path: ['phaseIndex'],
  })
export type JobProgress = z.infer<typeof JobProgressSchema>

export const JobLogEntrySchema = z.object({
  createdAt: z.iso.datetime(),
  message: z.string().trim().min(1),
})
export type JobLogEntry = z.infer<typeof JobLogEntrySchema>

export const JobLinkedRecordRefsSchema = z.object({
  llmRunId: z.number().int().positive().nullable(),
  pendingPurchaseApplyRequestId: z.number().int().positive().nullable(),
  pendingPurchasePacketId: z.number().int().positive().nullable(),
  proposalBatchId: z.number().int().positive().nullable(),
  undoEventId: z.number().int().positive().nullable(),
  writeOperationId: z.number().int().positive().nullable(),
})
export type JobLinkedRecordRefs = z.infer<typeof JobLinkedRecordRefsSchema>

export const CatalogSyncFullSummaryJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z
    .enum(['manual_refresh', 'scheduled', 'catalog_maintenance_fix_cache'])
    .default('manual_refresh'),
})
export type CatalogSyncFullSummaryJobPayload = z.infer<typeof CatalogSyncFullSummaryJobPayloadSchema>

export const CatalogSyncGroupDetailJobPayloadSchema = z.object({
  catalogGroupId: z.number().int().positive(),
  forceLiveRefresh: z.boolean().optional().default(false),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z
    .enum([
      'full_summary',
      'manual_refresh',
      'reconcile_post_write',
      'scheduled',
      'catalog_maintenance_edit',
      'catalog_maintenance_fix_cache',
      'discovered_orphan_group',
    ])
    .default('manual_refresh'),
})
export type CatalogSyncGroupDetailJobPayload = z.infer<typeof CatalogSyncGroupDetailJobPayloadSchema>

export const CatalogSyncDiscoverOrphanGroupsJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: z
    .enum(['catalog_maintenance_fix_cache', 'manual_refresh', 'scheduled'])
    .default('catalog_maintenance_fix_cache'),
})
export type CatalogSyncDiscoverOrphanGroupsJobPayload = z.infer<
  typeof CatalogSyncDiscoverOrphanGroupsJobPayloadSchema
>

export const ProposalImportReviewJsonJobPayloadSchema = z.object({
  filePath: z.string().trim().min(1),
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type ProposalImportReviewJsonJobPayload = z.infer<typeof ProposalImportReviewJsonJobPayloadSchema>

export const CatalogPendingPurchasesImportJobPayloadSchema = z.object({
  filePath: z.string().trim().min(1),
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type CatalogPendingPurchasesImportJobPayload = z.infer<typeof CatalogPendingPurchasesImportJobPayloadSchema>

export const CatalogPendingPurchasesGenerateJobPayloadSchema = z.object({
  fromDate: z.iso.date(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  toDate: z.iso.date(),
})
export type CatalogPendingPurchasesGenerateJobPayload = z.infer<typeof CatalogPendingPurchasesGenerateJobPayloadSchema>

export const CatalogPendingPurchasesApplyJobPayloadSchema = z.object({
  pendingPurchaseApplyRequestId: z.number().int().positive(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type CatalogPendingPurchasesApplyJobPayload = z.infer<typeof CatalogPendingPurchasesApplyJobPayloadSchema>

const ProposalBatchGenerationTriggerSchema = z.enum(['debug_promote', 'ui_generate'])

export const ProposalGenerateDescriptionBatchJobPayloadSchema = z.object({
  forceLiveRefresh: z.boolean().default(false),
  proposalBatchId: z.number().int().positive(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: ProposalBatchGenerationTriggerSchema.default('ui_generate'),
})
export type ProposalGenerateDescriptionBatchJobPayload = z.infer<typeof ProposalGenerateDescriptionBatchJobPayloadSchema>

export const ProposalGeneratePricingBatchJobPayloadSchema = z.object({
  forceLiveRefresh: z.boolean().default(false),
  proposalBatchId: z.number().int().positive(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: ProposalBatchGenerationTriggerSchema.default('ui_generate'),
})
export type ProposalGeneratePricingBatchJobPayload = z.infer<typeof ProposalGeneratePricingBatchJobPayloadSchema>

export const ReconcileGroupJobPayloadSchema = z.object({
  catalogGroupId: z.number().int().positive(),
  expectedDesiredProjectionHash: z.string().trim().min(1).nullable(),
  trigger: z.enum(['admin_force', 'approval', 'drift_sync', 'manual_refresh', 'retry', 'undo']).default('approval'),
  triggerAuditEventId: z.number().int().positive().nullable().optional(),
})
export type ReconcileGroupJobPayload = z.infer<typeof ReconcileGroupJobPayloadSchema>

export const UndoExecuteJobPayloadSchema = z.object({
  undoEventId: z.number().int().positive(),
})
export type UndoExecuteJobPayload = z.infer<typeof UndoExecuteJobPayloadSchema>

export const LlmDebugRerunJobPayloadSchema = z.object({
  catalogGroupId: z.number().int().positive(),
  forceLiveRefresh: z.boolean().default(false),
  llmRunId: z.number().int().positive(),
  purpose: z.enum(['description', 'pricing', 'debug']),
  requestedByUserId: z.number().int().positive(),
})
export type LlmDebugRerunJobPayload = z.infer<typeof LlmDebugRerunJobPayloadSchema>

export const ConfigWorkersStockRefreshJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: z
    .enum(['manual_run', 'scheduled', 'catalog_maintenance_fix_cache'])
    .default('scheduled'),
})
export type ConfigWorkersStockRefreshJobPayload = z.infer<typeof ConfigWorkersStockRefreshJobPayloadSchema>

export const ConfigWorkersLitalertsRefreshVariantJobPayloadSchema = z.object({
  queueRowId: z.number().int().positive(),
  productId: z.number().int().positive(),
  siteDealerId: z.number().int().positive().nullable().optional(),
  sourceSnapshotId: z.number().int().positive().nullable().optional(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
})
export type ConfigWorkersLitalertsRefreshVariantJobPayload = z.infer<
  typeof ConfigWorkersLitalertsRefreshVariantJobPayloadSchema
>

export const ConfigWorkersCatalogRefreshJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
})
export type ConfigWorkersCatalogRefreshJobPayload = z.infer<
  typeof ConfigWorkersCatalogRefreshJobPayloadSchema
>

export const CatalogReviewRerunRowJobPayloadSchema = z.object({
  scopeKind: ScopeKindSchema,
  scopeRef: ScopeRefSchema,
  reason: z.string().trim().min(1).max(1000).optional(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type CatalogReviewRerunRowJobPayload = z.infer<typeof CatalogReviewRerunRowJobPayloadSchema>

export {
  ScreensBannerRefreshJobPayloadSchema,
  ScreensBannerHealthMaintenanceJobPayloadSchema,
  ScreensBronxMidtownImageCloneJobPayloadSchema,
  ScreensEnableHealthyBannersJobPayloadSchema,
  ScreensImageBannerSyncJobPayloadSchema,
  ScreensMidtownFreshAndIntensePromoRebindJobPayloadSchema,
  ScreensMidtownPricedToMovePromoRebindJobPayloadSchema,
  SchedulingExtractConstraintsJobPayloadSchema,
  SchedulingGenerateCandidatesJobPayloadSchema,
}

export const JobPayloadSchema = JsonValueSchema
export type JobPayload = z.infer<typeof JobPayloadSchema>
