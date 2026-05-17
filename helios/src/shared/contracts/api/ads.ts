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
export const ADS_DRIVE_FOLDER_URL =
  `https://drive.google.com/drive/folders/${ADS_DRIVE_FOLDER_ID}`
