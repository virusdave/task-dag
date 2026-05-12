#!/usr/bin/env tsx
import { getPool } from './helios/src/server/db/pool.js'

async function main() {
  const pool = getPool()
  
  try {
    const packet = await pool.query(`
      SELECT 
        id,
        packet_title,
        status,
        site_labels_json,
        generated_at,
        summary_json,
        (SELECT COUNT(*) FROM pending_purchase_rows WHERE packet_id = id) as row_count
      FROM pending_purchase_packets 
      WHERE id = 8
    `)
    
    console.log('Packet:')
    console.log(JSON.stringify(packet.rows[0], null, 2))
    
    const rows = await pool.query(`
      SELECT 
        id,
        distributor_product_name,
        target_brand,
        target_group_name,
        target_variant_name,
        expected_category,
        proposed_price,
        mapping_status,
        approval_status
      FROM pending_purchase_rows
      WHERE packet_id = 8
      ORDER BY id
      LIMIT 5
    `)
    
    console.log('\nFirst 5 rows:')
    rows.rows.forEach(row => {
      console.log(`- ${row.distributor_product_name}`)
      console.log(`  Brand: ${row.target_brand} | Category: ${row.expected_category}`)
      console.log(`  Price: $${row.proposed_price} | Status: ${row.mapping_status}`)
    })
  } finally {
    await pool.end()
  }
}

main()
