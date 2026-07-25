import { z } from 'zod'

const CAPTURE_TARGETS = [
  'tasks-overview',
  'tasks-queue',
  'task-detail',
  'task-plan',
] as const

const ALLOWED_GITHUB_REPOSITORIES = new Set([
  'FreshlyBakedNYC/automation',
  'FreshlyBakedNYC/helios-parser-configs',
  'Nicponskis/github-worker',
  'Nicponskis/mostly-static-sites',
  'Nicponskis/nixos-sbc',
  'Nicponskis/shared-workflows',
  'virusdave/agent-pain-points',
  'virusdave/task-dag',
  'virusdave/top-level',
])

// Decimal 100 MB leaves enough room for the review page and metadata inside
// mss-one-offs' 100 MiB per-slot persisted-byte allowance.
export const OPERATOR_CAPTURE_MAX_BYTES = 100_000_000
export const OPERATOR_CAPTURE_MAX_DIMENSION = 100_000
export const OPERATOR_CAPTURE_MAX_PIXELS = 100_000_000

export const OperatorCaptureTargetSchema = z.enum(CAPTURE_TARGETS)
export type OperatorCaptureTarget = z.infer<typeof OperatorCaptureTargetSchema>

export const OperatorCaptureKeySchema = z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/)

export const OperatorCaptureMetadataSchema = z.object({
  capturedAt: z.iso.datetime(),
  devicePixelRatio: z.number().positive().max(4),
  height: z.number().int().positive().max(OPERATOR_CAPTURE_MAX_DIMENSION),
  pageUrl: z.url().max(2_048),
  renderer: z.string().min(1).max(80),
  viewportHeight: z.number().int().positive().max(12_000),
  viewportWidth: z.number().int().positive().max(12_000),
  width: z.number().int().positive().max(OPERATOR_CAPTURE_MAX_DIMENSION),
})
export type OperatorCaptureMetadata = z.infer<typeof OperatorCaptureMetadataSchema>

export const OperatorCaptureUploadFieldsSchema = z.object({
  captureKey: OperatorCaptureKeySchema,
  captureName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  metadata: OperatorCaptureMetadataSchema,
  redirectUrl: z.string().transform((value, context) => {
    const parsed = parseOperatorCaptureRedirect(value)
    if (parsed === null) {
      context.addIssue({ code: 'custom', message: 'Redirect must be an allowlisted GitHub issue or comment URL.' })
      return z.NEVER
    }
    return parsed
  }),
})
export type OperatorCaptureUploadFields = z.infer<typeof OperatorCaptureUploadFieldsSchema>

export const OperatorCaptureResponseSchema = z.object({
  captureId: OperatorCaptureKeySchema,
  directUrl: z.url(),
  expiresAt: z.iso.datetime(),
  redirectUrl: z.url(),
  reviewUrl: z.url(),
})
export type OperatorCaptureResponse = z.infer<typeof OperatorCaptureResponseSchema>

/** Accept only durable GitHub issue/reply destinations controlled by this fleet. */
export function parseOperatorCaptureRedirect(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== ''
  ) {
    return null
  }
  const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/u.exec(parsed.pathname)
  if (match === null || !ALLOWED_GITHUB_REPOSITORIES.has(`${match[1]}/${match[2]}`)) {
    return null
  }
  if (!/^#issuecomment-[1-9][0-9]*$/u.test(parsed.hash)) {
    return null
  }
  parsed.pathname = `/${match[1]}/${match[2]}/issues/${match[3]}`
  return parsed.toString()
}
