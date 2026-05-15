#!/usr/bin/env tsx
/**
 * Cleanup completed trials after 48hr
 * 
 * Removes trial ad groups from Google Ads and marks them as completed in Helios
 * 
 * Usage:
 *   ./scripts/cleanup-trials.ts [--dry-run]
 */

import type { GoogleAdsClient } from '../lib/gads-api/client.js';

interface CleanupOptions {
  dryRun: boolean;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): CleanupOptions {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  return { dryRun };
}

/**
 * Get trials ready for cleanup (>48hr old, all checks complete)
 */
async function getTrialsForCleanup(): Promise<any[]> {
  // TODO: Query Helios
  // const pool = getHeliosPool();
  
  const query = `
    SELECT 
      t.trial_id,
      t.trial_group_name,
      t.trial_ad_group_id,
      t.started_at,
      COUNT(DISTINCT tc.check_interval_hours) as checks_completed
    FROM gads_trials t
    LEFT JOIN gads_trial_checks tc ON t.trial_id = tc.trial_id
    WHERE t.status = 'running'
      AND t.started_at <= NOW() - INTERVAL '48 hours'
    GROUP BY t.trial_id, t.trial_group_name, t.trial_ad_group_id, t.started_at
    HAVING COUNT(DISTINCT tc.check_interval_hours) >= 4  -- All 4 checks done
    ORDER BY t.started_at
  `;
  
  // Mock for now
  return [];
}

/**
 * Remove trial ad group from Google Ads
 */
async function removeTrialAdGroup(
  client: GoogleAdsClient,
  adGroupId: string,
  trialName: string
): Promise<boolean> {
  try {
    console.log(`  🗑️  Removing ad group: ${trialName}`);
    // await client.removeAdGroup(adGroupId);
    return true;
  } catch (error) {
    console.error(`  ❌ Failed to remove ${trialName}:`, error);
    return false;
  }
}

/**
 * Mark trial as completed in Helios
 */
async function markTrialCompleted(trialId: string): Promise<void> {
  // TODO: Update Helios
  // const pool = getHeliosPool();
  
  const query = `
    UPDATE gads_trials
    SET 
      status = 'completed',
      ended_at = NOW()
    WHERE trial_id = $1
  `;
  
  // await pool.query(query, [trialId]);
}

/**
 * Main
 */
async function main() {
  const options = parseArgs();
  
  console.log('🧹 Cleaning up completed trials (>48hr old)');
  if (options.dryRun) {
    console.log('🏃 DRY RUN MODE - no changes will be made\n');
  }
  
  // Get trials for cleanup
  const trials = await getTrialsForCleanup();
  console.log(`Found ${trials.length} trials ready for cleanup\n`);
  
  if (trials.length === 0) {
    console.log('✅ No trials to cleanup');
    return;
  }
  
  // TODO: Initialize Google Ads client
  // const client = new GoogleAdsClient(loadConfig());
  
  let removed = 0;
  let failed = 0;
  
  for (const trial of trials) {
    console.log(`🔍 Trial: ${trial.trial_group_name} (started ${trial.started_at})`);
    console.log(`   Checks completed: ${trial.checks_completed}/4`);
    
    if (!options.dryRun) {
      // const success = await removeTrialAdGroup(client, trial.trial_ad_group_id, trial.trial_group_name);
      
      // if (success) {
      //   await markTrialCompleted(trial.trial_id);
      //   removed++;
      // } else {
      //   failed++;
      // }
    } else {
      console.log('  [DRY RUN] Would remove this trial');
    }
  }
  
  console.log(`\n✅ Cleanup complete:`);
  console.log(`   Removed: ${removed}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Total: ${trials.length}`);
}

main().catch(console.error);
