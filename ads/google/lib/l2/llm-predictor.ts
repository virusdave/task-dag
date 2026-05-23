/**
 * L2 LLM-based Risk Predictor
 * Uses LLM to analyze L1 summaries and generate risk predictions and action plans
 */

import type {
  AdSnapshot,
  L1FamilySummary,
  L2PredictionOutput,
} from '../shared/types.js';
import { LLMClient, formatPromptTemplate, loadPromptConfig } from '../shared/llm-client.js';

export interface L2PredictorConfig {
  promptConfigPath: string;
  llmClient: LLMClient;
  policyExperiences?: string;
  trialOutcomes?: string;
}

/**
 * L2 LLM Predictor
 */
export class L2LLMPredictor {
  private config: L2PredictorConfig;
  private promptConfig: any;

  constructor(config: L2PredictorConfig) {
    this.config = config;
  }

  /**
   * Initialize by loading prompt configuration
   */
  async initialize(): Promise<void> {
    this.promptConfig = await loadPromptConfig(this.config.promptConfigPath);
  }

  /**
   * Generate L2 predictions for all families
   */
  async predict(
    familySummaries: L1FamilySummary[],
    runId: string,
    snapshotDate: string,
    ads: ReadonlyArray<AdSnapshot> = []
  ): Promise<L2PredictionOutput> {
    if (!this.promptConfig) {
      throw new Error('L2Predictor not initialized. Call initialize() first.');
    }

    console.log(`🤖 Calling LLM for L2 predictions (${familySummaries.length} families)...`);

    // Build an ad index so we can attach REAL creative content to each
    // family summary the LLM sees. Without this the LLM only sees
    // aggregate stats and gets no signal about which specific ads to
    // re-enable, leading it to hallucinate ad_ids like "NYC Bud |
    // Core-38" that don't exist in the account. With real ad content
    // in front of it, it can produce repair/replace actions grounded
    // in actual creatives.
    const adIndex = new Map<string, AdSnapshot>();
    for (const ad of ads) {
      if (ad.ad_id) adIndex.set(ad.ad_id, ad);
    }
    const adsByFamilyKey = groupAdsByFamilyKey(ads, familySummaries);

    // Format L1 summaries for prompt
    const l1SummariesFormatted = familySummaries.map((summary, idx) => {
      const familyAds = adsByFamilyKey.get(idx) ?? [];

      // Surface real ad creatives, prioritising disapproved / limited
      // ads (since the operator's goal is re-enabling those) and
      // capping at 10 per family so the prompt stays bounded.
      const ranked = [...familyAds].sort((a, b) => statusUrgency(b.serving_status) - statusUrgency(a.serving_status));
      const sampleAds = ranked.slice(0, 10).map((ad) => ({
        ad_id: ad.ad_id,
        campaign_name: ad.campaign_name,
        ad_group_name: ad.ad_group_name,
        ad_status: ad.ad_status,
        serving_status: ad.serving_status,
        policy_status: ad.policy_status,
        policy_topics: ad.policy_topics,
        headlines: ad.headlines,
        descriptions: ad.descriptions,
        final_url: ad.final_url,
        metrics: ad.metrics,
      }));

      return {
        family_index: idx,
        family_key: summary.family_key,
        ads_total: summary.ads_total,
        policy_status_counts: summary.policy_status_counts,
        pattern_stats: summary.pattern_stats,
        anomalies: summary.anomalies,
        avg_performance: summary.avg_performance,
        // Real ads from this family. The LLM MUST only emit
        // ad-level actions that reference ad_id values from this
        // list (the prompt is updated to call this out). This is
        // what prevents the hallucinated-id problem.
        sample_ads: sampleAds,
      };
    });

    // Build user prompt
    const systemPrompt = this.promptConfig.main_prompt.system_prompt || '';
    const userPromptTemplate = this.promptConfig.main_prompt.user_prompt_template || '';
    
    const userPrompt = formatPromptTemplate(userPromptTemplate, {
      l1_family_summaries: JSON.stringify(l1SummariesFormatted, null, 2),
      l1_spot_check_results: '[]', // TODO: Implement L1 spot-checks
      policy_experiences: this.config.policyExperiences || 'No prior experiences available.',
      trial_outcomes: this.config.trialOutcomes || 'No prior trial outcomes available.',
    });

    // Call LLM
    const response = await this.config.llmClient.callWithRetry({
      use_case: 'gads-ads-l2-content-optimization',
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      temperature: 0.1,
      max_tokens: 8000,
      response_format: 'json',
    });

    // Parse response
    let parsedResponse: any;
    try {
      parsedResponse = JSON.parse(response.content);
    } catch (error) {
      console.error('Failed to parse LLM response:', response.content);
      throw new Error(`Invalid JSON response from LLM: ${error}`);
    }

    console.log('LLM response parsed:', JSON.stringify(parsedResponse, null, 2).substring(0, 500));

    // Map to L2PredictionOutput schema. The LLM is inconsistent
    // about the key (we've seen all of `families`, `L2_Predictions`,
    // `l2_predictions`, `predictions`, even `Families`) so accept
    // any case-variant whose value is an array.
    const knownKeys = ['families', 'l2_predictions', 'predictions'];
    let rawFamilies: any[] = [];
    for (const k of Object.keys(parsedResponse ?? {})) {
      if (knownKeys.includes(k.toLowerCase()) && Array.isArray((parsedResponse as any)[k])) {
        rawFamilies = (parsedResponse as any)[k];
        break;
      }
    }
    
    // Validate response structure
    if (!Array.isArray(rawFamilies)) {
      console.error('LLM response missing families/L2_Predictions array:', parsedResponse);
      throw new Error('LLM response missing families/L2_Predictions array');
    }

    if (rawFamilies.length !== familySummaries.length) {
      console.warn(`⚠️  LLM returned ${rawFamilies.length} families, expected ${familySummaries.length}`);
    }

    // Map LLM response structure to our schema
    // IMPORTANT: Preserve ALL fields from LLM response for downstream CSV/HTML
    const families: any[] = rawFamilies.map((fam: any) => {
      // LLM might return nested structure, flatten it
      const riskAssessment = fam.family_risk_assessment || fam;
      const adActions = fam.ad_level_actions || fam.ad_actions || [];
      const trialPlans = fam.trial_plans || [];
      
      return {
        family_key: fam.family_key,
        family_risk: riskAssessment.risk_level || fam.family_risk || 'low',
        risk_score: riskAssessment.risk_score || fam.risk_score || 0,
        issues: (riskAssessment.identified_issues || fam.issues || []).map((issue: any) => ({
          issue_code: issue.issue || issue.issue_code || 'unknown',
          issue_description: issue.severity || issue.issue_description || '',
          affected_ad_count: issue.affected_ad_count || 0,
          severity: issue.severity || 'medium',
        })),
        ad_actions: adActions.map((action: any) => {
          // Normalize action_type to lowercase: the LLM frequently
          // returns "Pause" / "Repair" / "Replace" / "Monitor" with
          // capital initial letters (matching the markdown headings in
          // the prompt), and downstream filters in csv-generator
          // compare against lowercase. Without this normalization the
          // entire pause/repair/replace work product was being
          // silently dropped on every morning run.
          const rawActionType: unknown = action.action ?? action.action_type ?? 'monitor';
          const actionType =
            typeof rawActionType === 'string' ? rawActionType.trim().toLowerCase() : 'monitor';
          return {
            // Spread first so the explicit fields below win.
            ...action,
            // Core fields (normalized)
            ad_id: action.ad_id,
            action_type: actionType,
            rationale: action.rationale || action.justification || '',
            csv_batch: action.csv_batch || 2,
            changes: action.changes || action.modifications || {},
            issue_codes: action.issue_codes || action.issues || [],
            justification: action.justification || action.rationale || '',
            suggested_new_creatives: action.suggested_new_creatives || [],
            csv_row_number: action.csv_row_number,
          };
        }),
        trial_plans: trialPlans,
        l1_summary_ref: fam.l1_summary_ref || `family-${fam.family_index || 0}`,
      };
    });

    // Validate and ensure all required fields
    const validatedFamilies = families.map((family: any, idx: number) => ({
      family_key: familySummaries[idx].family_key,
      family_risk: family.family_risk || 'low',
      risk_score: family.risk_score || 0,
      issues: family.issues || [],
      ad_actions: family.ad_actions || [],
      trial_plans: family.trial_plans || [],
      l1_summary_ref: family.l1_summary_ref || `family-${idx}`,
    }));

    return {
      run_id: runId,
      snapshot_date: snapshotDate,
      families: validatedFamilies,
      l1_rule_updates: parsedResponse.l1_rule_updates || [],
      generated_at: new Date().toISOString(),
      l2_prompt_version: this.promptConfig.version || '1.0.0',
      l1_config_version: '1.0.0', // TODO: Load from L1 config
    };
  }
}

/**
 * Priority for surfacing an ad in the prompt's sample list.
 * Disapproved > limited > under review > eligible. Re-enabling
 * limited/disapproved is the operator's primary goal, so we make
 * sure those creatives actually appear in front of the LLM.
 */
function statusUrgency(servingStatus: string): number {
  switch ((servingStatus ?? '').toLowerCase()) {
    case 'not_eligible':
      return 4;
    case 'eligible_limited':
      return 3;
    case 'under_review':
      return 2;
    case 'eligible':
      return 1;
    default:
      return 0;
  }
}

/**
 * Group ads by the same family-key the L1 aggregator used, so each
 * family summary the LLM receives can carry the actual creatives
 * from its own family (and only its own family).
 *
 * Match by:
 *  1. exact family_tags overlap with summary.family_key fields, and
 *  2. account_id match.
 */
function groupAdsByFamilyKey(
  ads: ReadonlyArray<AdSnapshot>,
  familySummaries: ReadonlyArray<L1FamilySummary>,
): Map<number, AdSnapshot[]> {
  const out = new Map<number, AdSnapshot[]>();
  for (let i = 0; i < familySummaries.length; i++) {
    out.set(i, []);
  }
  for (const ad of ads) {
    for (let i = 0; i < familySummaries.length; i++) {
      const key = familySummaries[i].family_key as Record<string, unknown>;
      let ok = true;
      for (const [k, v] of Object.entries(key)) {
        if (v === undefined || v === null) continue;
        if (k === 'account_id') {
          if (ad.account_id !== v) {
            ok = false;
            break;
          }
        } else if (k === 'campaign_name') {
          if (ad.campaign_name !== v) {
            ok = false;
            break;
          }
        } else {
          // creative_theme / product_tag / geo_target — match against family_tags
          if (ad.family_tags?.[k] !== v) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        out.get(i)!.push(ad);
        break; // first matching family wins (families are disjoint)
      }
    }
  }
  return out;
}

/**
 * Create L2 predictor with standard configuration
 */
export async function createL2Predictor(
  llmClient: LLMClient,
  promptConfigPath: string,
  extra: { policyExperiences?: string; trialOutcomes?: string } = {}
): Promise<L2LLMPredictor> {
  const predictor = new L2LLMPredictor({
    llmClient,
    promptConfigPath,
    policyExperiences: extra.policyExperiences,
    trialOutcomes: extra.trialOutcomes,
  });

  await predictor.initialize();
  return predictor;
}
