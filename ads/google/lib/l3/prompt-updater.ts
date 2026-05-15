/**
 * L3: Prompt Updater
 * Generates prompt and rule update proposals based on evaluation
 */

import type {
  PredictionAccuracy,
  PatternEffectiveness,
  ProposedUpdate,
} from '../shared/types.js';

/**
 * Generate prompt and rule update proposals
 */
export function generateUpdateProposals(
  accuracy: PredictionAccuracy,
  effectiveness: PatternEffectiveness[]
): ProposedUpdate[] {
  const proposals: ProposedUpdate[] = [];
  
  // Propose updates based on prediction accuracy
  proposals.push(...generateAccuracyBasedUpdates(accuracy));
  
  // Propose updates based on pattern effectiveness
  proposals.push(...generateEffectivenessBasedUpdates(effectiveness));
  
  return proposals;
}

/**
 * Generate updates based on prediction accuracy
 */
function generateAccuracyBasedUpdates(accuracy: PredictionAccuracy): ProposedUpdate[] {
  const proposals: ProposedUpdate[] = [];
  
  // If precision is low, we're over-predicting risk
  if (accuracy.precision < 0.6) {
    proposals.push({
      update_type: 'prompt',
      component: 'l2_risk_scoring',
      current_value: 'Current risk threshold: high=0.7',
      proposed_value: 'Proposed risk threshold: high=0.8',
      rationale: `Precision is ${(accuracy.precision * 100).toFixed(1)}%, indicating we're over-predicting high risk. Increase threshold to reduce false positives.`,
      expected_impact: 'Reduce false positive rate by ~20%',
      confidence: 0.7,
    });
  }
  
  // If recall is low, we're under-predicting risk
  if (accuracy.recall < 0.6) {
    proposals.push({
      update_type: 'prompt',
      component: 'l2_risk_scoring',
      current_value: 'Current risk threshold: high=0.7',
      proposed_value: 'Proposed risk threshold: high=0.6',
      rationale: `Recall is ${(accuracy.recall * 100).toFixed(1)}%, indicating we're missing high-risk families. Lower threshold to increase sensitivity.`,
      expected_impact: 'Reduce false negative rate by ~20%',
      confidence: 0.7,
    });
  }
  
  // If both are reasonable, suggest refinement
  if (accuracy.precision >= 0.6 && accuracy.recall >= 0.6 && accuracy.f1_score < 0.7) {
    proposals.push({
      update_type: 'l1_rule',
      component: 'feature_weights',
      current_value: JSON.stringify({
        medical_claim_patterns: 0.8,
        restricted_vocab_buckets: 0.9,
      }),
      proposed_value: JSON.stringify({
        medical_claim_patterns: 0.85,
        restricted_vocab_buckets: 0.95,
      }),
      rationale: `F1 score is ${(accuracy.f1_score * 100).toFixed(1)}%. Slightly increase weight on strongest predictors.`,
      expected_impact: 'Improve F1 score by 5-10%',
      confidence: 0.6,
    });
  }
  
  return proposals;
}

/**
 * Generate updates based on pattern effectiveness
 */
function generateEffectivenessBasedUpdates(effectiveness: PatternEffectiveness[]): ProposedUpdate[] {
  const proposals: ProposedUpdate[] = [];
  
  // Find highly effective patterns
  const highlyEffective = effectiveness.filter(e => 
    e.recommendation === 'continue' && 
    e.limitation_reduction_rate > 0.8 &&
    e.performance_impact.avg_ctr_delta > -0.01
  );
  
  if (highlyEffective.length > 0) {
    const patterns = highlyEffective.map(e => e.pattern_id).join(', ');
    proposals.push({
      update_type: 'prompt',
      component: 'l2_action_selection',
      current_value: 'Current: No pattern preferences',
      proposed_value: `Prioritize patterns: ${patterns}`,
      rationale: `These patterns achieved >80% limitation reduction with minimal performance impact. Recommend them more frequently.`,
      expected_impact: 'Increase compliant ad success rate by 15-25%',
      confidence: 0.8,
    });
  }
  
  // Find ineffective patterns
  const ineffective = effectiveness.filter(e => 
    e.recommendation === 'retire' ||
    (e.limitation_reduction_rate < 0.3 && e.times_applied > 5)
  );
  
  if (ineffective.length > 0) {
    const patterns = ineffective.map(e => e.pattern_id).join(', ');
    proposals.push({
      update_type: 'prompt',
      component: 'l2_action_selection',
      current_value: 'Current: No pattern blacklist',
      proposed_value: `Avoid patterns: ${patterns}`,
      rationale: `These patterns failed to reduce limitations or hurt performance significantly. Stop recommending.`,
      expected_impact: 'Reduce wasted trial budget, improve success rate',
      confidence: 0.75,
    });
  }
  
  // Find patterns needing modification
  const needsModification = effectiveness.filter(e => 
    e.recommendation === 'modify' &&
    e.limitation_reduction_rate > 0.4 &&
    e.limitation_reduction_rate < 0.7
  );
  
  if (needsModification.length > 0) {
    for (const pattern of needsModification.slice(0, 3)) {
      proposals.push({
        update_type: 'trial_design',
        component: 'variant_generation',
        current_value: `Pattern: ${pattern.pattern_id}`,
        proposed_value: `Create refined variants of: ${pattern.pattern_id}`,
        rationale: `Pattern shows promise (${(pattern.limitation_reduction_rate * 100).toFixed(0)}% success rate) but needs refinement. Design trials to test variations.`,
        expected_impact: 'Potentially increase success rate from ~50% to ~70%',
        confidence: 0.6,
      });
    }
  }
  
  // Suggest new trial categories if we're learning well
  const totalTrials = effectiveness.reduce((sum, e) => sum + e.times_applied, 0);
  const avgSuccess = effectiveness.reduce((sum, e) => sum + e.limitation_reduction_rate, 0) / effectiveness.length;
  
  if (totalTrials > 50 && avgSuccess > 0.6) {
    proposals.push({
      update_type: 'trial_design',
      component: 'trial_categories',
      current_value: 'Current categories: pattern_isolation, alternative_phrasing, boundary_probing, vocab_permutations',
      proposed_value: 'Add category: performance_optimization (test variants that are compliant but optimize CTR)',
      rationale: `We've learned a lot about compliance (${totalTrials} trials, ${(avgSuccess * 100).toFixed(0)}% avg success). Now focus on performance optimization within compliant patterns.`,
      expected_impact: 'Shift from pure compliance to compliance+performance optimization',
      confidence: 0.7,
    });
  }
  
  return proposals;
}

/**
 * Format proposals for human review
 */
export function formatProposalsForReview(proposals: ProposedUpdate[]): string {
  let markdown = '# L3 Prompt and Rule Update Proposals\n\n';
  markdown += `Generated: ${new Date().toISOString()}\n\n`;
  markdown += `Total Proposals: ${proposals.length}\n\n`;
  markdown += '---\n\n';
  
  for (const [idx, proposal] of proposals.entries()) {
    markdown += `## Proposal ${idx + 1}: ${proposal.component}\n\n`;
    markdown += `**Type**: ${proposal.update_type}\n\n`;
    markdown += `**Rationale**: ${proposal.rationale}\n\n`;
    markdown += `**Expected Impact**: ${proposal.expected_impact}\n\n`;
    markdown += `**Confidence**: ${(proposal.confidence * 100).toFixed(0)}%\n\n`;
    markdown += '### Change\n\n';
    markdown += '**Current**:\n```\n' + proposal.current_value + '\n```\n\n';
    markdown += '**Proposed**:\n```\n' + proposal.proposed_value + '\n```\n\n';
    markdown += '---\n\n';
  }
  
  markdown += '## Approval Process\n\n';
  markdown += '1. Review each proposal above\n';
  markdown += '2. Test proposed changes in staging environment\n';
  markdown += '3. Approve or reject with comments\n';
  markdown += '4. Apply approved changes to production config\n';
  markdown += '5. Document in version history\n';
  
  return markdown;
}
