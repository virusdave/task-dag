#!/usr/bin/env npx tsx

import fs from 'fs';
import path from 'path';

const packetPath = path.join(__dirname, 'combined_pending_purchases_proposal.json');
const data = JSON.parse(fs.readFileSync(packetPath, 'utf8'));

let stripped = 0;
for (const row of data.rows) {
  if (row.primaryImageUrl && (row.primaryImageUrl.includes('dutchie.com') || row.primaryImageUrl.includes('images.dutchie.com'))) {
    console.log(`Stripping: ${row.targetVariantName}`);
    row.primaryImageUrl = null;
    row.primaryImageHref = null;
    row.reviewFlags = row.reviewFlags || [];
    if (!row.reviewFlags.includes('Image scrubbed (Dutchie source forbidden)')) {
      row.reviewFlags.push('Image scrubbed (Dutchie source forbidden)');
    }
    stripped++;
  }
}

fs.writeFileSync(packetPath, JSON.stringify(data, null, 2));
console.log(`\nStripped ${stripped} Dutchie images`);
