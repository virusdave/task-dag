import * as path from 'node:path'

/**
 * Resolves the explicitly configured live Google Ads snapshot path.
 *
 * Why this exists: historically helios wrote the snapshot to its own
 * a private Helios checkout, but
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
 * group so it actually has permission to write there. Missing configuration
 * is an error: silently switching snapshots would produce misleading output.
 *
 * Both writers (runAdsIngest) and readers (runMorningBundle,
 * adAttemptsTracker) MUST go through this helper so the path stays
 * unified.
 */
export function sharedSnapshotPath(): string {
  const fromEnv = process.env.GADS_SNAPSHOT_PATH?.trim()
  if (!fromEnv) throw new Error('GADS_SNAPSHOT_PATH is required')
  return path.resolve(fromEnv)
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
