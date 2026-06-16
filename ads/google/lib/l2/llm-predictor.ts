/**
 * L2 LLM-based Risk Predictor
 * Uses LLM to analyze L1 summaries and generate risk predictions and action plans
 */

import type {
  AdSnapshot,
  FamilyKey,
  FamilyPrediction,
  L1FamilySummary,
  L1RuleUpdate,
  L2PredictionOutput,
  TrialPlan,
} from '../shared/types.js';
import { LLMClient, formatPromptTemplate, loadPromptConfig, readL3Addenda } from '../shared/llm-client.js';

/**
 * Loose shapes for the JSON an LLM returns. The model's output varies
 * run to run (key names, nesting, capitalization), so these boundary
 * interfaces keep every field optional; the normalization code below
 * reconciles them into the canonical {@link L2PredictionOutput} shape.
 */
interface RawLlmIssue {
  issue?: string;
  issue_code?: string;
  issue_description?: string;
  severity?: string;
  affected_ad_count?: number;
}

interface RawLlmAction {
  action?: string;
  action_type?: string;
  ad_id?: string;
  rationale?: string;
  justification?: string;
  csv_batch?: number;
  changes?: Record<string, unknown>;
  modifications?: Record<string, unknown>;
  issue_codes?: string[];
  issues?: string[];
  suggested_new_creatives?: unknown[];
  csv_row_number?: number;
  [key: string]: unknown;
}

interface RawLlmRiskAssessment {
  risk_level?: string;
  risk_score?: number;
  identified_issues?: RawLlmIssue[];
}

interface RawLlmFamily {
  family_key?: FamilyKey;
  family_risk_assessment?: RawLlmRiskAssessment;
  family_risk?: string;
  risk_level?: string;
  risk_score?: number;
  identified_issues?: RawLlmIssue[];
  issues?: RawLlmIssue[];
  ad_actions?: RawLlmAction[];
  ad_level_actions?: RawLlmAction[];
  trial_plans?: TrialPlan[];
  l1_summary_ref?: string;
  family_index?: number;
}

interface RawLlmResponse {
  families?: RawLlmFamily[];
  l2_predictions?: RawLlmFamily[];
  predictions?: RawLlmFamily[];
  family_predictions?: RawLlmFamily[];
  l1_rule_updates?: L1RuleUpdate[];
  ad_actions?: RawLlmAction[];
  ad_level_actions?: RawLlmAction[];
  trial_plans?: TrialPlan[];
}

/** The L2 prompt YAML config loaded by {@link loadPromptConfig}. */
interface L2PromptConfig {
  version?: string;
  main_prompt: {
    system_prompt?: string;
    user_prompt_template?: string;
  };
}

export interface L2PredictorConfig {
  promptConfigPath: string;
  llmClient: LLMClient;
  policyExperiences?: string;
  trialOutcomes?: string;
  /**
   * Optional markdown block listing landing pages with high
   * `landing_page_issue_confidence` (computed by
   * buildSnapshotFromCsv's sidecar). Appended to the per-family
   * system prompt so the LLM knows to recommend `monitor` (not
   * repair/pause) for impaired ads on these URLs — the URL is the
   * blocker, no creative tweak will help.
   */
  landingPageSuspicionMarkdown?: string;
}

/**
 * L2 LLM Predictor
 */
export class L2LLMPredictor {
  private config: L2PredictorConfig;
  private promptConfig!: L2PromptConfig;
  private l3Addenda: string = '';

  constructor(config: L2PredictorConfig) {
    this.config = config;
  }

  /**
   * Initialize by loading prompt configuration + any L3-generated
   * addenda. The addenda are natural-language guidance L3 wrote
   * after meta-analyzing recent runs — they're appended to every
   * per-family system prompt, which is how the feedback loop
   * (L2 output → ad attempts → L3 analysis → addenda → next L2)
   * actually closes. Without this, L3 just produced markdown
   * reports nobody read.
   */
  async initialize(): Promise<void> {
    // Boundary cast: loadPromptConfig returns the parsed YAML as unknown;
    // the L2 prompt file is authored to the L2PromptConfig shape.
    this.promptConfig = (await loadPromptConfig(this.config.promptConfigPath)) as L2PromptConfig;
    this.l3Addenda = await readL3Addenda(this.config.promptConfigPath);
    if (this.l3Addenda) {
      console.log(
        `📝 L2 loaded L3 addenda (${this.l3Addenda.length} chars) — feedback loop active`,
      );
    }
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

    // Format L1 summaries for prompt.
    //
    // The operator's primary goal is re-enabling EVERY disapproved /
    // limited ad in the account — at last count 95 impaired RSAs
    // across the snapshot, while L2 was only emitting ~14 actions.
    // The root cause was that we capped `sample_ads` at 10 per
    // family, so the LLM literally never saw the other 85 impaired
    // ads. We now include ALL impaired ads (no cap) and add a small
    // reference set of eligible ads from the same family as "what
    // currently works", letting the LLM ground its rewrites in
    // proven-good copy from the same context.
    let totalImpairedSent = 0;
    const l1SummariesFormatted = familySummaries.map((summary, idx) => {
      const familyAds = adsByFamilyKey.get(idx) ?? [];

      const impaired = familyAds.filter(
        (ad) =>
          ad.serving_status === 'not_eligible' ||
          ad.serving_status === 'eligible_limited',
      );
      const eligible = familyAds.filter((ad) => ad.serving_status === 'eligible');

      const compactAd = (ad: AdSnapshot) => ({
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
      });

      const impairedAds = impaired.map(compactAd);
      // Keep the eligible reference pool small to leave token budget
      // for the impaired ads (which is where the operator wants
      // coverage). 5 per family is plenty of "what good copy looks
      // like" signal.
      const eligibleReferenceAds = eligible.slice(0, 5).map(compactAd);

      totalImpairedSent += impairedAds.length;

      return {
        family_index: idx,
        family_key: summary.family_key,
        ads_total: summary.ads_total,
        policy_status_counts: summary.policy_status_counts,
        pattern_stats: summary.pattern_stats,
        anomalies: summary.anomalies,
        avg_performance: summary.avg_performance,
        // Every disapproved / limited ad in this family. The LLM
        // MUST emit a repair / replace / pause action for each
        // entry here (prompt instruction below enforces this). The
        // ad_id is the join key downstream CSV emitters use to
        // match this action back to the snapshot ad.
        impaired_ads: impairedAds,
        // Currently-eligible ads from the same family. Use these as
        // "what works for this audience / theme / geo" inspiration
        // when generating replacement copy. Do NOT issue actions
        // against these — they're serving fine.
        eligible_reference_ads: eligibleReferenceAds,
      };
    });
    console.log(
      `🤖 L2 prompt: ${totalImpairedSent} impaired RSAs sent in full to the LLM across ${familySummaries.length} families`,
    );

    // Build user prompt header (system prompt + template).
    //
    // PER-FAMILY BATCHING. The previous design sent ALL families in
    // one LLM call. With 5 families × ~20 impaired ads × full RSA
    // content (15 headlines + 4 descriptions each), the LLM
    // routinely allocated its attention budget to "produce a
    // valid-looking response for 5 families" rather than "carefully
    // repair every impaired ad in each family". The observable
    // symptom was identical pause-with-cookie-cutter-justification
    // rows: the model was triaging by emitting one or two real
    // attempts per family and then bulk-pausing the rest to fit
    // within its reasoning window.
    //
    // We now fire ONE LLM call per family in parallel. Each call
    // has the same large output budget (32K tokens) but a much
    // smaller input set, so the model can dedicate full attention
    // to every impaired ad in the family it's looking at. Total
    // wall time is roughly unchanged because the calls run
    // concurrently.
    const baseSystemPromptRaw = this.promptConfig.main_prompt.system_prompt || '';
    // Insert landing-page suspicion block AFTER the prompt body but
    // BEFORE the L3 addenda, so the LP guidance is treated as a
    // grounded fact about this snapshot rather than a meta-analysis
    // observation. Order is: body → LP suspicion → L3 addenda.
    const lpSuspicion = this.config.landingPageSuspicionMarkdown?.trim();
    const baseSystemPrompt = lpSuspicion
      ? `${baseSystemPromptRaw}\n\n## SUSPECT LANDING PAGES (URL is the problem, not the creative)\n\nThe operator analyzed how Google has graded each landing page in this snapshot. Pages below have multiple impaired ads but Google did NOT cite any specific creative policy topic — strong evidence the URL itself is what's blocking serving.\n\nFor any impaired ad whose \`final_url\` matches one of these, you MUST emit \`action_type: monitor\` (NOT repair, NOT replace, NOT pause), with a short justification like "URL flagged as landing-page suspect (confidence=X.XX); waiting on landing-page fix before churning creative". Repairing or replacing the creative on a URL-blocked ad is wasted effort — it will fail policy on the next review with the same outcome.\n\n${lpSuspicion}`
      : baseSystemPromptRaw;
    // Append the L3 addenda (if any) under a clearly-fenced section
    // so the LLM can attribute the guidance to the meta-analysis
    // layer rather than the original prompt author.
    const systemPrompt = this.l3Addenda
      ? `${baseSystemPrompt}\n\n## L3 META-ANALYSIS ADDENDA (read this — it's based on what we learned from your previous outputs)\n\n${this.l3Addenda}`
      : baseSystemPrompt;
    const userPromptTemplate = this.promptConfig.main_prompt.user_prompt_template || '';
    const llmClient = this.config.llmClient;
    const policyExperiences = this.config.policyExperiences;
    const trialOutcomes = this.config.trialOutcomes;

    const perFamilyResults = await Promise.all(
      l1SummariesFormatted.map(async (familyPayload) => {
        // Pass a 1-element array so the existing prompt template
        // (which expects `{l1_family_summaries}` as JSON) still
        // formats correctly. The LLM continues to return a
        // `families: [...]` shape; we just expect length 1.
        const userPrompt = formatPromptTemplate(userPromptTemplate, {
          l1_family_summaries: JSON.stringify([familyPayload], null, 2),
          l1_spot_check_results: '[]', // TODO: Implement L1 spot-checks
          policy_experiences: policyExperiences || 'No prior experiences available.',
          trial_outcomes: trialOutcomes || 'No prior trial outcomes available.',
        });

        let response;
        try {
          response = await llmClient.callWithRetry({
            use_case: 'gads-ads-l2-content-optimization',
            system_prompt: systemPrompt,
            user_prompt: userPrompt,
            temperature: 0.1,
            // Per-family output budget. At ~250 tokens per
            // ad_action (id + type + justification + 3 headlines +
            // 2 descriptions), 32K supports ~120 actions per
            // family. The largest single family in the current
            // snapshot has 67 impaired ads, so this fits with
            // headroom.
            max_tokens: 32000,
            response_format: 'json',
          });
        } catch (err) {
          // Don't poison the whole run on one family's failure —
          // log and return an empty family record so the others
          // still ship. run-analysis.ts's coverage guardrail will
          // catch a fully-empty run.
          console.warn(
            `⚠️  L2 LLM call failed for family ${JSON.stringify(familyPayload.family_key)}: ${(err as Error).message}`,
          );
          return {
            family_payload: familyPayload,
            rawFamily: null,
            l1_rule_updates: [] as L1RuleUpdate[],
          };
        }

        let parsedResponse: RawLlmResponse;
        try {
          parsedResponse = JSON.parse(response.content);
        } catch (error) {
          console.error(
            `Failed to parse LLM response for family ${JSON.stringify(familyPayload.family_key)}:`,
            response.content.substring(0, 400),
          );
          throw new Error(`Invalid JSON response from LLM: ${error}`);
        }

        const knownKeys = [
          'families',
          'l2_predictions',
          'predictions',
          'family_predictions', // observed in 5/24 per-family responses
        ];
        let rawFamiliesArray: RawLlmFamily[] = [];
        for (const k of Object.keys(parsedResponse ?? {})) {
          if (
            knownKeys.includes(k.toLowerCase()) &&
            Array.isArray((parsedResponse as Record<string, unknown>)[k])
          ) {
            rawFamiliesArray = (parsedResponse as Record<string, unknown>)[k] as RawLlmFamily[];
            break;
          }
        }
        // When we send a single family in the prompt, the LLM often
        // unwraps its response and returns the family object directly
        // at the top level (e.g. `{family_key, ad_actions, ...}`)
        // instead of wrapped in `{families: [{...}]}`. Accept either
        // shape — without this fallback the per-family run silently
        // dropped 4 out of 5 families because the response carried
        // no `families` key. Heuristic: it looks like a family if it
        // has any of the family-level keys we'll read downstream.
        if (rawFamiliesArray.length === 0 && parsedResponse && typeof parsedResponse === 'object') {
          const looksLikeFamily =
            'ad_actions' in parsedResponse ||
            'ad_level_actions' in parsedResponse ||
            'family_key' in parsedResponse ||
            'family_risk_assessment' in parsedResponse ||
            'trial_plans' in parsedResponse;
          if (looksLikeFamily) {
            rawFamiliesArray = [parsedResponse];
          }
        }
        const rawFamily = rawFamiliesArray[0] ?? null;
        if (rawFamiliesArray.length > 1) {
          console.warn(
            `⚠️  Per-family LLM call returned ${rawFamiliesArray.length} families for ${JSON.stringify(familyPayload.family_key)}; using only the first.`,
          );
        }
        if (!rawFamily) {
          console.warn(
            `⚠️  Per-family LLM call for ${JSON.stringify(familyPayload.family_key)} returned an unrecognized shape — keys: ${Object.keys(parsedResponse ?? {}).join(',')}`,
          );
        }
        const impairedCount = familyPayload.impaired_ads.length;
        const actionCount = (rawFamily?.ad_actions ?? rawFamily?.ad_level_actions ?? []).length;
        if (impairedCount > 0) {
          const pct = Math.round((actionCount / impairedCount) * 100);
          console.log(
            `  ${JSON.stringify(familyPayload.family_key)}: ${actionCount}/${impairedCount} impaired ads addressed (${pct}%)`,
          );
        }
        return {
          family_payload: familyPayload,
          rawFamily,
          l1_rule_updates: parsedResponse.l1_rule_updates ?? [],
        };
      }),
    );

    // Combine per-family responses into the canonical shape the
    // downstream code expects. Preserve a slot per input family (in
    // input order) — when a per-family call returned an unrecognized
    // shape we emit an empty stub so downstream `families[idx]`
    // alignment with `familySummaries[idx]` is preserved.
    const rawFamilies: RawLlmFamily[] = perFamilyResults.map((r) =>
      r.rawFamily ?? {
        family_key: r.family_payload.family_key,
        ad_actions: [],
        trial_plans: [],
        issues: [],
      },
    );
    const combinedL1RuleUpdates: L1RuleUpdate[] = perFamilyResults.flatMap(
      (r) => r.l1_rule_updates,
    );
    // Synthesize a parsedResponse-shaped object so downstream code
    // (which reads `parsedResponse.l1_rule_updates`) is unchanged.
    const parsedResponse = { l1_rule_updates: combinedL1RuleUpdates };

    if (rawFamilies.length !== familySummaries.length) {
      console.warn(
        `⚠️  L2 returned ${rawFamilies.length} families, expected ${familySummaries.length} (likely a per-family LLM failure — see warnings above).`,
      );
    }

    // Map LLM response structure to our schema
    // IMPORTANT: Preserve ALL fields from LLM response for downstream CSV/HTML
    const families = rawFamilies.map((fam) => {
      // LLM might return nested structure, flatten it
      const riskAssessment = fam.family_risk_assessment || fam;
      const adActions = fam.ad_level_actions || fam.ad_actions || [];
      const trialPlans = fam.trial_plans || [];
      
      return {
        family_key: fam.family_key,
        family_risk: riskAssessment.risk_level || fam.family_risk || 'low',
        risk_score: riskAssessment.risk_score || fam.risk_score || 0,
        issues: (riskAssessment.identified_issues || fam.issues || []).map((issue: RawLlmIssue) => ({
          issue_code: issue.issue || issue.issue_code || 'unknown',
          issue_description: issue.severity || issue.issue_description || '',
          affected_ad_count: issue.affected_ad_count || 0,
          severity: issue.severity || 'medium',
        })),
        ad_actions: adActions.map((action: RawLlmAction) => {
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
    const validatedFamilies = families.map((family, idx) => ({
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
      // The normalized families are a superset of the canonical contract:
      // they preserve extra LLM-supplied ad fields for downstream CSV/HTML
      // and carry the model's free-text risk/action labels. Adopt the
      // contract shape at this boundary.
      families: validatedFamilies as unknown as FamilyPrediction[],
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
    // 'pending' is the canonical ServingStatus for an ad awaiting
    // review; 'under_review' is retained for older persisted snapshots
    // that used the pre-contract value.
    case 'pending':
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
  extra: {
    policyExperiences?: string;
    trialOutcomes?: string;
    landingPageSuspicionMarkdown?: string;
  } = {}
): Promise<L2LLMPredictor> {
  const predictor = new L2LLMPredictor({
    llmClient,
    promptConfigPath,
    policyExperiences: extra.policyExperiences,
    trialOutcomes: extra.trialOutcomes,
    landingPageSuspicionMarkdown: extra.landingPageSuspicionMarkdown,
  });

  await predictor.initialize();
  return predictor;
}
