/**
 * HTML Review Packet Generator
 * Creates human-readable HTML review interface
 */

import type {
  L2PredictionOutput,
  HTMLPacket,
  ExecutiveSummary,
  GlobalOverview,
  CampaignSection,
} from '../shared/types.js';
import { formatFamilyKey, createAdSnippet, percentage, round } from '../shared/utils.js';

/**
 * Generate complete HTML packet
 */
export function generateHTMLPacket(
  l2Output: L2PredictionOutput,
  snapshotDate: string
): string {
  const packet = buildHTMLPacketData(l2Output, snapshotDate);
  return renderHTMLPacket(packet);
}

/**
 * Build HTML packet data structure
 */
function buildHTMLPacketData(
  l2Output: L2PredictionOutput,
  snapshotDate: string
): HTMLPacket {
  const execSummary = buildExecutiveSummary(l2Output);
  const globalOverview = buildGlobalOverview(l2Output);
  const campaignSections = buildCampaignSections(l2Output);
  
  return {
    run_id: l2Output.run_id,
    snapshot_date: snapshotDate,
    title: `Google Ads Content Optimization – ${snapshotDate}`,
    executive_summary: execSummary,
    global_overview: globalOverview,
    campaign_sections: campaignSections,
    issue_taxonomy: buildIssueTaxonomy(),
    technical_appendix: {
      l1_config_version: l2Output.l1_config_version,
      l2_prompt_version: l2Output.l2_prompt_version,
      l1_feature_summary: 'See technical appendix section',
      l2_rationale_summary: 'See per-family rationales',
      trial_labels: [],
    },
    generated_at: new Date().toISOString(),
  };
}

/**
 * Build executive summary
 */
function buildExecutiveSummary(l2Output: L2PredictionOutput): ExecutiveSummary {
  let totalCampaigns = new Set<string>();
  let totalAds = 0;
  let limitedDisapprovedAds = 0;
  let highRiskFamilies = 0;
  let repairActions = 0;
  let replacementActions = 0;
  let trialGroups = 0;
  
  for (const family of l2Output.families) {
    if (family.family_key.campaign_name) {
      totalCampaigns.add(family.family_key.campaign_name);
    }
    
    totalAds += family.ad_actions.length;
    
    if (family.family_risk === 'high') {
      highRiskFamilies++;
    }
    
    for (const action of family.ad_actions) {
      if (action.action_type === 'repair') repairActions++;
      if (action.action_type === 'replace') replacementActions++;
    }
    
    trialGroups += family.trial_plans.length;
  }
  
  const pct = round(percentage(limitedDisapprovedAds, totalAds), 1);
  
  return {
    total_campaigns: totalCampaigns.size,
    total_ads: totalAds,
    limited_disapproved_ads: limitedDisapprovedAds,
    limited_disapproved_pct: pct,
    high_risk_families: highRiskFamilies,
    repair_actions: repairActions,
    replacement_actions: replacementActions,
    trial_groups: trialGroups,
    checklist: [
      'Skim the summary tables below',
      'Review per-campaign recommendations',
      'If acceptable, import CSVs 001→005 in Ads Editor sequentially',
      `Monitor trial groups with labels FB_POLICY_PROBE_*`,
    ],
  };
}

/**
 * Build global overview
 */
function buildGlobalOverview(l2Output: L2PredictionOutput): GlobalOverview {
  return {
    families: l2Output.families.map((family, idx) => ({
      family_key: family.family_key,
      family_risk: family.family_risk,
      limited_disapproved_count: 0,
      repair_count: family.ad_actions.filter(a => a.action_type === 'repair').length,
      replacement_count: family.ad_actions.filter(a => a.action_type === 'replace').length,
      trial_count: family.trial_plans.length,
      anchor_id: `family-${idx}`,
    })),
  };
}

/**
 * Build campaign sections
 */
function buildCampaignSections(l2Output: L2PredictionOutput): CampaignSection[] {
  return l2Output.families.map(family => ({
    campaign_name: family.family_key.campaign_name || formatFamilyKey(family.family_key),
    family_key: family.family_key,
    summary: {
      risk_level: family.family_risk,
      main_issues: family.issues.map(i => i.issue_description),
    },
    policy_snapshot: [],
    repair_actions: family.ad_actions
      .filter(a => a.action_type === 'repair')
      .map(a => ({
        ad_group: '',
        ad_id: a.ad_id,
        issue_codes: a.issue_codes,
        csv_ref: `002:${a.csv_row_number || '?'}`,
      })),
    replacement_actions: family.ad_actions
      .filter(a => a.action_type === 'replace')
      .map(a => ({
        ad_group: '',
        ad_id: a.ad_id,
        issue_codes: a.issue_codes,
        csv_ref: `003:${a.csv_row_number || '?'}`,
      })),
    pause_actions: family.ad_actions
      .filter(a => a.action_type === 'pause')
      .map(a => ({
        ad_group: '',
        ad_id: a.ad_id,
        issue_codes: a.issue_codes,
        csv_ref: `004:${a.csv_row_number || '?'}`,
      })),
    trial_plans: (family.trial_plans || []).map(trial => ({
      trial_name: trial.trial_group_name,
      hypothesis: trial.hypothesis,
      controls: (trial.control_ads || trial.controls || []).map((c: any) => ({
        label: c.label,
        snippet: c.creative ? createAdSnippet(c.creative.headlines, c.creative.descriptions) : '',
      })),
      variants: (trial.variant_creatives || trial.variants || []).map((v: any) => ({
        label: v.variant_label || v.label || 'variant',
        snippet: createAdSnippet(v.headlines || [], v.descriptions || []),
      })),
      budget: trial.trial_budget_usd,
      expected_run_time: `${trial.success_criteria.time_window_days || 7} days`,
      policy_questions: [trial.policy_class_being_probed],
      csv_refs: ['001:?', '005:?'],
    })),
  }));
}

/**
 * Build issue taxonomy
 */
function buildIssueTaxonomy() {
  return {
    risk_definitions: {
      high: 'High probability of limitation/disapproval based on observed patterns',
      medium: 'Moderate risk, borderline patterns detected',
      low: 'Low risk, compliant patterns',
    },
    white_grey_hat_constraints: 'All recommendations maintain white-/grey-hat alignment: no deception, policy evasion, or classifier-only tricks.',
    issue_codes: [
      {
        code: 'MEDICAL_CLAIM',
        description: 'Implied medical claims without proper disclaimers',
        example_fixes: ['Add disclaimers', 'Use educational framing', 'Soften claims'],
      },
      {
        code: 'URGENCY_OVERLOAD',
        description: 'Excessive urgency language',
        example_fixes: ['Reduce urgency keywords', 'Use softer CTAs'],
      },
    ],
  };
}

/**
 * Render HTML packet to string
 */
function renderHTMLPacket(packet: HTMLPacket): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${packet.title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #333; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 40px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { font-size: 2em; margin-bottom: 10px; color: #1a1a1a; }
    h2 { font-size: 1.5em; margin: 30px 0 15px; padding-bottom: 10px; border-bottom: 2px solid #4CAF50; color: #2c3e50; }
    h3 { font-size: 1.2em; margin: 20px 0 10px; color: #34495e; }
    .metadata { color: #666; margin-bottom: 20px; font-size: 0.9em; }
    .exec-summary { background: #e8f5e9; padding: 20px; border-radius: 8px; margin: 20px 0; }
    .metric { display: inline-block; margin: 10px 20px 10px 0; }
    .metric-value { font-size: 2em; font-weight: bold; color: #4CAF50; display: block; }
    .metric-label { font-size: 0.9em; color: #666; }
    .checklist { list-style: none; margin: 15px 0; }
    .checklist li:before { content: "✓ "; color: #4CAF50; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f8f9fa; font-weight: 600; color: #495057; }
    .risk-high { color: #d32f2f; font-weight: bold; }
    .risk-medium { color: #f57c00; font-weight: bold; }
    .risk-low { color: #388e3c; font-weight: bold; }
    .trial { background: #fff3e0; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #ff9800; }
    .action { background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 4px; }
    .csv-ref { font-family: monospace; background: #263238; color: #aed581; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${packet.title}</h1>
    <div class="metadata">
      Run ID: ${packet.run_id} | Snapshot: ${packet.snapshot_date} | Generated: ${new Date(packet.generated_at).toLocaleString()}
    </div>
    
    <div class="exec-summary">
      <h2>Executive Summary</h2>
      <div>
        <div class="metric">
          <span class="metric-value">${packet.executive_summary.total_campaigns}</span>
          <span class="metric-label">Campaigns</span>
        </div>
        <div class="metric">
          <span class="metric-value">${packet.executive_summary.high_risk_families}</span>
          <span class="metric-label">High Risk Families</span>
        </div>
        <div class="metric">
          <span class="metric-value">${packet.executive_summary.repair_actions}</span>
          <span class="metric-label">Repairs</span>
        </div>
        <div class="metric">
          <span class="metric-value">${packet.executive_summary.replacement_actions}</span>
          <span class="metric-label">Replacements</span>
        </div>
        <div class="metric">
          <span class="metric-value">${packet.executive_summary.trial_groups}</span>
          <span class="metric-label">Trial Groups</span>
        </div>
      </div>
      <h3>What to Do</h3>
      <ul class="checklist">
        ${packet.executive_summary.checklist.map(item => `<li>${item}</li>`).join('')}
      </ul>
    </div>
    
    <h2>Global Overview</h2>
    <table>
      <thead>
        <tr>
          <th>Family</th>
          <th>Risk</th>
          <th>Repairs</th>
          <th>Replacements</th>
          <th>Trials</th>
        </tr>
      </thead>
      <tbody>
        ${packet.global_overview.families.map(f => `
          <tr>
            <td><a href="#${f.anchor_id}">${formatFamilyKey(f.family_key)}</a></td>
            <td class="risk-${f.family_risk}">${f.family_risk.toUpperCase()}</td>
            <td>${f.repair_count}</td>
            <td>${f.replacement_count}</td>
            <td>${f.trial_count}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    
    ${packet.campaign_sections.map((section, idx) => `
      <div id="family-${idx}">
        <h2>${section.campaign_name}</h2>
        <p><strong>Risk Level:</strong> <span class="risk-${section.summary.risk_level}">${section.summary.risk_level.toUpperCase()}</span></p>
        <p><strong>Main Issues:</strong> ${section.summary.main_issues.join(', ') || 'None'}</p>
        
        ${section.repair_actions.length > 0 ? `
          <h3>Repair Actions (CSV 002)</h3>
          ${section.repair_actions.map(a => `
            <div class="action">
              <strong>Ad ID:</strong> ${a.ad_id} | 
              <strong>Issues:</strong> ${a.issue_codes.join(', ')} | 
              <span class="csv-ref">${a.csv_ref}</span>
            </div>
          `).join('')}
        ` : ''}
        
        ${section.replacement_actions.length > 0 ? `
          <h3>Replacement Actions (CSV 003)</h3>
          ${section.replacement_actions.map(a => `
            <div class="action">
              <strong>Ad ID:</strong> ${a.ad_id} | 
              <strong>Issues:</strong> ${a.issue_codes.join(', ')} | 
              <span class="csv-ref">${a.csv_ref}</span>
            </div>
          `).join('')}
        ` : ''}
        
        ${section.pause_actions.length > 0 ? `
          <div class="warning">
            <h3>⚠️ Pause Actions (CSV 004) - Review Carefully</h3>
            ${section.pause_actions.map(a => `
              <div class="action">
                <strong>Ad ID:</strong> ${a.ad_id} | 
                <strong>Issues:</strong> ${a.issue_codes.join(', ')} | 
                <span class="csv-ref">${a.csv_ref}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        
        ${section.trial_plans.map(trial => `
          <div class="trial">
            <h3>${trial.trial_name}</h3>
            <p><strong>Hypothesis:</strong> ${trial.hypothesis}</p>
            <p><strong>Budget:</strong> $${trial.budget}/day | <strong>Run Time:</strong> ${trial.expected_run_time}</p>
            <p><strong>Policy Question:</strong> ${trial.policy_questions.join(', ')}</p>
            <p><strong>CSV Refs:</strong> ${trial.csv_refs.map(r => `<span class="csv-ref">${r}</span>`).join(' ')}</p>
          </div>
        `).join('')}
      </div>
    `).join('')}
    
    <h2>Issue Taxonomy</h2>
    <h3>Risk Definitions</h3>
    <ul>
      ${Object.entries(packet.issue_taxonomy.risk_definitions).map(([level, def]) => 
        `<li><strong>${level.toUpperCase()}:</strong> ${def}</li>`
      ).join('')}
    </ul>
    <p><strong>Constraints:</strong> ${packet.issue_taxonomy.white_grey_hat_constraints}</p>
    
  </div>
</body>
</html>`;
}
