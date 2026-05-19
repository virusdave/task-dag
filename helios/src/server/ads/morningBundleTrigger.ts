/**
 * Server-side trigger for the gads-run-analysis.service systemd unit
 * (the daily morning bundle pipeline; also reachable on demand from
 * the Ads ingest page via the "Run morning pipeline now" button).
 *
 * Architecture mirrors clusterSweepTrigger.ts exactly: helios shells
 * out to a tiny nix-built wrapper (`gads-run-morning-trigger`) which
 * is sudo-whitelisted for the helios system user. The wrapper does
 * `systemctl --no-block start gads-run-analysis.service` and exits
 * with distinct codes (0/64/65/77/other) so we can map back to a
 * typed status without scraping systemctl stderr. Helios never
 * invokes systemctl directly and there is no Python anywhere in this
 * path -- the pipeline itself is a writeShellApplication baked into
 * the system closure (see nixos-sbc/modules/google-ads-automation.nix).
 */

import { spawn } from 'node:child_process'

import type { MorningBundleRunTriggerResponse } from '../../shared/contracts/index.js'

const TRIGGER_WRAPPER = '/run/current-system/sw/bin/gads-run-morning-trigger'

// NixOS keeps the setuid `sudo` under /run/wrappers/bin/, which is
// NOT on the helios systemd unit's PATH (it only has the explicit
// nix-store entries baked into environment.systemd.PATH). Spawn the
// absolute path so we don't fail with `spawn sudo ENOENT` before the
// wrapper even gets a chance to run.
const SUDO_BIN = '/run/wrappers/bin/sudo'

export async function triggerMorningBundle(): Promise<MorningBundleRunTriggerResponse> {
  const start = await runWrapper()
  if (start.exitCode === 0) {
    return {
      status: 'triggered',
      startedAt: new Date().toISOString(),
      message:
        'Morning pipeline started. The new bundle ZIP will appear in the list below when it finishes — typically 1-2 minutes.',
    }
  }

  switch (start.exitCode) {
    case 64:
      return {
        status: 'service-not-deployed',
        message:
          'The gads-run-analysis service is not deployed on this host yet. Re-run self-deploy on vps-nixos-3 to pick up the unit.',
      }
    case 65:
      return {
        status: 'already-running',
        message:
          'A morning pipeline run is already in flight. The new bundle will appear in the list below once it completes.',
      }
    case 77:
      return {
        status: 'permission-denied',
        message:
          'Helios was blocked from starting the morning pipeline. The sudo whitelist for the gads-run-morning-trigger wrapper is missing or out of date.',
      }
    default:
      return {
        status: 'trigger-failed',
        message: 'Could not start the morning pipeline. Try again in a minute; if it keeps failing, alert on-call.',
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
    const child = spawn(SUDO_BIN, ['-n', TRIGGER_WRAPPER], { stdio: ['ignore', 'pipe', 'pipe'] })
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
