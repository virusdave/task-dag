import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_SCREENS_BRONX_SITE_DEALER_ID,
  HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
  getHeliosScreensSiteDealer,
  type ScreensBronxMidtownImageCloneJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { getWorkerEnv } from '../config/env.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

const ScreensBronxMidtownImageCloneArtifactSchema = z.object({
  bronxSources: z.array(z.object({
    bannerId: z.string(),
    bannerName: z.string(),
    mediaPlan: z.object({
      strategy: z.enum(['reuse_existing_media', 'upload_from_promo_media_url', 'upload_required']),
    }).passthrough(),
  }).passthrough()),
  finishedAt: z.string(),
  midtownCloneRun: z.object({
    screens: z.array(z.object({
      created: z.array(z.object({
        bannerId: z.string(),
        bannerName: z.string(),
      }).passthrough()).optional().default([]),
      final: z.array(z.object({
        bannerId: z.string(),
        bannerName: z.string(),
        finalEnabled: z.boolean(),
        finalTotalDuration: z.number().int(),
      }).passthrough()).optional().default([]),
      plannedCreates: z.array(z.object({
        bannerName: z.string(),
      }).passthrough()),
      screenId: z.number().int(),
      screenName: z.string(),
    }).passthrough()),
  }),
  mode: z.enum(['apply', 'dry-run']),
  startedAt: z.string(),
})

export async function runScreensBronxMidtownImageCloneJob(
  context: JobHandlerContext,
  payload: ScreensBronxMidtownImageCloneJobPayload,
): Promise<void> {
  const artifactPath = await runScreensBronxMidtownImageCloneScript(context.id, payload)
  const artifact = ScreensBronxMidtownImageCloneArtifactSchema.parse(JSON.parse(await readFile(artifactPath, 'utf-8')))
  const summary = summarizeArtifact(artifact)

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
          artifactPath,
          completedAt: artifact.finishedAt,
          runSummary: summary,
        }),
      ],
    )

    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'screens.bronx_midtown_image_clone.completed',
      module: 'screens',
      payload: {
        artifactPath,
        bannerNames: artifact.bronxSources.map((source) => source.bannerName),
        createdCloneCount: summary.createdCloneCount,
        enabledCloneCount: summary.enabledCloneCount,
        mode: artifact.mode,
        plannedCloneCount: summary.plannedCloneCount,
        queuedJobId: context.id,
        screenCount: summary.screenCount,
        sourceBannerCount: summary.sourceBannerCount,
        sourceDealerId: HELIOS_SCREENS_BRONX_SITE_DEALER_ID,
        sourceDealerName: readDealerName(HELIOS_SCREENS_BRONX_SITE_DEALER_ID),
        summary: buildCompletionSummary(artifact.mode, summary),
        targetDealerId: HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
        targetDealerName: readDealerName(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID),
        uploadedMediaCount: summary.uploadedMediaCount,
        uploadRequiredCount: summary.uploadRequiredCount,
        zeroDurationDisabledCount: summary.zeroDurationDisabledCount,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

async function runScreensBronxMidtownImageCloneScript(
  jobId: number,
  payload: ScreensBronxMidtownImageCloneJobPayload,
): Promise<string> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for Bronx-to-Midtown image clone jobs.')
  }

  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })

  const outputPath = resolve(
    artifactDirectory,
    `screens-bronx-midtown-image-clone-job-${jobId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  const scriptPath = resolve(process.cwd(), '../../screens/clone_bronx_banners_to_midtown.py')
  const args = [scriptPath, '--output', outputPath]

  if (payload.mode === 'apply') {
    args.push('--apply')
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('python3', args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SWEED_AUTH_TOKEN: env.sweedAuthToken ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      reject(error)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      reject(new Error(buildScriptFailureMessage(code, stdout, stderr)))
    })
  })

  return outputPath
}

function summarizeArtifact(artifact: z.infer<typeof ScreensBronxMidtownImageCloneArtifactSchema>): {
  createdCloneCount: number
  enabledCloneCount: number
  plannedCloneCount: number
  screenCount: number
  sourceBannerCount: number
  uploadedMediaCount: number
  uploadRequiredCount: number
  zeroDurationDisabledCount: number
} {
  let plannedCloneCount = 0
  let createdCloneCount = 0
  let enabledCloneCount = 0
  let zeroDurationDisabledCount = 0

  for (const screen of artifact.midtownCloneRun.screens) {
    plannedCloneCount += screen.plannedCreates.length
    createdCloneCount += screen.created.length
    for (const banner of screen.final) {
      if (banner.finalEnabled) {
        enabledCloneCount += 1
        continue
      }

      if (banner.finalTotalDuration === 0) {
        zeroDurationDisabledCount += 1
      }
    }
  }

  return {
    createdCloneCount,
    enabledCloneCount,
    plannedCloneCount,
    screenCount: artifact.midtownCloneRun.screens.length,
    sourceBannerCount: artifact.bronxSources.length,
    uploadedMediaCount: artifact.bronxSources.filter((source) => source.mediaPlan.strategy === 'upload_from_promo_media_url').length,
    uploadRequiredCount: artifact.bronxSources.filter((source) => source.mediaPlan.strategy === 'upload_required').length,
    zeroDurationDisabledCount,
  }
}

function buildCompletionSummary(
  mode: 'apply' | 'dry-run',
  summary: {
    createdCloneCount: number
    enabledCloneCount: number
    plannedCloneCount: number
    screenCount: number
    sourceBannerCount: number
    uploadedMediaCount: number
    uploadRequiredCount: number
    zeroDurationDisabledCount: number
  },
): string {
  if (mode === 'apply') {
    return `Applied Bronx-to-Midtown image fallback clone for ${summary.sourceBannerCount} Bronx source banner(s) across ${summary.screenCount} Midtown screen(s); created ${summary.createdCloneCount} image banner(s), ${summary.enabledCloneCount} finished enabled, ${summary.zeroDurationDisabledCount} zero-duration banner(s) remained disabled, and ${summary.uploadedMediaCount} source asset(s) required Midtown uploads.`
  }

  return `Completed Bronx-to-Midtown image fallback dry-run for ${summary.sourceBannerCount} Bronx source banner(s) across ${summary.screenCount} Midtown screen(s); planned ${summary.plannedCloneCount} image banner(s) and ${summary.uploadRequiredCount} source asset(s) would require Midtown uploads.`
}

function buildScriptFailureMessage(code: number | null, stdout: string, stderr: string): string {
  const combinedOutput = [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join('\n')
  if (combinedOutput.length === 0) {
    return `Screens Bronx-to-Midtown image clone script exited with code ${code ?? 'unknown'}.`
  }

  const truncatedOutput = combinedOutput.length > 800 ? `${combinedOutput.slice(0, 799)}…` : combinedOutput
  return `Screens Bronx-to-Midtown image clone script exited with code ${code ?? 'unknown'}: ${truncatedOutput}`
}

function readDealerName(dealerId: number): string {
  return getHeliosScreensSiteDealer(dealerId)?.dealerName ?? `dealer ${dealerId}`
}
