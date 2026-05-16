/**
 * L2 LLM-based Risk Predictor
 * Uses LLM to analyze L1 summaries and generate risk predictions and action plans
 */

import type { L1FamilySummary, L2PredictionOutput, L2FamilyPrediction } from '../shared/types.js';
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
    snapshotDate: string
  ): Promise<L2PredictionOutput> {
    if (!this.promptConfig) {
      throw new Error('L2Predictor not initialized. Call initialize() first.');
    }

    console.log(`🤖 Calling LLM for L2 predictions (${familySummaries.length} families)...`);

    // Format L1 summaries for prompt
    const l1SummariesFormatted = familySummaries.map((summary, idx) => ({
      family_index: idx,
      family_key: summary.family_key,
      ads_total: summary.ads_total,
      policy_status_counts: summary.policy_status_counts,
      pattern_stats: summary.pattern_stats,
      anomalies: summary.anomalies,
      avg_performance: summary.avg_performance,
    }));

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

    // Map to L2PredictionOutput schema
    // LLM may return either "families" or "L2_Predictions" array
    const rawFamilies = parsedResponse.families || parsedResponse.L2_Predictions || [];
    
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
        ad_actions: adActions.map((action: any) => ({
          // Core fields (normalized)
          ad_id: action.ad_id,
          action_type: action.action || action.action_type || 'monitor',
          rationale: action.rationale || action.justification || '',
          csv_batch: action.csv_batch || 2,
          changes: action.changes || action.modifications || {},
          // Preserve all additional fields for CSV/HTML
          issue_codes: action.issue_codes || action.issues || [],
          justification: action.justification || action.rationale || '',
          suggested_new_creatives: action.suggested_new_creatives || [],
          csv_row_number: action.csv_row_number,
          // Keep any other fields LLM might return
          ...action,
        })),
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
 * Create L2 predictor with standard configuration
 */
export async function createL2Predictor(
  llmClient: LLMClient,
  promptConfigPath: string
): Promise<L2LLMPredictor> {
  const predictor = new L2LLMPredictor({
    llmClient,
    promptConfigPath,
  });
  
  await predictor.initialize();
  return predictor;
}
