/**
 * L3: Prediction Evaluator
 * Evaluates L2 predictions against actual outcomes
 */

import type {
  L2PredictionOutput,
  FamilyPrediction,
  TrialOutcome,
  PredictionAccuracy,
  PatternEffectiveness,
  RiskLevel,
} from '../shared/types.js';

export interface ActualFamilyOutcome {
  family_key_str: string;
  actual_limited_count: number;
  actual_disapproved_count: number;
  actual_risk_level: RiskLevel;
}

/**
 * Evaluate L2 prediction accuracy
 */
export function evaluatePredictions(
  l2Predictions: FamilyPrediction[],
  actualOutcomes: ActualFamilyOutcome[]
): PredictionAccuracy {
  const outcomesByFamily = new Map(
    actualOutcomes.map(o => [o.family_key_str, o])
  );
  
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  
  const byRiskLevel: Record<RiskLevel, { precision: number; recall: number }> = {
    high: { precision: 0, recall: 0 },
    medium: { precision: 0, recall: 0 },
    low: { precision: 0, recall: 0 },
  };
  
  for (const prediction of l2Predictions) {
    const familyKeyStr = formatFamilyKey(prediction.family_key);
    const actual = outcomesByFamily.get(familyKeyStr);
    
    if (!actual) continue; // No outcome data yet
    
    const predictedRisk = prediction.family_risk;
    const actualRisk = actual.actual_risk_level;
    
    // Binary classification: high-risk vs not-high-risk
    const predictedHighRisk = predictedRisk === 'high';
    const actualHighRisk = actualRisk === 'high';
    
    if (predictedHighRisk && actualHighRisk) {
      truePositives++;
    } else if (predictedHighRisk && !actualHighRisk) {
      falsePositives++;
    } else if (!predictedHighRisk && !actualHighRisk) {
      trueNegatives++;
    } else {
      falseNegatives++;
    }
  }
  
  const precision = truePositives + falsePositives > 0
    ? truePositives / (truePositives + falsePositives)
    : 0;
    
  const recall = truePositives + falseNegatives > 0
    ? truePositives / (truePositives + falseNegatives)
    : 0;
    
  const f1Score = precision + recall > 0
    ? 2 * (precision * recall) / (precision + recall)
    : 0;
  
  return {
    precision,
    recall,
    f1_score: f1Score,
    true_positives: truePositives,
    false_positives: falsePositives,
    true_negatives: trueNegatives,
    false_negatives: falseNegatives,
    by_risk_level: byRiskLevel,
  };
}

/**
 * Evaluate pattern effectiveness from trial outcomes
 */
export function evaluatePatternEffectiveness(
  trialOutcomes: TrialOutcome[]
): PatternEffectiveness[] {
  // Group outcomes by pattern type
  const patternMap = new Map<string, {
    recommended: number;
    applied: number;
    limitationReductions: number;
    ctrDeltas: number[];
    convRateDeltas: number[];
  }>();
  
  for (const outcome of trialOutcomes) {
    for (const variant of outcome.variant_outcomes) {
      const pattern = variant.variant_label;
      
      if (!patternMap.has(pattern)) {
        patternMap.set(pattern, {
          recommended: 0,
          applied: 0,
          limitationReductions: 0,
          ctrDeltas: [],
          convRateDeltas: [],
        });
      }
      
      const stats = patternMap.get(pattern)!;
      stats.recommended++;
      stats.applied++;
      
      // Check if limitation was avoided
      const isEligible = variant.serving_status === 'eligible';
      if (isEligible) {
        stats.limitationReductions++;
      }
      
      // Calculate performance deltas
      if (variant.metrics && outcome.control_outcomes[0]?.metrics) {
        const controlCTR = outcome.control_outcomes[0].metrics.ctr || 0;
        const variantCTR = variant.metrics.ctr || 0;
        const ctrDelta = variantCTR - controlCTR;
        stats.ctrDeltas.push(ctrDelta);
        
        const controlConvRate = outcome.control_outcomes[0].metrics.conversion_rate || 0;
        const variantConvRate = variant.metrics.conversion_rate || 0;
        const convDelta = variantConvRate - controlConvRate;
        stats.convRateDeltas.push(convDelta);
      }
    }
  }
  
  // Convert to PatternEffectiveness array
  const effectiveness: PatternEffectiveness[] = [];
  
  for (const [pattern, stats] of patternMap.entries()) {
    const limitationReductionRate = stats.applied > 0
      ? stats.limitationReductions / stats.applied
      : 0;
    
    const avgCTRDelta = stats.ctrDeltas.length > 0
      ? stats.ctrDeltas.reduce((a, b) => a + b, 0) / stats.ctrDeltas.length
      : 0;
    
    const avgConvRateDelta = stats.convRateDeltas.length > 0
      ? stats.convRateDeltas.reduce((a, b) => a + b, 0) / stats.convRateDeltas.length
      : 0;
    
    // Simple statistical significance (t-test would be better)
    const significance = stats.ctrDeltas.length >= 10 ? 0.05 : 1.0;
    
    // Recommendation based on performance
    let recommendation: "continue" | "modify" | "retire";
    if (limitationReductionRate > 0.7 && avgCTRDelta >= -0.02) {
      recommendation = "continue";
    } else if (limitationReductionRate > 0.5 || avgCTRDelta >= -0.05) {
      recommendation = "modify";
    } else {
      recommendation = "retire";
    }
    
    effectiveness.push({
      pattern_id: pattern,
      pattern_description: pattern,
      times_recommended: stats.recommended,
      times_applied: stats.applied,
      limitation_reduction_rate: limitationReductionRate,
      performance_impact: {
        avg_ctr_delta: avgCTRDelta,
        avg_conv_rate_delta: avgConvRateDelta,
        statistical_significance: significance,
      },
      recommendation,
    });
  }
  
  return effectiveness;
}

/**
 * Helper: Format family key to string
 */
function formatFamilyKey(key: { account_id: string; campaign_name?: string; creative_theme?: string; product_tag?: string }): string {
  const parts = [key.account_id];
  if (key.campaign_name) parts.push(key.campaign_name);
  if (key.creative_theme) parts.push(key.creative_theme);
  if (key.product_tag) parts.push(key.product_tag);
  return parts.join('/');
}
