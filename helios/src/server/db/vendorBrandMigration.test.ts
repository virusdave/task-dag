import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { describeRequiresTestDb } from '../__tests__/requiresTestDb.js'
import { parseCsv } from '../seo/metricsImport.js'
import { getMigrationSentinel } from './pendingMigrations.js'
import { withClient } from './pool.js'

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'migrations/104_vendor_brand_associations.sql'),
  'utf8',
)

function seedRows(): string[][] {
  const match = migration.match(
    /from stdin with \(format csv, header true\);\n([\s\S]*?)\n\\\.\n/,
  )
  expect(match, 'migration must contain a terminated COPY CSV seed').not.toBeNull()
  const parsed = parseCsv(match![1]!)
  expect(parsed[0]).toEqual([
    'Brand',
    'Vendor Name',
    'Time to keep on hand',
    'Assets',
    'COD?',
    'COD Discount?',
    'Minimum Order',
    'Comments',
  ])
  return parsed.slice(1)
}

describe('migration 104 vendor seed', () => {
  it('preserves the source population and produces the reviewed normalized counts', () => {
    const rows = seedRows()
    const populatedBrands = rows.filter(([brand]) => brand?.trim() !== '')
    const validRows = rows.filter(([, vendor]) => {
      const name = vendor?.trim()
      return name !== '' && name !== '??' && name !== '???'
    })
    const vendorNames = new Set(validRows.map(([, vendor]) => vendor!.trim().toLowerCase()))
    const associations = new Set(
      validRows
        .filter(([brand]) => brand?.trim() !== '')
        .map(([brand, vendor]) => `${brand!.trim().toLowerCase()}\0${vendor!.trim().toLowerCase()}`),
    )
    const normalizedBrandKeys = new Set(
      validRows
        .filter(([brand]) => brand?.trim() !== '')
        .map(([brand]) => brand!.trim().toLowerCase()),
    )

    expect(rows).toHaveLength(240)
    expect(populatedBrands).toHaveLength(237)
    expect(vendorNames.size).toBe(84)
    // 237 populated-brand rows - 2 placeholder-vendor rows - 3 repeated
    // brand/vendor rows = 232. The attachment therefore disproves the issue's
    // preliminary estimate of 229 associations.
    expect(associations.size).toBe(232)
    expect(normalizedBrandKeys.size).toBe(232)
    expect(vendorNames).toContain('freshly baked nyc')
    expect(vendorNames.has('??')).toBe(false)
    expect(vendorNames.has('???')).toBe(false)
    expect([...associations].some((key) => key.startsWith('hgny\0'))).toBe(false)
    expect([...associations].some((key) => key.startsWith('ruby farms\0'))).toBe(false)
  })

  it('deduplicates repeated associations and preserves the first vendor spelling', () => {
    const rows = seedRows()
    for (const brand of ['1906', '1937', 'Enigma']) {
      expect(rows.filter(([candidate]) => candidate === brand)).toHaveLength(2)
    }
    const leftCoastSpellings = rows
      .map(([, vendor]) => vendor)
      .filter((vendor) => vendor?.toLowerCase() === 'left coast')
    expect(leftCoastSpellings).toEqual(['LEFT COAST', 'Left COAST'])
    expect(migration).toContain('order by lower(btrim(vendor_name)), source_order')
    expect(migration.match(/on conflict do nothing;/g)).toHaveLength(2)
  })

  it('keeps row-level purchasing metadata as source text and nullable typed fields', () => {
    const rows = seedRows()
    const brick = rows.find(([brand]) => brand === 'Brick')
    expect(brick).toEqual([
      'Brick',
      'Dumbo Electric',
      '18',
      '',
      'No',
      '16.67%',
      '0',
      'These are blunts, normally 12, but COD is 10.  Case size is 100',
    ])
    expect(migration).toContain('cod_required boolean')
    expect(migration).toContain('cod_discount_source text')
    expect(migration).toContain('minimum_order_dollars numeric(12,2)')
    expect(migration).not.toMatch(/case_size\s+(integer|numeric)/i)
  })
})

const schemaSql = `
  create table vendors (
    id bigint generated always as identity primary key,
    name text not null,
    is_mso boolean not null default false,
    is_micro boolean not null default false,
    cod_only boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint vendors_name_trimmed_nonempty_check check (name = btrim(name) and name <> '')
  );
  create unique index vendors_name_lower_uidx on vendors (lower(name));
  create table vendor_brand_associations (
    id bigint generated always as identity primary key,
    vendor_id bigint not null references vendors(id) on delete cascade,
    brand_name text not null,
    is_primary boolean not null default true,
    target_days_on_hand integer,
    asset_url text,
    cod_required boolean,
    cod_discount_source text,
    minimum_order_dollars numeric(12,2),
    comments text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint vendor_brand_associations_brand_trimmed_nonempty_check check (brand_name = btrim(brand_name) and brand_name <> ''),
    constraint vendor_brand_associations_target_days_check check (target_days_on_hand is null or target_days_on_hand > 0),
    constraint vendor_brand_associations_asset_url_check check (asset_url is null or (asset_url = btrim(asset_url) and asset_url <> '')),
    constraint vendor_brand_associations_cod_discount_source_check check (cod_discount_source is null or (cod_discount_source = btrim(cod_discount_source) and cod_discount_source <> '')),
    constraint vendor_brand_associations_minimum_order_check check (minimum_order_dollars is null or minimum_order_dollars >= 0),
    constraint vendor_brand_associations_comments_check check (comments is null or (comments = btrim(comments) and comments <> ''))
  );
  create unique index vendor_brand_associations_vendor_brand_lower_uidx on vendor_brand_associations (vendor_id, lower(brand_name));
  create unique index vendor_brand_associations_one_primary_brand_uidx on vendor_brand_associations (lower(brand_name)) where is_primary;
`

describeRequiresTestDb('migration 104 exact schema sentinel', () => {
  it('rejects representative schema drift and every load-bearing uniqueness index', async () => {
    await withClient(async (client) => {
      await client.query('begin')
      try {
        await client.query(schemaSql)
        const sentinel = getMigrationSentinel('104_vendor_brand_associations')
        expect(sentinel).not.toBeNull()
        const check = () => sentinel!.check(client)

        await expect(check()).resolves.toBe(true)

        await client.query('alter table vendors alter column is_mso drop default')
        await expect(check()).resolves.toBe(false)
        await client.query('alter table vendors alter column is_mso set default false')
        await expect(check()).resolves.toBe(true)

        await client.query('alter table vendor_brand_associations drop constraint vendor_brand_associations_target_days_check')
        await expect(check()).resolves.toBe(false)
        await client.query('alter table vendor_brand_associations add constraint vendor_brand_associations_target_days_check check (target_days_on_hand is null or target_days_on_hand > 0)')
        await expect(check()).resolves.toBe(true)

        const indexes = [
          ['vendors_name_lower_uidx', 'create unique index vendors_name_lower_uidx on vendors (lower(name))'],
          ['vendor_brand_associations_vendor_brand_lower_uidx', 'create unique index vendor_brand_associations_vendor_brand_lower_uidx on vendor_brand_associations (vendor_id, lower(brand_name))'],
          ['vendor_brand_associations_one_primary_brand_uidx', 'create unique index vendor_brand_associations_one_primary_brand_uidx on vendor_brand_associations (lower(brand_name)) where is_primary'],
        ] as const
        for (const [name, createSql] of indexes) {
          await client.query(`drop index ${name}`)
          await expect(check()).resolves.toBe(false)
          await client.query(createSql)
          await expect(check()).resolves.toBe(true)
        }

        await client.query(
          'alter table vendors add constraint vendors_unexpected_unique unique (name, created_at)',
        )
        await expect(check()).resolves.toBe(false)
        await client.query('alter table vendors drop constraint vendors_unexpected_unique')
        await expect(check()).resolves.toBe(true)

        const version = await client.query<{ server_version_num: number }>(
          `select current_setting('server_version_num')::integer as server_version_num`,
        )
        if ((version.rows[0]?.server_version_num ?? 0) >= 180000) {
          await client.query('alter table vendors alter column is_mso drop not null')
          await client.query(
            'alter table vendors add constraint vendors_is_mso_not_null not null is_mso not valid',
          )
          await expect(check()).resolves.toBe(false)
        }
      } finally {
        await client.query('rollback')
      }
    })
  })
})
