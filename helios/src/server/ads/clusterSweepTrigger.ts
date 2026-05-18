/**
 * Server-side trigger for the gads-cluster-sweep.service systemd unit.
 *
 * The cluster-proposals page exposes a single "Run cluster sweep now"
 * button. When clicked it POSTs /api/ads/cluster-proposals/sweep/run,
 * which calls into here. We invoke `systemctl --no-block start` on the
 * shipped unit name and translate systemctl's exit code + stderr into
 * one of a small set of operator-facing statuses, so the page can
 * render a single line of plain English regardless of what failed
 * underneath. Operator-facing copy NEVER includes the literal
 * `systemctl` command; that's the whole point.
 *
 * Until P4 of the gemini-clusters epic lands (which provisions the
 * unit + a polkit rule granting the helios service user permission to
 * start it), `triggerClusterSweep` will resolve to
 * `service-not-deployed` or `permission-denied` and the page will
 * show a clean disabled-state with a one-liner explaining what's
 * missing — still no infra leakage.
 */

import { spawn } from 'node:child_process'

import type { ClusterSweepRunTriggerResponse } from '../../shared/contracts/index.js'

const CLUSTER_SWEEP_UNIT = 'gads-cluster-sweep.service'

export async function triggerClusterSweep(): Promise<ClusterSweepRunTriggerResponse> {
  const status = await runSystemctl(['is-active', CLUSTER_SWEEP_UNIT])
  if (status.exitCode === 0 && status.stdout.trim() === 'active') {
    return {
      status: 'already-running',
      message: 'A cluster sweep is already running. The new run will appear at the top of this page once it completes.',
    }
  }

  const start = await runSystemctl(['--no-block', 'start', CLUSTER_SWEEP_UNIT])
  if (start.exitCode === 0) {
    return {
      status: 'triggered',
      startedAt: new Date().toISOString(),
      message: 'Cluster sweep started. The new run will appear at the top of this page when it finishes — typically within a few minutes.',
    }
  }

  // Translate systemctl's noisier failure modes to one of our typed
  // statuses. systemctl writes its diagnostic to stderr; we look for
  // the well-known strings rather than parsing the exit code (which
  // is overloaded across distros + unit states).
  const combined = `${start.stdout}\n${start.stderr}`.toLowerCase()

  if (
    combined.includes('not loaded') ||
    combined.includes('not found') ||
    combined.includes('no such file or directory') ||
    combined.includes('could not be found')
  ) {
    return {
      status: 'service-not-deployed',
      message:
        'The cluster-sweep service is not deployed on this host yet. It is part of an in-progress rollout; once it lands this button will start working automatically.',
    }
  }

  if (
    combined.includes('access denied') ||
    combined.includes('permission denied') ||
    combined.includes('interactive authentication required') ||
    combined.includes('not authorized')
  ) {
    return {
      status: 'permission-denied',
      message:
        'Helios does not currently have permission to start the cluster-sweep service. The host needs a polkit/sudo rule for the helios service user; this is part of the same rollout that ships the service itself.',
    }
  }

  return {
    status: 'trigger-failed',
    message: 'Could not start the cluster-sweep service. Try again in a minute; if it keeps failing, alert on-call.',
    detail: combined.trim() || null,
  }
}

interface SystemctlResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

function runSystemctl(args: string[]): Promise<SystemctlResult> {
  return new Promise((resolve) => {
    const child = spawn('systemctl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', (err) => {
      resolve({ exitCode: 127, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${(err as Error).message}` })
    })
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr })
    })
  })
}
