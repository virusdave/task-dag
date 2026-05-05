import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID,
  HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME,
  HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_ID,
  HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_NAME,
  HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
  getHeliosScreensSiteDealer,
  type ScreensMidtownFreshAndIntensePromoRebindJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { getWorkerEnv } from '../config/env.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

const ScreensMidtownFreshAndIntensePromoRebindArtifactSchema = z.object({
  action: z.object({
    id: z.string().nullable().optional(),
    name: z.string(),
    readyForReplacement: z.boolean().optional(),
    selectorProductCount: z.number().int().nullable().optional(),
    status: z.string(),
  }).passthrough(),
  campaign: z.object({
    id: z.string().nullable().optional(),
    name: z.string(),
    status: z.string(),
  }).passthrough(),
  finishedAt: z.string(),
  mode: z.enum(['apply', 'dry-run']),
  screens: z.array(z.object({
    deletedImageBanner: z.object({
      bannerId: z.string(),
      bannerName: z.string(),
    }).passthrough().nullable().optional(),
    keptImageFallback: z.object({
      bannerId: z.string(),
      bannerName: z.string(),
    }).passthrough().nullable().optional(),
    newProductMenuBanner: z.object({
      bannerId: z.string(),
      bannerName: z.string(),
      finalEnabled: z.boolean().optional(),
      finalTotalDuration: z.number().int().optional(),
    }).passthrough().nullable().optional(),
    plannedProductMenuBanner: z.object({
      bannerName: z.string(),
    }).passthrough().nullable().optional(),
    screenId: z.number().int(),
    screenName: z.string(),
    skippedTargetReason: z.string().nullable().optional(),
  }).passthrough()),
  sourceCloneArtifactPath: z.string().optional(),
  startedAt: z.string(),
})

export async function runScreensMidtownFreshAndIntensePromoRebindJob(
  context: JobHandlerContext,
  payload: ScreensMidtownFreshAndIntensePromoRebindJobPayload,
): Promise<void> {
  const artifactPath = await runScreensMidtownFreshAndIntensePromoRebindScript(context.id, payload)
  const artifact = ScreensMidtownFreshAndIntensePromoRebindArtifactSchema.parse(JSON.parse(await readFile(artifactPath, 'utf-8')))
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
      eventType: 'screens.midtown_fresh_and_intense_promo_rebind.completed',
      module: 'screens',
      payload: {
        actionId: artifact.action.id ?? HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID,
        actionName: artifact.action.name,
        artifactPath,
        bannerName: HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME,
        campaignId: artifact.campaign.id ?? HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_ID,
        campaignName: artifact.campaign.name ?? HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_NAME,
        createdReplacementCount: summary.createdReplacementCount,
        deletedImageFallbackCount: summary.deletedImageFallbackCount,
        enabledReplacementCount: summary.enabledReplacementCount,
        keptImageFallbackCount: summary.keptImageFallbackCount,
        mode: artifact.mode,
        plannedReplacementCount: summary.plannedReplacementCount,
        queuedJobId: context.id,
        screenCount: summary.screenCount,
        selectorProductCount: artifact.action.selectorProductCount ?? null,
        skippedTargetCount: summary.skippedTargetCount,
        sourceCloneArtifactPath: artifact.sourceCloneArtifactPath ?? null,
        summary: buildCompletionSummary(artifact.mode, summary, artifact.action.selectorProductCount ?? null),
        targetDealerId: HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
        targetDealerName: readDealerName(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID),
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

async function runScreensMidtownFreshAndIntensePromoRebindScript(
  jobId: number,
  payload: ScreensMidtownFreshAndIntensePromoRebindJobPayload,
): Promise<string> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for Midtown Fresh & INTENSE promo rebinding jobs.')
  }

  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })

  const outputPath = resolve(
    artifactDirectory,
    `screens-midtown-fresh-and-intense-promo-rebind-job-${jobId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  const scriptPath = resolve(process.cwd(), '../../screens/replace_midtown_fresh_and_intense_image_banners_with_dynamic_promo.py')
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

function summarizeArtifact(artifact: z.infer<typeof ScreensMidtownFreshAndIntensePromoRebindArtifactSchema>): {
  createdReplacementCount: number
  deletedImageFallbackCount: number
  enabledReplacementCount: number
  keptImageFallbackCount: number
  plannedReplacementCount: number
  screenCount: number
  skippedTargetCount: number
} {
  let createdReplacementCount = 0
  let deletedImageFallbackCount = 0
  let enabledReplacementCount = 0
  let keptImageFallbackCount = 0
  let plannedReplacementCount = 0
  let skippedTargetCount = 0

  for (const screen of artifact.screens) {
    if (screen.plannedProductMenuBanner) {
      plannedReplacementCount += 1
    }
    if (screen.newProductMenuBanner) {
      createdReplacementCount += 1
      if (screen.newProductMenuBanner.finalEnabled) {
        enabledReplacementCount += 1
      }
    }
    if (screen.deletedImageBanner) {
      deletedImageFallbackCount += 1
    }
    if (screen.keptImageFallback) {
      keptImageFallbackCount += 1
    }
    if (screen.skippedTargetReason) {
      skippedTargetCount += 1
    }
  }

  return {
    createdReplacementCount,
    deletedImageFallbackCount,
    enabledReplacementCount,
    keptImageFallbackCount,
    plannedReplacementCount,
    screenCount: artifact.screens.length,
    skippedTargetCount,
  }
}

function buildCompletionSummary(
  mode: 'apply' | 'dry-run',
  summary: {
    createdReplacementCount: number
    deletedImageFallbackCount: number
    enabledReplacementCount: number
    keptImageFallbackCount: number
    plannedReplacementCount: number
    screenCount: number
    skippedTargetCount: number
  },
  selectorProductCount: number | null,
): string {
  const selectorClause = typeof selectorProductCount === 'number'
    ? ` The selector currently resolves ${selectorProductCount} product(s).`
    : ''
  const skippedClause = summary.skippedTargetCount > 0
    ? ` ${summary.skippedTargetCount} target banner(s) were already missing and were skipped.`
    : ''

  if (mode === 'apply') {
    return `Applied Midtown Fresh & INTENSE promo rebinding across ${summary.screenCount} screen(s); planned ${summary.plannedReplacementCount} replacement(s), created ${summary.createdReplacementCount} promo-backed banner(s), deleted ${summary.deletedImageFallbackCount} image fallback banner(s), kept ${summary.keptImageFallbackCount} image fallback banner(s), and ${summary.enabledReplacementCount} finished enabled.${selectorClause}${skippedClause}`
  }

  return `Completed Midtown Fresh & INTENSE promo rebinding dry-run across ${summary.screenCount} screen(s); planned ${summary.plannedReplacementCount} replacement(s) using the Midtown New Arrivals campaign and Fresh & Intense promo action.${selectorClause}${skippedClause}`
}

function buildScriptFailureMessage(code: number | null, stdout: string, stderr: string): string {
  const combinedOutput = [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join('\n')
  if (combinedOutput.length === 0) {
    return `Screens Midtown Fresh & INTENSE promo rebinding script exited with code ${code ?? 'unknown'}.`
  }

  const truncatedOutput = combinedOutput.length > 800 ? `${combinedOutput.slice(0, 799)}…` : combinedOutput
  return `Screens Midtown Fresh & INTENSE promo rebinding script exited with code ${code ?? 'unknown'}: ${truncatedOutput}`
}

function readDealerName(dealerId: number): string {
  return getHeliosScreensSiteDealer(dealerId)?.dealerName ?? `dealer ${dealerId}`
}
