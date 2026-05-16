/**
 * L3 LLM-based Meta-Analyzer
 * Uses LLM to evaluate L2 predictions vs actual outcomes and propose improvements
 */

import type { L2PredictionOutput, L3EvaluationOutput } from '../shared/types.js';
import { LLMClient, formatPromptTemplate } from '../shared/llm-client.js';

export interface L3AnalyzerConfig {
  llmClient: LLMClient;
}

export interface TrialOutcome {
  trial_id: string;
  family_key: any;
  trial_plan: any;
  l2_predicted_risk: string;
  l2_predicted_success: boolean;
  actual_serving_status: string;
  actual_policy_topics: string[];
  actual_ctr_vs_control: number;
  actual_conversion_rate_vs_control: number;
  success: boolean;
  insights: string;
}

export interface PredictionAccuracy {
  l2_run_id: string;
  total_families: number;
  high_risk_correct: number;
  high_risk_total: number;
  medium_risk_correct: number;
  medium_risk_total: number;
  low_risk_correct: number;
  low_risk_total: number;
  overall_accuracy: number;
}

/**
 * L3 LLM Analyzer
 */
export class L3LLMAnalyzer {
  private config: L3AnalyzerConfig;

  constructor(config: L3AnalyzerConfig) {
    this.config = config;
  }

  /**
   * Analyze L2 predictions vs outcomes and generate improvement proposals
   */
  async analyze(
    l2Runs: L2PredictionOutput[],
    trialOutcomes: TrialOutcome[],
    predictionAccuracy: PredictionAccuracy[]
  ): Promise<L3EvaluationOutput> {
    console.log(`🔬 Running L3 meta-analysis...`);
    console.log(`  L2 runs: ${l2Runs.length}`);
    console.log(`  Trial outcomes: ${trialOutcomes.length}`);

    const systemPrompt = this.getSystemPrompt();
    const userPrompt = this.getUserPrompt(l2Runs, trialOutcomes, predictionAccuracy);

    // Call LLM
    const response = await this.config.llmClient.callWithRetry({
      use_case: 'gads-ads-l3-prompt-improvement',
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

    // Build L3 output
    const l3Output: L3EvaluationOutput = {
      evaluation_id: `l3-eval-${new Date().toISOString().split('T')[0]}`,
      l2_runs_analyzed: l2Runs.map(r => r.run_id),
      trials_analyzed: trialOutcomes.length,
      prediction_accuracy: parsedResponse.prediction_accuracy || predictionAccuracy[0] || {},
      trial_insights: parsedResponse.trial_insights || [],
      prompt_updates: parsedResponse.prompt_updates || [],
      rule_updates: parsedResponse.rule_updates || [],
      generated_at: new Date().toISOString(),
      requires_human_approval: true,
    };

    console.log(`✅ L3 analysis complete`);
    console.log(`  Prompt updates proposed: ${l3Output.prompt_updates.length}`);
    console.log(`  Rule updates proposed: ${l3Output.rule_updates.length}`);

    return l3Output;
  }

  /**
   * Get L3 system prompt
   */
  private getSystemPrompt(): string {
    return `You are a meta-learning system that improves Google Ads policy compliance predictions.

Your role is to:
1. Evaluate L2 prediction accuracy by comparing predictions to actual outcomes
2. Analyze trial experiment results to identify policy patterns
3. Propose improvements to L2 prompts and L1 rules

CRITICAL CONSTRAINTS:
- All proposals must be grounded in observed data
- Consider BOTH policy compliance AND ad performance
- Propose only changes that can be tested and validated
- Maintain white-/grey-hat alignment principles
- All changes require human approval before application

NORTH STAR:
- We optimize (limitation_avoidance × user_clarity × performance)
- We learn Google's opaque policy enforcement through systematic observation
- We never recommend deception or policy evasion`;
  }

  /**
   * Get L3 user prompt
   */
  private getUserPrompt(
    l2Runs: L2PredictionOutput[],
    trialOutcomes: TrialOutcome[],
    predictionAccuracy: PredictionAccuracy[]
  ): string {
    return `Analyze the following L2 predictions vs actual outcomes and propose improvements.

## L2 Prediction Runs

${JSON.stringify(l2Runs, null, 2)}

## Trial Experiment Outcomes

${JSON.stringify(trialOutcomes, null, 2)}

## Prediction Accuracy Metrics

${JSON.stringify(predictionAccuracy, null, 2)}

Based on this data, provide:

1. **Prediction Accuracy Assessment**
   - Overall accuracy metrics
   - Breakdown by risk level (high/medium/low)
   - False positive and false negative analysis
   - Confidence calibration assessment

2. **Trial Insights**
   - Key patterns discovered from trial experiments
   - Policy boundary learnings
   - Unexpected outcomes and their implications
   - Performance vs compliance trade-offs observed

3. **Prompt Update Proposals**
   For each proposed L2 prompt improvement:
   - Section to update (system_prompt, user_prompt_template, constraints, etc.)
   - Current text (excerpt)
   - Proposed new text
   - Rationale (what data supports this change)
   - Expected impact (how will this improve predictions)
   - Test plan (how to validate the improvement)

4. **Rule Update Proposals**
   For each proposed L1 rule improvement:
   - Rule type (text_patterns, structure, policy_status, landing_linkage)
   - Current rule (if modifying existing)
   - Proposed new rule
   - Rationale
   - Expected impact
   - Test plan

5. **Meta-Recommendations**
   - Should we run more trials in specific areas?
   - Are there new pattern categories to explore?
   - Should we adjust trial budgets or timings?
   - Any systemic issues to address?

Output as JSON matching L3EvaluationOutput schema with arrays of:
- prediction_accuracy: accuracy metrics
- trial_insights: learnings from trials
- prompt_updates: proposed L2 prompt changes
- rule_updates: proposed L1 rule changes

Remember: All proposals require human review and approval. Focus on data-driven,
testable improvements that maintain our white-/grey-hat principles.`;
  }
}

/**
 * Create L3 analyzer
 */
export function createL3Analyzer(llmClient: LLMClient): L3LLMAnalyzer {
  return new L3LLMAnalyzer({ llmClient });
}
