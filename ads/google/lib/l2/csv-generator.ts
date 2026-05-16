/**
 * L2: CSV Generator
 * Generates numbered CSV files (001-005) for Ads Editor import
 */

import type {
  L2PredictionOutput,
  FamilyPrediction,
  AdAction,
  TrialPlan,
  CSVBatch,
  CSVRow,
} from '../shared/types.js';

/**
 * Generate all CSV batches from L2 output
 */
export function generateCSVBatches(l2Output: L2PredictionOutput): CSVBatch[] {
  const batches: CSVBatch[] = [];
  
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
  
  return batches;
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
