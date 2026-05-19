import { z } from 'zod'

/**
 * POST /api/ads/ingest
 *
 * Triggers the host-side ingestion pipeline. When `driveFileUrlOrId`
 * is omitted, the server auto-discovers the newest CSV in the
 * canonical Drive folder (needs a Drive API key on disk -- see
 * ads/google/docs/HELIOS_EXPORT_SOURCE.md).
 */
export const AdsIngestRequestSchema = z.object({
  driveFileUrlOrId: z.string().trim().min(1).optional(),
})
export type AdsIngestRequest = z.infer<typeof AdsIngestRequestSchema>

// publicUrl + outputPath are nullable: helios's ingest pipeline used
// to also render the experiments-viz HTML and upload it to
// mss-one-offs, returning a public URL. Rendering required spawning
// python, which is now forbidden inside helios; the dashboard is
// rebuilt out-of-band via gads-run-morning and there is no longer a
// per-ingest publicUrl. Kept on the schema (rather than removed
// entirely) so older clients that pre-cached the field don't have to
// branch on its presence — they just see `null`.
export const AdsIngestResponseSchema = z.object({
  publicUrl: z.string().url().nullable(),
  sourceFileId: z.string(),
  snapshotPath: z.string(),
  outputPath: z.string().nullable(),
})
export type AdsIngestResponse = z.infer<typeof AdsIngestResponseSchema>

/**
 * GET /api/ads/status
 *
 * Snapshot of the auto-ingest poller. Cheap to call -- the UI polls
 * this every ~10s for live status.
 */
export const AdsDriveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  modifiedTime: z.string(),
  webViewLink: z.string().nullable(),
  resourceKey: z.string().nullable(),
})
export type AdsDriveFile = z.infer<typeof AdsDriveFileSchema>

export const AdsStatusResponseSchema = z.object({
  // True when the Drive API key is on disk and the poller is alive.
  configured: z.boolean(),
  // Human-readable reason if configured=false ("api key not configured" etc.).
  reason: z.string().nullable(),
  // ISO timestamp of the most recent poll attempt (success or failure).
  lastCheckedAt: z.string().nullable(),
  // Newest CSV currently sitting in the Drive folder (null if list failed).
  latestDiscoveredFile: AdsDriveFileSchema.nullable(),
  // True while an ingestion is actively running.
  running: z.boolean(),
  // Last error message from the poller or a manual run, if any.
  lastError: z.string().nullable(),
  // Most recent successful ingest:
  lastSuccessAt: z.string().nullable(),
  lastIngestedFileId: z.string().nullable(),
  lastIngestedModifiedTime: z.string().nullable(),
  lastPublicUrl: z.string().nullable(),
})
export type AdsStatusResponse = z.infer<typeof AdsStatusResponseSchema>

export const ADS_DRIVE_FOLDER_ID = '1zaGxH-nY1ARF9VyddDbs5oO7OUawaTbL'

/**
 * GET /api/ads/cluster-proposals/runs
 *
 * Index of cluster-sweep runs the gads-cluster-sweep service has
 * written to disk under ads/google/outputs/cluster-sweep/. The
 * cluster-sweep proper is delivered by P1 of the gemini-clusters epic
 * (see docs/helios/gemini-clusters/EPIC_PLAN.md); this contract is the
 * read-only surface that lets the Ads → Cluster proposals page list
 * what's available and download the bundle ZIP for any given run.
 *
 * `manifestPresent` is false when the run dir exists but the
 * cluster-sweep hadn't written its manifest.json yet (a still-running
 * sweep, or a sweep that crashed mid-write). The UI uses that to
 * label such runs as "in progress" or "incomplete" rather than
 * silently hiding them.
 */
export const ClusterSweepRunSummarySchema = z.object({
  runId: z.string(),
  generatedAt: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  manifestPresent: z.boolean(),
})
export type ClusterSweepRunSummary = z.infer<typeof ClusterSweepRunSummarySchema>

export const ClusterSweepRunsResponseSchema = z.object({
  runs: z.array(ClusterSweepRunSummarySchema),
})
export type ClusterSweepRunsResponse = z.infer<typeof ClusterSweepRunsResponseSchema>

/**
 * POST /api/ads/cluster-proposals/sweep/run
 *
 * Operator-facing "Run cluster sweep now" trigger. Asks the host to
 * start `gads-cluster-sweep.service` (the unit shipped by P4 of the
 * gemini-clusters epic) without blocking; the actual sweep typically
 * takes minutes, so the response only reports whether the *trigger*
 * succeeded. The page polls the runs index after a successful
 * trigger to discover the resulting run.
 *
 * The body is empty; the route is auth-gated to the `editor` role.
 *
 * Failure modes the client must render gracefully:
 *   - service-not-deployed:  the systemd unit doesn't exist yet
 *                            (P4 hasn't landed on this host).
 *   - permission-denied:     the helios service user can't start the
 *                            unit (polkit/sudo rule not provisioned).
 *   - already-running:       a sweep is already in flight; no-op.
 *   - trigger-failed:        anything else (network split,
 *                            systemd broken, ...); detail in `message`.
 */
export const ClusterSweepRunTriggerResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('triggered'),
    startedAt: z.string(),
    message: z.string(),
  }),
  z.object({
    status: z.literal('already-running'),
    message: z.string(),
  }),
  z.object({
    status: z.literal('service-not-deployed'),
    message: z.string(),
  }),
  z.object({
    status: z.literal('permission-denied'),
    message: z.string(),
  }),
  z.object({
    status: z.literal('trigger-failed'),
    message: z.string(),
    detail: z.string().nullable(),
  }),
])
export type ClusterSweepRunTriggerResponse = z.infer<typeof ClusterSweepRunTriggerResponseSchema>

export const ADS_DRIVE_FOLDER_URL =
  `https://drive.google.com/drive/folders/${ADS_DRIVE_FOLDER_ID}`
