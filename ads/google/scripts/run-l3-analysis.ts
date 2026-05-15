#!/usr/bin/env tsx
/**
 * Run L3 meta-analysis on completed trials
 * 
 * Evaluates L2 predictions against actual outcomes and generates
 * prompt/rule update proposals
 * 
 * Usage:
 *   ./scripts/run-l3-analysis.ts --l2-runs run-2026-05-15-abc,run-2026-05-16-def
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  L2PredictionOutput,
  L3EvaluationOutput,
  TrialOutcome,
} from '../lib/shared/types.js';
import { generateRunId } from '../lib/shared/utils.js';
import { collectTrialOutcomes } from '../lib/l3/outcome-collector.js';
import { evaluatePredictions, evaluatePatternEffectiveness } from '../lib/l3/prediction-evaluator.js';
import { generateUpdateProposals, formatProposalsForReview } from '../lib/l3/prompt-updater.js';

interface L3Options {
  l2RunIds: string[];
  outputDir: string;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): L3Options {
  const args = process.argv.slice(2);
  let l2RunIds: string[] = [];
  let outputDir = 'outputs/l3';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--l2-runs' && i + 1 < args.length) {
      l2RunIds = args[i + 1].split(',');
      i++;
    } else if (args[i] === '--output-dir' && i + 1 < args.length) {
      outputDir = args[i + 1];
      i++;
    }
  }
  
  if (l2RunIds.length === 0) {
    console.error('Error: --l2-runs <id1,id2,...> required');
    process.exit(1);
  }
  
  return { l2RunIds, outputDir };
}

/**
 * Load L2 outputs
 */
async function loadL2Outputs(runIds: string[]): Promise<L2PredictionOutput[]> {
  const outputs: L2PredictionOutput[] = [];
  
  for (const runId of runIds) {
    const filepath = `outputs/json/${runId}-l2-output.json`;
    const content = await fs.readFile(filepath, 'utf-8');
    outputs.push(JSON.parse(content));
  }
  
  return outputs;
}

/**
 * Collect all trial outcomes from Helios
 */
async function collectAllTrialOutcomes(l2Outputs: L2PredictionOutput[]): Promise<TrialOutcome[]> {
  // TODO: Query Helios for all trial outcomes
  // const heliosSnapshots = await queryHeliosForTrialSnapshots({ ... });
  
  const allTrialPlans = l2Outputs.flatMap(l2 => 
    l2.families.flatMap(f => f.trial_plans)
  );
  
  // Mock for now
  const outcomes = await collectTrialOutcomes(allTrialPlans, []);
  
  return outcomes;
}

/**
 * Collect actual family outcomes from Helios
 */
async function collectFamilyOutcomes(): Promise<any[]> {
  // TODO: Query Helios for actual limitation/disapproval rates by family
  
  // Mock for now
  return [];
}

/**
 * Main
 */
async function main() {
  const options = parseArgs();
  const evaluationId = generateRunId();
  
  console.log(`🤖 Running L3 Meta-Analysis`);
  console.log(`Evaluation ID: ${evaluationId}`);
  console.log(`L2 Runs: ${options.l2RunIds.join(', ')}\n`);
  
  // Load L2 outputs
  console.log('📥 Loading L2 outputs...');
  const l2Outputs = await loadL2Outputs(options.l2RunIds);
  console.log(`Loaded ${l2Outputs.length} L2 runs`);
  
  // Collect trial outcomes
  console.log('\n📊 Collecting trial outcomes...');
  const trialOutcomes = await collectAllTrialOutcomes(l2Outputs);
  console.log(`Collected ${trialOutcomes.length} trial outcomes`);
  
  // Collect actual family outcomes
  console.log('\n📈 Collecting family outcomes...');
  const familyOutcomes = await collectFamilyOutcomes();
  console.log(`Collected ${familyOutcomes.length} family outcomes`);
  
  // Evaluate predictions
  console.log('\n🎯 Evaluating predictions...');
  const allPredictions = l2Outputs.flatMap(l2 => l2.families);
  const predictionAccuracy = evaluatePredictions(allPredictions, familyOutcomes);
  console.log(`Precision: ${(predictionAccuracy.precision * 100).toFixed(1)}%`);
  console.log(`Recall: ${(predictionAccuracy.recall * 100).toFixed(1)}%`);
  console.log(`F1 Score: ${(predictionAccuracy.f1_score * 100).toFixed(1)}%`);
  
  // Evaluate pattern effectiveness
  console.log('\n🔬 Evaluating pattern effectiveness...');
  const patternEffectiveness = evaluatePatternEffectiveness(trialOutcomes);
  console.log(`Analyzed ${patternEffectiveness.length} patterns`);
  
  const effective = patternEffectiveness.filter(p => p.recommendation === 'continue');
  const ineffective = patternEffectiveness.filter(p => p.recommendation === 'retire');
  console.log(`  Continue: ${effective.length}`);
  console.log(`  Retire: ${ineffective.length}`);
  
  // Generate update proposals
  console.log('\n💡 Generating update proposals...');
  const proposals = generateUpdateProposals(predictionAccuracy, patternEffectiveness);
  console.log(`Generated ${proposals.length} proposals`);
  
  // Build L3 output
  const l3Output: L3EvaluationOutput = {
    run_id: evaluationId,
    evaluation_date: new Date().toISOString().split('T')[0],
    l2_run_ids_evaluated: options.l2RunIds,
    prediction_accuracy: predictionAccuracy,
    pattern_effectiveness: patternEffectiveness,
    trial_outcomes: trialOutcomes,
    proposed_updates: proposals,
    governance_status: 'pending_review',
    generated_at: new Date().toISOString(),
    l3_prompt_version: '1.0.0',
  };
  
  // Write outputs
  console.log('\n💾 Writing outputs...');
  await fs.mkdir(options.outputDir, { recursive: true });
  
  const jsonPath = path.join(options.outputDir, `${evaluationId}-l3-evaluation.json`);
  await fs.writeFile(jsonPath, JSON.stringify(l3Output, null, 2));
  console.log(`  JSON: ${jsonPath}`);
  
  const proposalsPath = path.join(options.outputDir, `${evaluationId}-proposals.md`);
  const proposalsMarkdown = formatProposalsForReview(proposals);
  await fs.writeFile(proposalsPath, proposalsMarkdown);
  console.log(`  Proposals: ${proposalsPath}`);
  
  console.log('\n✅ L3 Analysis Complete!');
  console.log(`\nNext Steps:`);
  console.log(`  1. Review proposals: ${proposalsPath}`);
  console.log(`  2. Test proposed changes in staging`);
  console.log(`  3. Approve/reject proposals`);
  console.log(`  4. Apply approved changes to config`);
}

main().catch(console.error);
