import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { ScreensBannerRefreshJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { getWorkerEnv } from '../config/env.js'
import { pageDave } from '../runtime/pageDave.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

export const ScreenBannerArtifactSchema = z.object({
  finishedAt: z.string(),
  mode: z.enum(['apply', 'dry-run']),
  siteDealers: z.array(z.object({
    dealerId: z.number().int(),
    dealerName: z.string(),
    screens: z.array(z.object({
      bannerCount: z.number().int(),
      banners: z.array(z.object({
        finalEnabled: z.boolean().optional(),
        finalTotalDuration: z.number().int().optional(),
        forcedDisabledBecauseZero: z.boolean(),
        originalEnabled: z.boolean(),
        originalTotalDuration: z.number().int(),
      }).passthrough()),
      screenId: z.number().int(),
      screenName: z.string(),
    }).passthrough()),
  }).passthrough()),
  startedAt: z.string(),
})
export type ScreenBannerArtifact = z.infer<typeof ScreenBannerArtifactSchema>

export interface ScreenBannerArtifactSummary {
  bannerCount: number
  screenCount: number
  siteDealerCount: number
  zeroDurationBannerCount: number
}

const MAX_JOB_PROGRESS_LOG_ENTRIES = 200

interface JobProgressBeacon {
  phase: string
  phaseIndex: number
  phaseCount: number
  message: string
  completed: number | null
  total: number | null
}

const TOTAL_PHASES = 5

const STAGE_TO_PHASE: Record<string, { phaseIndex: number; phase: string }> = {
  starting: { phaseIndex: 1, phase: 'Starting refresh' },
  banners_off: { phaseIndex: 2, phase: 'Disabling banners' },
  hold_started: { phaseIndex: 3, phase: 'Holding screens off' },
  hold_finished: { phaseIndex: 4, phase: 'Re-enabling banners' },
  reenable: { phaseIndex: 4, phase: 'Re-enabling banners' },
  finalize: { phaseIndex: 5, phase: 'Finalizing artifact' },
  completed: { phaseIndex: 5, phase: 'Completed' },
}

export async function runScreensBannerRefreshJob(
  context: JobHandlerContext,
  payload: ScreensBannerRefreshJobPayload,
): Promise<void> {
  const startedAtMs = Date.now()
  await updateJobProgress(context.id, {
    phase: 'Starting refresh',
    phaseIndex: 1,
    phaseCount: TOTAL_PHASES,
    message: payload.intent === 'bounce'
      ? `Starting ${payload.holdSeconds}-second banner/screen bounce.`
      : 'Starting screens banner refresh.',
    completed: null,
    total: null,
  })

  let artifactPath: string
  let artifact: ScreenBannerArtifact
  let summary: ScreenBannerArtifactSummary
  try {
    artifactPath = await runScreensRefreshScript(context.id, payload)
    artifact = ScreenBannerArtifactSchema.parse(JSON.parse(await readFile(artifactPath, 'utf-8')))
    summary = summarizeScreenBannerArtifact(artifact)
  } catch (error) {
    if (payload.intent === 'bounce') {
      await pageDaveSafe(buildBounceFailureMessage(context.id, payload, error))
    }
    throw error
  }

  const elapsedSeconds = Math.round((Date.now() - startedAtMs) / 1000)

  await updateJobProgress(context.id, {
    phase: 'Completed',
    phaseIndex: TOTAL_PHASES,
    phaseCount: TOTAL_PHASES,
    message: buildScreenBannerRefreshCompletionSummary(artifact.mode, summary, payload, elapsedSeconds),
    completed: summary.bannerCount,
    total: summary.bannerCount,
  })

  const completionSummary = buildScreenBannerRefreshCompletionSummary(artifact.mode, summary, payload, elapsedSeconds)

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
          elapsedSeconds,
          runSummary: summary,
        }),
      ],
    )

    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'screens.banner_refresh.completed',
      module: 'screens',
      payload: {
        artifactPath,
        bannerCount: summary.bannerCount,
        elapsedSeconds,
        holdSeconds: payload.holdSeconds,
        intent: payload.intent,
        mode: artifact.mode,
        queuedJobId: context.id,
        screenCount: summary.screenCount,
        siteDealerCount: summary.siteDealerCount,
        siteDealerIds: payload.siteDealerIds,
        siteDealerNames: artifact.siteDealers.map((siteDealer) => siteDealer.dealerName),
        summary: completionSummary,
        zeroDurationBannerCount: summary.zeroDurationBannerCount,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })

  if (payload.intent === 'bounce') {
    await pageDaveSafe(
      [
        `Helios screens bounce job #${context.id} ${artifact.mode === 'apply' ? 'applied' : 'dry-run'} succeeded.`,
        completionSummary,
        `Elapsed ${elapsedSeconds}s. Artifact: ${artifactPath}`,
      ].join(' '),
    )
  }
}

export async function runScreensRefreshScript(jobId: number, payload: ScreensBannerRefreshJobPayload): Promise<string> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for screens banner refresh jobs.')
  }

  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })

  const outputPath = resolve(
    artifactDirectory,
    `screens-banner-refresh-job-${jobId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  const scriptPath = resolve(process.cwd(), '../../screens/refresh_all_sites_screen_banners.py')
  const args = [scriptPath, '--output', outputPath]

  if (payload.mode === 'apply') {
    args.push('--apply')
  }
  for (const dealerId of payload.siteDealerIds) {
    args.push('--dealer-id', String(dealerId))
  }
  if (payload.holdSeconds > 0) {
    args.push('--hold-seconds', String(payload.holdSeconds))
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('python3', args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        SWEED_AUTH_TOKEN: env.sweedAuthToken ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''
    let stderrBuffer = ''

    const handleLines = (chunk: string, isError: boolean) => {
      const text = chunk.toString()
      const buffer = isError ? stderrBuffer + text : stdoutBuffer + text
      const lines = buffer.split('\n')
      const tail = lines.pop() ?? ''
      if (isError) {
        stderrBuffer = tail
      } else {
        stdoutBuffer = tail
      }
      for (const line of lines) {
        if (line.length === 0) continue
        if (isError) {
          console.error(`[screens.banner_refresh][job ${jobId}] ${line}`)
        } else {
          console.log(`[screens.banner_refresh][job ${jobId}] ${line}`)
        }
        const stage = parseHeliosStageLine(line)
        if (stage) {
          void writeStageProgress(jobId, stage, payload).catch((error) => {
            console.error(`[screens.banner_refresh][job ${jobId}] failed to record stage progress: ${(error as Error).message}`)
          })
        }
      }
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdout += text
      handleLines(text, false)
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderr += text
      handleLines(text, true)
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

export function summarizeScreenBannerArtifact(artifact: ScreenBannerArtifact): ScreenBannerArtifactSummary {
  let screenCount = 0
  let bannerCount = 0
  let zeroDurationBannerCount = 0

  for (const siteDealer of artifact.siteDealers) {
    screenCount += siteDealer.screens.length
    for (const screen of siteDealer.screens) {
      bannerCount += screen.banners.length
      for (const banner of screen.banners) {
        if (artifact.mode === 'apply') {
          if (banner.finalEnabled === false && banner.finalTotalDuration === 0) {
            zeroDurationBannerCount += 1
          }
          continue
        }

        if (banner.originalEnabled === false && banner.originalTotalDuration === 0) {
          zeroDurationBannerCount += 1
        }
      }
    }
  }

  return {
    bannerCount,
    screenCount,
    siteDealerCount: artifact.siteDealers.length,
    zeroDurationBannerCount,
  }
}

export function buildScreenBannerRefreshCompletionSummary(
  mode: 'apply' | 'dry-run',
  summary: ScreenBannerArtifactSummary,
  payload?: ScreensBannerRefreshJobPayload,
  elapsedSeconds?: number,
): string {
  const intentLabel = payload?.intent === 'bounce'
    ? `${payload.holdSeconds > 0 ? `${payload.holdSeconds}-second ` : ''}banner/screen bounce`
    : 'screens banner refresh'
  const elapsedTail = typeof elapsedSeconds === 'number' ? ` Elapsed ${elapsedSeconds}s.` : ''
  if (mode === 'apply') {
    return `Applied ${intentLabel} across ${summary.siteDealerCount} site(s), ${summary.screenCount} screen(s), and ${summary.bannerCount} banner(s); ${summary.zeroDurationBannerCount} zero-duration banner(s) remained disabled.${elapsedTail}`
  }

  return `Completed ${intentLabel} dry-run across ${summary.siteDealerCount} site(s), ${summary.screenCount} screen(s), and ${summary.bannerCount} banner(s); ${summary.zeroDurationBannerCount} banner(s) are currently disabled with zero duration.${elapsedTail}`
}

function buildScriptFailureMessage(code: number | null, stdout: string, stderr: string): string {
  const combinedOutput = [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join('\n')
  if (combinedOutput.length === 0) {
    return `Screens banner refresh script exited with code ${code ?? 'unknown'}.`
  }

  const truncatedOutput = combinedOutput.length > 800 ? `${combinedOutput.slice(0, 799)}…` : combinedOutput
  return `Screens banner refresh script exited with code ${code ?? 'unknown'}: ${truncatedOutput}`
}

function buildBounceFailureMessage(jobId: number, payload: ScreensBannerRefreshJobPayload, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const truncated = message.length > 400 ? `${message.slice(0, 399)}…` : message
  return `Helios screens bounce job #${jobId} (${payload.mode}, hold=${payload.holdSeconds}s) FAILED: ${truncated}`
}

async function pageDaveSafe(message: string): Promise<void> {
  try {
    await pageDave(message)
  } catch (error) {
    console.error(`[screens.banner_refresh] page-dave failed: ${(error as Error).message}`)
  }
}

function parseHeliosStageLine(line: string): string | null {
  const match = line.match(/HELIOS_STAGE\s+(\w+)/)
  return match ? match[1] : null
}

async function writeStageProgress(
  jobId: number,
  stage: string,
  payload: ScreensBannerRefreshJobPayload,
): Promise<void> {
  const mapped = STAGE_TO_PHASE[stage]
  if (!mapped) return

  const messages: Record<string, string> = {
    starting: payload.intent === 'bounce'
      ? `Starting ${payload.holdSeconds}-second banner/screen bounce.`
      : 'Starting screens banner refresh.',
    banners_off: 'Turning targeted banners off.',
    hold_started: payload.holdSeconds > 0
      ? `Screens off; holding for ${payload.holdSeconds} seconds.`
      : 'Screens off; immediate continuation.',
    hold_finished: 'Hold complete; re-enabling banners.',
    reenable: 'Re-enabling banners.',
    finalize: 'Finalizing artifact and readback.',
    completed: 'Completed.',
  }

  await updateJobProgress(jobId, {
    phase: mapped.phase,
    phaseIndex: mapped.phaseIndex,
    phaseCount: TOTAL_PHASES,
    message: messages[stage] ?? mapped.phase,
    completed: null,
    total: null,
  })
}

async function updateJobProgress(jobId: number, progress: JobProgressBeacon): Promise<void> {
  const progressLogEntry = JSON.stringify({
    createdAt: new Date().toISOString(),
    message: progress.message,
  })

  await getPool().query(
    `
      update job_queue
      set payload_json = (
            jsonb_set(
              jsonb_set(coalesce(payload_json, '{}'::jsonb), '{progress}', $2::jsonb, true),
              '{progressLog}',
              (
                select coalesce(jsonb_agg(entry order by ordinality asc), '[]'::jsonb)
                from (
                  select entry, ordinality
                  from (
                    select entry, ordinality
                    from jsonb_array_elements(coalesce(payload_json->'progressLog', '[]'::jsonb) || $3::jsonb) with ordinality as log_entries(entry, ordinality)
                    order by ordinality desc
                    limit ${MAX_JOB_PROGRESS_LOG_ENTRIES}
                  ) recent_entries
                ) trimmed_entries
              ),
              true
            )
          ),
          updated_at = now()
      where id = $1
    `,
    [jobId, JSON.stringify(progress), progressLogEntry],
  )
}
