import { z } from 'zod'

export const StaffInclusionStatusSchema = z.enum(['unapproved', 'approved', 'rejected'])
export type StaffInclusionStatus = z.infer<typeof StaffInclusionStatusSchema>

export const STAFF_INCLUSION_STATUSES: readonly StaffInclusionStatus[] = [
  'unapproved',
  'approved',
  'rejected',
]

export const StaffDealerAssignmentSchema = z.object({
  dealerId: z.number().int(),
  dealerName: z.string(),
})
export type StaffDealerAssignment = z.infer<typeof StaffDealerAssignmentSchema>

export const StaffRowSchema = z.object({
  staffId: z.string().min(1),
  fullName: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  photoUrl: z.string().nullable(),
  currentDealerId: z.number().int().nullable(),
  currentDealerName: z.string().nullable(),
  dealers: z.array(StaffDealerAssignmentSchema),
  blocked: z.boolean(),
  userStatus: z.number().int().nullable(),
  fetchedAt: z.string(),
  inclusionStatus: StaffInclusionStatusSchema,
  inclusionDecidedAt: z.string().nullable(),
  inclusionDecidedBy: z.string().nullable(),
})
export type StaffRow = z.infer<typeof StaffRowSchema>

export const StaffListResponseSchema = z.object({
  items: z.array(StaffRowSchema),
  fetchedAt: z.string().nullable(),
  totalCount: z.number().int(),
  withPhotoCount: z.number().int(),
  approvedCount: z.number().int(),
})
export type StaffListResponse = z.infer<typeof StaffListResponseSchema>

export const StaffRefreshResponseSchema = StaffListResponseSchema.extend({
  refreshed: z.literal(true),
  upstreamCount: z.number().int(),
})
export type StaffRefreshResponse = z.infer<typeof StaffRefreshResponseSchema>

export const StaffStatusUpdateSchema = z.object({
  status: StaffInclusionStatusSchema,
  notes: z.string().trim().max(2000).optional(),
})
export type StaffStatusUpdate = z.infer<typeof StaffStatusUpdateSchema>

// Per-photo focal point cached by the helios worker (computed by the
// private LLM). Coordinates are normalized [0..1] from the top-left
// corner of the original photo. The public page applies it as
// `object-position: ${x*100}% ${y*100}%` so portraits stay framed on
// the subject's face under `object-fit: cover`.
export const PublicStaffPhotoFocalPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  model: z.string().min(1),
})
export type PublicStaffPhotoFocalPoint = z.infer<typeof PublicStaffPhotoFocalPointSchema>

// Public "Meet The Team" projection: approved staff only, with the
// only attributes the public page is allowed to display (first name
// + opaque proxy token + optional focal point). Consumed by the
// mostly-static-sites freshlybaked.nyc /about-us "Meet The Team"
// surface.
//
// `photoProxyToken` is an opaque HMAC-signed token that the public
// site exchanges for the photo bytes via its own proxy route
// (`/api/staff-photo/<token>`); the upstream Sweed URL is NEVER
// exposed to the browser, so visitors never see media-prime.sweedpos.com
// references and the upstream URL can rotate without breaking links.
//
// `focalPoint` is omitted while the worker has not yet computed one
// for this photo (first deploy after a new staff member's portrait
// appears). When omitted, the renderer falls back to the geometric
// center, which matches pre-focal-point behavior.
export const PublicTeamMemberSchema = z.object({
  staffId: z.string().min(1),
  firstName: z.string().min(1),
  photoProxyToken: z.string().min(1),
  focalPoint: PublicStaffPhotoFocalPointSchema.optional(),
})
export type PublicTeamMember = z.infer<typeof PublicTeamMemberSchema>

export const PublicTeamResponseSchema = z.object({
  members: z.array(PublicTeamMemberSchema),
  generatedAt: z.string(),
})
export type PublicTeamResponse = z.infer<typeof PublicTeamResponseSchema>
