import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { ScreensEnableHealthyBannersJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { getWorkerEnv } from '../config/env.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

export const ScreensEnableHealthyBannersArtifactSchema = z.object({
  finishedAt: z.string(),
  mode: z.enum(['apply', 'dry-run']),
  siteDealers: z.array(z.object({
    dealerId: z.number().int(),
    dealerName: z.string(),
    screens: z.array(z.object({
      screenId: z.number().int(),
      screenName: z.string(),
      targetBannerCount: z.number().int(),
      targetBanners: z.array(z.object({
        finalEnabled: z.boolean().optional(),
        finalTotalDuration: z.number().int().optional(),
        forcedDisabledBecauseZero: z.boolean().optional(),
        originalEnabled: z.boolean(),
        originalTotalDuration: z.number().int(),
      }).passthrough()),
    }).passthrough()),
  }).passthrough()),
  startedAt: z.string(),
})
export type ScreensEnableHealthyBannersArtifact = z.infer<typeof ScreensEnableHealthyBannersArtifactSchema>

export interface ScreensEnableHealthyBannersArtifactSummary {
  enabledBannerCount: number
  screenCount: number
  siteDealerCount: number
  targetBannerCount: number
  targetedScreenCount: number
  zeroDurationDisabledCount: number
}

export async function runScreensEnableHealthyBannersJob(
  context: JobHandlerContext,
  payload: ScreensEnableHealthyBannersJobPayload,
): Promise<void> {
  const artifactPath = await runScreensEnableHealthyBannersScript(context.id, payload)
  const artifact = ScreensEnableHealthyBannersArtifactSchema.parse(JSON.parse(await readFile(artifactPath, 'utf-8')))
  const summary = summarizeScreensEnableHealthyBannersArtifact(artifact)

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
      eventType: 'screens.enable_healthy_banners.completed',
      module: 'screens',
      payload: {
        artifactPath,
        enabledBannerCount: summary.enabledBannerCount,
        mode: artifact.mode,
        queuedJobId: context.id,
        screenCount: summary.screenCount,
        siteDealerCount: summary.siteDealerCount,
        siteDealerIds: payload.siteDealerIds,
        siteDealerNames: artifact.siteDealers.map((siteDealer) => siteDealer.dealerName),
        summary: buildScreensEnableHealthyBannersCompletionSummary(artifact.mode, summary),
        targetBannerCount: summary.targetBannerCount,
        targetedScreenCount: summary.targetedScreenCount,
        zeroDurationDisabledCount: summary.zeroDurationDisabledCount,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

export async function runScreensEnableHealthyBannersScript(
  jobId: number,
  payload: ScreensEnableHealthyBannersJobPayload,
): Promise<string> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for healthy-banner enable sweep jobs.')
  }

  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })

  const outputPath = resolve(
    artifactDirectory,
    `screens-enable-healthy-banners-job-${jobId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  const scriptPath = resolve(process.cwd(), '../../screens/enable_healthy_screen_banners.py')
  const args = [scriptPath, '--output', outputPath]

  if (payload.mode === 'apply') {
    args.push('--apply')
  }
  for (const dealerId of payload.siteDealerIds) {
    args.push('--dealer-id', String(dealerId))
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

export function summarizeScreensEnableHealthyBannersArtifact(
  artifact: ScreensEnableHealthyBannersArtifact,
): ScreensEnableHealthyBannersArtifactSummary {
  let targetBannerCount = 0
  let targetedScreenCount = 0
  let enabledBannerCount = 0
  let zeroDurationDisabledCount = 0

  for (const siteDealer of artifact.siteDealers) {
    for (const screen of siteDealer.screens) {
      targetBannerCount += screen.targetBanners.length
      if (screen.targetBannerCount > 0) {
        targetedScreenCount += 1
      }
      for (const banner of screen.targetBanners) {
        if (artifact.mode === 'apply') {
          if (banner.finalEnabled) {
            enabledBannerCount += 1
            continue
          }
          if (banner.finalTotalDuration === 0) {
            zeroDurationDisabledCount += 1
          }
          continue
        }

        enabledBannerCount += 1
      }
    }
  }

  return {
    enabledBannerCount,
    screenCount: artifact.siteDealers.reduce((count, siteDealer) => count + siteDealer.screens.length, 0),
    siteDealerCount: artifact.siteDealers.length,
    targetBannerCount,
    targetedScreenCount,
    zeroDurationDisabledCount,
  }
}

export function buildScreensEnableHealthyBannersCompletionSummary(
  mode: 'apply' | 'dry-run',
  summary: ScreensEnableHealthyBannersArtifactSummary,
): string {
  if (mode === 'apply') {
    return `Applied healthy-banner enable sweep across ${summary.siteDealerCount} site(s) and ${summary.targetedScreenCount} screen(s); ${summary.enabledBannerCount} banner(s) finished enabled and ${summary.zeroDurationDisabledCount} reread at zero duration and stayed disabled.`
  }

  return `Completed healthy-banner enable sweep dry-run across ${summary.siteDealerCount} site(s) and ${summary.screenCount} screen(s); ${summary.targetBannerCount} disabled banner(s) currently read with positive duration and would be re-enabled.`
}

function buildScriptFailureMessage(code: number | null, stdout: string, stderr: string): string {
  const combinedOutput = [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join('\n')
  if (combinedOutput.length === 0) {
    return `Healthy-banner enable sweep script exited with code ${code ?? 'unknown'}.`
  }

  const truncatedOutput = combinedOutput.length > 800 ? `${combinedOutput.slice(0, 799)}…` : combinedOutput
  return `Healthy-banner enable sweep script exited with code ${code ?? 'unknown'}: ${truncatedOutput}`
}
