/**
 * L2: CSV Generator
 * Generates numbered CSV files (001-005) for Ads Editor import
 */

import type {
  AdSnapshot,
  L2PredictionOutput,
  FamilyPrediction,
  AdAction,
  TrialPlan,
  CSVBatch,
  CSVRow,
} from '../shared/types.js';

/**
 * Optional context passed alongside the L2 output. When `snapshotAds`
 * is provided, the generator builds an ad-group -> campaign index from
 * the snapshot and uses it to backfill missing Campaign / Ad group
 * cells the L2 LLM didn't populate (the most common cause of
 * "campaign name can't be empty" rejections on import).
 */
export interface GenerateCSVBatchesOptions {
  snapshotAds?: AdSnapshot[];
}

/**
 * Generate all CSV batches from L2 output
 */
export function generateCSVBatches(
  l2Output: L2PredictionOutput,
  options: GenerateCSVBatchesOptions = {},
): CSVBatch[] {
  const batches: CSVBatch[] = [];

  // Build the snapshot-derived backfill index once. Empty Map when no
  // snapshot was passed — backfill is a no-op in that case.
  const adGroupIndex = options.snapshotAds
    ? buildAdGroupToCampaignIndex(options.snapshotAds)
    : new Map<string, AdGroupCampaignEntry>();

  // 001: Create trial campaigns and ad groups
  batches.push(generateTrialGroupsCSV(l2Output));

  // 002: Repair existing ads
  batches.push(generateRepairCSV(l2Output));

  // 003: Replace and new ads
  batches.push(generateReplaceCSV(l2Output));

  // 004: Pause high-risk ads
  batches.push(generatePauseCSV(l2Output));

  // 005: Create trial ads
  batches.push(generateTrialAdsCSV(l2Output));

  // Backfill before validating. The L2 LLM frequently omits
  // original_campaign_name (and sometimes original_ad_group_name)
  // because the family summary it sees only has family_key — a
  // single family often spans multiple campaigns, so the LLM can't
  // know the right campaign without explicit grounding. Recover that
  // grounding from the snapshot, which is authoritative.
  backfillCampaignAndAdGroup(batches, adGroupIndex);

  // Defense-in-depth: refuse to return a batch that has any row with
  // an empty Campaign or Ad group column. Ads Editor rejects those
  // on import with "campaign name can't be empty", and we've burned
  // operator time more than once shipping a bundle that was
  // dead-on-arrival. Throw here so the calling pipeline (run-analysis
  // and runMorningBundle) treats the run as a hard failure instead
  // of silently writing invalid CSVs.
  assertCampaignAndAdGroupNonEmpty(batches);

  return batches;
}

interface AdGroupCampaignEntry {
  adGroupName: string;
  campaignName: string;
}

/**
 * Normalize an ad-group / trial-group name to a stable lookup key.
 *
 * The L2 LLM derives trial group names like "NYC Bud-trial-001" from
 * snapshot ad-group names like "NYC Bud | Core" — so a literal lookup
 * never matches. We normalize both sides identically:
 *
 *   - lowercase
 *   - strip "-trial-NNN" / "-trial-NN" suffixes
 *   - strip " | <suffix>" / " - <suffix>" (Editor lane / variant tags)
 *   - collapse whitespace
 *
 * Same input produces same key on both sides; matching is exact on
 * the normalized form (no fuzzy/edit-distance — that would silently
 * pick wrong campaigns).
 */
function normalizeAdGroupKey(name: string): string {
  let s = name.toLowerCase().trim();
  // Suffix strippers can compose ("nyc bud-trial-001 | variant"
  // needs both " | variant" and "-trial-001" removed). Iterate until
  // a pass changes nothing.
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(/-trial-\d+\s*$/i, '');
    s = s.replace(/\s*\|\s*[^|]+\s*$/, '');
    s = s.replace(/\s+-\s+[^-]+\s*$/, '');
    s = s.trim();
    if (s === before) break;
  }
  return s.replace(/\s+/g, ' ').trim();
}

function buildAdGroupToCampaignIndex(
  ads: AdSnapshot[],
): Map<string, AdGroupCampaignEntry> {
  const index = new Map<string, AdGroupCampaignEntry>();
  for (const ad of ads) {
    if (!ad.ad_group_name || !ad.campaign_name) continue;
    // Index under both the exact and normalized keys, so an L2
    // response that happens to use the full ad-group name also hits.
    const exact = ad.ad_group_name.toLowerCase().trim();
    const norm = normalizeAdGroupKey(ad.ad_group_name);
    const entry: AdGroupCampaignEntry = {
      adGroupName: ad.ad_group_name,
      campaignName: ad.campaign_name,
    };
    if (!index.has(exact)) index.set(exact, entry);
    if (!index.has(norm)) index.set(norm, entry);
  }
  return index;
}

function lookupAdGroup(
  index: Map<string, AdGroupCampaignEntry>,
  candidates: Array<string | undefined>,
): AdGroupCampaignEntry | null {
  for (const raw of candidates) {
    if (!raw) continue;
    const exact = raw.toLowerCase().trim();
    if (index.has(exact)) return index.get(exact)!;
    const norm = normalizeAdGroupKey(raw);
    if (norm && index.has(norm)) return index.get(norm)!;
  }
  return null;
}

/**
 * Walk every row that *should* have Campaign / Ad group columns and
 * fill in any that are empty/missing from the snapshot index, using
 * the row's source trial/action plus the ad-group / trial-group name
 * candidates that are present.
 */
function backfillCampaignAndAdGroup(
  batches: CSVBatch[],
  index: Map<string, AdGroupCampaignEntry>,
): void {
  if (index.size === 0) return;
  for (const batch of batches) {
    for (const row of batch.rows) {
      const hasCampaignCol = 'Campaign' in row.data;
      const hasAdGroupCol = 'Ad group' in row.data;
      if (!hasCampaignCol && !hasAdGroupCol) continue;
      const campaign = hasCampaignCol ? String(row.data['Campaign'] ?? '').trim() : '';
      const adGroup = hasAdGroupCol ? String(row.data['Ad group'] ?? '').trim() : '';
      if (campaign && adGroup) continue;
      const hit = lookupAdGroup(index, [
        adGroup,
        row.data['Ad group'] != null ? String(row.data['Ad group']) : undefined,
      ]);
      if (!hit) continue;
      if (hasCampaignCol && !campaign) row.data['Campaign'] = hit.campaignName;
      if (hasAdGroupCol && !adGroup) row.data['Ad group'] = hit.adGroupName;
    }
  }
}

/**
 * Reject any row that names a "Campaign" or "Ad group" column with
 * an empty / whitespace-only value. Required keys are mandatory only
 * when the column is present in row.data — batches like 002-repair
 * (which addresses ads by Ad ID) legitimately don't emit Campaign at
 * all, and we don't want to force them to.
 */
function assertCampaignAndAdGroupNonEmpty(batches: CSVBatch[]): void {
  const REQUIRED_COLS = ['Campaign', 'Ad group'] as const;
  const offenders: string[] = [];
  for (const batch of batches) {
    for (const row of batch.rows) {
      for (const col of REQUIRED_COLS) {
        if (!(col in row.data)) continue;
        const raw = row.data[col];
        const value = (raw == null ? '' : String(raw)).trim();
        if (value === '') {
          const source =
            row.source_action_id ?? row.source_trial_id ?? '(unknown source)';
          offenders.push(
            `  - batch ${String(batch.batch_number).padStart(3, '0')}-${batch.batch_name}, ` +
              `row ${row.row_number}, column "${col}" is empty (source: ${source})`,
          );
        }
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to emit Ads Editor CSV batches: ${offenders.length} row(s) ` +
        `have an empty Campaign or Ad group column. Ads Editor rejects those ` +
        `imports with "campaign name can't be empty".\n` +
        offenders.join('\n') +
        '\nFix the L2 prediction (TrialPlan.original_campaign_name / ' +
        'AdAction replace handling) so every row has a real campaign / ad-group name.',
    );
  }
}

/**
 * Generate CSV 001: Create trial campaigns and ad groups
 */
function generateTrialGroupsCSV(l2Output: L2PredictionOutput): CSVBatch {
  const rows: CSVRow[] = [];
  let rowNumber = 1;
  
  for (const family of l2Output.families) {
    for (const trial of family.trial_plans) {
      rows.push({
        row_number: rowNumber++,
        data: {
          Campaign: trial.original_campaign_name,
          'Ad group': trial.trial_group_name,
          'Ad group status': 'Enabled',
          'Default max. CPC': '1.00',
          'Campaign daily budget': (trial.trial_budget_usd || 0.01).toFixed(2),
        },
        source_trial_id: trial.trial_id,
      });
    }
  }
  
  return {
    batch_number: 1,
    batch_name: 'create-trial-campaigns-and-ad-groups',
    description: 'Set up trial campaign and ad group infrastructure',
    rows,
    validation_status: 'valid',
    validation_messages: [],
  };
}

/**
 * Generate CSV 002: Repair existing ads
 */
function generateRepairCSV(l2Output: L2PredictionOutput): CSVBatch {
  const rows: CSVRow[] = [];
  let rowNumber = 1;
  
  for (const family of l2Output.families) {
    const repairActions = family.ad_actions.filter(a => a.action_type === 'repair');
    
    for (const action of repairActions) {
      if (!action.suggested_new_creatives || action.suggested_new_creatives.length === 0) {
        continue;
      }
      
      const creative = action.suggested_new_creatives[0];
      const rowData: Record<string, string> = {
        'Ad ID': action.ad_id,
        'Ad status': 'Enabled',
        'Final URL': creative.final_url || '',
      };
      
      // Add headlines
      for (let i = 0; i < creative.headlines.length && i < 15; i++) {
        rowData[`Headline ${i + 1}`] = creative.headlines[i];
      }
      
      // Add descriptions
      for (let i = 0; i < creative.descriptions.length && i < 4; i++) {
        rowData[`Description ${i + 1}`] = creative.descriptions[i];
      }
      
      rows.push({
        row_number: rowNumber++,
        data: rowData,
        source_action_id: action.ad_id,
        notes: `Issues: ${action.issue_codes.join(', ')} | ${action.justification}`,
      });
    }
  }
  
  return {
    batch_number: 2,
    batch_name: 'repair-existing-ads',
    description: 'Inline edits to existing ads',
    rows,
    validation_status: rows.length > 0 ? 'valid' : 'valid',
    validation_messages: [],
  };
}

/**
 * Generate CSV 003: Replace and new ads
 */
function generateReplaceCSV(l2Output: L2PredictionOutput): CSVBatch {
  const rows: CSVRow[] = [];
  let rowNumber = 1;
  
  for (const family of l2Output.families) {
    const replaceActions = family.ad_actions.filter(a => a.action_type === 'replace');
    
    for (const action of replaceActions) {
      if (!action.suggested_new_creatives) continue;
      
      for (const creative of action.suggested_new_creatives) {
        const rowData: Record<string, string> = {
          Campaign: '', // To be filled from family context
          'Ad group': '', // To be filled from family context
          'Ad type': creative.ad_type === 'responsive_search_ad' ? 'Responsive search ad' : 'Expanded text ad',
          'Ad status': 'Enabled',
          'Final URL': creative.final_url || '',
        };
        
        // Add headlines
        for (let i = 0; i < creative.headlines.length && i < 15; i++) {
          rowData[`Headline ${i + 1}`] = creative.headlines[i];
        }
        
        // Add descriptions
        for (let i = 0; i < creative.descriptions.length && i < 4; i++) {
          rowData[`Description ${i + 1}`] = creative.descriptions[i];
        }
        
        if (creative.paths) {
          for (let i = 0; i < creative.paths.length && i < 2; i++) {
            rowData[`Path ${i + 1}`] = creative.paths[i];
          }
        }
        
        rows.push({
          row_number: rowNumber++,
          data: rowData,
          source_action_id: action.ad_id,
          notes: `Variant: ${creative.variant_label} | ${creative.notes_for_human || ''}`,
        });
      }
    }
  }
  
  return {
    batch_number: 3,
    batch_name: 'replace-and-new-ads',
    description: 'New compliant creatives',
    rows,
    validation_status: 'valid',
    validation_messages: [],
  };
}

/**
 * Generate CSV 004: Pause high-risk ads
 */
function generatePauseCSV(l2Output: L2PredictionOutput): CSVBatch {
  const rows: CSVRow[] = [];
  let rowNumber = 1;
  
  for (const family of l2Output.families) {
    const pauseActions = family.ad_actions.filter(a => a.action_type === 'pause');
    
    // Limit to 10% of family ads
    const maxPause = Math.ceil(family.ad_actions.length * 0.1);
    const limitedPause = pauseActions.slice(0, maxPause);
    
    for (const action of limitedPause) {
      rows.push({
        row_number: rowNumber++,
        data: {
          'Ad ID': action.ad_id,
          'Ad status': 'Paused',
        },
        source_action_id: action.ad_id,
        notes: `HIGH RISK PAUSE | Issues: ${action.issue_codes.join(', ')} | ${action.justification}`,
      });
    }
  }
  
  const validation_messages: string[] = [];
  if (rows.length > 10) {
    validation_messages.push(`WARNING: Pausing ${rows.length} ads. Review carefully before import.`);
  }
  
  return {
    batch_number: 4,
    batch_name: 'pause-high-risk-ads',
    description: 'Pause obviously-bad assets',
    rows,
    validation_status: rows.length > 10 ? 'warning' : 'valid',
    validation_messages,
  };
}

/**
 * Generate CSV 005: Create trial ads
 */
function generateTrialAdsCSV(l2Output: L2PredictionOutput): CSVBatch {
  const rows: CSVRow[] = [];
  let rowNumber = 1;
  
  for (const family of l2Output.families) {
    for (const trial of family.trial_plans) {
      // Add control ads
      const controlAds = trial.control_ads || trial.controls || [];
      for (const control of controlAds) {
        if (control.creative) {
          rows.push(createTrialAdRow(
            rowNumber++,
            trial,
            control.creative.headlines,
            control.creative.descriptions,
            control.creative.final_url,
            control.label,
            true
          ));
        }
      }
      
      // Add variant ads
      const variantCreatives = trial.variant_creatives || trial.variants || trial.variant_ads || [];
      for (const variant of variantCreatives) {
        try {
          rows.push(createTrialAdRow(
            rowNumber++,
            trial,
            variant.headlines || [],
            variant.descriptions || [],
            variant.final_url || '',
            variant.variant_label || 'trial',
            false
          ));
        } catch (error) {
          console.warn(`Skipping malformed variant in trial ${trial.trial_group_name}:`, error);
        }
      }
    }
  }
  
  return {
    batch_number: 5,
    batch_name: 'create-trial-ads',
    description: 'Populate trial groups with controls and variants',
    rows,
    validation_status: 'valid',
    validation_messages: [],
  };
}

/**
 * Create a trial ad row
 */
function createTrialAdRow(
  rowNumber: number,
  trial: TrialPlan,
  headlines: string[],
  descriptions: string[],
  finalUrl: string | undefined,
  label: string,
  isControl: boolean
): CSVRow {
  const rowData: Record<string, string> = {
    Campaign: trial.original_campaign_name,
    'Ad group': trial.trial_group_name,
    'Ad type': 'Responsive search ad',
    'Ad status': 'Enabled',
    'Final URL': finalUrl || '',
  };
  
  // Add headlines
  for (let i = 0; i < headlines.length && i < 15; i++) {
    rowData[`Headline ${i + 1}`] = headlines[i];
  }
  
  // Add descriptions
  for (let i = 0; i < descriptions.length && i < 4; i++) {
    rowData[`Description ${i + 1}`] = descriptions[i];
  }
  
  return {
    row_number: rowNumber,
    data: rowData,
    source_trial_id: trial.trial_id,
    notes: `${isControl ? 'CONTROL' : 'VARIANT'}: ${label} | Hypothesis: ${trial.hypothesis}`,
  };
}

/**
 * Export CSV batch to string
 */
export function csvBatchToString(batch: CSVBatch): string {
  if (batch.rows.length === 0) {
    return ''; // Empty CSV
  }
  
  // Get all column names from all rows
  const columnSet = new Set<string>();
  for (const row of batch.rows) {
    Object.keys(row.data).forEach(col => columnSet.add(col));
  }
  const columns = Array.from(columnSet);
  
  // Create header row
  const lines: string[] = [columns.join(',')];
  
  // Create data rows
  for (const row of batch.rows) {
    const values = columns.map(col => {
      const value = row.data[col] || '';
      // Escape quotes and wrap in quotes if needed
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    });
    lines.push(values.join(','));
  }
  
  return lines.join('\n');
}
