#!/usr/bin/env tsx
/**
 * Export Google Ads snapshot from Helios to JSONL
 * 
 * Usage:
 *   ./scripts/helios-export-snapshot.ts --date 2026-05-15 --output snapshots/gads_ads_2026-05-15.jsonl
 */

import * as fs from 'fs/promises';

interface ExportOptions {
  snapshotDate: string;
  outputPath: string;
  accountIds?: string[];
}

/**
 * Parse CLI arguments
 */
function parseArgs(): ExportOptions {
  const args = process.argv.slice(2);
  let snapshotDate = new Date().toISOString().split('T')[0];
  let outputPath = '';
  let accountIds: string[] | undefined = undefined;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && i + 1 < args.length) {
      snapshotDate = args[i + 1];
      i++;
    } else if (args[i] === '--output' && i + 1 < args.length) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === '--accounts' && i + 1 < args.length) {
      accountIds = args[i + 1].split(',');
      i++;
    }
  }
  
  if (!outputPath) {
    outputPath = `snapshots/gads_ads_${snapshotDate}.jsonl`;
  }
  
  return { snapshotDate, outputPath, accountIds };
}

/**
 * Export snapshot from Helios database
 */
async function exportSnapshot(options: ExportOptions): Promise<void> {
  console.log(`📥 Exporting Google Ads snapshot for ${options.snapshotDate}`);
  
  // TODO: Connect to Helios database
  // const pool = getHeliosPool();
  
  const query = `
    SELECT 
      acc.account_id,
      c.campaign_id,
      c.campaign_name,
      ag.ad_group_id,
      ag.ad_group_name,
      ad.ad_id,
      ad.ad_type,
      ad.ad_status,
      ad.headlines,
      ad.descriptions,
      ad.paths,
      ad.final_url,
      ad.policy_status,
      ad.policy_topics,
      ad.serving_status,
      ps.impressions,
      ps.clicks,
      ps.conversions,
      ps.cost,
      ps.ctr,
      ps.conversion_rate,
      ps.quality_score,
      jsonb_object_agg(ft.tag_key, ft.tag_value) FILTER (WHERE ft.tag_key IS NOT NULL) as family_tags
    FROM gads_ads ad
    JOIN gads_ad_groups ag ON ad.ad_group_id = ag.ad_group_id
    JOIN gads_campaigns c ON ag.campaign_id = c.campaign_id
    JOIN gads_accounts acc ON c.account_id = acc.account_id
    LEFT JOIN gads_performance_snapshots ps 
      ON ad.ad_id = ps.ad_id 
      AND ps.snapshot_date = $1
    LEFT JOIN gads_family_tags ft ON ad.ad_id = ft.ad_id
    WHERE ($2::text[] IS NULL OR acc.account_id = ANY($2))
      AND ad.ad_status != 'REMOVED'
    GROUP BY 
      acc.account_id, c.campaign_id, c.campaign_name,
      ag.ad_group_id, ag.ad_group_name,
      ad.ad_id, ad.ad_type, ad.ad_status,
      ad.headlines, ad.descriptions, ad.paths, ad.final_url,
      ad.policy_status, ad.policy_topics, ad.serving_status,
      ps.impressions, ps.clicks, ps.conversions, ps.cost,
      ps.ctr, ps.conversion_rate, ps.quality_score
    ORDER BY acc.account_id, c.campaign_name, ag.ad_group_name, ad.ad_id
  `;
  
  // TODO: Execute query
  // const result = await pool.query(query, [options.snapshotDate, options.accountIds || null]);
  
  // Mock result for now
  console.log(`⚠️  Using example data (Helios not connected)`);
  const examplePath = 'ads/google/snapshots/example-snapshot.jsonl';
  const exampleContent = await fs.readFile(examplePath, 'utf-8');
  
  await fs.writeFile(options.outputPath, exampleContent, 'utf-8');
  
  const lineCount = exampleContent.trim().split('\n').length;
  console.log(`✅ Exported ${lineCount} ads to ${options.outputPath}`);
  console.log(`\nNext: ./ads/google/scripts/run-analysis.ts --snapshot ${options.outputPath}`);
}

/**
 * Main
 */
async function main() {
  const options = parseArgs();
  await exportSnapshot(options);
}

main().catch(console.error);
