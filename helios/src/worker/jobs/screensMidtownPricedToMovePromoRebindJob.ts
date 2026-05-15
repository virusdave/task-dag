import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
  HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS,
  getHeliosScreensSiteDealer,
  type ScreensMidtownPricedToMovePromoRebindJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { getWorkerEnv } from '../config/env.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

const ScreensMidtownPricedToMovePromoRebindArtifactSchema = z.object({
  finishedAt: z.string(),
  mode: z.enum(['apply', 'dry-run']),
  promoActions: z.array(z.object({
    actionId: z.string(),
    actionName: z.string(),
    bannerName: z.string(),
    finalEnabled: z.boolean(),
  }).passthrough()),
  screens: z.array(z.object({
    createdProductMenuBanners: z.array(z.object({
      bannerId: z.string(),
      bannerName: z.string(),
      finalEnabled: z.boolean().optional(),
      finalTotalDuration: z.number().int().optional(),
    }).passthrough()).optional().default([]),
    plannedProductMenuBanners: z.array(z.object({
      bannerName: z.string(),
    }).passthrough()).optional().default([]),
    screenId: z.number().int(),
    screenName: z.string(),
    skippedTargets: z.array(z.object({
      bannerName: z.string(),
      reason: z.string(),
    }).passthrough()).optional().default([]),
  }).passthrough()),
  sourceCloneArtifactPath: z.string().optional(),
  startedAt: z.string(),
})

export async function runScreensMidtownPricedToMovePromoRebindJob(
  context: JobHandlerContext,
  payload: ScreensMidtownPricedToMovePromoRebindJobPayload,
): Promise<void> {
  const artifactPath = await runScreensMidtownPricedToMovePromoRebindScript(context.id, payload)
  const artifact = ScreensMidtownPricedToMovePromoRebindArtifactSchema.parse(JSON.parse(await readFile(artifactPath, 'utf-8')))
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
      eventType: 'screens.midtown_priced_to_move_promo_rebind.completed',
      module: 'screens',
      payload: {
        actionIds: artifact.promoActions.map((action) => action.actionId),
        actionNames: artifact.promoActions.map((action) => action.actionName),
        artifactPath,
        bannerNames: HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS.map((action) => action.bannerName),
        createdReplacementCount: summary.createdReplacementCount,
        enabledReplacementCount: summary.enabledReplacementCount,
        mode: artifact.mode,
        plannedReplacementCount: summary.plannedReplacementCount,
        promoActionCount: summary.promoActionCount,
        queuedJobId: context.id,
        screenCount: summary.screenCount,
        skippedTargetCount: summary.skippedTargetCount,
        sourceCloneArtifactPath: artifact.sourceCloneArtifactPath ?? null,
        summary: buildCompletionSummary(artifact.mode, summary),
        targetDealerId: HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
        targetDealerName: readDealerName(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID),
        zeroDurationDisabledCount: summary.zeroDurationDisabledCount,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

async function runScreensMidtownPricedToMovePromoRebindScript(
  jobId: number,
  payload: ScreensMidtownPricedToMovePromoRebindJobPayload,
): Promise<string> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for Midtown Priced to MOVE promo rebinding jobs.')
  }

  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })

  const outputPath = resolve(
    artifactDirectory,
    `screens-midtown-priced-to-move-promo-rebind-job-${jobId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  const scriptPath = resolve(process.cwd(), '../../screens/tie_midtown_priced_to_move_banners_to_velocity_promos.py')
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

function summarizeArtifact(artifact: z.infer<typeof ScreensMidtownPricedToMovePromoRebindArtifactSchema>): {
  createdReplacementCount: number
  enabledReplacementCount: number
  plannedReplacementCount: number
  promoActionCount: number
  screenCount: number
  skippedTargetCount: number
  zeroDurationDisabledCount: number
} {
  let plannedReplacementCount = 0
  let createdReplacementCount = 0
  let enabledReplacementCount = 0
  let skippedTargetCount = 0
  let zeroDurationDisabledCount = 0

  for (const screen of artifact.screens) {
    plannedReplacementCount += screen.plannedProductMenuBanners.length
    createdReplacementCount += screen.createdProductMenuBanners.length
    skippedTargetCount += screen.skippedTargets.length
    for (const banner of screen.createdProductMenuBanners) {
      if (banner.finalEnabled) {
        enabledReplacementCount += 1
        continue
      }

      if (banner.finalTotalDuration === 0) {
        zeroDurationDisabledCount += 1
      }
    }
  }

  return {
    createdReplacementCount,
    enabledReplacementCount,
    plannedReplacementCount,
    promoActionCount: artifact.promoActions.length,
    screenCount: artifact.screens.length,
    skippedTargetCount,
    zeroDurationDisabledCount,
  }
}

function buildCompletionSummary(
  mode: 'apply' | 'dry-run',
  summary: {
    createdReplacementCount: number
    enabledReplacementCount: number
    plannedReplacementCount: number
    promoActionCount: number
    screenCount: number
    skippedTargetCount: number
    zeroDurationDisabledCount: number
  },
): string {
  const skippedClause = summary.skippedTargetCount > 0
    ? ` ${summary.skippedTargetCount} target banner(s) were already missing and were skipped.`
    : ''

  if (mode === 'apply') {
    return `Applied Midtown Priced to MOVE promo rebinding across ${summary.screenCount} screen(s); planned ${summary.plannedReplacementCount} replacement(s), created ${summary.createdReplacementCount} promo-backed banner(s), ${summary.enabledReplacementCount} finished enabled, and ${summary.zeroDurationDisabledCount} remained disabled with zero duration.${skippedClause}`
  }

  return `Completed Midtown Priced to MOVE promo rebinding dry-run across ${summary.screenCount} screen(s); planned ${summary.plannedReplacementCount} replacement(s) using ${summary.promoActionCount} Velocity Boosters promo action(s).${skippedClause}`
}

function buildScriptFailureMessage(code: number | null, stdout: string, stderr: string): string {
  const combinedOutput = [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join('\n')
  if (combinedOutput.length === 0) {
    return `Screens Midtown Priced to MOVE promo rebinding script exited with code ${code ?? 'unknown'}.`
  }

  const truncatedOutput = combinedOutput.length > 800 ? `${combinedOutput.slice(0, 799)}…` : combinedOutput
  return `Screens Midtown Priced to MOVE promo rebinding script exited with code ${code ?? 'unknown'}: ${truncatedOutput}`
}

function readDealerName(dealerId: number): string {
  return getHeliosScreensSiteDealer(dealerId)?.dealerName ?? `dealer ${dealerId}`
}
