#!/usr/bin/env tsx
/**
 * Monitor active trials and collect outcomes
 * 
 * Checks trial status at intervals (1hr, 4hr, 24hr, 48hr) and stores results in Helios
 * 
 * Usage:
 *   ./scripts/monitor-trials.ts --interval 1  # Check trials at 1hr mark
 *   ./scripts/monitor-trials.ts --interval 24 # Check trials at 24hr mark
 */

import type { GoogleAdsClient } from '../lib/gads-api/client.js';

interface MonitorOptions {
  intervalHours: number;
  dryRun: boolean;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): MonitorOptions {
  const args = process.argv.slice(2);
  let intervalHours = 1;
  let dryRun = false;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && i + 1 < args.length) {
      intervalHours = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }
  
  if (![1, 4, 24, 48].includes(intervalHours)) {
    console.error('Error: --interval must be 1, 4, 24, or 48');
    process.exit(1);
  }
  
  return { intervalHours, dryRun };
}

interface ActiveTrial {
  trial_id: string;
  trial_group_name: string;
  trial_ad_group_id: string;
  started_at: string;
  ad_ids: string[];
  is_controls: boolean[];
  variant_labels: string[];
}

interface TrialCheckResult {
  trial_id: string;
  ad_id: string;
  is_control: boolean;
  variant_label: string;
  serving_status: string;
  policy_status: string;
  policy_topics: string[];
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  conversion_rate: number;
}

/**
 * Get active trials from Helios
 */
async function getActiveTrials(intervalHours: number): Promise<ActiveTrial[]> {
  // TODO: Query Helios for trials that need checking at this interval
  // const pool = getHeliosPool();
  
  const query = `
    SELECT 
      t.trial_id,
      t.trial_group_name,
      t.trial_ad_group_id,
      t.started_at,
      array_agg(ta.ad_id) as ad_ids,
      array_agg(ta.is_control) as is_controls,
      array_agg(ta.variant_label) as variant_labels
    FROM gads_trials t
    JOIN gads_trial_ads ta ON t.trial_id = ta.trial_id
    WHERE t.status = 'running'
      AND t.started_at <= NOW() - INTERVAL '${intervalHours} hours'
      AND t.started_at > NOW() - INTERVAL '${intervalHours + 1} hours'
      AND NOT EXISTS (
        SELECT 1 FROM gads_trial_checks tc
        WHERE tc.trial_id = t.trial_id
          AND tc.check_interval_hours = ${intervalHours}
      )
    GROUP BY t.trial_id, t.trial_group_name, t.trial_ad_group_id, t.started_at
  `;
  
  // Mock for now
  return [];
}

/**
 * Check trial status via Google Ads API
 */
async function checkTrialStatus(
  client: GoogleAdsClient,
  trial: ActiveTrial
): Promise<TrialCheckResult[]> {
  const results: TrialCheckResult[] = [];
  
  for (let i = 0; i < trial.ad_ids.length; i++) {
    const adId = trial.ad_ids[i];
    
    // Get current policy status
    // const adInfo = await client.getAdInfo(adId);
    
    // Get performance metrics
    // const metrics = await client.getPerformanceMetrics([adId], trial.started_at, new Date());
    
    results.push({
      trial_id: trial.trial_id,
      ad_id: adId,
      is_control: trial.is_controls[i],
      variant_label: trial.variant_labels[i],
      serving_status: 'unknown', // adInfo.serving_status
      policy_status: 'unknown', // adInfo.policy_status
      policy_topics: [], // adInfo.policy_topics
      impressions: 0, // metrics?.impressions
      clicks: 0, // metrics?.clicks
      conversions: 0, // metrics?.conversions
      ctr: 0, // metrics?.ctr
      conversion_rate: 0, // metrics?.conversion_rate
    });
  }
  
  return results;
}

/**
 * Store check results in Helios
 */
async function storeCheckResults(
  intervalHours: number,
  results: TrialCheckResult[]
): Promise<void> {
  // TODO: Insert into gads_trial_checks table
  // const pool = getHeliosPool();
  
  for (const result of results) {
    const query = `
      INSERT INTO gads_trial_checks (
        trial_id, ad_id, check_time, check_interval_hours,
        serving_status, policy_status, policy_topics,
        impressions, clicks, conversions, ctr, conversion_rate
      ) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (trial_id, ad_id, check_interval_hours) DO UPDATE SET
        serving_status = EXCLUDED.serving_status,
        policy_status = EXCLUDED.policy_status,
        policy_topics = EXCLUDED.policy_topics,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        conversions = EXCLUDED.conversions,
        ctr = EXCLUDED.ctr,
        conversion_rate = EXCLUDED.conversion_rate
    `;
    
    // await pool.query(query, [
    //   result.trial_id, result.ad_id, intervalHours,
    //   result.serving_status, result.policy_status, JSON.stringify(result.policy_topics),
    //   result.impressions, result.clicks, result.conversions,
    //   result.ctr, result.conversion_rate
    // ]);
  }
  
  console.log(`✅ Stored ${results.length} check results`);
}

/**
 * Main
 */
async function main() {
  const options = parseArgs();
  
  console.log(`🔍 Monitoring trials at ${options.intervalHours}hr interval`);
  if (options.dryRun) {
    console.log('🏃 DRY RUN MODE - no changes will be made');
  }
  
  // Get active trials
  const trials = await getActiveTrials(options.intervalHours);
  console.log(`Found ${trials.length} trials to check`);
  
  if (trials.length === 0) {
    console.log('✅ No trials to check at this interval');
    return;
  }
  
  // TODO: Initialize Google Ads client
  // const client = new GoogleAdsClient(loadConfig());
  
  // Check each trial
  let totalResults = 0;
  for (const trial of trials) {
    console.log(`\n📊 Checking trial: ${trial.trial_group_name}`);
    
    // const results = await checkTrialStatus(client, trial);
    // console.log(`  Checked ${results.length} ads`);
    
    // if (!options.dryRun) {
    //   await storeCheckResults(options.intervalHours, results);
    // }
    
    // totalResults += results.length;
  }
  
  console.log(`\n✅ Monitoring complete: Checked ${totalResults} trial ads`);
}

main().catch(console.error);
