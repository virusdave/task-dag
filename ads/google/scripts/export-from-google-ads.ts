#!/usr/bin/env tsx
/**
 * Export LIVE snapshot directly from Google Ads API
 * Bypasses Helios - goes straight to Google Ads to get current state
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GoogleAdsApi } from 'google-ads-api';
import type { AdSnapshot } from '../lib/shared/types.js';
import type { GadsExportRow } from '../lib/gads-api/real-client.js';

async function main() {
  console.log('🚀 Exporting LIVE snapshot from Google Ads API\n');
  
  // Load credentials
  const secretBase = path.join(os.homedir(), '.secret/google-ads');
  const developerToken = fsSync.readFileSync(path.join(secretBase, 'developer-token'), 'utf-8').trim();
  const authorizedUser = JSON.parse(fsSync.readFileSync(path.join(secretBase, 'authorized-user.json'), 'utf-8'));
  
  // Get customer IDs from last verification
  const verification = JSON.parse(fsSync.readFileSync(path.join(secretBase, 'last-verification.json'), 'utf-8'));
  const customerIds = verification.response.resourceNames.map((r: string) => r.replace('customers/', ''));
  
  console.log(`📋 Found ${customerIds.length} customer accounts:`);
  customerIds.forEach((id: string) => console.log(`  - ${id}`));
  
  // Create API client
  const client = new GoogleAdsApi({
    client_id: authorizedUser.client_id,
    client_secret: authorizedUser.client_secret,
    developer_token: developerToken,
  });
  
  const allAds: AdSnapshot[] = [];
  
  // Fetch from each customer
  for (const customerId of customerIds) {
    console.log(`\n📡 Fetching ads from customer ${customerId}...`);
    
    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: authorizedUser.refresh_token,
    });
    
    const query = `
      SELECT
        customer.id,
        campaign.id,
        campaign.name,
        campaign.status,
        ad_group.id,
        ad_group.name,
        ad_group.status,
        ad_group_ad.ad.id,
        ad_group_ad.ad.type,
        ad_group_ad.ad.responsive_search_ad.headlines,
        ad_group_ad.ad.responsive_search_ad.descriptions,
        ad_group_ad.ad.responsive_search_ad.path1,
        ad_group_ad.ad.responsive_search_ad.path2,
        ad_group_ad.ad.final_urls,
        ad_group_ad.status,
        ad_group_ad.policy_summary.approval_status,
        ad_group_ad.policy_summary.policy_topic_entries,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.cost_micros,
        metrics.ctr,
        metrics.conversions_from_interactions_rate
      FROM ad_group_ad
      WHERE 
        ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
        AND ad_group_ad.status != 'REMOVED'
        AND campaign.status != 'REMOVED'
        AND ad_group.status != 'REMOVED'
      ORDER BY campaign.id, ad_group.id
    `;
    
    try {
      // Boundary cast: adopt the narrow GadsExportRow shape for the
      // fields the GAQL SELECT above guarantees.
      const results = (await customer.query(query)) as unknown as GadsExportRow[];
      console.log(`  ✅ Fetched ${results.length} ads`);
      
      for (const row of results) {
        const ad = transformAdToSnapshot(row, customerId);
        allAds.push(ad);
      }
      
      // Rate limit: wait 10s between customers
      if (customerIds.indexOf(customerId) < customerIds.length - 1) {
        console.log('  ⏱️  Waiting 10s (rate limit)...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    } catch (error: unknown) {
      console.error(`  ❌ Error fetching from ${customerId}:`, error instanceof Error ? error.message : String(error));
    }
  }
  
  console.log(`\n📊 Total ads exported: ${allAds.length}`);
  
  // Count by status
  const byStatus: Record<string, number> = {};
  for (const ad of allAds) {
    byStatus[ad.serving_status] = (byStatus[ad.serving_status] || 0) + 1;
  }
  
  console.log('\n📈 Ad Status Breakdown:');
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  ${status}: ${count}`);
  }
  
  // Write JSONL
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outputPath = `snapshots/ads-snapshot-${timestamp}.jsonl`;
  
  await fs.mkdir('snapshots', { recursive: true });
  await fs.writeFile(
    outputPath,
    allAds.map(ad => JSON.stringify(ad)).join('\n')
  );
  
  console.log(`\n💾 Snapshot written to: ${outputPath}`);
  console.log(`\nNext step: Run analysis`);
  console.log(`  npx tsx scripts/run-analysis.ts --snapshot ${outputPath} --output-dir outputs/urgent`);
}

function transformAdToSnapshot(row: GadsExportRow, customerId: string): AdSnapshot {
  const ad = row.ad_group_ad.ad;
  const rsa = ad.responsive_search_ad;
  
  const policyApproval = row.ad_group_ad.policy_summary?.approval_status || 'UNKNOWN';
  const policyTopics = (row.ad_group_ad.policy_summary?.policy_topic_entries || [])
    .map((entry) => entry.type || entry.topic)
    .filter((t): t is string => Boolean(t));
  
  const servingStatusMap: Record<string, AdSnapshot['serving_status']> = {
    'APPROVED': 'eligible',
    'APPROVED_LIMITED': 'eligible_limited',
    'DISAPPROVED': 'not_eligible',
    'UNDER_REVIEW': 'pending',
    'AREA_OF_INTEREST_ONLY': 'eligible_limited',
  };
  
  const servingStatus = servingStatusMap[policyApproval] || 'unknown';
  
  // Extract family tags from names
  const name = `${row.campaign.name} ${row.ad_group.name}`.toLowerCase();
  const familyTags: Record<string, string> = {};
  
  if (name.includes('brand')) familyTags.creative_theme = 'brand';
  else if (name.includes('promo')) familyTags.creative_theme = 'promo';
  else if (name.includes('local')) familyTags.creative_theme = 'local';
  else if (name.includes('medical')) familyTags.creative_theme = 'medical';
  else familyTags.creative_theme = 'general';
  
  if (name.includes('flower')) familyTags.product_tag = 'flower';
  else if (name.includes('edible')) familyTags.product_tag = 'edibles';
  else if (name.includes('vape')) familyTags.product_tag = 'vapes';
  else familyTags.product_tag = 'general';
  
  if (name.includes('midtown')) familyTags.geo_target = 'midtown';
  else if (name.includes('bronx')) familyTags.geo_target = 'bronx';
  else if (name.includes('brooklyn')) familyTags.geo_target = 'brooklyn';
  else if (name.includes('queens')) familyTags.geo_target = 'queens';
  
  return {
    account_id: customerId,
    campaign_id: row.campaign.id.toString(),
    campaign_name: row.campaign.name,
    ad_group_id: row.ad_group.id.toString(),
    ad_group_name: row.ad_group.name,
    ad_id: ad.id.toString(),
    ad_type: 'responsive_search_ad',
    ad_status: row.ad_group_ad.status.toLowerCase(),
    headlines: (rsa?.headlines || []).map((h) => h.text ?? ''),
    descriptions: (rsa?.descriptions || []).map((d) => d.text ?? ''),
    paths: [rsa?.path1, rsa?.path2].filter((p): p is string => Boolean(p)),
    final_url: (ad.final_urls || [])[0] || '',
    policy_status: policyApproval.toLowerCase() as AdSnapshot['policy_status'],
    policy_topics: policyTopics,
    serving_status: servingStatus,
    metrics: {
      impressions: row.metrics?.impressions ?? 0,
      clicks: row.metrics?.clicks ?? 0,
      conversions: row.metrics?.conversions ?? 0,
      cost: (row.metrics?.cost_micros ?? 0) / 1000000,
      ctr: row.metrics?.ctr ?? 0,
      conversion_rate: row.metrics?.conversions_from_interactions_rate ?? 0,
    },
    family_tags: familyTags,
    snapshot_date: new Date().toISOString().split('T')[0],
  };
}

main().catch(console.error);
