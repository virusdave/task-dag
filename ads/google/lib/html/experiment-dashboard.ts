/**
 * Experiment Dashboard Generator
 * Creates visual HTML dashboard showing trial structure, hypotheses, and status
 */

import type { L2PredictionOutput, TrialPlan } from '../shared/types.js';

export interface ExperimentDashboardData {
  l2Runs: L2PredictionOutput[];
  trialStatuses?: Map<string, {
    status: string;
    serving_status: string;
    impressions: number;
    clicks: number;
    ctr: number;
    last_check: string;
  }>;
}

/**
 * Generate experiment dashboard HTML
 */
export function generateExperimentDashboard(data: ExperimentDashboardData): string {
  const allTrials = data.l2Runs.flatMap(run => 
    run.families.flatMap(family => 
      family.trial_plans.map(trial => ({
        run_id: run.run_id,
        family_key: family.family_key,
        trial,
      }))
    )
  );

  const totalTrials = allTrials.length;
  const totalVariants = allTrials.reduce((sum, t) => 
    sum + (t.trial.variants?.length || 0), 0
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Google Ads Experiment Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
      color: #333;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
      min-height: 100vh;
    }
    .container { 
      max-width: 1400px;
      margin: 0 auto;
    }
    .header {
      background: white;
      padding: 30px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      margin-bottom: 30px;
    }
    h1 { 
      font-size: 2.5em;
      color: #1a1a1a;
      margin-bottom: 10px;
    }
    .subtitle {
      font-size: 1.2em;
      color: #666;
      margin-bottom: 20px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }
    .stat-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-value {
      font-size: 3em;
      font-weight: bold;
      display: block;
      margin-bottom: 5px;
    }
    .stat-label {
      font-size: 0.9em;
      opacity: 0.9;
    }
    .experiments {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(450px, 1fr));
      gap: 20px;
    }
    .experiment-card {
      background: white;
      border-radius: 12px;
      padding: 25px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .experiment-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 30px rgba(0,0,0,0.15);
    }
    .experiment-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 15px;
      padding-bottom: 15px;
      border-bottom: 2px solid #f0f0f0;
    }
    .experiment-name {
      font-size: 1.3em;
      font-weight: 600;
      color: #2c3e50;
      flex: 1;
    }
    .experiment-badge {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.8em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-running { background: #c8e6c9; color: #2e7d32; }
    .badge-pending { background: #fff3cd; color: #856404; }
    .badge-complete { background: #e3f2fd; color: #1565c0; }
    .hypothesis {
      background: #f8f9fa;
      padding: 15px;
      border-left: 4px solid #667eea;
      border-radius: 4px;
      margin: 15px 0;
      font-style: italic;
    }
    .hypothesis-label {
      font-weight: 600;
      color: #667eea;
      text-transform: uppercase;
      font-size: 0.75em;
      letter-spacing: 1px;
      margin-bottom: 5px;
    }
    .policy-class {
      display: inline-block;
      background: #fff3e0;
      color: #e65100;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 0.85em;
      font-weight: 500;
      margin: 5px 0;
    }
    .trial-structure {
      margin: 20px 0;
    }
    .control-variant-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-top: 10px;
    }
    .control-box, .variant-box {
      padding: 12px;
      border-radius: 6px;
      font-size: 0.9em;
    }
    .control-box {
      background: #e8f5e9;
      border: 2px solid #4caf50;
    }
    .variant-box {
      background: #fff3e0;
      border: 2px solid #ff9800;
    }
    .box-header {
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.75em;
      letter-spacing: 1px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .control-icon { color: #4caf50; }
    .variant-icon { color: #ff9800; }
    .ad-snippet {
      background: white;
      padding: 8px;
      border-radius: 4px;
      margin-top: 5px;
      font-size: 0.85em;
      line-height: 1.4;
    }
    .success-criteria {
      background: #f3f4f6;
      padding: 12px;
      border-radius: 6px;
      margin-top: 15px;
      font-size: 0.85em;
    }
    .criteria-label {
      font-weight: 600;
      color: #374151;
      margin-bottom: 5px;
    }
    .criteria-list {
      list-style: none;
      padding-left: 0;
    }
    .criteria-list li:before {
      content: "✓ ";
      color: #10b981;
      font-weight: bold;
      margin-right: 5px;
    }
    .expected-insights {
      background: #fef3c7;
      padding: 12px;
      border-radius: 6px;
      margin-top: 10px;
      font-size: 0.85em;
    }
    .insights-label {
      font-weight: 600;
      color: #92400e;
      margin-bottom: 5px;
    }
    .trial-meta {
      display: flex;
      gap: 15px;
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid #e5e7eb;
      font-size: 0.85em;
      color: #6b7280;
    }
    .meta-item {
      display: flex;
      flex-direction: column;
    }
    .meta-label {
      font-weight: 600;
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .meta-value {
      color: #1f2937;
      font-weight: 500;
    }
    .timeline {
      background: white;
      padding: 30px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      margin-bottom: 30px;
    }
    .timeline h2 {
      font-size: 1.8em;
      margin-bottom: 20px;
      color: #1a1a1a;
    }
    .timeline-items {
      position: relative;
      padding-left: 30px;
    }
    .timeline-items:before {
      content: '';
      position: absolute;
      left: 10px;
      top: 0;
      bottom: 0;
      width: 2px;
      background: linear-gradient(to bottom, #667eea, #764ba2);
    }
    .timeline-item {
      position: relative;
      margin-bottom: 20px;
      padding-left: 20px;
    }
    .timeline-item:before {
      content: '';
      position: absolute;
      left: -25px;
      top: 5px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #667eea;
      border: 3px solid white;
      box-shadow: 0 0 0 2px #667eea;
    }
    .timeline-time {
      font-weight: 600;
      color: #667eea;
      font-size: 0.9em;
    }
    .timeline-desc {
      color: #4b5563;
      margin-top: 3px;
    }
    .philosophy {
      background: white;
      padding: 25px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      margin-bottom: 30px;
      border-left: 5px solid #667eea;
    }
    .philosophy h2 {
      font-size: 1.5em;
      color: #1a1a1a;
      margin-bottom: 15px;
    }
    .philosophy-text {
      color: #4b5563;
      line-height: 1.8;
    }
    .empty-state {
      background: white;
      padding: 60px;
      border-radius: 12px;
      text-align: center;
      color: #9ca3af;
    }
    .empty-state-icon {
      font-size: 4em;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🧪 Google Ads Experiment Dashboard</h1>
      <div class="subtitle">Three-Layer Agentic Optimization System</div>
      <div class="stats">
        <div class="stat-card">
          <span class="stat-value">${totalTrials}</span>
          <span class="stat-label">Active Experiments</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${totalVariants}</span>
          <span class="stat-label">Variant Ads</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${data.l2Runs.length}</span>
          <span class="stat-label">Analysis Runs</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">$${(totalTrials * 0.01).toFixed(2)}</span>
          <span class="stat-label">Daily Budget</span>
        </div>
      </div>
    </div>

    <div class="philosophy">
      <h2>🎯 Optimization Philosophy</h2>
      <div class="philosophy-text">
        <strong>Multi-Objective:</strong> (limitation_avoidance × user_clarity × performance)<br>
        <strong>Approach:</strong> Hill-climbing through systematic experimentation<br>
        <strong>Method:</strong> Learn Google's opaque policy enforcement through controlled trials<br>
        <strong>Constraints:</strong> White-/grey-hat alignment — no deception, nearby strategy search for compliance
      </div>
    </div>

    <div class="timeline">
      <h2>📅 Experiment Timeline</h2>
      <div class="timeline-items">
        <div class="timeline-item">
          <div class="timeline-time">T+0hr: Trial Creation</div>
          <div class="timeline-desc">Create trial ad groups with controls + variants, $0.01/day budget</div>
        </div>
        <div class="timeline-item">
          <div class="timeline-time">T+1hr: First Check</div>
          <div class="timeline-desc">Check serving status — did Google disapprove/limit immediately?</div>
        </div>
        <div class="timeline-item">
          <div class="timeline-time">T+4hr: Early Performance</div>
          <div class="timeline-desc">Check impressions/clicks — are variants getting traffic?</div>
        </div>
        <div class="timeline-item">
          <div class="timeline-time">T+24hr: Policy + Performance</div>
          <div class="timeline-desc">Evaluate both compliance AND effectiveness vs control</div>
        </div>
        <div class="timeline-item">
          <div class="timeline-time">T+48hr: Final Decision</div>
          <div class="timeline-desc">Final check, record outcomes, remove trial ads completely</div>
        </div>
        <div class="timeline-item">
          <div class="timeline-time">Weekly: L3 Meta-Learning</div>
          <div class="timeline-desc">Analyze all trial outcomes, update predictions, improve over time</div>
        </div>
      </div>
    </div>

    <h2 style="color: white; font-size: 2em; margin: 30px 0 20px;">🔬 Active Experiments</h2>
    
    ${totalTrials === 0 ? `
      <div class="empty-state">
        <div class="empty-state-icon">🔬</div>
        <h3>No Active Experiments</h3>
        <p style="margin-top: 10px;">Run the L2 analysis pipeline to generate trial experiments.</p>
        <code style="display: block; margin-top: 20px; padding: 10px; background: #f3f4f6; border-radius: 4px;">
          npx tsx scripts/run-analysis.ts --snapshot snapshots/latest.jsonl
        </code>
      </div>
    ` : `
      <div class="experiments">
        ${allTrials.map((item, idx) => generateExperimentCard(item, idx, data.trialStatuses)).join('\n')}
      </div>
    `}
  </div>
</body>
</html>`;
}

/**
 * Generate individual experiment card
 */
function generateExperimentCard(
  item: { run_id: string; family_key: any; trial: TrialPlan },
  index: number,
  statuses?: Map<string, any>
): string {
  const trial = item.trial;
  const familyName = formatFamilyName(item.family_key);
  const status = statuses?.get(trial.trial_group_name || '');
  const statusBadge = status ? 'running' : 'pending';
  
  const controls = trial.controls || trial.control_ads || [];
  const variants = trial.variants || trial.variant_creatives || trial.variant_ads || [];

  return `
    <div class="experiment-card">
      <div class="experiment-header">
        <div class="experiment-name">${trial.trial_group_name || `Trial ${index + 1}`}</div>
        <span class="experiment-badge badge-${statusBadge}">${statusBadge}</span>
      </div>
      
      <div style="color: #6b7280; font-size: 0.9em; margin-bottom: 10px;">
        Family: <strong>${familyName}</strong>
      </div>

      <div class="policy-class">
        📋 Testing: ${trial.policy_class_being_probed || trial.policy_class_probed || 'General Policy'}
      </div>

      <div class="hypothesis">
        <div class="hypothesis-label">💡 Hypothesis</div>
        ${trial.hypothesis || 'No hypothesis specified'}
      </div>

      <div class="trial-structure">
        <div style="font-weight: 600; margin-bottom: 10px; color: #374151;">Trial Structure</div>
        <div class="control-variant-grid">
          <div class="control-box">
            <div class="box-header">
              <span class="control-icon">✓</span>
              Control (${Array.isArray(controls) ? controls.length : 0})
            </div>
            ${formatAdList(controls, 'control')}
          </div>
          <div class="variant-box">
            <div class="box-header">
              <span class="variant-icon">🧪</span>
              Variants (${Array.isArray(variants) ? variants.length : 0})
            </div>
            ${formatAdList(variants, 'variant')}
          </div>
        </div>
      </div>

      ${trial.success_criteria ? `
        <div class="success-criteria">
          <div class="criteria-label">🎯 Success Criteria</div>
          <ul class="criteria-list">
            <li>Serve for ${trial.success_criteria.time_window_days || 2} days minimum</li>
            <li>Maintain ≥${(trial.success_criteria.min_ctr_ratio || 0.8) * 100}% of control CTR</li>
            <li>Maintain ≥${(trial.success_criteria.min_conversion_rate_ratio || 0.8) * 100}% of control conversion rate</li>
            <li>Allowed serving: ${(trial.success_criteria.allowed_serving_statuses || ['eligible']).join(', ')}</li>
          </ul>
        </div>
      ` : ''}

      ${trial.expected_insights ? `
        <div class="expected-insights">
          <div class="insights-label">🔍 Expected Insights</div>
          ${trial.expected_insights}
        </div>
      ` : ''}

      <div class="trial-meta">
        <div class="meta-item">
          <span class="meta-label">Budget</span>
          <span class="meta-value">$${(trial.budget || trial.trial_budget_usd || 0.01).toFixed(2)}/day</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Duration</span>
          <span class="meta-value">${trial.success_criteria?.time_window_days || 2} days</span>
        </div>
        ${status ? `
          <div class="meta-item">
            <span class="meta-label">Impressions</span>
            <span class="meta-value">${status.impressions || 0}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">CTR</span>
            <span class="meta-value">${((status.ctr || 0) * 100).toFixed(2)}%</span>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

/**
 * Format family key as readable name
 */
function formatFamilyName(key: any): string {
  const parts = [];
  if (key.account_id) parts.push(key.account_id.substring(0, 8));
  if (key.creative_theme) parts.push(key.creative_theme);
  if (key.product_tag) parts.push(key.product_tag);
  if (key.geo_target) parts.push(key.geo_target);
  if (key.campaign_name) parts.push(key.campaign_name);
  return parts.join(' / ') || 'Unknown Family';
}

/**
 * Format ad list (controls or variants)
 */
function formatAdList(ads: any[], type: 'control' | 'variant'): string {
  if (!Array.isArray(ads) || ads.length === 0) {
    return `<div style="color: #9ca3af; font-style: italic;">None</div>`;
  }

  return ads.map((ad: any) => {
    // Handle different formats
    let text = '';
    if (typeof ad === 'string') {
      text = ad;
    } else if (ad.creative) {
      const h = ad.creative.headlines?.[0] || '';
      const d = ad.creative.descriptions?.[0] || '';
      text = `${h} | ${d}`;
    } else if (ad.headlines) {
      text = `${ad.headlines[0] || ''} | ${ad.descriptions?.[0] || ''}`;
    } else if (ad.text) {
      text = ad.text;
    }
    
    return `<div class="ad-snippet">${text || '[Ad content]'}</div>`;
  }).join('');
}
