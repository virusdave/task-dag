#!/usr/bin/env npx tsx
/**
 * Flip every audience TargetingSetting from "Targeting" to "Observation"
 * across all enabled campaigns + ad_groups in the linked Google Ads
 * accounts. This eliminates the Ads Editor warning:
 *
 *   "You have Search Network or Shopping audiences reach set to
 *    'Targeting' which restricts traffic to just the users in your
 *    audience segments. Use 'Observation' to target all users."
 *
 * Use --dry-run to only report what would change.
 */

import {GoogleAdsApi, enums} from 'google-ads-api';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SECRET = path.join(os.homedir(), '.secret/google-ads');
const auth = JSON.parse(fs.readFileSync(path.join(SECRET, 'authorized-user.json'), 'utf-8'));
const developer_token = fs.readFileSync(path.join(SECRET, 'developer-token'), 'utf-8').trim();
const verification = JSON.parse(fs.readFileSync(path.join(SECRET, 'last-verification.json'), 'utf-8'));

const dryRun = process.argv.includes('--dry-run');
const explicitId = process.argv.find(a => a.startsWith('--customer='))?.split('=')[1];

const api = new GoogleAdsApi({
  client_id: auth.client_id,
  client_secret: auth.client_secret,
  developer_token,
});

// Resolve which login customer to use. The last-verification probe used
// a flat customer ID; if there's a manager hop required for a child we
// will surface the error and try the next id.
async function listAccessible(): Promise<string[]> {
  // The API exposes a helper for this on the Customer object too, but it
  // requires a customer_id; just reuse the cached list from last verify.
  return (verification.response?.resourceNames || []).map((rn: string) => rn.split('/')[1]);
}

interface Hit {
  scope: 'campaign' | 'ad_group';
  resourceName: string;
  campaignName: string;
  adGroupName?: string;
  // existing audience target_restriction.bid_only value
  audienceBidOnly: boolean | null;
}

async function findAudienceTargeting(customerId: string): Promise<Hit[]> {
  const customer = api.Customer({customer_id: customerId, refresh_token: auth.refresh_token});
  const hits: Hit[] = [];

  // Campaign-level
  const campRows = await customer.query(`
    SELECT
      campaign.resource_name,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.targeting_setting.target_restrictions
    FROM campaign
    WHERE campaign.status != 'REMOVED'
      AND campaign.advertising_channel_type IN ('SEARCH','SHOPPING')
  `);
  for (const row of campRows) {
    const restrictions = row.campaign?.targeting_setting?.target_restrictions || [];
    for (const r of restrictions) {
      if (r.targeting_dimension === enums.TargetingDimension.AUDIENCE) {
        hits.push({
          scope: 'campaign',
          resourceName: row.campaign!.resource_name!,
          campaignName: row.campaign!.name!,
          audienceBidOnly: r.bid_only ?? null,
        });
      }
    }
  }

  // Ad-group-level
  const agRows = await customer.query(`
    SELECT
      ad_group.resource_name,
      ad_group.name,
      ad_group.status,
      ad_group.targeting_setting.target_restrictions,
      campaign.name,
      campaign.advertising_channel_type
    FROM ad_group
    WHERE ad_group.status != 'REMOVED'
      AND campaign.advertising_channel_type IN ('SEARCH','SHOPPING')
  `);
  for (const row of agRows) {
    const restrictions = row.ad_group?.targeting_setting?.target_restrictions || [];
    for (const r of restrictions) {
      if (r.targeting_dimension === enums.TargetingDimension.AUDIENCE) {
        hits.push({
          scope: 'ad_group',
          resourceName: row.ad_group!.resource_name!,
          campaignName: row.campaign!.name!,
          adGroupName: row.ad_group!.name!,
          audienceBidOnly: r.bid_only ?? null,
        });
      }
    }
  }
  return hits;
}

async function fixOne(customerId: string, hit: Hit): Promise<void> {
  const customer = api.Customer({customer_id: customerId, refresh_token: auth.refresh_token});
  // Re-read existing restrictions and replace AUDIENCE one with bid_only=true.
  // The TargetingSetting field is REPLACE on update; we must include all
  // existing TargetRestrictions and just modify the AUDIENCE row.
  const isCampaign = hit.scope === 'campaign';
  const query = isCampaign
    ? `SELECT campaign.resource_name, campaign.targeting_setting.target_restrictions
       FROM campaign WHERE campaign.resource_name = '${hit.resourceName}'`
    : `SELECT ad_group.resource_name, ad_group.targeting_setting.target_restrictions
       FROM ad_group WHERE ad_group.resource_name = '${hit.resourceName}'`;
  const [row] = await customer.query(query);
  const existing = isCampaign
    ? (row.campaign?.targeting_setting?.target_restrictions || [])
    : (row.ad_group?.targeting_setting?.target_restrictions || []);
  const updated = existing.map(r =>
    r.targeting_dimension === enums.TargetingDimension.AUDIENCE
      ? {...r, bid_only: true}
      : r
  );
  const targeting_setting = {target_restrictions: updated};
  if (isCampaign) {
    await customer.campaigns.update([{resource_name: hit.resourceName, targeting_setting}]);
  } else {
    await customer.adGroups.update([{resource_name: hit.resourceName, targeting_setting}]);
  }
}

async function main() {
  const ids = explicitId ? [explicitId] : await listAccessible();
  console.log(`Checking ${ids.length} customer account(s): ${ids.join(', ')}`);
  let total = 0;
  let toFix = 0;
  let fixed = 0;
  for (const cid of ids) {
    let hits: Hit[];
    try {
      hits = await findAudienceTargeting(cid);
    } catch (e: unknown) {
      console.log(`  ${cid}: query failed — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!hits.length) {
      console.log(`  ${cid}: no Search/Shopping audience TargetRestrictions found`);
      continue;
    }
    total += hits.length;
    const needs = hits.filter(h => h.audienceBidOnly === false);
    toFix += needs.length;
    console.log(`  ${cid}: ${hits.length} audience attachment(s), ${needs.length} on 'Targeting' (need fix)`);
    for (const h of needs) {
      const label = h.scope === 'campaign'
        ? `campaign "${h.campaignName}"`
        : `ad_group "${h.adGroupName}" (in "${h.campaignName}")`;
      if (dryRun) {
        console.log(`    [dry-run] would flip ${label} → Observation`);
      } else {
        try {
          await fixOne(cid, h);
          fixed += 1;
          console.log(`    ✓ flipped ${label} → Observation`);
        } catch (e: unknown) {
          console.log(`    ✗ failed ${label}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  console.log(`\nSummary: ${total} audience attachment(s) scanned, ${toFix} on 'Targeting', ${dryRun ? 0 : fixed} flipped to 'Observation'.`);
}

main().catch(e => { console.error(e); process.exit(1); });
