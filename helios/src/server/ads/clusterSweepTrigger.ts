/**
 * Server-side trigger for the gads-cluster-sweep.service systemd unit.
 *
 * The cluster-proposals page exposes a single "Run cluster sweep now"
 * button. When clicked it POSTs /api/ads/cluster-proposals/sweep/run,
 * which calls into here. We shell out to the
 * `gads-cluster-sweep-trigger` wrapper (a tiny nixpkgs-built shell
 * script declared in nixos-sbc/modules/google-ads-automation.nix
 * that does exactly `systemctl --no-block start
 * gads-cluster-sweep.service`). That wrapper is sudo-whitelisted for
 * the `helios` system user; helios never invokes `systemctl` directly,
 * so we don't need a permissive sudo rule for the systemctl binary
 * itself.
 *
 * We translate exit code + stderr into one of a small set of
 * operator-facing statuses so the page can render a single line of
 * plain English regardless of what failed underneath. The operator
 * never sees the literal `systemctl`/`sudo` commands.
 */

import { spawn } from 'node:child_process'

import type { ClusterSweepRunTriggerResponse } from '../../shared/contracts/index.js'

/**
 * Path to the nix-built wrapper from
 * nixos-sbc/modules/google-ads-automation.nix. The wrapper is
 * declared in `environment.systemPackages` so it is reliably
 * available at `/run/current-system/sw/bin/<name>` on every
 * activation of the system closure that includes it. We pin the
 * fully-qualified path rather than relying on $PATH so the helios
 * service unit (which has a minimal default PATH) can find it.
 */
const TRIGGER_WRAPPER = '/run/current-system/sw/bin/gads-cluster-sweep-trigger'

export async function triggerClusterSweep(): Promise<ClusterSweepRunTriggerResponse> {
  const start = await runWrapper()
  if (start.exitCode === 0) {
    return {
      status: 'triggered',
      startedAt: new Date().toISOString(),
      message: 'Cluster sweep started. The new run will appear at the top of this page when it finishes — typically within a few minutes.',
    }
  }

  // The wrapper exits with distinct codes so we can translate them
  // back to typed statuses without scraping localised systemctl
  // stderr. See the writeShellApplication body in
  // nixos-sbc/modules/google-ads-automation.nix.
  switch (start.exitCode) {
    case 64:
      // Reserved by the wrapper for "service unit not present in the
      // running system" (e.g. someone disabled it, or the system
      // closure is older than this helios deploy).
      return {
        status: 'service-not-deployed',
        message:
          'The cluster-sweep service is not deployed on this host yet. Re-run self-deploy on vps-nixos-3 to pick up the unit.',
      }
    case 65:
      // Reserved by the wrapper for "another sweep is already in
      // flight"; isolated from generic failure so the UI can render
      // a friendlier message.
      return {
        status: 'already-running',
        message: 'A cluster sweep is already running. The new run will appear at the top of this page once it completes.',
      }
    case 77:
      // EX_NOPERM — wrapper detected it does not have permission to
      // run systemctl. Should not happen on a properly-deployed
      // vps-nixos-3 but covered defensively.
      return {
        status: 'permission-denied',
        message:
          'Helios was blocked from starting the cluster-sweep service. The sudo whitelist for the gads-cluster-sweep-trigger wrapper is missing or out of date.',
      }
    default:
      return {
        status: 'trigger-failed',
        message: 'Could not start the cluster-sweep service. Try again in a minute; if it keeps failing, alert on-call.',
        detail: `${start.stdout}\n${start.stderr}`.trim() || null,
      }
  }
}

interface SpawnResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

function runWrapper(): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // `sudo -n` — non-interactive. With the NOPASSWD rule provisioned
    // by the nix module, sudo immediately runs the wrapper as root.
    // Without it sudo exits non-zero with "a password is required"
    // and the wrapper's distinct exit codes are unreachable; we fall
    // through to the `trigger-failed` default branch, which surfaces
    // the sudo diagnostic in the collapsed <details> on the page.
    const child = spawn('sudo', ['-n', TRIGGER_WRAPPER], { stdio: ['ignore', 'pipe', 'pipe'] })
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
