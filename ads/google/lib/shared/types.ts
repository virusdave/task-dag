/**
 * Shared TypeScript type definitions for Google Ads Content Optimization System
 * 
 * These types define the data contracts between:
 * - Helios snapshots
 * - L1 feature extraction
 * - L2 strategy & action planning
 * - L3 meta-analysis
 * - HTML & CSV generation
 */

// ============================================================================
// Core Domain Types
// ============================================================================

export type AdType = 
  | "responsive_search_ad"
  | "expanded_text_ad"
  | "call_ad"
  | "responsive_display_ad"
  | "image_ad"
  | "video_ad";

export type PolicyStatus = 
  | "approved"
  | "approved_limited"
  | "disapproved"
  | "under_review"
  | "unknown";

export type ServingStatus = 
  | "eligible"
  | "eligible_limited"
  | "not_eligible"
  | "pending"
  | "unknown";

export type RiskLevel = "high" | "medium" | "low";

export type ActionType = "repair" | "replace" | "pause" | "monitor_only";

// ============================================================================
// Helios Snapshot Types
// ============================================================================

export interface PerformanceMetrics {
  impressions?: number;
  clicks?: number;
  conversions?: number;
  cost?: number;
  ctr?: number;
  conversion_rate?: number;
  quality_score?: number;
}

export interface FamilyTags {
  [key: string]: string;
}

export interface FamilyKey {
  account_id: string;
  campaign_name?: string;
  creative_theme?: string;
  product_tag?: string;
}

/**
 * Ad snapshot exported from Helios
 * This is the canonical format for all ads exported from the database
 */
export interface AdSnapshot {
  account_id: string;
  campaign_id: string;
  campaign_name: string;
  ad_group_id: string;
  ad_group_name: string;
  ad_id: string;
  ad_type: AdType;
  ad_status?: string;
  headlines: string[];
  descriptions: string[];
  paths?: string[];
  final_url: string;
  policy_status: PolicyStatus;
  policy_topics: string[];
  serving_status: ServingStatus;
  metrics?: PerformanceMetrics;
  family_tags: FamilyTags;
  snapshot_date: string;
}

// ============================================================================
// L1 Feature Types
// ============================================================================

export interface TextPatternFeatures {
  has_restricted_vocab_buckets: string[];  // Category labels, not raw words
  urgency_score: number;                    // 0-1
  hype_score: number;                       // 0-1
  capitalization_score: number;             // 0-1
  punctuation_score: number;                // 0-1
  medical_claim_patterns: string[];         // Detected claim types
  superlative_usage: string[];              // "best", "#1", etc.
}

export interface StructureFeatures {
  headline_lengths: number[];
  description_lengths: number[];
  missing_headlines: number;
  missing_descriptions: number;
  redundancy_score: number;                 // 0-1, Jaccard similarity
  total_char_count: number;
}

export interface LandingLinkageFeatures {
  final_url_domain: string;
  final_url_family_risk: "high" | "medium" | "low" | "unknown";
  landing_page_id?: string;
  landing_page_policy_status?: string;
}

export interface NormalizedPolicyStatus {
  serving_status: ServingStatus;
  policy_topics: string[];                  // Normalized topic codes
  policy_limit_reasons: string[];           // Normalized reason codes
  approval_history?: string[];              // If available
}

/**
 * L1 feature vector for a single ad
 */
export interface L1Features {
  ad_id: string;
  text_patterns: TextPatternFeatures;
  structure: StructureFeatures;
  landing_linkage: LandingLinkageFeatures;
  policy_status: NormalizedPolicyStatus;
  extracted_at: string;
}

/**
 * Anomaly detected by L1
 */
export interface Anomaly {
  ad_id: string;
  anomaly_type: string;
  severity: "high" | "medium" | "low";
  details: Record<string, unknown>;
  suggested_action?: string;
}

/**
 * L1 family-level summary
 */
export interface L1FamilySummary {
  family_key: FamilyKey;
  ads_total: number;
  policy_status_counts: Record<string, number>;
  pattern_stats: Record<string, { count: number; pct: number }>;
  anomalies: Anomaly[];
  sample_ad_ids: string[];
  avg_performance?: PerformanceMetrics;
}

/**
 * L1 spot-check LLM result
 */
export interface L1SpotCheckResult {
  ad_id: string;
  assessment: "ok" | "borderline" | "likely_policy_issue";
  issues: string[];
  suggested_new_checks: string[];
  confidence: number;
}

/**
 * L1 rule update suggestion
 */
export interface L1RuleUpdate {
  rule_type: "feature_extractor" | "threshold" | "bucket_definition";
  description: string;
  rationale: string;
  proposed_change: Record<string, unknown>;
}

// ============================================================================
// L2 Strategy & Action Types
// ============================================================================

export interface FamilyIssue {
  issue_code: string;
  issue_description: string;
  affected_ad_count: number;
  severity: "high" | "medium" | "low";
}

export interface SuggestedCreative {
  template_id?: string;
  variant_label: string;                    // e.g., "soften_medical_claim_v1"
  ad_type: AdType;
  headlines: string[];
  descriptions: string[];
  paths?: string[];
  final_url?: string;
  notes_for_human?: string;
}

export interface AdAction {
  ad_id: string;
  action_type: ActionType;
  issue_codes: string[];
  justification: string;
  suggested_new_creatives?: SuggestedCreative[];
  csv_batch_number: number;
  csv_row_number?: number;
}

export interface ControlRef {
  ad_id?: string;                           // Existing ad to clone
  creative?: SuggestedCreative;             // Or explicit creative
  label: string;
}

export interface SuccessCriteria {
  allowed_serving_statuses: string[];
  min_ctr_delta?: number;
  min_impressions?: number;
  time_window_days?: number;
}

export interface TrialPlan {
  trial_id: string;
  trial_group_name: string;
  original_campaign_name: string;
  original_ad_group_name: string;
  trial_budget_usd: number;
  control_ads: ControlRef[];
  variant_creatives: SuggestedCreative[];
  hypothesis: string;
  policy_class_being_probed: string;
  success_criteria: SuccessCriteria;
  csv_batch_number: number;
  expected_start_date?: string;
  expected_end_date?: string;
}

export interface FamilyPrediction {
  family_key: FamilyKey;
  family_risk: RiskLevel;
  risk_score: number;                       // 0-1
  issues: FamilyIssue[];
  ad_actions: AdAction[];
  trial_plans: TrialPlan[];
  l1_summary_ref: string;                   // Reference to L1 summary
}

/**
 * Complete L2 output
 */
export interface L2PredictionOutput {
  run_id: string;
  snapshot_date: string;
  families: FamilyPrediction[];
  l1_rule_updates: L1RuleUpdate[];
  prompt_notes_for_l3?: string[];
  generated_at: string;
  l2_prompt_version: string;
  l1_config_version: string;
}

// ============================================================================
// L3 Meta-Analysis Types
// ============================================================================

export interface PredictionAccuracy {
  precision: number;                        // TP / (TP + FP)
  recall: number;                           // TP / (TP + FN)
  f1_score: number;
  true_positives: number;
  false_positives: number;
  true_negatives: number;
  false_negatives: number;
  by_risk_level?: Record<RiskLevel, {
    precision: number;
    recall: number;
  }>;
}

export interface PatternEffectiveness {
  pattern_id: string;
  pattern_description: string;
  times_recommended: number;
  times_applied: number;
  limitation_reduction_rate: number;        // % of applied cases that reduced limitations
  performance_impact: {
    avg_ctr_delta: number;
    avg_conv_rate_delta: number;
    statistical_significance: number;
  };
  recommendation: "continue" | "modify" | "retire";
}

export interface ProposedUpdate {
  update_type: "prompt" | "l1_rule" | "trial_design" | "action_threshold";
  component: string;
  current_value: string | Record<string, unknown>;
  proposed_value: string | Record<string, unknown>;
  rationale: string;
  expected_impact: string;
  confidence: number;
}

export interface TrialOutcome {
  trial_id: string;
  trial_group_name: string;
  hypothesis: string;
  policy_class_probed: string;
  control_outcomes: {
    serving_status: ServingStatus;
    metrics?: PerformanceMetrics;
  }[];
  variant_outcomes: {
    variant_label: string;
    serving_status: ServingStatus;
    metrics?: PerformanceMetrics;
  }[];
  conclusion: string;
  learned_patterns: string[];
}

/**
 * Complete L3 output
 */
export interface L3EvaluationOutput {
  run_id: string;
  evaluation_date: string;
  l2_run_ids_evaluated: string[];
  prediction_accuracy: PredictionAccuracy;
  pattern_effectiveness: PatternEffectiveness[];
  trial_outcomes: TrialOutcome[];
  proposed_updates: ProposedUpdate[];
  governance_status: "pending_review" | "approved" | "rejected";
  governance_notes?: string;
  generated_at: string;
  l3_prompt_version: string;
}

// ============================================================================
// CSV & HTML Generation Types
// ============================================================================

export interface CSVBatch {
  batch_number: number;
  batch_name: string;
  description: string;
  rows: CSVRow[];
  validation_status: "valid" | "invalid" | "warning";
  validation_messages: string[];
}

export interface CSVRow {
  row_number: number;
  data: Record<string, string | number>;
  source_action_id?: string;
  source_trial_id?: string;
  notes?: string;
}

export interface HTMLPacket {
  run_id: string;
  snapshot_date: string;
  title: string;
  executive_summary: ExecutiveSummary;
  global_overview: GlobalOverview;
  campaign_sections: CampaignSection[];
  issue_taxonomy: IssueTaxonomy;
  technical_appendix: TechnicalAppendix;
  csv_download_url?: string;
  generated_at: string;
}

export interface ExecutiveSummary {
  total_campaigns: number;
  total_ads: number;
  limited_disapproved_ads: number;
  limited_disapproved_pct: number;
  high_risk_families: number;
  repair_actions: number;
  replacement_actions: number;
  trial_groups: number;
  checklist: string[];
}

export interface GlobalOverview {
  families: {
    family_key: FamilyKey;
    family_risk: RiskLevel;
    limited_disapproved_count: number;
    repair_count: number;
    replacement_count: number;
    trial_count: number;
    anchor_id: string;
  }[];
}

export interface CampaignSection {
  campaign_name: string;
  family_key: FamilyKey;
  summary: {
    objective?: string;
    daily_budget?: number;
    risk_level: RiskLevel;
    main_issues: string[];
  };
  policy_snapshot: {
    ad_group: string;
    eligible: number;
    eligible_limited: number;
    disapproved: number;
    spend_at_risk_pct: number;
  }[];
  repair_actions: AdActionDisplay[];
  replacement_actions: AdActionDisplay[];
  pause_actions: AdActionDisplay[];
  trial_plans: TrialPlanDisplay[];
}

export interface AdActionDisplay {
  ad_group: string;
  ad_id: string;
  before_snippet?: string;
  after_snippet?: string;
  issue_codes: string[];
  csv_ref: string;
}

export interface TrialPlanDisplay {
  trial_name: string;
  hypothesis: string;
  controls: { label: string; snippet: string }[];
  variants: { label: string; snippet: string }[];
  budget: number;
  expected_run_time: string;
  policy_questions: string[];
  csv_refs: string[];
}

export interface IssueTaxonomy {
  risk_definitions: Record<RiskLevel, string>;
  white_grey_hat_constraints: string;
  issue_codes: {
    code: string;
    description: string;
    example_fixes: string[];
  }[];
}

export interface TechnicalAppendix {
  l1_config_version: string;
  l2_prompt_version: string;
  l1_feature_summary: string;
  l2_rationale_summary: string;
  trial_labels: string[];
}

// ============================================================================
// Run Metadata Types
// ============================================================================

export interface RunMetadata {
  run_id: string;
  snapshot_date: string;
  snapshot_file: string;
  l1_output_file?: string;
  l2_output_file?: string;
  html_output_file?: string;
  csv_output_dir?: string;
  l1_config_version: string;
  l2_prompt_version: string;
  started_at: string;
  completed_at?: string;
  status: "running" | "completed" | "failed";
  error_message?: string;
}
