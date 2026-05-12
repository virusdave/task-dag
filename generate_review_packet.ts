#!/usr/bin/env tsx
/**
 * Generate modern review UI packet for PO 21 pending purchases
 * Uses modern components (no Helios UI dependencies)
 * Ready for mss-one-offs publishing
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPool } from './helios/src/server/db/pool.js'

const PACKET_ID = 8
const OUTPUT_DIR = process.env.OUTPUT_DIR || `/tmp/po21-review-${Date.now()}`

interface ProductRow {
  id: number
  distributor_product_name: string
  target_brand: string | null
  target_group_name: string | null
  target_variant_name: string | null
  expected_category: string | null
  expected_subcategory: string | null
  proposed_price: number | null
  current_price: number | null
  mapping_status: string
  approval_status: string
  market_advice_summary: string | null
  pricing_reason: string | null
  notes: string | null
}

async function fetchPacketData(pool: any): Promise<ProductRow[]> {
  const result = await pool.query<ProductRow>(`
    SELECT 
      id,
      distributor_product_name,
      target_brand,
      target_group_name,
      target_variant_name,
      expected_category,
      expected_subcategory,
      proposed_price,
      current_price,
      mapping_status,
      approval_status,
      market_advice_summary,
      pricing_reason,
      notes
    FROM pending_purchase_rows
    WHERE packet_id = $1
    ORDER BY expected_category, target_brand, distributor_product_name
  `, [PACKET_ID])
  
  return result.rows
}

function generateHTML(rows: ProductRow[]): string {
  const byCategory = rows.reduce((acc, row) => {
    const cat = row.expected_category || 'Unknown'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(row)
    return acc
  }, {} as Record<string, ProductRow[]>)
  
  const categoryCards = Object.entries(byCategory).map(([category, products]) => `
    <div class="category-section">
      <h2 class="category-title">${category} <span class="count">(${products.length})</span></h2>
      <div class="products-grid">
        ${products.map(renderProductCard).join('\n')}
      </div>
    </div>
  `).join('\n')
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PO 21 Pending Purchases Review — 10FF Distribution</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 2rem;
    }
    
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .header {
      background: white;
      border-radius: 16px;
      padding: 2rem;
      margin-bottom: 2rem;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
    }
    
    .header h1 {
      font-size: 2rem;
      color: #1a202c;
      margin-bottom: 0.5rem;
    }
    
    .header .meta {
      color: #718096;
      font-size: 0.95rem;
    }
    
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-top: 1.5rem;
    }
    
    .stat-card {
      background: #f7fafc;
      padding: 1rem;
      border-radius: 8px;
      border-left: 4px solid #667eea;
    }
    
    .stat-label {
      font-size: 0.85rem;
      color: #718096;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .stat-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: #1a202c;
      margin-top: 0.25rem;
    }
    
    .category-section {
      background: white;
      border-radius: 16px;
      padding: 2rem;
      margin-bottom: 2rem;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
    }
    
    .category-title {
      font-size: 1.5rem;
      color: #1a202c;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 2px solid #e2e8f0;
    }
    
    .category-title .count {
      color: #667eea;
      font-weight: normal;
      font-size: 1.25rem;
    }
    
    .products-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 1.5rem;
    }
    
    .product-card {
      background: #ffffff;
      border: 2px solid #e2e8f0;
      border-radius: 12px;
      padding: 1.5rem;
      transition: all 0.2s;
    }
    
    .product-card:hover {
      border-color: #667eea;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.15);
    }
    
    .product-brand {
      font-size: 0.85rem;
      color: #667eea;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .product-name {
      font-size: 1.1rem;
      font-weight: 600;
      color: #1a202c;
      margin: 0.5rem 0;
      line-height: 1.4;
    }
    
    .product-variant {
      font-size: 0.9rem;
      color: #718096;
      margin-bottom: 1rem;
    }
    
    .pricing {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      background: #f7fafc;
      border-radius: 8px;
      margin-bottom: 1rem;
    }
    
    .price-label {
      font-size: 0.8rem;
      color: #718096;
      text-transform: uppercase;
    }
    
    .price-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: #48bb78;
    }
    
    .gm-badge {
      background: #48bb78;
      color: white;
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 600;
    }
    
    .metadata {
      font-size: 0.85rem;
      color: #4a5568;
      line-height: 1.6;
    }
    
    .metadata strong {
      color: #1a202c;
    }
    
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 600;
      margin-top: 0.75rem;
    }
    
    .status-needs_review {
      background: #fef5e7;
      color: #d68910;
    }
    
    .footer {
      text-align: center;
      color: white;
      padding: 2rem;
      font-size: 0.9rem;
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🛒 PO 21 Pending Purchases Review</h1>
      <div class="meta">10FF Distribution • Invoice Date: 5/6/2026 • Total: $21,532.50</div>
      
      <div class="stats">
        <div class="stat-card">
          <div class="stat-label">Total Products</div>
          <div class="stat-value">${rows.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Estimated Retail</div>
          <div class="stat-value">$${rows.reduce((sum, r) => sum + (typeof r.proposed_price === 'number' ? r.proposed_price : parseFloat(String(r.proposed_price || 0))), 0).toFixed(2)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Categories</div>
          <div class="stat-value">${Object.keys(byCategory).length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Brands</div>
          <div class="stat-value">${new Set(rows.map(r => r.target_brand)).size}</div>
        </div>
      </div>
    </div>
    
    ${categoryCards}
    
    <div class="footer">
      Generated ${new Date().toLocaleString()} • Packet ID: ${PACKET_ID}
    </div>
  </div>
</body>
</html>
  `.trim()
}

function renderProductCard(row: ProductRow): string {
  const gmPercent = row.pricing_reason?.match(/(\d+\.\d+)% GM/)?.[1] || '60.0'
  const price = typeof row.proposed_price === 'number' ? row.proposed_price : parseFloat(String(row.proposed_price || 0))
  
  return `
    <div class="product-card">
      <div class="product-brand">${row.target_brand || 'Unknown Brand'}</div>
      <div class="product-name">${row.target_group_name || row.distributor_product_name}</div>
      <div class="product-variant">${row.target_variant_name || ''} ${row.expected_subcategory ? `• ${row.expected_subcategory}` : ''}</div>
      
      <div class="pricing">
        <div>
          <div class="price-label">Proposed Price</div>
          <div class="price-value">$${price.toFixed(2)}</div>
        </div>
        <div class="gm-badge">${gmPercent}% GM</div>
      </div>
      
      <div class="metadata">
        ${row.market_advice_summary ? `<div><strong>Market:</strong> ${row.market_advice_summary}</div>` : ''}
        ${row.notes ? `<div><strong>Notes:</strong> ${row.notes}</div>` : ''}
        <div><strong>SKU:</strong> ${row.distributor_product_name.substring(0, 40)}...</div>
      </div>
      
      <div class="status-badge status-${row.mapping_status}">${row.mapping_status.replace(/_/g, ' ')}</div>
    </div>
  `
}

async function main() {
  const pool = getPool()
  
  try {
    console.log('Fetching packet data...')
    const rows = await fetchPacketData(pool)
    console.log(`Found ${rows.length} products`)
    
    console.log('Generating HTML...')
    const html = generateHTML(rows)
    
    console.log(`Creating output directory: ${OUTPUT_DIR}`)
    await mkdir(OUTPUT_DIR, { recursive: true, mode: 0o2770 })
    
    const indexPath = join(OUTPUT_DIR, 'index.html')
    await writeFile(indexPath, html, 'utf-8')
    
    console.log(`\n✅ Review packet generated!`)
    console.log(`   Output: ${OUTPUT_DIR}/index.html`)
    console.log(`   Upload ID: ${OUTPUT_DIR.split('/').pop()}`)
    console.log(`\nNext: Use mss-one-offs control socket to publish`)
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('Generation failed:', error)
  process.exit(1)
})
