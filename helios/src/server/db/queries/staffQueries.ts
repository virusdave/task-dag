import { z } from 'zod'

import {
  StaffInclusionStatusSchema,
  type StaffDealerAssignment,
  type StaffInclusionStatus,
  type StaffRow,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

const StaffDirectoryRowSchema = z.object({
  staff_id: z.string(),
  raw: z.unknown(),
  full_name: z.string(),
  first_name: z.string(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  photo_url: z.string().nullable(),
  current_dealer_id: z.coerce.number().int().nullable(),
  current_dealer_name: z.string().nullable(),
  blocked: z.boolean(),
  user_status: z.coerce.number().int().nullable(),
  fetched_at: z.coerce.date(),
  inclusion_status: StaffInclusionStatusSchema,
  inclusion_decided_at: z.coerce.date().nullable(),
  inclusion_decided_by: z.string().nullable(),
})

const SELECT_JOINED = `
  select
    sd.staff_id,
    sd.raw,
    sd.full_name,
    sd.first_name,
    sd.last_name,
    sd.email,
    sd.photo_url,
    sd.current_dealer_id,
    sd.current_dealer_name,
    sd.blocked,
    sd.user_status,
    sd.fetched_at,
    coalesce(si.status, 'unapproved')::text as inclusion_status,
    si.decided_at as inclusion_decided_at,
    si.decided_by as inclusion_decided_by
  from staff_directory_cache sd
  left join staff_inclusion si on si.staff_id = sd.staff_id
`

function extractDealers(raw: unknown): StaffDealerAssignment[] {
  if (!raw || typeof raw !== 'object') return []
  const dealers = (raw as { dealers?: unknown }).dealers
  if (!Array.isArray(dealers)) return []
  const out: StaffDealerAssignment[] = []
  for (const d of dealers) {
    if (!d || typeof d !== 'object') continue
    const dealerId = Number((d as { dealerId?: unknown }).dealerId)
    const dealerName = String((d as { dealerName?: unknown }).dealerName ?? '').trim()
    if (!Number.isInteger(dealerId) || dealerName.length === 0) continue
    out.push({ dealerId, dealerName })
  }
  return out
}

function toStaffRow(row: z.infer<typeof StaffDirectoryRowSchema>): StaffRow {
  return {
    staffId: row.staff_id,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    photoUrl: row.photo_url,
    currentDealerId: row.current_dealer_id,
    currentDealerName: row.current_dealer_name,
    dealers: extractDealers(row.raw),
    blocked: row.blocked,
    userStatus: row.user_status,
    fetchedAt: row.fetched_at.toISOString(),
    inclusionStatus: row.inclusion_status,
    inclusionDecidedAt: row.inclusion_decided_at ? row.inclusion_decided_at.toISOString() : null,
    inclusionDecidedBy: row.inclusion_decided_by,
  }
}

export async function listStaffRowsWithInclusion(db: Queryable): Promise<StaffRow[]> {
  const res = await db.query(`${SELECT_JOINED} order by sd.first_name asc, sd.last_name asc, sd.staff_id asc`)
  return res.rows.map((row) => toStaffRow(StaffDirectoryRowSchema.parse(row)))
}

export async function getStaffDirectoryFetchedAt(db: Queryable): Promise<string | null> {
  const res = await db.query<{ max: Date | null }>(`select max(fetched_at) as max from staff_directory_cache`)
  const max = res.rows[0]?.max
  return max ? new Date(max).toISOString() : null
}

export async function updateStaffInclusionStatus(
  db: Queryable,
  args: { staffId: string; status: StaffInclusionStatus; decidedBy: string; notes?: string },
): Promise<StaffRow | null> {
  // The staff_id must already exist in staff_directory_cache for the
  // decision to make sense. Reject otherwise so the UI doesn't create
  // dangling inclusion rows for staff Sweed no longer knows about.
  const existing = await db.query<{ exists: boolean }>(
    `select exists(select 1 from staff_directory_cache where staff_id = $1) as exists`,
    [args.staffId],
  )
  if (existing.rows[0]?.exists !== true) {
    return null
  }

  await db.query(
    `insert into staff_inclusion (staff_id, status, decided_at, decided_by, notes)
     values ($1, $2, now(), $3, $4)
     on conflict (staff_id) do update set
       status = excluded.status,
       decided_at = excluded.decided_at,
       decided_by = excluded.decided_by,
       notes = excluded.notes`,
    [args.staffId, args.status, args.decidedBy, args.notes ?? null],
  )

  const res = await db.query(`${SELECT_JOINED} where sd.staff_id = $1`, [args.staffId])
  if (res.rows.length === 0) return null
  return toStaffRow(StaffDirectoryRowSchema.parse(res.rows[0]))
}

export interface UpstreamStaffDirectoryRow {
  staffId: string
  fullName: string
  firstName: string
  lastName: string | null
  email: string | null
  photoUrl: string | null
  currentDealerId: number | null
  currentDealerName: string | null
  blocked: boolean
  userStatus: number | null
  raw: unknown
}

export interface UpsertStaffDirectoryResult {
  totalUpserted: number
  newlySeededInclusions: number
}

export async function upsertStaffDirectoryCache(
  db: Queryable,
  rows: readonly UpstreamStaffDirectoryRow[],
): Promise<UpsertStaffDirectoryResult> {
  let newlySeededInclusions = 0

  for (const row of rows) {
    await db.query(
      `insert into staff_directory_cache (
         staff_id, raw, full_name, first_name, last_name, email,
         photo_url, current_dealer_id, current_dealer_name,
         blocked, user_status, fetched_at
       ) values ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       on conflict (staff_id) do update set
         raw = excluded.raw,
         full_name = excluded.full_name,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         email = excluded.email,
         photo_url = excluded.photo_url,
         current_dealer_id = excluded.current_dealer_id,
         current_dealer_name = excluded.current_dealer_name,
         blocked = excluded.blocked,
         user_status = excluded.user_status,
         fetched_at = excluded.fetched_at`,
      [
        row.staffId,
        JSON.stringify(row.raw),
        row.fullName,
        row.firstName,
        row.lastName,
        row.email,
        row.photoUrl,
        row.currentDealerId,
        row.currentDealerName,
        row.blocked,
        row.userStatus,
      ],
    )

    // Seed inclusion ONLY if absent. Existing decisions are preserved.
    const defaultStatus: StaffInclusionStatus =
      row.photoUrl && row.photoUrl.trim().length > 0 ? 'unapproved' : 'rejected'
    const seedRes = await db.query<{ inserted: boolean }>(
      `insert into staff_inclusion (staff_id, status, decided_at, decided_by, notes)
       values ($1, $2, now(), $3, $4)
       on conflict (staff_id) do nothing
       returning true as inserted`,
      [row.staffId, defaultStatus, 'system:refresh-seed', null],
    )
    if (seedRes.rows.length > 0) newlySeededInclusions += 1
  }

  return { totalUpserted: rows.length, newlySeededInclusions }
}

export async function listApprovedTeamMembers(db: Queryable): Promise<
  Array<{ staffId: string; firstName: string; photoUrl: string }>
> {
  const res = await db.query<{
    staff_id: string
    first_name: string
    photo_url: string
  }>(
    `select sd.staff_id, sd.first_name, sd.photo_url
       from staff_directory_cache sd
       join staff_inclusion si on si.staff_id = sd.staff_id
      where si.status = 'approved'
        and sd.photo_url is not null
        and length(trim(sd.photo_url)) > 0
        and sd.blocked = false
      order by sd.first_name asc, sd.staff_id asc`,
  )
  return res.rows.map((row) => ({
    staffId: row.staff_id,
    firstName: row.first_name,
    photoUrl: row.photo_url,
  }))
}
