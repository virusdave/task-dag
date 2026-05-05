import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Pool } from 'pg'

import { readRequiredDatabaseUrl } from '../src/shared/config/runtimeEnv.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDirectory = resolve(__dirname, '../migrations')
const databaseUrl = readRequiredDatabaseUrl()

const statusOnly = process.argv.includes('--status')
const pool = new Pool({ connectionString: databaseUrl })

try {
  await ensureSchemaMigrationsTable()
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort()

  const applied = await loadAppliedMigrations()

  for (const fileName of migrationFiles) {
    const contents = await readFile(resolve(migrationsDirectory, fileName), 'utf8')
    const checksum = sha256(contents)
    const appliedMigration = applied.get(fileName)

    if (appliedMigration) {
      if (appliedMigration.checksum !== checksum) {
        throw new Error(`Migration checksum mismatch for ${fileName}.`)
      }
      if (statusOnly) {
        console.log(`applied ${fileName}`)
      }
      continue
    }

    if (statusOnly) {
      console.log(`pending ${fileName}`)
      continue
    }

    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(contents)
      await client.query(
        `
          insert into schema_migrations (file_name, checksum)
          values ($1, $2)
        `,
        [fileName, checksum],
      )
      await client.query('commit')
      console.log(`applied ${fileName}`)
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
} finally {
  await pool.end()
}

async function ensureSchemaMigrationsTable(): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      file_name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `)
}

async function loadAppliedMigrations(): Promise<Map<string, { checksum: string }>> {
  const result = await pool.query<{ checksum: string; file_name: string }>('select file_name, checksum from schema_migrations order by file_name asc')
  return new Map(result.rows.map((row) => [row.file_name, { checksum: row.checksum }]))
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}
