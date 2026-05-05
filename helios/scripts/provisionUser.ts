import { z } from 'zod'

import { RoleSchema } from '../src/shared/contracts/domain/auth.js'
import { closePool, getPool } from '../src/server/db/pool.js'
import { provisionUser } from '../src/server/db/queries/authQueries.js'

const ProvisionUserArgsSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: RoleSchema,
})

try {
  const args = parseArgs(process.argv.slice(2))
  const input = ProvisionUserArgsSchema.parse(args)
  const user = await provisionUser(getPool(), input)
  console.log(`Provisioned ${user.email} as ${user.role} (#${user.id}).`)
} finally {
  await closePool()
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      continue
    }

    const key = token.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}.`)
    }
    parsed[key] = value
    index += 1
  }

  return parsed
}
