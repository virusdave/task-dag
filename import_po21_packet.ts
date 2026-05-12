#!/usr/bin/env tsx
/**
 * Import PO 21 pending purchase packet into Helios
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { getPool } from './helios/src/server/db/pool.js'
import {
  importPendingPurchasePacket,
  PendingPurchasePacketSchema,
  type PendingPurchasePacket,
} from './helios/src/server/pendingPurchases/pendingPurchasePacketImport.js'

async function main() {
  const packetPath = resolve(__dirname, 'pending_purchases_po21_packet.json')
  console.log(`Reading packet from ${packetPath}`)

  const packetText = await readFile(packetPath, 'utf8')
  const packet = PendingPurchasePacketSchema.parse(JSON.parse(packetText))

  console.log(`Parsed packet: ${packet.packetTitle}`)
  console.log(`  Rows: ${packet.rows.length}`)
  console.log(`  Sites: ${packet.siteLabels.join(', ')}`)

  const pool = getPool()

  try {
    const result = await importPendingPurchasePacket(pool, {
      createdByUserId: null,
      importFileName: 'pending_purchases_po21_packet.json',
      jobId: null,
      packet,
      requestId: randomUUID(),
      source: 'import',
      sourcePath: packetPath,
    })

    console.log(`\nImported successfully:`)
    console.log(`  Packet ID: ${result.packetId}`)
    console.log(`  Imported rows: ${result.importedRowCount}`)
    console.log(`  Audit event ID: ${result.auditEventId}`)
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('Import failed:', error)
  process.exit(1)
})
