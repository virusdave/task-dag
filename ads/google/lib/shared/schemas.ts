/**
 * Zod schemas for runtime validation of Google Ads optimization data
 * 
 * These schemas validate data contracts between system components and
 * provide type safety for JSON serialization/deserialization.
 */

import { z } from 'zod';

// ============================================================================
// Core Domain Schemas
// ============================================================================

export const AdTypeSchema = z.enum([
  "responsive_search_ad",
  "expanded_text_ad",
  "call_ad",
  "responsive_display_ad",
  "image_ad",
  "video_ad",
]);

export const PolicyStatusSchema = z.enum([
  "approved",
  "approved_limited",
  "disapproved",
  "under_review",
  "unknown",
]);

export const ServingStatusSchema = z.enum([
  "eligible",
  "eligible_limited",
  "not_eligible",
  "pending",
  "unknown",
]);

export const RiskLevelSchema = z.enum(["high", "medium", "low"]);

export const ActionTypeSchema = z.enum(["repair", "replace", "pause", "monitor_only"]);

// ============================================================================
// Helios Snapshot Schemas
// ============================================================================

export const PerformanceMetricsSchema = z.object({
  impressions: z.number().optional(),
  clicks: z.number().optional(),
  conversions: z.number().optional(),
  cost: z.number().optional(),
  ctr: z.number().optional(),
  conversion_rate: z.number().optional(),
  quality_score: z.number().optional(),
});

export const FamilyTagsSchema = z.record(z.string());

export const FamilyKeySchema = z.object({
  account_id: z.string(),
  campaign_name: z.string().optional(),
  creative_theme: z.string().optional(),
  product_tag: z.string().optional(),
});

export const AdSnapshotSchema = z.object({
  account_id: z.string(),
  campaign_id: z.string(),
  campaign_name: z.string(),
  ad_group_id: z.string(),
  ad_group_name: z.string(),
  ad_id: z.string(),
  ad_type: AdTypeSchema,
  ad_status: z.string().optional(),
  headlines: z.array(z.string()),
  descriptions: z.array(z.string()),
  paths: z.array(z.string()).optional(),
  final_url: z.string(),
  policy_status: PolicyStatusSchema,
  policy_topics: z.array(z.string()),
  serving_status: ServingStatusSchema,
  metrics: PerformanceMetricsSchema.optional(),
  family_tags: FamilyTagsSchema,
  snapshot_date: z.string(),
});

// ============================================================================
// L1 Feature Schemas
// ============================================================================

export const TextPatternFeaturesSchema = z.object({
  has_restricted_vocab_buckets: z.array(z.string()),
  urgency_score: z.number().min(0).max(1),
  hype_score: z.number().min(0).max(1),
  capitalization_score: z.number().min(0).max(1),
  punctuation_score: z.number().min(0).max(1),
  medical_claim_patterns: z.array(z.string()),
  superlative_usage: z.array(z.string()),
});

export const StructureFeaturesSchema = z.object({
  headline_lengths: z.array(z.number()),
  description_lengths: z.array(z.number()),
  missing_headlines: z.number(),
  missing_descriptions: z.number(),
  redundancy_score: z.number().min(0).max(1),
  total_char_count: z.number(),
});

export const LandingLinkageFeaturesSchema = z.object({
  final_url_domain: z.string(),
  final_url_family_risk: z.enum(["high", "medium", "low", "unknown"]),
  landing_page_id: z.string().optional(),
  landing_page_policy_status: z.string().optional(),
});

export const NormalizedPolicyStatusSchema = z.object({
  serving_status: ServingStatusSchema,
  policy_topics: z.array(z.string()),
  policy_limit_reasons: z.array(z.string()),
  approval_history: z.array(z.string()).optional(),
});

export const L1FeaturesSchema = z.object({
  ad_id: z.string(),
  text_patterns: TextPatternFeaturesSchema,
  structure: StructureFeaturesSchema,
  landing_linkage: LandingLinkageFeaturesSchema,
  policy_status: NormalizedPolicyStatusSchema,
  extracted_at: z.string(),
});

export const AnomalySchema = z.object({
  ad_id: z.string(),
  anomaly_type: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  details: z.record(z.unknown()),
  suggested_action: z.string().optional(),
});

export const L1FamilySummarySchema = z.object({
  family_key: FamilyKeySchema,
  ads_total: z.number(),
  policy_status_counts: z.record(z.number()),
  pattern_stats: z.record(z.object({
    count: z.number(),
    pct: z.number(),
  })),
  anomalies: z.array(AnomalySchema),
  sample_ad_ids: z.array(z.string()),
  avg_performance: PerformanceMetricsSchema.optional(),
});

export const L1SpotCheckResultSchema = z.object({
  ad_id: z.string(),
  assessment: z.enum(["ok", "borderline", "likely_policy_issue"]),
  issues: z.array(z.string()),
  suggested_new_checks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export const L1RuleUpdateSchema = z.object({
  rule_type: z.enum(["feature_extractor", "threshold", "bucket_definition"]),
  description: z.string(),
  rationale: z.string(),
  proposed_change: z.record(z.unknown()),
});

// ============================================================================
// L2 Strategy & Action Schemas
// ============================================================================

export const FamilyIssueSchema = z.object({
  issue_code: z.string(),
  issue_description: z.string(),
  affected_ad_count: z.number(),
  severity: z.enum(["high", "medium", "low"]),
});

export const SuggestedCreativeSchema = z.object({
  template_id: z.string().optional(),
  variant_label: z.string(),
  ad_type: AdTypeSchema,
  headlines: z.array(z.string()),
  descriptions: z.array(z.string()),
  paths: z.array(z.string()).optional(),
  final_url: z.string().optional(),
  notes_for_human: z.string().optional(),
});

export const AdActionSchema = z.object({
  ad_id: z.string(),
  action_type: ActionTypeSchema,
  issue_codes: z.array(z.string()),
  justification: z.string(),
  suggested_new_creatives: z.array(SuggestedCreativeSchema).optional(),
  csv_batch_number: z.number(),
  csv_row_number: z.number().optional(),
});

export const ControlRefSchema = z.object({
  ad_id: z.string().optional(),
  creative: SuggestedCreativeSchema.optional(),
  label: z.string(),
});

export const SuccessCriteriaSchema = z.object({
  allowed_serving_statuses: z.array(z.string()),
  min_ctr_delta: z.number().optional(),
  min_impressions: z.number().optional(),
  time_window_days: z.number().optional(),
});

export const TrialPlanSchema = z.object({
  trial_id: z.string(),
  trial_group_name: z.string(),
  original_campaign_name: z.string(),
  original_ad_group_name: z.string(),
  trial_budget_usd: z.number(),
  control_ads: z.array(ControlRefSchema),
  variant_creatives: z.array(SuggestedCreativeSchema),
  hypothesis: z.string(),
  policy_class_being_probed: z.string(),
  success_criteria: SuccessCriteriaSchema,
  csv_batch_number: z.number(),
  expected_start_date: z.string().optional(),
  expected_end_date: z.string().optional(),
});

export const FamilyPredictionSchema = z.object({
  family_key: FamilyKeySchema,
  family_risk: RiskLevelSchema,
  risk_score: z.number().min(0).max(1),
  issues: z.array(FamilyIssueSchema),
  ad_actions: z.array(AdActionSchema),
  trial_plans: z.array(TrialPlanSchema),
  l1_summary_ref: z.string(),
});

export const L2PredictionOutputSchema = z.object({
  run_id: z.string(),
  snapshot_date: z.string(),
  families: z.array(FamilyPredictionSchema),
  l1_rule_updates: z.array(L1RuleUpdateSchema),
  prompt_notes_for_l3: z.array(z.string()).optional(),
  generated_at: z.string(),
  l2_prompt_version: z.string(),
  l1_config_version: z.string(),
});

// ============================================================================
// L3 Meta-Analysis Schemas
// ============================================================================

export const PredictionAccuracySchema = z.object({
  precision: z.number(),
  recall: z.number(),
  f1_score: z.number(),
  true_positives: z.number(),
  false_positives: z.number(),
  true_negatives: z.number(),
  false_negatives: z.number(),
  by_risk_level: z.record(z.object({
    precision: z.number(),
    recall: z.number(),
  })).optional(),
});

export const PatternEffectivenessSchema = z.object({
  pattern_id: z.string(),
  pattern_description: z.string(),
  times_recommended: z.number(),
  times_applied: z.number(),
  limitation_reduction_rate: z.number(),
  performance_impact: z.object({
    avg_ctr_delta: z.number(),
    avg_conv_rate_delta: z.number(),
    statistical_significance: z.number(),
  }),
  recommendation: z.enum(["continue", "modify", "retire"]),
});

export const ProposedUpdateSchema = z.object({
  update_type: z.enum(["prompt", "l1_rule", "trial_design", "action_threshold"]),
  component: z.string(),
  current_value: z.union([z.string(), z.record(z.unknown())]),
  proposed_value: z.union([z.string(), z.record(z.unknown())]),
  rationale: z.string(),
  expected_impact: z.string(),
  confidence: z.number().min(0).max(1),
});

export const TrialOutcomeSchema = z.object({
  trial_id: z.string(),
  trial_group_name: z.string(),
  hypothesis: z.string(),
  policy_class_probed: z.string(),
  control_outcomes: z.array(z.object({
    serving_status: ServingStatusSchema,
    metrics: PerformanceMetricsSchema.optional(),
  })),
  variant_outcomes: z.array(z.object({
    variant_label: z.string(),
    serving_status: ServingStatusSchema,
    metrics: PerformanceMetricsSchema.optional(),
  })),
  conclusion: z.string(),
  learned_patterns: z.array(z.string()),
});

export const L3EvaluationOutputSchema = z.object({
  run_id: z.string(),
  evaluation_date: z.string(),
  l2_run_ids_evaluated: z.array(z.string()),
  prediction_accuracy: PredictionAccuracySchema,
  pattern_effectiveness: z.array(PatternEffectivenessSchema),
  trial_outcomes: z.array(TrialOutcomeSchema),
  proposed_updates: z.array(ProposedUpdateSchema),
  governance_status: z.enum(["pending_review", "approved", "rejected"]),
  governance_notes: z.string().optional(),
  generated_at: z.string(),
  l3_prompt_version: z.string(),
});

// ============================================================================
// Run Metadata Schema
// ============================================================================

export const RunMetadataSchema = z.object({
  run_id: z.string(),
  snapshot_date: z.string(),
  snapshot_file: z.string(),
  l1_output_file: z.string().optional(),
  l2_output_file: z.string().optional(),
  html_output_file: z.string().optional(),
  csv_output_dir: z.string().optional(),
  l1_config_version: z.string(),
  l2_prompt_version: z.string(),
  started_at: z.string(),
  completed_at: z.string().optional(),
  status: z.enum(["running", "completed", "failed"]),
  error_message: z.string().optional(),
});
