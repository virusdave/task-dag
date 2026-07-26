import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { lockPendingPurchasePacketRootRow } from './queries/pendingPurchaseRefinementQueries.js'

describe('pending-purchase revision/apply root lock integration', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helios-pending-purchase-lock-'))
  const dataDir = resolve(root, 'data')
  const socketDir = resolve(root, 'socket')
  let postgres: ChildProcess
  let pool: Pool

  beforeAll(async () => {
    execFileSync('mkdir', ['-p', socketDir])
    const initdb = realpathSync(execFileSync('which', ['initdb'], { encoding: 'utf8' }).trim())
    const binDir = dirname(initdb)
    execFileSync(initdb, ['-A', 'trust', '-U', 'postgres', '-D', dataDir], { stdio: 'ignore' })
    postgres = spawn(resolve(binDir, 'postgres'), ['-D', dataDir, '-k', socketDir, '-h', '', '-F'], { stdio: 'ignore' })
    pool = new Pool({ host: socketDir, user: 'postgres', database: 'postgres', max: 4 })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await pool.query('select 1')
        break
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      }
    }
    await pool.query(`
      create table pending_purchase_packet_roots (
        id bigint primary key,
        current_packet_id bigint not null
      );
      create table pending_purchase_packets (
        id bigint primary key,
        packet_root_id bigint not null references pending_purchase_packet_roots(id)
      );
      create table pending_purchase_apply_requests (
        id bigint primary key,
        packet_id bigint not null,
        status text not null
      );
      insert into pending_purchase_packet_roots (id, current_packet_id) values (77, 100);
      insert into pending_purchase_packets (id, packet_root_id) values (100, 77), (101, 77);
    `)
  }, 15_000)

  afterAll(async () => {
    await pool?.end()
    if (postgres) {
      postgres.kill('SIGTERM')
      if (postgres.exitCode === null) {
        await new Promise<void>((resolveWait) => postgres.once('exit', () => resolveWait()))
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('makes apply startup wait for a revision switch and then observe the new current packet', async () => {
    const switching = await beginClient()
    const startingApply = await beginClient()
    try {
      await lockPendingPurchasePacketRootRow(switching, 100)
      await switching.query('update pending_purchase_packet_roots set current_packet_id = 101 where id = 77')

      let acquired = false
      const waitingLock = lockPendingPurchasePacketRootRow(startingApply, 100).then(() => { acquired = true })
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      expect(acquired).toBe(false)

      await switching.query('commit')
      await waitingLock
      expect((await startingApply.query('select current_packet_id from pending_purchase_packet_roots where id = 77')).rows[0])
        .toEqual({ current_packet_id: '101' })
    } finally {
      await rollbackAndRelease(switching)
      await rollbackAndRelease(startingApply)
    }
  })

  it('makes revision switching wait for apply enqueue and then observe the active request', async () => {
    await pool.query("update pending_purchase_packet_roots set current_packet_id = 100 where id = 77; delete from pending_purchase_apply_requests")
    const enqueueing = await beginClient()
    const switching = await beginClient()
    try {
      await lockPendingPurchasePacketRootRow(enqueueing, 100)
      await enqueueing.query("insert into pending_purchase_apply_requests (id, packet_id, status) values (88, 100, 'queued')")

      let acquired = false
      const waitingLock = lockPendingPurchasePacketRootRow(switching, 100).then(() => { acquired = true })
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      expect(acquired).toBe(false)

      await enqueueing.query('commit')
      await waitingLock
      expect((await switching.query("select id from pending_purchase_apply_requests where packet_id = 100 and status in ('queued', 'running')")).rows)
        .toEqual([{ id: '88' }])
    } finally {
      await rollbackAndRelease(enqueueing)
      await rollbackAndRelease(switching)
    }
  })

  async function beginClient(): Promise<PoolClient> {
    const client = await pool.connect()
    await client.query('begin')
    return client
  }

  async function rollbackAndRelease(client: PoolClient): Promise<void> {
    await client.query('rollback').catch(() => undefined)
    client.release()
  }
})
