import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { ScreensBannerHealthMaintenanceJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import {
  ScreenBannerArtifactSchema,
  buildScreenBannerRefreshCompletionSummary,
  runScreensRefreshScript,
  summarizeScreenBannerArtifact,
  type ScreenBannerArtifactSummary,
} from './screensBannerRefreshJob.js'
import {
  ScreensEnableHealthyBannersArtifactSchema,
  buildScreensEnableHealthyBannersCompletionSummary,
  runScreensEnableHealthyBannersScript,
  summarizeScreensEnableHealthyBannersArtifact,
  type ScreensEnableHealthyBannersArtifactSummary,
} from './screensEnableHealthyBannersJob.js'

const ScreensBannerHealthMaintenanceArtifactSchema = z.object({
  completedAt: z.string(),
  enableHealthyArtifactPath: z.string(),
  enableHealthySummary: z.object({
    enabledBannerCount: z.number().int().min(0),
    screenCount: z.number().int().min(0),
    siteDealerCount: z.number().int().min(0),
    targetBannerCount: z.number().int().min(0),
    targetedScreenCount: z.number().int().min(0),
    zeroDurationDisabledCount: z.number().int().min(0),
  }),
  enableHealthySummaryText: z.string(),
  mode: z.enum(['apply', 'dry-run']),
  refreshArtifactPath: z.string(),
  refreshSummary: z.object({
    bannerCount: z.number().int().min(0),
    screenCount: z.number().int().min(0),
    siteDealerCount: z.number().int().min(0),
    zeroDurationBannerCount: z.number().int().min(0),
  }),
  refreshSummaryText: z.string(),
  siteDealerIds: z.array(z.number().int().positive()),
  siteDealerNames: z.array(z.string()),
  startedAt: z.string(),
  trigger: z.enum(['manual_queue', 'scheduled']),
})

export async function runScreensBannerHealthMaintenanceJob(
  context: JobHandlerContext,
  payload: ScreensBannerHealthMaintenanceJobPayload,
): Promise<void> {
  const startedAt = new Date().toISOString()
  const refreshArtifactPath = await runScreensRefreshScript(context.id, {
    holdSeconds: 0,
    intent: 'refresh',
    mode: payload.mode,
    requestedByUserId: payload.requestedByUserId,
    siteDealerIds: payload.siteDealerIds,
  })
  const refreshArtifact = ScreenBannerArtifactSchema.parse(JSON.parse(await readFile(refreshArtifactPath, 'utf-8')))
  const refreshSummary = summarizeScreenBannerArtifact(refreshArtifact)

  await updateJobPayloadMetadata(context.id, {
    refreshArtifactPath,
    refreshCompletedAt: refreshArtifact.finishedAt,
    refreshRunSummary: refreshSummary,
    trigger: payload.trigger,
  })

  const enableHealthyArtifactPath = await runScreensEnableHealthyBannersScript(context.id, payload)
  const enableHealthyArtifact = ScreensEnableHealthyBannersArtifactSchema.parse(
    JSON.parse(await readFile(enableHealthyArtifactPath, 'utf-8')),
  )
  const enableHealthySummary = summarizeScreensEnableHealthyBannersArtifact(enableHealthyArtifact)
  if (enableHealthyArtifact.mode !== refreshArtifact.mode) {
    throw new Error(
      `Screens banner-health maintenance mode mismatch: refresh returned ${refreshArtifact.mode} but healthy-banner enable returned ${enableHealthyArtifact.mode}.`,
    )
  }

  const refreshSummaryPayload = {
    bannerCount: refreshSummary.bannerCount,
    screenCount: refreshSummary.screenCount,
    siteDealerCount: refreshSummary.siteDealerCount,
    zeroDurationBannerCount: refreshSummary.zeroDurationBannerCount,
  }
  const enableHealthySummaryPayload = {
    enabledBannerCount: enableHealthySummary.enabledBannerCount,
    screenCount: enableHealthySummary.screenCount,
    siteDealerCount: enableHealthySummary.siteDealerCount,
    targetBannerCount: enableHealthySummary.targetBannerCount,
    targetedScreenCount: enableHealthySummary.targetedScreenCount,
    zeroDurationDisabledCount: enableHealthySummary.zeroDurationDisabledCount,
  }

  const refreshSummaryText = buildScreenBannerRefreshCompletionSummary(refreshArtifact.mode, refreshSummary)
  const enableHealthySummaryText = buildScreensEnableHealthyBannersCompletionSummary(
    enableHealthyArtifact.mode,
    enableHealthySummary,
  )

  const combinedArtifactPath = await writeCombinedArtifact({
    completedAt: enableHealthyArtifact.finishedAt,
    enableHealthyArtifactPath,
    enableHealthySummary: enableHealthySummaryPayload,
    enableHealthySummaryText,
    jobId: context.id,
    mode: refreshArtifact.mode,
    refreshArtifactPath,
    refreshSummary: refreshSummaryPayload,
    refreshSummaryText,
    siteDealerIds: payload.siteDealerIds,
    siteDealerNames: collectSiteDealerNames(refreshArtifact, enableHealthyArtifact),
    startedAt,
    trigger: payload.trigger,
  })

  const combinedArtifact = ScreensBannerHealthMaintenanceArtifactSchema.parse(
    JSON.parse(await readFile(combinedArtifactPath, 'utf-8')),
  )

  await withTransaction(async (db) => {
    await db.query(
      `
        update job_queue
        set payload_json = payload_json || $2::jsonb,
            updated_at = now()
        where id = $1
      `,
      [
        context.id,
        JSON.stringify({
          artifactPath: combinedArtifactPath,
          completedAt: combinedArtifact.completedAt,
          enableHealthyArtifactPath,
          refreshArtifactPath,
          runSummary: {
            enableHealthy: enableHealthySummaryPayload,
            enableHealthySummaryText,
            refresh: refreshSummaryPayload,
            refreshSummaryText,
          },
          trigger: payload.trigger,
        }),
      ],
    )

    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'screens.banner_health_maintenance.completed',
      module: 'screens',
      payload: {
        artifactPath: combinedArtifactPath,
        enableHealthyArtifactPath,
        enableHealthySummary: enableHealthySummaryPayload,
        enableHealthySummaryText,
        mode: combinedArtifact.mode,
        queuedJobId: context.id,
        refreshArtifactPath,
        refreshSummary: refreshSummaryPayload,
        refreshSummaryText,
        siteDealerIds: payload.siteDealerIds,
        siteDealerNames: combinedArtifact.siteDealerNames,
        summary: buildScreensBannerHealthMaintenanceCompletionSummary(combinedArtifact.mode, {
          enableHealthy: enableHealthySummary,
          refresh: refreshSummary,
        }),
        trigger: payload.trigger,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

function collectSiteDealerNames(
  refreshArtifact: z.infer<typeof ScreenBannerArtifactSchema>,
  enableHealthyArtifact: z.infer<typeof ScreensEnableHealthyBannersArtifactSchema>,
): string[] {
  const names = new Set<string>()

  for (const siteDealer of refreshArtifact.siteDealers) {
    names.add(siteDealer.dealerName)
  }
  for (const siteDealer of enableHealthyArtifact.siteDealers) {
    names.add(siteDealer.dealerName)
  }

  return [...names]
}

async function updateJobPayloadMetadata(jobId: number, metadata: Record<string, unknown>): Promise<void> {
  await withTransaction(async (db) => {
    await db.query(
      `
        update job_queue
        set payload_json = payload_json || $2::jsonb,
            updated_at = now()
        where id = $1
      `,
      [jobId, JSON.stringify(metadata)],
    )
  })
}

async function writeCombinedArtifact({
  completedAt,
  enableHealthyArtifactPath,
  enableHealthySummary,
  enableHealthySummaryText,
  jobId,
  mode,
  refreshArtifactPath,
  refreshSummary,
  refreshSummaryText,
  siteDealerIds,
  siteDealerNames,
  startedAt,
  trigger,
}: {
  completedAt: string
  enableHealthyArtifactPath: string
  enableHealthySummary: ScreensEnableHealthyBannersArtifactSummary
  enableHealthySummaryText: string
  jobId: number
  mode: 'apply' | 'dry-run'
  refreshArtifactPath: string
  refreshSummary: ScreenBannerArtifactSummary
  refreshSummaryText: string
  siteDealerIds: number[]
  siteDealerNames: string[]
  startedAt: string
  trigger: ScreensBannerHealthMaintenanceJobPayload['trigger']
}): Promise<string> {
  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })

  const outputPath = resolve(
    artifactDirectory,
    `screens-banner-health-maintenance-job-${jobId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )

  const artifact = ScreensBannerHealthMaintenanceArtifactSchema.parse({
    completedAt,
    enableHealthyArtifactPath,
    enableHealthySummary,
    enableHealthySummaryText,
    mode,
    refreshArtifactPath,
    refreshSummary,
    refreshSummaryText,
    siteDealerIds,
    siteDealerNames,
    startedAt,
    trigger,
  })

  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8')
  return outputPath
}

function buildScreensBannerHealthMaintenanceCompletionSummary(
  mode: 'apply' | 'dry-run',
  summaries: {
    enableHealthy: ScreensEnableHealthyBannersArtifactSummary
    refresh: ScreenBannerArtifactSummary
  },
): string {
  if (mode === 'apply') {
    return `Applied banner-health maintenance across ${summaries.refresh.siteDealerCount} site(s) and ${summaries.refresh.screenCount} screen(s): refresh evaluated ${summaries.refresh.bannerCount} banner(s), ${summaries.refresh.zeroDurationBannerCount} zero-duration banner(s) stayed disabled, then the healthy-banner pass finished with ${summaries.enableHealthy.enabledBannerCount} banner(s) enabled and ${summaries.enableHealthy.zeroDurationDisabledCount} target banner(s) left disabled after rereading at zero duration.`
  }

  return `Completed banner-health maintenance dry-run across ${summaries.refresh.siteDealerCount} site(s) and ${summaries.refresh.screenCount} screen(s): refresh inspected ${summaries.refresh.bannerCount} banner(s), ${summaries.refresh.zeroDurationBannerCount} currently read as disabled zero-duration, and the follow-up sweep would re-enable ${summaries.enableHealthy.targetBannerCount} disabled banner(s) with positive duration.`
}

export {
  buildScreensBannerHealthMaintenanceCompletionSummary,
}
