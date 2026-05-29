import { Pool } from 'pg'
;(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL })
  const r = await p.query(`
    select
      count(*) filter (where address_id is not null) as linked,
      count(*) filter (where address_id is null and (
        nullif(trim(coalesce(address, '')), '') is not null
        or nullif(trim(coalesce(city, '')), '') is not null
        or nullif(trim(coalesce(state, '')), '') is not null
        or nullif(trim(coalesce(postal_code, '')), '') is not null
      )) as unlinked_with_text,
      count(*) filter (where address_id is null and
        nullif(trim(coalesce(address, '')), '') is null
        and nullif(trim(coalesce(city, '')), '') is null
        and nullif(trim(coalesce(state, '')), '') is null
        and nullif(trim(coalesce(postal_code, '')), '') is null
      ) as unlinked_no_text,
      count(*) as total
    from visitor_scans
  `)
  console.log('visitor_scans status:', r.rows[0])
  const r2 = await p.query(
    "select count(*) filter (where geocode_status = 'ok') as ok, count(*) filter (where geocode_status = 'pending') as pending, count(*) filter (where geocode_status = 'failed') as failed, count(*) filter (where geocode_status = 'not_us') as not_us, count(*) as total from addresses",
  )
  console.log('addresses status:', r2.rows[0])
  await p.end()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
