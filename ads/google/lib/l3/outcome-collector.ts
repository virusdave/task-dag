/**
 * L3: Outcome Collector
 * Collects trial outcomes from Helios after trials have run
 */

import type {
  TrialPlan,
  TrialOutcome,
  ServingStatus,
  PerformanceMetrics,
} from '../shared/types.js';

export interface TrialSnapshot {
  trial_id: string;
  trial_group_name: string;
  ad_id: string;
  variant_label: string;
  is_control: boolean;
  check_time: string;
  serving_status: ServingStatus;
  metrics?: PerformanceMetrics;
}

export interface HeliosTrialQuery {
  run_id: string;
  check_interval_hours: number;
}

/**
 * Collect trial outcomes from Helios snapshots
 */
export async function collectTrialOutcomes(
  trialPlans: TrialPlan[],
  heliosSnapshots: TrialSnapshot[]
): Promise<TrialOutcome[]> {
  const outcomes: TrialOutcome[] = [];
  
  for (const trial of trialPlans) {
    const trialSnapshots = heliosSnapshots.filter(
      s => s.trial_group_name === trial.trial_group_name
    );
    
    if (trialSnapshots.length === 0) {
      continue; // Trial not yet run
    }
    
    const outcome = buildTrialOutcome(trial, trialSnapshots);
    outcomes.push(outcome);
  }
  
  return outcomes;
}

/**
 * Build trial outcome from snapshots
 */
function buildTrialOutcome(
  trial: TrialPlan,
  snapshots: TrialSnapshot[]
): TrialOutcome {
  // Separate controls and variants
  const controlSnapshots = snapshots.filter(s => s.is_control);
  const variantSnapshots = snapshots.filter(s => !s.is_control);
  
  // Group variants by label
  const variantsByLabel = new Map<string, TrialSnapshot[]>();
  for (const snapshot of variantSnapshots) {
    const label = snapshot.variant_label;
    if (!variantsByLabel.has(label)) {
      variantsByLabel.set(label, []);
    }
    variantsByLabel.get(label)!.push(snapshot);
  }
  
  // Aggregate control outcomes
  const controlOutcomes = controlSnapshots.map(s => ({
    serving_status: s.serving_status,
    metrics: s.metrics,
  }));
  
  // Aggregate variant outcomes
  const variantOutcomes = Array.from(variantsByLabel.entries()).map(([label, snaps]) => {
    // Use latest snapshot for each variant
    const latest = snaps.sort((a, b) => 
      new Date(b.check_time).getTime() - new Date(a.check_time).getTime()
    )[0];
    
    return {
      variant_label: label,
      serving_status: latest.serving_status,
      metrics: latest.metrics,
    };
  });
  
  // Determine conclusion
  const conclusion = analyzeTrialConclusion(
    trial,
    controlOutcomes,
    variantOutcomes
  );
  
  // Extract learned patterns
  const learnedPatterns = extractLearnedPatterns(
    trial,
    variantOutcomes
  );
  
  return {
    trial_id: trial.trial_id,
    trial_group_name: trial.trial_group_name,
    hypothesis: trial.hypothesis,
    policy_class_probed: trial.policy_class_being_probed,
    control_outcomes: controlOutcomes,
    variant_outcomes: variantOutcomes,
    conclusion,
    learned_patterns: learnedPatterns,
  };
}

/**
 * Analyze trial to draw conclusion
 */
function analyzeTrialConclusion(
  trial: TrialPlan,
  controlOutcomes: { serving_status: ServingStatus; metrics?: PerformanceMetrics }[],
  variantOutcomes: { variant_label: string; serving_status: ServingStatus; metrics?: PerformanceMetrics }[]
): string {
  // Check if any variants succeeded (eligible + good performance)
  const successfulVariants = variantOutcomes.filter(v => {
    const isEligible = v.serving_status === 'eligible' || v.serving_status === 'eligible_limited';
    
    if (!v.metrics || controlOutcomes.length === 0 || !controlOutcomes[0].metrics) {
      return isEligible;
    }
    
    const avgControlCTR = controlOutcomes[0].metrics.ctr || 0;
    const variantCTR = v.metrics.ctr || 0;
    const ctrRatio = avgControlCTR > 0 ? variantCTR / avgControlCTR : 1;
    
    return isEligible && ctrRatio >= 0.8;
  });
  
  if (successfulVariants.length === 0) {
    return `No variants achieved both eligibility and performance criteria. Hypothesis "${trial.hypothesis}" not validated.`;
  }
  
  if (successfulVariants.length === variantOutcomes.length) {
    return `All ${successfulVariants.length} variants succeeded. Hypothesis "${trial.hypothesis}" strongly validated.`;
  }
  
  return `${successfulVariants.length}/${variantOutcomes.length} variants succeeded. Hypothesis "${trial.hypothesis}" partially validated. Successful patterns: ${successfulVariants.map(v => v.variant_label).join(', ')}`;
}

/**
 * Extract learned patterns from trial
 */
function extractLearnedPatterns(
  trial: TrialPlan,
  variantOutcomes: { variant_label: string; serving_status: ServingStatus; metrics?: PerformanceMetrics }[]
): string[] {
  const patterns: string[] = [];
  
  // Pattern: Which variants were approved
  const approved = variantOutcomes.filter(v => v.serving_status === 'eligible');
  if (approved.length > 0) {
    patterns.push(`Approved patterns: ${approved.map(v => v.variant_label).join(', ')}`);
  }
  
  // Pattern: Which variants were limited
  const limited = variantOutcomes.filter(v => v.serving_status === 'eligible_limited');
  if (limited.length > 0) {
    patterns.push(`Limited patterns: ${limited.map(v => v.variant_label).join(', ')}`);
  }
  
  // Pattern: Which variants were disapproved
  const disapproved = variantOutcomes.filter(v => v.serving_status === 'not_eligible');
  if (disapproved.length > 0) {
    patterns.push(`Disapproved patterns: ${disapproved.map(v => v.variant_label).join(', ')}`);
  }
  
  // Pattern: Performance differences
  const withMetrics = variantOutcomes.filter(v => v.metrics?.ctr);
  if (withMetrics.length > 0) {
    const avgCTR = withMetrics.reduce((sum, v) => sum + (v.metrics!.ctr || 0), 0) / withMetrics.length;
    patterns.push(`Average CTR: ${(avgCTR * 100).toFixed(2)}%`);
    
    const best = withMetrics.reduce((best, v) => 
      (v.metrics!.ctr || 0) > (best.metrics!.ctr || 0) ? v : best
    );
    patterns.push(`Best performing: ${best.variant_label} (CTR: ${((best.metrics!.ctr || 0) * 100).toFixed(2)}%)`);
  }
  
  return patterns;
}

/**
 * Query Helios for trial snapshots
 */
export async function queryHeliosForTrialSnapshots(
  query: HeliosTrialQuery
): Promise<TrialSnapshot[]> {
  // TODO: Implement actual Helios query
  // This would query the gads_ads table for ads with trial labels
  // and join with performance snapshots at the specified interval
  
  // Mock implementation for now
  return [];
}
