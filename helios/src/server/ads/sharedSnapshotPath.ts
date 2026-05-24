import * as path from 'node:path'

import { automationRepoPath } from './automationRepoRoot.js'

/**
 * Resolves the canonical absolute path of the live Google Ads
 * snapshot, taking the GADS_SNAPSHOT_PATH env var if set.
 *
 * Why this exists: historically helios wrote the snapshot to its own
 * `${AUTOMATION_REPO_PATH}/ads/google/snapshots/ads-snapshot-live.jsonl`
 * (which on prod is `/var/lib/helios/automation/ads/google/...`), but
 * the `gads-run-morning` systemd unit reads from a completely
 * different tree (`/var/lib/gads/automation/ads/google/snapshots/...`,
 * which is a symlink to `/var/lib/gads/data/snapshots/...`). The two
 * trees never communicated, so every helios "ingest now" was
 * invisible to the morning bundle pipeline and the operator's L2
 * recommendations were always built on a stale snapshot.
 *
 * The nixos-sbc deployment sets GADS_SNAPSHOT_PATH on the helios
 * server + worker units to the same shared location gads-run-morning
 * reads from, with the helios service user added to the `agents`
 * group so it actually has permission to write there. When the env
 * var isn't set (local dev, ad-hoc scripts) we fall back to the
 * legacy in-repo path so behaviour stays predictable.
 *
 * Both writers (runAdsIngest) and readers (runMorningBundle,
 * adAttemptsTracker) MUST go through this helper so the path stays
 * unified.
 */
export function sharedSnapshotPath(): string {
  const fromEnv = process.env.GADS_SNAPSHOT_PATH?.trim()
  if (fromEnv) {
    return path.resolve(fromEnv)
  }
  return automationRepoPath('ads/google/snapshots/ads-snapshot-live.jsonl')
}

/**
 * Directory containing the live snapshot file, derived from
 * sharedSnapshotPath(). Use this when you need to list / scan
 * snapshots (e.g. pickFreshestSnapshot's fallback over older
 * dated snapshots).
 */
export function sharedSnapshotDir(): string {
  return path.dirname(sharedSnapshotPath())
}
