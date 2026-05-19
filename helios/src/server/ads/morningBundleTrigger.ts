/**
 * In-process trigger for the morning bundle pipeline.
 *
 * Replaces the old `sudo -n /run/current-system/sw/bin/gads-run-morning-trigger`
 * approach. The pipeline now runs IN the helios-server process as a
 * detached background promise — no sudo, no systemd, no python.
 *
 * The HTTP route awaits this function only long enough to acquire
 * the single-flight lock and decide the operator-facing status:
 *   - 'triggered'        : we started the pipeline; UI should poll
 *                          the runs index for the new ZIP to appear.
 *   - 'already-running'  : a pipeline is already in flight; no-op.
 *   - 'trigger-failed'   : something upstream of the pipeline itself
 *                          blocked the start (e.g. no snapshot on
 *                          disk yet).
 *
 * The actual L1→L2 analysis + zip + filesystem writes happen in
 * runMorningBundle(), executed without awaiting the HTTP request —
 * the operator gets the "triggered" pill back within a few hundred
 * ms while the pipeline keeps running in the background for ~1–2
 * minutes. Completion is observed by the new ZIP appearing in the
 * runs index.
 */

import type { FastifyBaseLogger } from 'fastify'

import type { MorningBundleRunTriggerResponse } from '../../shared/contracts/index.js'
import { runMorningBundle, MorningBundleRunError } from './runMorningBundle.js'

interface InflightState {
  startedAt: Date
  promise: Promise<unknown>
}

interface LastResult {
  finishedAt: Date
  ok: boolean
  runId: string | null
  errorMessage: string | null
  errorDetail: string | null
}

let inflight: InflightState | null = null
let lastResult: LastResult | null = null

export function getMorningBundleInflight(): { startedAt: string } | null {
  return inflight ? { startedAt: inflight.startedAt.toISOString() } : null
}

export function getMorningBundleLastResult(): LastResult | null {
  return lastResult
}

export async function triggerMorningBundle(
  log: FastifyBaseLogger,
): Promise<MorningBundleRunTriggerResponse> {
  if (inflight) {
    return {
      status: 'already-running',
      message: 'A morning pipeline run is already in flight. The new bundle will appear in the list below once it completes.',
    }
  }

  const startedAt = new Date()

  // Kick off the pipeline without awaiting it on the HTTP path. We
  // capture the promise so:
  //   1. unhandled-rejection won't crash the process,
  //   2. the in-flight flag stays accurate,
  //   3. lastResult is recorded for diagnostics.
  const promise = runMorningBundle({
    onLog: (line) => {
      log.info({ component: 'morning-bundle' }, line)
    },
  })
    .then((result) => {
      lastResult = {
        finishedAt: new Date(),
        ok: true,
        runId: result.runId,
        errorMessage: null,
        errorDetail: null,
      }
      log.info(
        { component: 'morning-bundle', runId: result.runId, bytes: result.bytes, csvCount: result.csvCount },
        'morning bundle complete',
      )
    })
    .catch((err: unknown) => {
      if (err instanceof MorningBundleRunError) {
        lastResult = {
          finishedAt: new Date(),
          ok: false,
          runId: null,
          errorMessage: `[${err.stage}] ${err.message}`,
          errorDetail: err.detail ?? null,
        }
        log.error(
          { component: 'morning-bundle', stage: err.stage, detail: err.detail },
          err.message,
        )
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        lastResult = {
          finishedAt: new Date(),
          ok: false,
          runId: null,
          errorMessage: msg,
          errorDetail: null,
        }
        log.error({ component: 'morning-bundle', err }, 'morning bundle failed')
      }
    })
    .finally(() => {
      if (inflight && inflight.promise === promise) {
        inflight = null
      }
    })

  inflight = { startedAt, promise }

  return {
    status: 'triggered',
    startedAt: startedAt.toISOString(),
    message: 'Morning pipeline started. The new bundle ZIP will appear in the list below when it finishes — typically 1–2 minutes.',
  }
}
