#!/usr/bin/env tsx
/**
 * Main orchestration script for Google Ads content analysis
 * 
 * Usage:
 *   ./scripts/run-analysis.ts --snapshot <path> --output-dir <path>
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { AdSnapshot, L1Features, L1FamilySummary, L2PredictionOutput } from '../lib/shared/types.js';
import { generateRunId } from '../lib/shared/utils.js';
import { extractTextPatterns } from '../lib/l1/ad-text-patterns.js';
import { extractStructure } from '../lib/l1/ad-structure.js';
import { extractPolicyStatus } from '../lib/l1/policy-status-extractor.js';
import { extractLandingLinkage } from '../lib/l1/landing-linkage.js';
import { aggregateByFamily } from '../lib/l1/family-aggregation.js';
import { generateCSVBatches, csvBatchToString } from '../lib/l2/csv-generator.js';
import { generateHTMLPacket } from '../lib/html/packet-generator.js';
import { createLLMClientFromEnv } from '../lib/shared/llm-client.js';
import { createL2Predictor } from '../lib/l2/llm-predictor.js';

interface CliArgs {
  snapshotFile: string;
  outputDir: string;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let snapshotFile = '';
  let outputDir = 'outputs';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--snapshot' && i + 1 < args.length) {
      snapshotFile = args[i + 1];
      i++;
    } else if (args[i] === '--output-dir' && i + 1 < args.length) {
      outputDir = args[i + 1];
      i++;
    }
  }
  
  if (!snapshotFile) {
    console.error('Error: --snapshot <file> required');
    process.exit(1);
  }
  
  return { snapshotFile, outputDir };
}

/**
 * Load snapshot from JSONL file
 */
async function loadSnapshot(filePath: string): Promise<AdSnapshot[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  return lines.map(line => JSON.parse(line));
}

/**
 * Load L1 configuration (simplified - would load from YAML)
 */
function loadL1Config() {
  return {
    textPatterns: {
      urgency: { keywords: ['now', 'today', 'hurry'], weight: 0.1, max_score: 1.0 },
      hype: { keywords: ['amazing', 'incredible'], weight: 0.15, max_score: 1.0 },
      superlatives: { patterns: ['best', '#1'], require_qualifier: true },
      capitalization: { threshold: 0.3, ignore_acronyms: true },
      punctuation: { max_exclamations: 1, max_question_marks: 1, max_consecutive_punctuation: 1 },
    },
    restrictedVocabBuckets: {
      cannabis_generic: ['cannabis', 'marijuana', 'weed'],
      medical_claims: ['cure', 'treat', 'heal'],
    },
    structure: {
      rsa: {
        min_headlines: 5, max_headlines: 15,
        min_descriptions: 2, max_descriptions: 4,
        min_headline_length: 15, max_headline_length: 30,
        min_description_length: 60, max_description_length: 90,
      },
      eta: {
        min_headlines: 2, max_headlines: 3,
        min_descriptions: 1, max_descriptions: 2,
        min_headline_length: 15, max_headline_length: 30,
        min_description_length: 60, max_description_length: 90,
      },
      redundancy: { jaccard_threshold: 0.5 },
    },
    policyStatus: {
      topic_mapping: {
        'CANNABIS': 'cannabis',
        'HEALTHCARE': 'healthcare',
      },
      limit_reason_mapping: {
        'CANNABIS_LIMITED': 'cannabis_limited',
      },
    },
    landingLinkage: {
      high_risk_domains: [],
      medium_risk_domains: [],
      mss_integration: { enabled: false, api_endpoint: '' },
    },
    familyAggregation: {
      family_tag_keys: ['creative_theme', 'product_tag'],
      min_family_size: 1, // Lowered for testing with small snapshots
      pattern_threshold: 0.1,
      sample_size: 5,
      sample_strategy: 'mixed' as const,
    },
  };
}

/**
 * Run L1 feature extraction
 */
function runL1Extraction(ads: AdSnapshot[], config: ReturnType<typeof loadL1Config>): Map<string, L1Features> {
  const features = new Map<string, L1Features>();
  
  for (const ad of ads) {
    const textPatterns = extractTextPatterns(ad, config.textPatterns, config.restrictedVocabBuckets);
    const structure = extractStructure(ad, config.structure);
    const policyStatus = extractPolicyStatus(ad, config.policyStatus);
    const landingLinkage = extractLandingLinkage(ad, config.landingLinkage);
    
    features.set(ad.ad_id, {
      ad_id: ad.ad_id,
      text_patterns: textPatterns,
      structure,
      policy_status: policyStatus,
      landing_linkage: landingLinkage,
      extracted_at: new Date().toISOString(),
    });
  }
  
  return features;
}

/**
 * Render a human-readable description from an Anomaly's `details`
 * Record. The previous code did `a.details.toString()` which yields
 * the literal '[object Object]' for any non-trivial details payload
 * — that string then flowed all the way through to the HTML packet's
 * "Main Issues" field. This helper picks the first interesting field
 * and falls back to the anomaly type when details is empty.
 */
function summarizeAnomalyDetails(
  details: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  if (!details || typeof details !== 'object') return fallback;
  const entries = Object.entries(details).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return fallback;
  // Prefer a 'description' / 'message' / 'reason' field if present.
  for (const key of ['description', 'message', 'reason', 'detail', 'summary']) {
    const hit = entries.find(([k]) => k === key);
    if (hit && typeof hit[1] === 'string') return hit[1];
  }
  // Otherwise emit a compact "key=value, key=value" summary.
  return entries
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

/**
 * Mock L2 prediction (simplified - would use LLM)
 */
function mockL2Prediction(familySummaries: L1FamilySummary[], runId: string): L2PredictionOutput {
  return {
    run_id: runId,
    snapshot_date: new Date().toISOString().split('T')[0],
    families: familySummaries.map(summary => ({
      family_key: summary.family_key,
      family_risk: summary.anomalies.length > 0 ? 'high' : 'low',
      risk_score: summary.anomalies.length / 10,
      issues: summary.anomalies.map(a => ({
        issue_code: a.anomaly_type,
        issue_description: summarizeAnomalyDetails(a.details, a.anomaly_type),
        affected_ad_count: 1,
        severity: a.severity,
      })),
      ad_actions: [],
      trial_plans: [],
      l1_summary_ref: `family-${summary.family_key.account_id}`,
    })),
    l1_rule_updates: [],
    generated_at: new Date().toISOString(),
    l2_prompt_version: '1.0.0',
    l1_config_version: '1.0.0',
  };
}

/**
 * Main function
 */
async function main() {
  const args = parseArgs();
  const runId = generateRunId();
  
  console.log(`[${runId}] Starting Google Ads content analysis`);
  console.log(`Snapshot: ${args.snapshotFile}`);
  console.log(`Output: ${args.outputDir}`);
  
  // Load snapshot
  console.log('\n📥 Loading snapshot...');
  const ads = await loadSnapshot(args.snapshotFile);
  console.log(`Loaded ${ads.length} ads`);
  
  // Load config
  console.log('\n⚙️  Loading configuration...');
  const config = loadL1Config();
  
  // Run L1 extraction
  console.log('\n🔍 Running L1 feature extraction...');
  const features = runL1Extraction(ads, config);
  console.log(`Extracted features for ${features.size} ads`);
  
  // Aggregate by family
  console.log('\n📊 Aggregating by family...');
  const familySummaries = aggregateByFamily(ads, features, config.familyAggregation);
  console.log(`Created ${familySummaries.length} family summaries`);
  
  // Run L2 prediction
  console.log('\n🤖 Running L2 prediction...');
  let l2Output: L2PredictionOutput;
  
  // Try to use real LLM if configured, otherwise fall back to mock
  try {
    const llmClient = createLLMClientFromEnv();
    const promptPath = path.join(__dirname, '../config/l2-prompts.yaml');
    // helios's morning bundle prep step writes a per-ad attempt
    // history file and points us at it via this env var so the L2
    // prompt's `policy_experiences` slot is actually populated. If
    // not set (manual / standalone run), the predictor falls back
    // to the literal "No prior experiences available." it used
    // before this wiring existed.
    let policyExperiences: string | undefined = undefined;
    const policyExpFile = process.env.GADS_POLICY_EXPERIENCES_FILE;
    if (policyExpFile) {
      try {
        policyExperiences = await fs.readFile(policyExpFile, 'utf-8');
        console.log(`📚 Loaded prior-attempt context from ${policyExpFile} (${policyExperiences.length} bytes)`);
      } catch (e) {
        console.warn(`⚠️  Could not read GADS_POLICY_EXPERIENCES_FILE=${policyExpFile}: ${(e as Error).message}`);
      }
    }
    const predictor = await createL2Predictor(llmClient, promptPath, {
      policyExperiences,
    });
    l2Output = await predictor.predict(
      familySummaries,
      runId,
      new Date().toISOString().split('T')[0],
      // Pass the loaded snapshot through so the LLM sees real ad
      // creatives (with real ad_ids) for each family, not just
      // aggregate statistics. This is what stops it from
      // hallucinating ad_ids like "NYC Bud | Core-38" that don't
      // exist in the account and makes the produced repair/replace
      // actions actually addressable in Ads Editor.
      ads
    );
  } catch (error: any) {
    const msg = error?.message || String(error);

    const isConfigError =
      msg.includes('LLM credentials') ||
      msg.includes('ENOENT') ||
      msg.includes('Bedrock Mantle token not found');

    const isTransientLLMError =
      msg.includes('LLM API error') ||
      msg.includes('timeout') ||
      msg.includes('network') ||
      msg.includes('Invalid JSON response from LLM') ||
      msg.includes('missing families') ||
      msg.includes('fetch failed');

    if (isConfigError || isTransientLLMError) {
      // GADS_ALLOW_MOCK=1 explicitly opts in to the mock fallback
      // (for local dev / smoke tests). In every other context — and
      // specifically in the gads-run-analysis.service production
      // path — we hard-fail instead of silently producing an empty
      // bundle. The previous behaviour ("⚠️  using mock predictions"
      // → continue with l2Output.families = [] → emit 0-row repair /
      // replace CSVs → bundle uploaded as "success" → operator
      // imports nothing → nothing changes in the account) is what
      // made the operator say the system "basically does nothing".
      if (process.env.GADS_ALLOW_MOCK === '1') {
        console.warn('⚠️  LLM unavailable; GADS_ALLOW_MOCK=1 set, using mock');
        console.warn(`    Error: ${msg}`);
        l2Output = mockL2Prediction(familySummaries, runId);
      } else {
        throw new Error(
          `L2 LLM unavailable and mock fallback is disabled in prod. ` +
            `Refusing to emit a no-op bundle. Set GADS_ALLOW_MOCK=1 to ` +
            `override (smoke tests only). Underlying error: ${msg}`,
        );
      }
    } else {
      throw error;
    }
  }

  console.log(`Generated predictions for ${l2Output.families.length} families`);

  // Coverage guardrail: if the snapshot contains impaired ads (any
  // disapproved or "Approved limited" RSAs) but L2 emitted no
  // actions for them, the bundle would be a no-op. Hard-fail so the
  // operator finds out from the alerting path (systemd unit going
  // red, journalctl) rather than from "why didn't anything change?".
  // The L2 prompt is supposed to repair / replace / pause every
  // impaired ad. If it's not, the prompt needs work — but pretending
  // success is the worst possible outcome.
  const impairedCount = ads.filter(
    (a) => a.serving_status === 'not_eligible' ||
           a.serving_status === 'eligible_limited',
  ).length
  const actionCount = l2Output.families.reduce(
    (acc, f) => acc + (f.ad_actions?.length ?? 0) + (f.trial_plans?.length ?? 0),
    0,
  )
  if (impairedCount > 0 && actionCount === 0) {
    throw new Error(
      `Coverage failure: snapshot has ${impairedCount} impaired RSAs ` +
        `(disapproved or limited) but L2 produced 0 actions across ` +
        `${l2Output.families.length} families. Refusing to emit a no-op ` +
        `bundle. Investigate the L2 prompt / predictor output. Set ` +
        `GADS_ALLOW_NOOP=1 to bypass this guard for diagnostic runs.`,
    )
  }
  if (impairedCount > 0 && actionCount < impairedCount * 0.5) {
    console.warn(
      `⚠️  Coverage warning: ${actionCount} L2 actions for ${impairedCount} ` +
        `impaired RSAs (<50%). Many impaired ads will not be addressed by ` +
        `this bundle. The L2 prompt may need broader grounding.`,
    )
  }
  
  // Generate CSV batches
  console.log('\n📄 Generating CSV batches...');
  // Pass the snapshot ads so the generator can backfill missing
  // Campaign / Ad group cells the L2 LLM left blank, instead of
  // throwing at the "campaign name can't be empty" guard.
  const csvBatches = generateCSVBatches(l2Output, { snapshotAds: ads });
  console.log(`Generated ${csvBatches.length} CSV batches`);
  for (const batch of csvBatches) {
    if (batch.validation_messages.length > 0) {
      console.log(
        `  ⚠ ${String(batch.batch_number).padStart(3, '0')}-${batch.batch_name} (${batch.rows.length} rows, status=${batch.validation_status})`
      );
      for (const m of batch.validation_messages.slice(0, 30)) {
        console.log(`     - ${m}`);
      }
      if (batch.validation_messages.length > 30) {
        console.log(`     … (+${batch.validation_messages.length - 30} more)`);
      }
    }
  }
  
  // Generate HTML packet
  console.log('\n🌐 Generating HTML review packet...');
  const htmlPacket = generateHTMLPacket(l2Output, args.snapshotFile.split('/').pop() || 'unknown');
  console.log('HTML packet generated');
  
  // Write outputs
  console.log('\n💾 Writing outputs...');
  await fs.mkdir(path.join(args.outputDir, 'json'), { recursive: true });
  await fs.mkdir(path.join(args.outputDir, 'csv'), { recursive: true });
  await fs.mkdir(path.join(args.outputDir, 'html'), { recursive: true });
  
  // Write L2 JSON
  await fs.writeFile(
    path.join(args.outputDir, 'json', `${runId}-l2-output.json`),
    JSON.stringify(l2Output, null, 2)
  );
  
  // Write CSV batches
  for (const batch of csvBatches) {
    if (batch.rows.length > 0) {
      const csvContent = csvBatchToString(batch);
      const filename = `${String(batch.batch_number).padStart(3, '0')}-${batch.batch_name}.csv`;
      await fs.writeFile(path.join(args.outputDir, 'csv', filename), csvContent);
      console.log(`  Written: ${filename} (${batch.rows.length} rows)`);
    }
  }
  
  // Write HTML packet
  await fs.writeFile(
    path.join(args.outputDir, 'html', `${runId}-review-packet.html`),
    htmlPacket
  );
  
  console.log('\n✅ Analysis complete!');
  console.log(`\nOutputs:`);
  console.log(`  JSON: ${args.outputDir}/json/${runId}-l2-output.json`);
  console.log(`  CSV:  ${args.outputDir}/csv/`);
  console.log(`  HTML: ${args.outputDir}/html/${runId}-review-packet.html`);
  console.log(`\nNext steps:`);
  console.log(`  1. Open HTML packet for review`);
  console.log(`  2. Import CSVs 001-005 into Ads Editor sequentially`);
}

// Propagate failures as a non-zero exit code so callers (e.g. the
// helios morning-bundle pipeline) can detect them. Previously this
// was `main().catch(console.error)` which logged the error but kept
// exit 0 — silent failures shipped stale bundles to the operator.
main().catch((err) => {
  console.error('run-analysis.ts: fatal error');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
