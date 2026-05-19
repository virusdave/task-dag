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
import { safeRender, safeText, safeToken, escapeHtml } from './safe-render.js';

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
 *
 * Every read off l2Output is wrapped in asArray() / optional
 * chaining so a malformed/mock L2 payload (missing arrays, null
 * keys, etc.) can't throw — it just degrades to a zero count.
 */
function buildExecutiveSummary(l2Output: L2PredictionOutput): ExecutiveSummary {
  const families = asArray<any>((l2Output as any)?.families);
  const familyKeys = new Set<string>();
  let totalAds = 0;
  let limitedDisapprovedAds = 0;
  let highRiskFamilies = 0;
  let repairActions = 0;
  let replacementActions = 0;
  let trialGroups = 0;

  for (const family of families) {
    const key = formatFamilyKey((family?.family_key ?? {}) as any);
    if (key && key !== 'unknown') familyKeys.add(key);

    const actions = asArray<any>(family?.ad_actions);
    totalAds += actions.length;

    if (family?.family_risk === 'high') {
      highRiskFamilies++;
    }

    for (const action of actions) {
      if (action?.action_type === 'repair') repairActions++;
      if (action?.action_type === 'replace') replacementActions++;
    }

    trialGroups += asArray(family?.trial_plans).length;
  }

  const pct = round(percentage(limitedDisapprovedAds, totalAds), 1);

  // Build a checklist that only references CSV batches the bundle
  // will actually contain, so the operator isn't told to import
  // CSVs that don't exist.
  const csvBatches: number[] = [];
  if (trialGroups > 0) csvBatches.push(1, 5);
  if (repairActions > 0) csvBatches.push(2);
  if (replacementActions > 0) csvBatches.push(3);
  const csvList = csvBatches.length > 0
    ? csvBatches.sort((a, b) => a - b).map((n) => String(n).padStart(3, '0')).join(', ')
    : null;

  return {
    total_campaigns: familyKeys.size,
    total_ads: totalAds,
    limited_disapproved_ads: limitedDisapprovedAds,
    limited_disapproved_pct: pct,
    high_risk_families: highRiskFamilies,
    repair_actions: repairActions,
    replacement_actions: replacementActions,
    trial_groups: trialGroups,
    checklist: [
      'Skim the executive summary above',
      'Tap each family below for per-family recommendations',
      csvList
        ? `If acceptable, import CSV batches ${csvList} into Ads Editor (in numeric order)`
        : 'No CSV batches generated this run — review-only',
      `Monitor trial groups with labels FB_POLICY_PROBE_*`,
    ],
  };
}

/**
 * Build global overview
 */
function buildGlobalOverview(l2Output: L2PredictionOutput): GlobalOverview {
  const families = asArray<any>((l2Output as any)?.families);
  return {
    families: families.map((family, idx) => {
      const actions = asArray<any>(family?.ad_actions);
      return {
        family_key: family?.family_key,
        family_risk: family?.family_risk,
        limited_disapproved_count: 0,
        repair_count: actions.filter((a) => a?.action_type === 'repair').length,
        replacement_count: actions.filter((a) => a?.action_type === 'replace').length,
        trial_count: asArray(family?.trial_plans).length,
        anchor_id: `family-${idx}`,
      };
    }),
  };
}

/**
 * Format a csv row reference like `002:14`. If row is missing or
 * malformed, falls back to `002:?` so we never emit something
 * like `002:[object Object]` from a stringified non-number.
 */
function formatCsvRef(batch: string, row: unknown): string {
  const n = Number(row);
  return Number.isFinite(n) && n > 0 ? `${batch}:${Math.trunc(n)}` : `${batch}:?`;
}

/**
 * Build campaign sections
 *
 * Robust against partial / malformed family payloads: every nested
 * read is guarded, every array is asArray()'d.
 */
function buildCampaignSections(l2Output: L2PredictionOutput): CampaignSection[] {
  const families = asArray<any>((l2Output as any)?.families);
  return families.map((family) => {
    const fkey = (family?.family_key ?? {}) as any;
    const actions = asArray<any>(family?.ad_actions);
    const issues = asArray<any>(family?.issues);
    const trials = asArray<any>(family?.trial_plans);
    return {
      campaign_name: fkey.campaign_name || formatFamilyKey(fkey),
      family_key: fkey,
      summary: {
        risk_level: family?.family_risk,
        main_issues: issues.map((i) => i?.issue_description),
      },
      policy_snapshot: [],
      repair_actions: actions
        .filter((a) => a?.action_type === 'repair')
        .map((a) => ({
          ad_group: '',
          ad_id: a?.ad_id,
          issue_codes: asArray(a?.issue_codes),
          csv_ref: formatCsvRef('002', a?.csv_row_number),
        })),
      replacement_actions: actions
        .filter((a) => a?.action_type === 'replace')
        .map((a) => ({
          ad_group: '',
          ad_id: a?.ad_id,
          issue_codes: asArray(a?.issue_codes),
          csv_ref: formatCsvRef('003', a?.csv_row_number),
        })),
      pause_actions: actions
        .filter((a) => a?.action_type === 'pause')
        .map((a) => ({
          ad_group: '',
          ad_id: a?.ad_id,
          issue_codes: asArray(a?.issue_codes),
          csv_ref: formatCsvRef('004', a?.csv_row_number),
        })),
      trial_plans: trials.map((trial) => {
        const successCriteria = (trial?.success_criteria ?? {}) as any;
        const days = Number(successCriteria.time_window_days);
        const runDays = Number.isFinite(days) && days > 0 ? days : 7;
        const budget = Number(trial?.trial_budget_usd);
        return {
          trial_name: trial?.trial_group_name,
          hypothesis: trial?.hypothesis,
          controls: asArray<any>(trial?.control_ads || trial?.controls).map((c) => ({
            label: c?.label,
            snippet: c?.creative
              ? createAdSnippet(asArray(c.creative?.headlines), asArray(c.creative?.descriptions))
              : '',
          })),
          variants: asArray<any>(trial?.variant_creatives || trial?.variants).map((v) => ({
            label: v?.variant_label || v?.label || 'variant',
            snippet: createAdSnippet(asArray(v?.headlines), asArray(v?.descriptions)),
          })),
          budget: Number.isFinite(budget) ? budget : undefined,
          expected_run_time: `${runDays} days`,
          policy_questions: trial?.policy_class_being_probed
            ? [trial.policy_class_being_probed]
            : [],
          csv_refs: ['001:?', '005:?'],
        };
      }),
    };
  });
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

// ----------------------------------------------------------------------
// Render helpers — all interpolations route through safe-render so the
// packet never shows '[object Object]' or bare 'undefined' even when
// the L2 LLM (or mock fallback) produces malformed data.
// ----------------------------------------------------------------------

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const formatDateTime = (value: unknown): string => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toLocaleString();
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return '—';
};

const riskClass = (risk: unknown): string => `risk-${safeToken(risk, 'unknown')}`;

const riskLabel = (risk: unknown): string => {
  if (typeof risk !== 'string' || risk.trim() === '') return safeText(risk);
  return escapeHtml(risk.toUpperCase());
};

function renderRiskBadge(risk: unknown): string {
  return `<span class="risk-badge ${riskClass(risk)}">${riskLabel(risk)}</span>`;
}

function renderCsvChip(ref: unknown): string {
  return `<span class="csv-ref">${safeText(ref)}</span>`;
}

function renderActionCard(action: unknown): string {
  const a = (action ?? {}) as Record<string, unknown>;
  const issues = asArray(a.issue_codes);
  return `
    <div class="action-card">
      <div class="action-row"><span class="kv-key">Ad ID</span><span class="kv-val">${safeText(a.ad_id)}</span></div>
      <div class="action-row"><span class="kv-key">Issues</span><span class="kv-val">${safeRender(issues, { mode: 'inline' })}</span></div>
      <div class="action-row"><span class="kv-key">CSV</span><span class="kv-val">${renderCsvChip(a.csv_ref)}</span></div>
    </div>`;
}

function renderActionGroup(label: string, csvLabel: string, actions: unknown, tone: 'neutral' | 'warning'): string {
  const list = asArray(actions);
  if (list.length === 0) return '';
  const toneClass = tone === 'warning' ? 'group warning' : 'group';
  return `
    <section class="${toneClass}">
      <h3 class="group-title">${safeText(label)} <span class="group-meta">${safeText(csvLabel)}</span> <span class="count-pill">${list.length}</span></h3>
      <div class="action-list">${list.map((a) => renderActionCard(a)).join('')}</div>
    </section>`;
}

function renderTrialCard(trial: unknown): string {
  const t = (trial ?? {}) as Record<string, unknown>;
  const refs = asArray(t.csv_refs);
  const budgetNum = typeof t.budget === 'number' && Number.isFinite(t.budget) ? t.budget : null;
  const budgetText = budgetNum !== null ? `$${budgetNum}/day` : '—';
  return `
    <article class="trial-card">
      <h3 class="trial-name">${safeText(t.trial_name)}</h3>
      <dl class="kv-grid">
        <dt>Hypothesis</dt><dd>${safeRender(t.hypothesis, { mode: 'auto' })}</dd>
        <dt>Budget</dt><dd>${escapeHtml(budgetText)}</dd>
        <dt>Run time</dt><dd>${safeText(t.expected_run_time)}</dd>
        <dt>Policy question</dt><dd>${safeRender(t.policy_questions, { mode: 'auto' })}</dd>
        <dt>CSV refs</dt><dd class="chip-row">${refs.length > 0 ? refs.map((r) => renderCsvChip(r)).join(' ') : '—'}</dd>
      </dl>
    </article>`;
}

function renderFamilyDetails(section: unknown, idx: number): string {
  const s = (section ?? {}) as Record<string, unknown>;
  const summary = (s.summary ?? {}) as Record<string, unknown>;
  const risk = summary.risk_level;
  const repairCount = asArray(s.repair_actions).length;
  const replaceCount = asArray(s.replacement_actions).length;
  const pauseCount = asArray(s.pause_actions).length;
  const trialCount = asArray(s.trial_plans).length;
  // Only the first family is auto-expanded so the operator isn't
  // dumped into a scroll wall of expanded high-risk panels on a
  // small screen. They can tap any other card to expand it.
  const isOpen = idx === 0;
  return `
    <details id="family-${idx}" class="family-card" ${isOpen ? 'open' : ''}>
      <summary class="family-summary">
        <span class="family-name">${safeText(s.campaign_name)}</span>
        <span class="family-meta">
          ${renderRiskBadge(risk)}
          ${repairCount > 0 ? `<span class="count-pill repair"><span class="sr-only">${repairCount} repair actions</span><span aria-hidden="true">${repairCount}R</span></span>` : ''}
          ${replaceCount > 0 ? `<span class="count-pill replace"><span class="sr-only">${replaceCount} replacement actions</span><span aria-hidden="true">${replaceCount}X</span></span>` : ''}
          ${pauseCount > 0 ? `<span class="count-pill pause"><span class="sr-only">${pauseCount} pause actions</span><span aria-hidden="true">${pauseCount}P</span></span>` : ''}
          ${trialCount > 0 ? `<span class="count-pill trial"><span class="sr-only">${trialCount} trial plans</span><span aria-hidden="true">${trialCount}T</span></span>` : ''}
        </span>
      </summary>
      <div class="family-body">
        <dl class="kv-grid">
          <dt>Risk</dt><dd>${renderRiskBadge(risk)}</dd>
          <dt>Main issues</dt><dd>${safeRender(summary.main_issues, { mode: 'auto' })}</dd>
        </dl>
        ${renderActionGroup('Repair actions', 'CSV 002', s.repair_actions, 'neutral')}
        ${renderActionGroup('Replacement actions', 'CSV 003', s.replacement_actions, 'neutral')}
        ${renderActionGroup('Pause actions — review carefully', 'CSV 004', s.pause_actions, 'warning')}
        ${asArray(s.trial_plans).length > 0 ? `
          <section class="group">
            <h3 class="group-title">Trial plans <span class="group-meta">CSV 001 / 005</span> <span class="count-pill">${trialCount}</span></h3>
            <div class="trial-list">${asArray(s.trial_plans).map((t) => renderTrialCard(t)).join('')}</div>
          </section>` : ''}
      </div>
    </details>`;
}

/**
 * Render HTML packet to string. Mobile-first; every value flows
 * through safe-render so undefineds/objects/arrays of objects
 * degrade gracefully instead of producing '[object Object]'.
 */
function renderHTMLPacket(packet: HTMLPacket): string {
  const exec = (packet.executive_summary ?? {}) as Record<string, unknown>;
  const overviewFamilies = asArray((packet.global_overview ?? {} as any).families);
  const sections = asArray(packet.campaign_sections);
  const taxonomy = (packet.issue_taxonomy ?? {}) as Record<string, unknown>;
  const riskDefs = (taxonomy.risk_definitions ?? {}) as Record<string, unknown>;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>${safeText(packet.title)}</title>
  <style>
    :root {
      --bg: #f7f7f8;
      --surface: #ffffff;
      --surface-2: #f1f3f5;
      --text: #1a1a1a;
      --text-muted: #5f6b76;
      --border: #e4e7ea;
      --accent: #2e7d32;
      --accent-fg: #ffffff;
      --high: #c62828;
      --medium: #ef6c00;
      --low: #2e7d32;
      --warn-bg: #fff8e1;
      --warn-border: #f9a825;
      --chip-bg: #1f2933;
      --chip-fg: #c5e1a5;
      --radius: 10px;
      --tap: 44px;
      --max-w: 760px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1115;
        --surface: #181b21;
        --surface-2: #1f242c;
        --text: #f0f2f5;
        --text-muted: #9aa4ad;
        --border: #2a2f37;
        --accent: #66bb6a;
        --accent-fg: #0f1115;
        --high: #ef9a9a;
        --medium: #ffb74d;
        --low: #a5d6a7;
        --warn-bg: #3a2f10;
        --warn-border: #ffb300;
        --chip-bg: #0c1116;
        --chip-fg: #c5e1a5;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.5;
      color: var(--text);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
      -webkit-text-size-adjust: 100%;
    }
    a { color: inherit; }
    .sticky-header {
      position: sticky; top: 0; z-index: 20;
      background: color-mix(in srgb, var(--surface) 92%, transparent);
      backdrop-filter: saturate(140%) blur(8px);
      -webkit-backdrop-filter: saturate(140%) blur(8px);
      border-bottom: 1px solid var(--border);
      padding: env(safe-area-inset-top, 0) clamp(12px, 4vw, 24px) 10px;
    }
    .sticky-header .title {
      font-size: clamp(1.05rem, 4.2vw, 1.5rem);
      font-weight: 700;
      margin: 12px 0 4px;
      line-height: 1.2;
      color: var(--text);
    }
    h1.title { padding: 0; }
    .sticky-header .meta {
      display: flex; flex-wrap: wrap; gap: 6px 12px;
      font-size: 0.78rem; color: var(--text-muted);
    }
    .container {
      max-width: var(--max-w);
      margin: 0 auto;
      padding: clamp(12px, 4vw, 24px);
      padding-bottom: max(24px, env(safe-area-inset-bottom, 0));
    }
    h2 { font-size: clamp(1.05rem, 4vw, 1.3rem); margin: 20px 0 10px; color: var(--text); }
    h3 { font-size: clamp(0.95rem, 3.6vw, 1.1rem); margin: 14px 0 8px; color: var(--text); }
    p  { margin: 6px 0; }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: clamp(12px, 3vw, 18px);
      margin: 12px 0;
    }
    .panel.warning { background: var(--warn-bg); border-color: var(--warn-border); }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 10px;
      margin: 8px 0 4px;
    }
    .metric {
      background: var(--surface-2);
      border-radius: 8px;
      padding: 10px 12px;
      text-align: left;
    }
    .metric-value { font-size: 1.6rem; font-weight: 700; color: var(--accent); display: block; line-height: 1.1; }
    .metric-label { font-size: 0.78rem; color: var(--text-muted); display: block; margin-top: 2px; }
    .checklist { list-style: none; margin: 6px 0; padding-left: 0; }
    .checklist li {
      padding: 6px 0 6px 22px;
      position: relative;
      border-bottom: 1px solid var(--border);
    }
    .checklist li:last-child { border-bottom: none; }
    .checklist li:before {
      content: "✓";
      color: var(--accent);
      font-weight: 700;
      position: absolute;
      left: 0;
      top: 6px;
    }
    .family-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin: 10px 0;
      overflow: hidden;
    }
    .family-summary {
      list-style: none;
      cursor: pointer;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: var(--tap);
      align-items: flex-start;
    }
    .family-summary::-webkit-details-marker { display: none; }
    .family-summary::after {
      content: "▸";
      color: var(--text-muted);
      font-size: 0.9rem;
      align-self: flex-end;
      margin-top: -22px;
      transition: transform 0.15s ease;
    }
    details[open] > .family-summary::after { transform: rotate(90deg); }
    .family-name { font-weight: 600; word-break: break-word; }
    .family-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .family-body { padding: 0 14px 14px; border-top: 1px solid var(--border); }
    .risk-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--accent-fg);
      background: var(--text-muted);
    }
    .risk-high   { background: var(--high); color: #ffffff; }
    .risk-medium { background: var(--medium); color: #1a1a1a; }
    .risk-low    { background: var(--low); color: #ffffff; }
    .count-pill {
      display: inline-block;
      min-width: 28px;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--text);
      font-size: 0.72rem;
      font-weight: 600;
      text-align: center;
      border: 1px solid var(--border);
    }
    .count-pill.repair  { background: rgba(46,125,50,0.12); }
    .count-pill.replace { background: rgba(239,108,0,0.12); }
    .count-pill.pause   { background: rgba(198,40,40,0.12); }
    .count-pill.trial   { background: rgba(25,118,210,0.12); }
    .kv-grid {
      display: grid;
      grid-template-columns: minmax(110px, max-content) 1fr;
      gap: 4px 12px;
      margin: 6px 0 10px;
    }
    .kv-grid dt { color: var(--text-muted); font-size: 0.85rem; padding-top: 2px; }
    .kv-grid dd { margin: 0; word-break: break-word; }
    .group { margin: 14px 0; }
    .group-title {
      display: flex; align-items: center; gap: 8px;
      margin: 0 0 8px;
    }
    .group-meta {
      font-size: 0.72rem;
      color: var(--text-muted);
      font-weight: 500;
    }
    .action-list { display: flex; flex-direction: column; gap: 8px; }
    .action-card {
      background: var(--surface-2);
      border-radius: 8px;
      padding: 10px 12px;
      border: 1px solid var(--border);
    }
    .action-row {
      display: grid;
      grid-template-columns: minmax(70px, max-content) 1fr;
      gap: 6px 12px;
      padding: 4px 0;
      align-items: baseline;
    }
    .action-row + .action-row { border-top: 1px dashed var(--border); }
    .kv-key { color: var(--text-muted); font-size: 0.82rem; }
    .kv-val { word-break: break-word; }
    .csv-ref {
      display: inline-block;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: var(--chip-bg);
      color: var(--chip-fg);
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 0.8rem;
      line-height: 1;
      min-height: 24px;
    }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .trial-list { display: flex; flex-direction: column; gap: 10px; }
    .trial-card {
      background: var(--surface-2);
      border-radius: 8px;
      padding: 12px;
      border: 1px solid var(--border);
    }
    .trial-name { margin: 0 0 6px; font-size: 1rem; }
    .nav-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .nav-item a {
      display: flex; justify-content: space-between; align-items: center; gap: 10px;
      min-height: var(--tap);
      padding: 10px 12px;
      border-radius: 8px;
      background: var(--surface-2);
      text-decoration: none;
      color: var(--text);
      border: 1px solid var(--border);
    }
    .nav-item a:active { background: var(--surface); }
    .nav-name { word-break: break-word; }
    .nav-counts { display: flex; gap: 4px; flex-shrink: 0; }
    .appendix { margin-top: 24px; }
    .appendix > summary {
      cursor: pointer;
      padding: 12px 0;
      font-weight: 600;
      color: var(--text-muted);
      list-style: none;
    }
    .appendix > summary::after { content: " ▸"; }
    .appendix[open] > summary::after { content: " ▾"; }
    /* safe-render fallback styles */
    .sr-empty { color: var(--text-muted); }
    .sr-truncated { color: var(--text-muted); font-style: italic; }
    .sr-list { margin: 4px 0 4px 18px; padding: 0; }
    .sr-list li { margin: 2px 0; }
    .sr-object { margin: 4px 0; display: grid; grid-template-columns: minmax(90px, max-content) 1fr; gap: 2px 10px; }
    .sr-object .sr-row { display: contents; }
    .sr-object dt { color: var(--text-muted); font-size: 0.82rem; }
    .sr-object dd { margin: 0; }
    /* Accessibility: focus rings for keyboard / switch users. */
    a:focus-visible,
    summary:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 4px;
    }
    /* Visually-hidden text for screen readers. */
    .sr-only {
      position: absolute !important;
      width: 1px; height: 1px;
      padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0);
      white-space: nowrap; border: 0;
    }
    /* Make jump-link targets land below the sticky header. */
    .family-card { scroll-margin-top: 88px; }
    /* Pause action group needs its 'warning' tone to actually show. */
    .group.warning .group-title { color: var(--warn-border); }
    .group.warning .action-card {
      background: var(--warn-bg);
      border-color: var(--warn-border);
    }
    /* Sticky header on phones is too tall — collapse meta + drop sticky. */
    @media (max-width: 480px) {
      .sticky-header { position: static; }
      .sticky-header .meta { display: none; }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .kv-grid { grid-template-columns: 1fr; gap: 2px; }
      .kv-grid dt { padding-top: 8px; font-weight: 600; color: var(--text); }
      .action-row { grid-template-columns: 1fr; gap: 2px; }
      .family-card { scroll-margin-top: 12px; }
    }
    /* Dark-mode badge contrast: light backgrounds need dark text. */
    @media (prefers-color-scheme: dark) {
      .risk-high, .risk-medium, .risk-low { color: #0f1115; }
    }
    @media (min-width: 720px) {
      :root { --max-w: 880px; }
      .kv-grid { grid-template-columns: 160px 1fr; }
    }
  </style>
</head>
<body>
  <header class="sticky-header">
    <div class="container" style="padding-top: 0; padding-bottom: 0;">
      <h1 class="title">${safeText(packet.title)}</h1>
      <div class="meta">
        <span><strong>Run</strong> ${safeText(packet.run_id)}</span>
        <span><strong>Snapshot</strong> ${safeText(packet.snapshot_date)}</span>
        <span><strong>Generated</strong> ${safeText(formatDateTime(packet.generated_at))}</span>
      </div>
    </div>
  </header>

  <main class="container">
    <section class="panel">
      <h2 style="margin-top:0">Executive summary</h2>
      <div class="metric-grid">
        <div class="metric"><span class="metric-value">${safeText(exec.total_campaigns)}</span><span class="metric-label">Campaigns</span></div>
        <div class="metric"><span class="metric-value">${safeText(exec.high_risk_families)}</span><span class="metric-label">High-risk families</span></div>
        <div class="metric"><span class="metric-value">${safeText(exec.repair_actions)}</span><span class="metric-label">Repairs</span></div>
        <div class="metric"><span class="metric-value">${safeText(exec.replacement_actions)}</span><span class="metric-label">Replacements</span></div>
        <div class="metric"><span class="metric-value">${safeText(exec.trial_groups)}</span><span class="metric-label">Trial groups</span></div>
      </div>
      <h3>What to do</h3>
      <ul class="checklist">
        ${asArray(exec.checklist).map((item) => `<li>${safeRender(item, { mode: 'inline' })}</li>`).join('')}
      </ul>
    </section>

    ${overviewFamilies.length > 0 ? `
    <nav class="panel" aria-label="Jump to family">
      <h2 style="margin-top:0">Jump to family</h2>
      <ul class="nav-list">
        ${overviewFamilies.map((f: any) => {
          const anchor = safeToken(f?.anchor_id, 'family');
          const repair = Number(f?.repair_count) || 0;
          const replace = Number(f?.replacement_count) || 0;
          const trial = Number(f?.trial_count) || 0;
          return `
          <li class="nav-item">
            <a href="#${anchor}">
              <span class="nav-name">${safeText(formatFamilyKey((f?.family_key ?? {}) as any))} ${renderRiskBadge(f?.family_risk)}</span>
              <span class="nav-counts">
                ${repair > 0 ? `<span class="count-pill repair">${repair}R</span>` : ''}
                ${replace > 0 ? `<span class="count-pill replace">${replace}X</span>` : ''}
                ${trial > 0 ? `<span class="count-pill trial">${trial}T</span>` : ''}
              </span>
            </a>
          </li>`;
        }).join('')}
      </ul>
    </nav>` : ''}

    <section>
      <h2>Per-family detail</h2>
      ${sections.map((section, idx) => renderFamilyDetails(section, idx)).join('')}
    </section>

    <details class="appendix">
      <summary>Reference: risk levels &amp; constraints</summary>
      <div class="panel">
        <h3 style="margin-top:0">Risk levels</h3>
        <dl class="kv-grid">
          ${Object.entries(riskDefs).map(([level, def]) => `
            <dt>${renderRiskBadge(level)}</dt>
            <dd>${safeRender(def, { mode: 'auto' })}</dd>
          `).join('')}
        </dl>
        <h3>Constraints</h3>
        <p>${safeRender(taxonomy.white_grey_hat_constraints, { mode: 'auto' })}</p>
      </div>
    </details>
  </main>
</body>
</html>`;
}
