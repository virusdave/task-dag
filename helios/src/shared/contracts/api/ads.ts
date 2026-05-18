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

export const AdsIngestResponseSchema = z.object({
  publicUrl: z.string().url(),
  sourceFileId: z.string(),
  snapshotPath: z.string(),
  outputPath: z.string(),
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

export const ADS_DRIVE_FOLDER_URL =
  `https://drive.google.com/drive/folders/${ADS_DRIVE_FOLDER_ID}`
