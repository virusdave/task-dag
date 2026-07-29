import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getMigrationSentinel } from './pendingMigrations.js'

describe('migration 107 read-only role PostgreSQL integration', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helios-readonly-role-'))
  const dataDir = resolve(root, 'data')
  const socketDir = resolve(root, 'socket')
  let postgres: ChildProcess
  let postgresPool: Pool
  let rootTsdbPool: Pool
  let adminPool: Pool
  let readonlyPool: Pool
  let postgresBinDir: string

  beforeAll(async () => {
    execFileSync('mkdir', ['-p', socketDir])
    const initdb = realpathSync(execFileSync('which', ['initdb'], { encoding: 'utf8' }).trim())
    postgresBinDir = dirname(initdb)
    execFileSync(initdb, ['-A', 'trust', '-U', 'postgres', '-D', dataDir], { stdio: 'ignore' })
    postgres = spawn(
      resolve(postgresBinDir, 'postgres'),
      ['-D', dataDir, '-k', socketDir, '-h', '', '-F'],
      { stdio: 'ignore' },
    )
    postgresPool = new Pool({ host: socketDir, user: 'postgres', database: 'postgres', max: 1 })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await postgresPool.query('select 1')
        break
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      }
    }
    await postgresPool.query('create role tsdbadmin login createrole')
    await postgresPool.query('create database tsdb owner tsdbadmin')
    rootTsdbPool = new Pool({ host: socketDir, user: 'postgres', database: 'tsdb', max: 1 })
    adminPool = new Pool({ host: socketDir, user: 'tsdbadmin', database: 'tsdb', max: 1 })
    await adminPool.query(`
      create table existing_helios_row (id integer primary key, value text);
      insert into existing_helios_row values (1, 'ok');
      create sequence ungranted_sequence;
    `)
    runMigration('107_helios_agent_readonly_role.sql')
    await adminPool.query('alter role helios_agent_readonly login')
    runMigration('107_helios_agent_readonly_role.sql')
    await adminPool.query(`
      create table future_helios_row (id integer primary key);
      insert into future_helios_row values (1);
    `)
    readonlyPool = new Pool({
      host: socketDir,
      user: 'helios_agent_readonly',
      database: 'tsdb',
      options: '-c default_transaction_read_only=off',
      max: 1,
    })
  }, 15_000)

  afterAll(async () => {
    await readonlyPool?.end()
    runMigration('107_helios_agent_readonly_role.down.sql')
    await adminPool?.end()
    await rootTsdbPool?.end()
    await postgresPool?.end()
    if (postgres) {
      postgres.kill('SIGTERM')
      if (postgres.exitCode === null) {
        await new Promise<void>((resolveWait) => postgres.once('exit', () => resolveWait()))
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('reads current and future tables while persistent mutations stay denied', async () => {
    expect((await readonlyPool.query('select value from existing_helios_row')).rows).toEqual([
      { value: 'ok' },
    ])
    expect((await readonlyPool.query('select count(*)::int as count from future_helios_row')).rows).toEqual([
      { count: 1 },
    ])
    await expect(
      readonlyPool.query("insert into existing_helios_row values (2, 'blocked')"),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      readonlyPool.query('create table blocked_persistent_ddl (id integer)'),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(readonlyPool.query('reindex table existing_helios_row')).rejects.toMatchObject({
      code: '42501',
    })
    expect(await sentinelApplied()).toBe(true)
  })

  it('detects a persistent write grant outside the Helios-owned relations', async () => {
    await rootTsdbPool.query(`
      create schema external_data;
      create table external_data.rows (id integer);
      grant usage on schema external_data to helios_agent_readonly;
      grant update on external_data.rows to helios_agent_readonly;
    `)
    expect(await sentinelApplied()).toBe(false)
    await rootTsdbPool.query('drop schema external_data cascade')
    expect(await sentinelApplied()).toBe(true)
  })

  it('detects CREATE on any persistent schema', async () => {
    await rootTsdbPool.query(`
      create schema external_create;
      grant create on schema external_create to helios_agent_readonly;
    `)
    expect(await sentinelApplied()).toBe(false)
    await rootTsdbPool.query('drop schema external_create cascade')
    expect(await sentinelApplied()).toBe(true)
  })

  it('detects persistent table-maintenance privileges', async () => {
    await rootTsdbPool.query('grant maintain on existing_helios_row to helios_agent_readonly')
    expect(await sentinelApplied()).toBe(false)
    await rootTsdbPool.query('revoke maintain on existing_helios_row from helios_agent_readonly')
    expect(await sentinelApplied()).toBe(true)
  })

  it('does not allowlist a same-signature non-extension SECURITY DEFINER', async () => {
    await rootTsdbPool.query(`
      create function public.hypertable_detailed_size(regclass)
      returns bigint language sql security definer as 'select 1::bigint';
    `)
    expect(await sentinelApplied()).toBe(false)
    await rootTsdbPool.query('drop function public.hypertable_detailed_size(regclass)')
    expect(await sentinelApplied()).toBe(true)
  })

  it('detects role memberships', async () => {
    await postgresPool.query('create role dangerous_writer')
    await postgresPool.query('grant dangerous_writer to helios_agent_readonly')
    expect(await sentinelApplied()).toBe(false)
    await postgresPool.query('revoke dangerous_writer from helios_agent_readonly')
    await postgresPool.query('drop role dangerous_writer')
    expect(await sentinelApplied()).toBe(true)
  })

  async function sentinelApplied(): Promise<boolean> {
    const sentinel = getMigrationSentinel('107_helios_agent_readonly_role')
    expect(sentinel).not.toBeNull()
    return sentinel!.check(adminPool)
  }

  function runMigration(fileName: string): void {
    execFileSync(
      resolve(postgresBinDir, 'psql'),
      [
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        socketDir,
        '-U',
        'tsdbadmin',
        '-d',
        'tsdb',
        '-f',
        resolve('src/server/db/migrations', fileName),
      ],
      { stdio: 'ignore' },
    )
  }
})
