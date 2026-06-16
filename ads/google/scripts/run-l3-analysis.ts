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
import { spawn } from 'node:child_process';
import type {
  L2PredictionOutput,
  L3EvaluationOutput,
  TrialOutcome,
  AdAction,
  L2RunPredictionAccuracy,
  ProposedUpdate,
} from '../lib/shared/types.js';
import type { ActualFamilyOutcome } from '../lib/l3/prediction-evaluator.js';
import { generateRunId } from '../lib/shared/utils.js';
import { collectTrialOutcomes } from '../lib/l3/outcome-collector.js';
import { evaluatePredictions, evaluatePatternEffectiveness } from '../lib/l3/prediction-evaluator.js';
import { generateUpdateProposals, formatProposalsForReview } from '../lib/l3/prompt-updater.js';
import { createLLMClientFromEnv } from '../lib/shared/llm-client.js';
import { createL3Analyzer } from '../lib/l3/llm-analyzer.js';

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
 * Load L2 outputs. The morning bundle writes them under
 * `outputs/prod/json/`; the old path `outputs/json/` only existed
 * in the test harness and produced an ENOENT in production every
 * Sunday at 04:00 (= L3 never ran). We try the prod path first,
 * fall back to the legacy path for any historical fixtures.
 */
async function loadL2Outputs(runIds: string[]): Promise<L2PredictionOutput[]> {
  const outputs: L2PredictionOutput[] = [];
  const candidates = (id: string) => [
    `outputs/prod/json/${id}-l2-output.json`,
    `outputs/json/${id}-l2-output.json`,
  ];

  for (const runId of runIds) {
    let loaded = false;
    for (const candidate of candidates(runId)) {
      try {
        const content = await fs.readFile(candidate, 'utf-8');
        outputs.push(JSON.parse(content));
        loaded = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    if (!loaded) {
      console.warn(
        `⚠️  L3: L2 run ${runId} not found under outputs/prod/json/ or outputs/json/ — skipping`,
      );
    }
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
async function collectFamilyOutcomes(): Promise<ActualFamilyOutcome[]> {
  // TODO: Query Helios for actual limitation/disapproval rates by family
  
  // Mock for now
  return [];
}

/**
 * Real ad-attempt outcome history, pulled from the Helios
 * `gads_ad_attempts` table via a small standalone script that lives
 * inside `helios/scripts/` (so it has access to the existing pg
 * connection pool config). This is the data L3 used to mock as
 * `collectFamilyOutcomes() => []`. Returns `null` if the script
 * isn't reachable, the DB is down, or DATABASE_URL isn't set —
 * the rest of L3 falls back to its deterministic L2-output-only
 * observations in that case.
 */
interface AdAttemptOutcomes {
  generated_at: string;
  lookback_days: number;
  totals: { attempts: number; observed: number; open: number };
  byActionType: Array<{
    action_type: string;
    total: number;
    observed: number;
    outcomes: Record<string, number>;
  }>;
  byFamily: Array<{
    family_key: Record<string, unknown> | null;
    action_type: string;
    total: number;
    observed: number;
    outcomes: Record<string, number>;
  }>;
}

async function collectAdAttemptOutcomes(): Promise<AdAttemptOutcomes | null> {
  // The L3 service runs with WorkingDirectory=ads/google, so the
  // helios checkout lives two dirs up.
  const heliosDir = path.resolve('../../helios');
  const scriptPath = 'scripts/dump-gads-outcomes.ts';
  try {
    await fs.access(path.join(heliosDir, scriptPath));
  } catch {
    console.warn(`  (helios/${scriptPath} not found — skipping real outcome collection)`);
    return null;
  }
  return new Promise<AdAttemptOutcomes | null>((resolve) => {
    const child = spawn('npx', ['tsx', scriptPath], {
      cwd: heliosDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (b) => chunks.push(b));
    child.stderr.on('data', (b) => errChunks.push(b));
    child.on('error', (err) => {
      console.warn(`  (dump-gads-outcomes spawn failed: ${err.message})`);
      resolve(null);
    });
    child.on('close', (code) => {
      const out = Buffer.concat(chunks).toString('utf-8').trim();
      if (!out) {
        console.warn(`  (dump-gads-outcomes exited ${code} with no stdout)`);
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(out);
        if (parsed.error) {
          console.warn(`  (dump-gads-outcomes returned error: ${parsed.error})`);
          resolve(null);
          return;
        }
        resolve(parsed as AdAttemptOutcomes);
      } catch (err) {
        console.warn(`  (dump-gads-outcomes JSON parse failed: ${(err as Error).message})`);
        resolve(null);
      }
    });
  });
}

/**
 * Translate raw outcome counts into the kind of short, concrete
 * observation that's actually useful inside an LLM prompt addenda.
 * Returns 0..several bullet points; empty array means "nothing
 * worth saying".
 */
function summarizeAdAttemptOutcomes(o: AdAttemptOutcomes): string[] {
  const obs: string[] = [];
  if (o.totals.attempts === 0) return obs;
  obs.push(
    `Tracked ${o.totals.attempts} L2-proposed actions in the last ${o.lookback_days} days (${o.totals.observed} observed outcomes, ${o.totals.open} still open).`,
  );
  for (const a of o.byActionType) {
    if (a.observed === 0) continue;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(a.outcomes)) {
      parts.push(`${k}=${v}`);
    }
    obs.push(
      `Action "${a.action_type}": ${a.total} proposed, ${a.observed} observed → ${parts.join(', ') || 'no outcomes yet'}.`,
    );
  }
  // Surface the worst-performing family/action pair if any
  const observedFamily = o.byFamily.filter((f) => f.observed > 0);
  if (observedFamily.length > 0) {
    const worst = observedFamily
      .map((f) => ({
        f,
        worsePct:
          ((f.outcomes.worse ?? 0) + (f.outcomes.no_change ?? 0)) /
          Math.max(1, f.observed),
      }))
      .sort((a, b) => b.worsePct - a.worsePct)[0];
    if (worst && worst.worsePct >= 0.5) {
      obs.push(
        `Family ${JSON.stringify(worst.f.family_key)} ${worst.f.action_type} actions had ${(worst.worsePct * 100).toFixed(0)}% no_change/worse outcomes — try a different approach for this family.`,
      );
    }
  }
  return obs;
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

  // Collect real ad-attempt outcomes from Helios DB. This is the
  // bit that used to be mocked — now it actually pulls observed
  // outcomes (no_change / superseded / success / worse / etc.) per
  // (family, action_type) over the last 30 days. Result is null if
  // the DB is unreachable; we degrade gracefully.
  console.log('\n📉 Collecting real ad-attempt outcomes from Helios DB...');
  const adAttemptOutcomes = await collectAdAttemptOutcomes();
  if (adAttemptOutcomes) {
    console.log(
      `Pulled ${adAttemptOutcomes.totals.attempts} attempts (${adAttemptOutcomes.totals.observed} observed) over ${adAttemptOutcomes.lookback_days} days`,
    );
  } else {
    console.log('No ad-attempt outcome data available (DB down or empty).');
  }
  
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
  
  // Use LLM for deep analysis and proposal generation
  console.log('\n🤖 Running LLM-based meta-analysis...');
  let l3Output: L3EvaluationOutput;
  const predictionAccuracyArray: L2RunPredictionAccuracy[] = [{
    l2_run_id: options.l2RunIds.join(','),
    total_families: allPredictions.length,
    high_risk_correct: 0,
    high_risk_total: 0,
    medium_risk_correct: 0,
    medium_risk_total: 0,
    low_risk_correct: 0,
    low_risk_total: 0,
    overall_accuracy: predictionAccuracy.precision,
  }];
  
  try {
    const llmClient = createLLMClientFromEnv();
    const analyzer = createL3Analyzer(llmClient);
    
    l3Output = await analyzer.analyze(l2Outputs, trialOutcomes, predictionAccuracyArray);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Missing required environment variables')) {
      console.warn('⚠️  LLM not configured, using deterministic evaluation only');
      
      // Fallback to deterministic analysis
      const proposals = generateUpdateProposals(predictionAccuracy, patternEffectiveness);
      l3Output = {
        evaluation_id: evaluationId,
        l2_runs_analyzed: options.l2RunIds,
        trials_analyzed: trialOutcomes.length,
        prediction_accuracy: predictionAccuracyArray[0],
        trial_insights: [],
        prompt_updates: proposals,
        rule_updates: [],
        generated_at: new Date().toISOString(),
        requires_human_approval: true,
      };
    } else {
      throw error;
    }
  }
  
  console.log(`Generated ${l3Output.prompt_updates.length} prompt updates`);
  console.log(`Generated ${l3Output.rule_updates.length} rule updates`);
  
  // Write outputs
  console.log('\n💾 Writing outputs...');
  await fs.mkdir(options.outputDir, { recursive: true });
  
  const jsonPath = path.join(options.outputDir, `${evaluationId}-l3-evaluation.json`);
  await fs.writeFile(jsonPath, JSON.stringify(l3Output, null, 2));
  console.log(`  JSON: ${jsonPath}`);
  
  const proposalsPath = path.join(options.outputDir, `${evaluationId}-proposals.md`);
  const proposalsMarkdown = formatProposalsForReview(l3Output.prompt_updates);
  await fs.writeFile(proposalsPath, proposalsMarkdown);
  console.log(`  Proposals: ${proposalsPath}`);

  // Close the feedback loop: distil the proposals into a short
  // natural-language addenda that the L2 predictor will read on its
  // next run via readL3Addenda(). Previously the proposals were
  // markdown reports a human had to manually re-encode into the
  // YAML prompt — and the human never did, so L3 never actually
  // improved anything. Now L3 writes directly into the path L2
  // reads, capped at a small handful of high-confidence
  // observations so we don't drown the system prompt in noise.
  const addendaPath = path.resolve('config/l3-addenda.md');
  const highConfidenceUpdates = l3Output.prompt_updates
    .filter((p: ProposedUpdate) => p.update_type === 'prompt' && p.confidence >= 0.6)
    .slice(0, 10);
  const issueObservations = summarizeRecentIssues(l2Outputs);
  const outcomeObservations = adAttemptOutcomes
    ? summarizeAdAttemptOutcomes(adAttemptOutcomes)
    : [];
  const addendaLines: string[] = [];
  addendaLines.push(
    `<!-- Generated by run-l3-analysis.ts at ${new Date().toISOString()}.`,
  );
  addendaLines.push(
    `     Evaluation: ${evaluationId} over L2 runs: ${options.l2RunIds.join(', ')}.`,
  );
  addendaLines.push(
    `     DO NOT EDIT BY HAND — the next L3 run will overwrite this file.`,
  );
  addendaLines.push(`-->`);
  addendaLines.push('');
  addendaLines.push('### What we learned from the last batch of L2 runs');
  addendaLines.push('');
  if (
    issueObservations.length === 0 &&
    highConfidenceUpdates.length === 0 &&
    outcomeObservations.length === 0
  ) {
    addendaLines.push(
      '- (no high-confidence patterns this run — keep doing what you were doing)',
    );
  } else {
    for (const obs of issueObservations) addendaLines.push(`- ${obs}`);
    for (const up of highConfidenceUpdates) {
      addendaLines.push(
        `- ${up.rationale} (expected impact: ${up.expected_impact}; confidence ${(up.confidence * 100).toFixed(0)}%)`,
      );
    }
  }
  if (outcomeObservations.length > 0) {
    addendaLines.push('');
    addendaLines.push(
      '### Real outcomes of your previous proposed actions (from gads_ad_attempts)',
    );
    addendaLines.push('');
    for (const obs of outcomeObservations) addendaLines.push(`- ${obs}`);
  }
  await fs.mkdir(path.dirname(addendaPath), { recursive: true });
  await fs.writeFile(addendaPath, addendaLines.join('\n') + '\n');
  console.log(`  Addenda (consumed by L2 next run): ${addendaPath}`);

  console.log('\n✅ L3 Analysis Complete!');
}

/**
 * Distil concrete, actionable observations from recent L2 outputs.
 * These are deterministic — no LLM involved — so they always run
 * even when the LLM call is unconfigured / down.
 */
function summarizeRecentIssues(l2Outputs: L2PredictionOutput[]): string[] {
  const obs: string[] = [];

  const allActions = l2Outputs.flatMap((o) =>
    o.families.flatMap((f) => f.ad_actions ?? []),
  );
  if (allActions.length === 0) return obs;

  const byType: Record<string, number> = {};
  for (const a of allActions) {
    const t = (a.action_type ?? 'unknown').toLowerCase();
    byType[t] = (byType[t] ?? 0) + 1;
  }
  const total = allActions.length;
  const pausePct = ((byType.pause ?? 0) / total) * 100;
  const repairPct = ((byType.repair ?? 0) / total) * 100;
  if (pausePct > 25) {
    obs.push(
      `Across the last ${l2Outputs.length} runs you emitted ${pausePct.toFixed(0)}% pause actions (${byType.pause} of ${total}). This is too high — most impaired ads can be re-enabled with a small repair. Default to repair, reserve pause for cases where you can name a specific unfixable policy violation.`,
    );
  }
  if (repairPct < 60) {
    obs.push(
      `Repair actions were only ${repairPct.toFixed(0)}% of output across the last ${l2Outputs.length} runs. Target ~80% repair; the operator's goal is to restore revenue from limited/disapproved ads, not to triage them.`,
    );
  }

  // Detect repeated-justification pattern (the cookie-cutter
  // "approved limited, family has disapprovals" template we
  // observed). If any single justification text appears 5+ times,
  // call it out as a signal of triaging-by-template.
  const justificationCounts: Record<string, number> = {};
  for (const a of allActions) {
    const j = (a.justification ?? (a as AdAction & { rationale?: string }).rationale ?? '').trim();
    if (j.length > 40) {
      justificationCounts[j] = (justificationCounts[j] ?? 0) + 1;
    }
  }
  const repeated = Object.entries(justificationCounts).filter(([, c]) => c >= 5);
  if (repeated.length > 0) {
    const example = repeated[0];
    obs.push(
      `You reused the same justification text ${example[1]} times in the last ${l2Outputs.length} runs (e.g. "${example[0].slice(0, 100)}…"). Each impaired ad has its own creative and its own reason for being limited — write a per-ad justification grounded in the specific headlines/descriptions, not a template.`,
    );
  }

  return obs;
}

main().catch(console.error);
