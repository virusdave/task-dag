#!/usr/bin/env npx tsx

import fs from 'fs';
import path from 'path';

const dir = __dirname;
const packetPath = path.join(dir, 'combined_pending_purchases_proposal.json');

console.log('Loading packet...');
const data = JSON.parse(fs.readFileSync(packetPath, 'utf8'));

console.log(`Total rows: ${data.rows.length}`);

let stripped = 0;
let tagged = 0;

// Load manifest for METRC tags
const manifestPath = path.join(dir, 'manifest_10ff.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const manifestMap = new Map();
for (const item of manifest.lineItems) {
  manifestMap.set(item.distributorProductName, item);
}

for (const row of data.rows) {
  // Strip Dutchie images
  const imgUrl = row.primaryImageUrl;
  if (imgUrl && typeof imgUrl === 'string' && (imgUrl.includes('dutchie.com') || imgUrl.includes('images.dutchie.com'))) {
    console.log(`  Stripping Dutchie image: ${row.targetVariantName}`);
    row.primaryImageUrl = null;
    row.primaryImageHref = null;
    row.reviewFlags = row.reviewFlags || [];
    if (!row.reviewFlags.includes('Image scrubbed (Dutchie source forbidden)')) {
      row.reviewFlags.push('Image scrubbed (Dutchie source forbidden)');
    }
    stripped++;
  }
  
  // Add METRC tags
  const dpName = row.distributorProductName;
  if (dpName && manifestMap.has(dpName)) {
    const metrc = manifestMap.get(dpName)!.metrcTag;
    if (metrc && !row.packageTag) {
      row.packageTag = metrc;
      tagged++;
    }
  }
}

fs.writeFileSync(packetPath, JSON.stringify(data, null, 2));
console.log(`\n✅ Stripped ${stripped} Dutchie images`);
console.log(`✅ Tagged ${tagged} rows with METRC tags`);
