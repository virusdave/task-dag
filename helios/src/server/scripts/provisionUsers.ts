import { z } from 'zod'

import { RoleSchema } from '../../shared/contracts/domain/auth.js'
import { provisionUser } from '../db/queries/authQueries.js'
import { closePool, getPool } from '../db/pool.js'

// Standalone bootstrap script invoked from the helios-provision-users
// systemd one-shot service. Reads HELIOS_PROVISION_USERS_JSON (a JSON
// array of user records) and idempotently upserts each into the users
// table via `provisionUser`. Existing rows keep their google_sub —
// `provisionUser` updates name/role/active but leaves google_sub alone,
// so re-running this on every deploy is safe and never re-claims a
// previously-bound Google identity.

const ProvisionUserSchema = z.object({
  active: z.boolean().optional(),
  email: z.string().trim().email(),
  name: z.string().trim().min(1),
  role: RoleSchema,
})
const ProvisionUserListSchema = z.array(ProvisionUserSchema)

async function main(): Promise<void> {
  const raw = process.env.HELIOS_PROVISION_USERS_JSON
  if (!raw || raw.trim().length === 0) {
    console.log('[provision-users] HELIOS_PROVISION_USERS_JSON is empty; nothing to do.')
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `HELIOS_PROVISION_USERS_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const users = ProvisionUserListSchema.parse(parsed)
  if (users.length === 0) {
    console.log('[provision-users] User list is empty; nothing to do.')
    return
  }

  const pool = getPool()
  for (const user of users) {
    const result = await provisionUser(pool, user)
    console.log(
      `[provision-users] ensured user id=${result.id} email=${result.email} role=${result.role} active=${result.active}`,
    )
  }
}

main()
  .catch((error) => {
    console.error('[provision-users] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool().catch((error) => {
      console.error('[provision-users] failed to close pool:', error)
    })
  })
