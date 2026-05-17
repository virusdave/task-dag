import { z } from 'zod'

/**
 * POST /api/ads/ingest
 *
 * Forwards a pasted Google Drive file URL/ID to the host-side
 * ingestion script. See ads/google/docs/HELIOS_EXPORT_SOURCE.md for
 * how operators get the file URL.
 */
export const AdsIngestRequestSchema = z.object({
  driveFileUrlOrId: z.string().trim().min(1),
})
export type AdsIngestRequest = z.infer<typeof AdsIngestRequestSchema>

export const AdsIngestResponseSchema = z.object({
  publicUrl: z.string().url(),
  sourceFileId: z.string(),
  snapshotPath: z.string(),
  outputPath: z.string(),
})
export type AdsIngestResponse = z.infer<typeof AdsIngestResponseSchema>

export const ADS_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/1zaGxH-nY1ARF9VyddDbs5oO7OUawaTbL'
