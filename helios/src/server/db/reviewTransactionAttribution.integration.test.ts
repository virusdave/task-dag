import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { queryBudtenderReviewCashiers } from '../budtenderAnalytics/budtenderAnalyticsQueries.js'
import { insertReviewSubmissionAt, type InsertReviewSubmissionInput } from './queries/customerReviewsQueries.js'

describe('review transaction attribution PostgreSQL integration', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helios-review-attribution-'))
  const dataDir = resolve(root, 'data')
  const socketDir = resolve(root, 'socket')
  let postgres: ChildProcess
  let pool: Pool
  let postgresBinDir: string

  beforeAll(async () => {
    execFileSync('mkdir', ['-p', socketDir])
    const initdb = realpathSync(execFileSync('which', ['initdb'], { encoding: 'utf8' }).trim())
    postgresBinDir = dirname(initdb)
    execFileSync(initdb, ['-A', 'trust', '-U', 'postgres', '-D', dataDir], { stdio: 'ignore' })
    postgres = spawn(resolve(postgresBinDir, 'postgres'), ['-D', dataDir, '-k', socketDir, '-h', '', '-F'], { stdio: 'ignore' })
    pool = new Pool({ host: socketDir, user: 'postgres', database: 'postgres', max: 1 })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await pool.query('select 1')
        return
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      }
    }
    throw new Error('ephemeral PostgreSQL did not start')
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

  it('executes migration, inference, analytics, replay, constraints, and down', async () => {
    const env = { ...process.env, PGHOST: socketDir, PGUSER: 'postgres', PGDATABASE: 'postgres' }
    const forward = resolve('src/server/db/migrations/105_review_transaction_attribution.sql')
    const down = resolve('src/server/db/migrations/105_review_transaction_attribution.down.sql')
    await pool.query(`
      create table site_review_settings (
        dealer_id integer primary key, site_label text not null,
        review_provider_kind text not null default 'google', review_provider_url_template text,
        review_email_dave text, review_email_support text, review_email_ops text,
        review_drawing_enabled boolean not null default false,
        review_free_preroll_enabled boolean not null default false,
        review_llm_gate_enabled boolean not null default false,
        sweed_drawing_segment_id integer, sweed_free_preroll_segment_id integer,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      insert into site_review_settings (dealer_id, site_label) values (210705, 'Midtown');
      create table review_submissions (
        id uuid primary key default gen_random_uuid(), dealer_id integer not null references site_review_settings,
        star_rating integer, review_text text, submission_kind text not null default 'form',
        source_ip text, user_agent text, referrer text, raw_payload jsonb not null,
        fraud_marked boolean not null default false, fraud_marked_at timestamptz,
        fraud_marked_by text, created_at timestamptz not null default now()
      );
    `)
    const legacyId = (await pool.query(`insert into review_submissions (dealer_id, raw_payload) values (210705, '{}') returning id`)).rows[0].id
    const psql = resolve(postgresBinDir, 'psql')
    execFileSync(psql, ['-v', 'ON_ERROR_STOP=1', '-f', forward], { env, stdio: 'ignore' })
    execFileSync(psql, ['-v', 'ON_ERROR_STOP=1', '-f', forward], { env, stdio: 'ignore' })
    execFileSync(psql, ['-v', 'ON_ERROR_STOP=1', '-f', resolve('src/server/db/schema/customerReviewsLlmGate.sql')], { env, stdio: 'ignore' })

    expect((await pool.query("select invoice_match_status, matched_invoice_id, matched_cashier_user_id, matched_at from review_submissions where id = $1", [legacyId])).rows[0]).toEqual({ invoice_match_status: 'not_attempted', matched_invoice_id: null, matched_cashier_user_id: null, matched_at: null })
    await pool.query(`
      create table staff_directory_cache (staff_id text primary key, full_name text);
      create table sweed_orders (
        dealer_id bigint not null, invoice_id text not null, pay_time timestamptz not null,
        cashier_user_id bigint, raw_json jsonb not null, primary key (dealer_id, invoice_id)
      );
      create index sweed_orders_dealer_pay_time_idx on sweed_orders (dealer_id, pay_time);
    `)
    const now = new Date('2026-07-20T12:00:00.000Z')
    const input: InsertReviewSubmissionInput = {
      dealerId: 210705, starRating: 5, reviewText: null, submissionKind: 'form',
      sourceIp: null, userAgent: null, referrer: null, rawPayload: {}, contacts: [],
      llmVerdict: null, degradedPass: null, llmRaw: null, llmModelRef: null,
      llmAt: null, reviewProviderUrl: null,
    }
    const infer = async (rows: Array<[string, Date, number | null, string]>) => {
      await pool.query('truncate sweed_orders')
      for (const [invoiceId, payTime, cashierId, rawJson] of rows) {
        await pool.query('insert into sweed_orders values (210705, $1, $2, $3, $4::jsonb)', [invoiceId, payTime, cashierId, rawJson])
      }
      const inserted = await insertReviewSubmissionAt(pool, input, now)
      return (await pool.query('select invoice_match_status, matched_invoice_id from review_submissions where id = $1', [inserted.submissionId])).rows[0]
    }
    expect(await infer([['early-boundary', new Date(now.getTime() - 30 * 60_000), 1, '{}']])).toEqual({ invoice_match_status: 'matched', matched_invoice_id: 'early-boundary' })
    expect(await infer([['late-boundary', new Date(now.getTime() + 4 * 60_000), 1, '{}']])).toEqual({ invoice_match_status: 'matched', matched_invoice_id: 'late-boundary' })
    expect(await infer([['later', new Date(now.getTime() + 120_000), 1, '{}'], ['earlier', new Date(now.getTime() - 120_000), 1, '{}']])).toEqual({ invoice_match_status: 'matched', matched_invoice_id: 'earlier' })
    expect(await infer([['b', new Date(now.getTime() - 120_000), 1, '{}'], ['a', new Date(now.getTime() - 120_000), 1, '{}']])).toEqual({ invoice_match_status: 'matched', matched_invoice_id: 'a' })
    expect(await infer([])).toEqual({ invoice_match_status: 'unmatched', matched_invoice_id: null })
    expect(await infer([
      ['cancelled-nearest', new Date(now.getTime() - 10_000), 1, '{"invoiceStatus":{"name":"Cancelled"}}'],
      ['nearest-null', new Date(now.getTime() - 20_000), null, '{}'],
      ['farther-cashier', new Date(now.getTime() - 30_000), 9, '{}'],
    ])).toEqual({ invoice_match_status: 'unmatched', matched_invoice_id: null })

    await pool.query(`insert into staff_directory_cache values ('77', 'Review Only')`)
    await pool.query(
      `insert into review_submissions
       (dealer_id, star_rating, review_text, raw_payload, created_at, invoice_match_status,
        matched_invoice_id, matched_cashier_user_id, matched_at, llm_verdict, fraud_marked)
       values
       (210705, 4, null, '{}', $1, 'matched', 'a', 77, $1, null, false),
       (210705, 1, null, '{}', $1, 'matched', 'b', 77, $1, 'negative', true),
       (210705, 1, null, '{}', $2, 'matched', 'c', 77, $2, 'negative', false)`,
      [now, new Date(now.getTime() - 86_400_000)],
    )
    const reviews = await queryBudtenderReviewCashiers(pool, [210705], new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000))
    expect(reviews.find((row) => row.cashierId === '77')).toEqual({ cashierId: '77', cashierName: 'Review Only', reviewCount: 1, averageStarRating: 4, classifiedReviewCount: 0, lukewarmOrNegativeCount: 0, lukewarmOrNegativeRate: null })

    await expect(pool.query(`insert into review_submissions (dealer_id, raw_payload, invoice_match_status) values (210705, '{}', 'matched')`)).rejects.toMatchObject({ code: '23514' })
    execFileSync(psql, ['-v', 'ON_ERROR_STOP=1', '-f', down], { env, stdio: 'ignore' })
    expect((await pool.query("select count(*)::int as n from information_schema.columns where table_name = 'review_submissions' and column_name = any($1::text[])", [['invoice_match_status', 'matched_invoice_id', 'matched_cashier_user_id', 'matched_at']])).rows[0]).toEqual({ n: 0 })
    expect((await pool.query("select count(*)::int as n from pg_constraint where conname = any($1::text[])", [['review_submissions_invoice_match_status_check', 'review_submissions_invoice_match_state_check']])).rows[0]).toEqual({ n: 0 })
  }, 20_000)
})
