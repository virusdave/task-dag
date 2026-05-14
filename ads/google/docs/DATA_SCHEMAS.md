# Google Ads Content Optimization - Data Schemas

## Overview

This document describes the data schemas used throughout the Google Ads content optimization system. All schemas are defined in TypeScript with Zod runtime validation.

## Schema Files

- **TypeScript Types**: `lib/shared/types.ts` - TypeScript interfaces for compile-time type safety
- **Zod Schemas**: `lib/shared/schemas.ts` - Runtime validation schemas

## Data Flow

```
AdSnapshot (Helios export)
    ↓
L1Features (deterministic extraction)
    ↓
L1FamilySummary (family aggregation)
    ↓
L2PredictionOutput (strategy & actions)
    ↓
CSVBatch + HTMLPacket (human review)
    ↓
(CSV import via Ads Editor)
    ↓
AdSnapshot (new state)
    ↓
L3EvaluationOutput (meta-analysis)
```

## Core Domain Types

### AdType
Enumeration of supported Google Ads ad types:
- `responsive_search_ad`
- `expanded_text_ad`
- `call_ad`
- `responsive_display_ad`
- `image_ad`
- `video_ad`

### PolicyStatus
Ad policy approval status:
- `approved` - Fully approved
- `approved_limited` - Approved but with serving limitations
- `disapproved` - Rejected by policy review
- `under_review` - Pending policy review
- `unknown` - Status unavailable

### ServingStatus
Ad serving eligibility:
- `eligible` - Fully eligible to serve
- `eligible_limited` - Eligible but with limitations
- `not_eligible` - Cannot serve
- `pending` - Status pending
- `unknown` - Status unavailable

### RiskLevel
Predicted policy risk level:
- `high` - High probability of limitation/disapproval
- `medium` - Moderate risk
- `low` - Low risk

### ActionType
Recommended action for an ad:
- `repair` - Inline edit to existing ad
- `replace` - Create new compliant ad
- `pause` - Pause the ad
- `monitor_only` - Watch but no immediate action

## Helios Snapshot Schema

### AdSnapshot
Complete ad state exported from Helios:

```typescript
{
  account_id: string;
  campaign_id: string;
  campaign_name: string;
  ad_group_id: string;
  ad_group_name: string;
  ad_id: string;
  ad_type: AdType;
  ad_status?: string;
  headlines: string[];              // RSA: up to 15, ETA: up to 3
  descriptions: string[];           // RSA: up to 4, ETA: up to 2
  paths?: string[];                 // Optional path1, path2
  final_url: string;
  policy_status: PolicyStatus;
  policy_topics: string[];          // Policy topic codes
  serving_status: ServingStatus;
  metrics?: PerformanceMetrics;
  family_tags: FamilyTags;          // Custom tags for family grouping
  snapshot_date: string;            // ISO 8601 date
}
```

### PerformanceMetrics
Ad performance data:

```typescript
{
  impressions?: number;
  clicks?: number;
  conversions?: number;
  cost?: number;
  ctr?: number;                     // Click-through rate
  conversion_rate?: number;
  quality_score?: number;           // If available
}
```

### FamilyTags
Custom tags for grouping ads into creative families:

```typescript
{
  [key: string]: string;            // e.g., {"product": "flower", "theme": "brand"}
}
```

### FamilyKey
Identifier for a creative family:

```typescript
{
  account_id: string;
  campaign_name?: string;
  creative_theme?: string;          // e.g., "brand", "promo", "educational"
  product_tag?: string;             // e.g., "flower", "edibles", "vapes"
}
```

## L1 Feature Schemas

### L1Features
Complete feature vector for a single ad:

```typescript
{
  ad_id: string;
  text_patterns: TextPatternFeatures;
  structure: StructureFeatures;
  landing_linkage: LandingLinkageFeatures;
  policy_status: NormalizedPolicyStatus;
  extracted_at: string;             // ISO 8601 timestamp
}
```

### TextPatternFeatures
Text-based pattern detection:

```typescript
{
  has_restricted_vocab_buckets: string[];   // ["cannabis_generic", "medical_claim"]
  urgency_score: number;                    // 0-1, urgency language intensity
  hype_score: number;                       // 0-1, hype/superlative intensity
  capitalization_score: number;             // 0-1, excessive caps usage
  punctuation_score: number;                // 0-1, excessive punctuation
  medical_claim_patterns: string[];         // Detected medical claim types
  superlative_usage: string[];              // ["best", "#1", "guaranteed"]
}
```

### StructureFeatures
Ad structure analysis:

```typescript
{
  headline_lengths: number[];               // Character count per headline
  description_lengths: number[];            // Character count per description
  missing_headlines: number;                // Count of unused headline slots
  missing_descriptions: number;             // Count of unused description slots
  redundancy_score: number;                 // 0-1, Jaccard similarity across elements
  total_char_count: number;                 // Total characters used
}
```

### LandingLinkageFeatures
Landing page linkage analysis:

```typescript
{
  final_url_domain: string;
  final_url_family_risk: "high" | "medium" | "low" | "unknown";
  landing_page_id?: string;                 // MSS landing page ID if known
  landing_page_policy_status?: string;      // MSS LP policy status if known
}
```

### NormalizedPolicyStatus
Normalized policy information:

```typescript
{
  serving_status: ServingStatus;
  policy_topics: string[];                  // Normalized Google policy topic codes
  policy_limit_reasons: string[];           // Normalized limitation reason codes
  approval_history?: string[];              // Historical approval states if available
}
```

### L1FamilySummary
Aggregated features for a creative family:

```typescript
{
  family_key: FamilyKey;
  ads_total: number;
  policy_status_counts: {                   // e.g., {"approved": 30, "approved_limited": 12}
    [status: string]: number;
  };
  pattern_stats: {                          // e.g., {"urgency_score>0.8": {count: 10, pct: 0.21}}
    [pattern: string]: {
      count: number;
      pct: number;
    };
  };
  anomalies: Anomaly[];
  sample_ad_ids: string[];                  // 3-5 representative ad IDs
  avg_performance?: PerformanceMetrics;
}
```

### Anomaly
Detected anomaly in L1 analysis:

```typescript
{
  ad_id: string;
  anomaly_type: string;                     // e.g., "disapproved_with_no_restricted_vocab"
  severity: "high" | "medium" | "low";
  details: Record<string, unknown>;
  suggested_action?: string;
}
```

### L1SpotCheckResult
LLM spot-check result for sampled ads:

```typescript
{
  ad_id: string;
  assessment: "ok" | "borderline" | "likely_policy_issue";
  issues: string[];
  suggested_new_checks: string[];           // Suggestions for new L1 extractors
  confidence: number;                       // 0-1
}
```

### L1RuleUpdate
Suggested update to L1 extraction rules:

```typescript
{
  rule_type: "feature_extractor" | "threshold" | "bucket_definition";
  description: string;
  rationale: string;
  proposed_change: Record<string, unknown>;
}
```

## L2 Strategy & Action Schemas

### L2PredictionOutput
Complete L2 output for a run:

```typescript
{
  run_id: string;
  snapshot_date: string;
  families: FamilyPrediction[];
  l1_rule_updates: L1RuleUpdate[];
  prompt_notes_for_l3?: string[];           // Notes for L3 meta-analysis
  generated_at: string;
  l2_prompt_version: string;
  l1_config_version: string;
}
```

### FamilyPrediction
L2 predictions and actions for a single family:

```typescript
{
  family_key: FamilyKey;
  family_risk: RiskLevel;
  risk_score: number;                       // 0-1 continuous risk score
  issues: FamilyIssue[];
  ad_actions: AdAction[];
  trial_plans: TrialPlan[];
  l1_summary_ref: string;                   // Reference to L1FamilySummary
}
```

### FamilyIssue
Identified issue affecting a family:

```typescript
{
  issue_code: string;                       // e.g., "MEDICAL_CLAIM_PATTERN"
  issue_description: string;
  affected_ad_count: number;
  severity: "high" | "medium" | "low";
}
```

### AdAction
Recommended action for a specific ad:

```typescript
{
  ad_id: string;
  action_type: ActionType;
  issue_codes: string[];                    // Issue codes being addressed
  justification: string;
  suggested_new_creatives?: SuggestedCreative[];
  csv_batch_number: number;                 // Which CSV (001-005) contains this action
  csv_row_number?: number;                  // Row number within the CSV
}
```

### SuggestedCreative
New or modified creative:

```typescript
{
  template_id?: string;                     // Template for grouping similar variants
  variant_label: string;                    // e.g., "soften_medical_claim_v1"
  ad_type: AdType;
  headlines: string[];
  descriptions: string[];
  paths?: string[];
  final_url?: string;
  notes_for_human?: string;                 // Explanation for reviewer
}
```

### TrialPlan
Experimental trial group design:

```typescript
{
  trial_id: string;
  trial_group_name: string;                 // e.g., "<ad-group>-trial-001"
  original_campaign_name: string;
  original_ad_group_name: string;
  trial_budget_usd: number;                 // Typically 1
  control_ads: ControlRef[];                // 1-2 controls
  variant_creatives: SuggestedCreative[];   // 1-3 variants
  hypothesis: string;
  policy_class_being_probed: string;        // e.g., "Restricted drug terms vs educational content"
  success_criteria: SuccessCriteria;
  csv_batch_number: number;
  expected_start_date?: string;
  expected_end_date?: string;
}
```

### ControlRef
Reference to control ad in a trial:

```typescript
{
  ad_id?: string;                           // Existing ad to clone
  creative?: SuggestedCreative;             // Or explicit creative
  label: string;                            // e.g., "current_approved_baseline"
}
```

### SuccessCriteria
Trial success criteria:

```typescript
{
  allowed_serving_statuses: string[];       // e.g., ["eligible", "eligible_limited"]
  min_ctr_delta?: number;                   // Minimum CTR improvement vs control
  min_impressions?: number;                 // Minimum impressions before evaluation
  time_window_days?: number;                // Days to run trial
}
```

## L3 Meta-Analysis Schemas

### L3EvaluationOutput
Complete L3 evaluation output:

```typescript
{
  run_id: string;
  evaluation_date: string;
  l2_run_ids_evaluated: string[];           // Which L2 runs were analyzed
  prediction_accuracy: PredictionAccuracy;
  pattern_effectiveness: PatternEffectiveness[];
  trial_outcomes: TrialOutcome[];
  proposed_updates: ProposedUpdate[];
  governance_status: "pending_review" | "approved" | "rejected";
  governance_notes?: string;
  generated_at: string;
  l3_prompt_version: string;
}
```

### PredictionAccuracy
L2 prediction accuracy metrics:

```typescript
{
  precision: number;                        // TP / (TP + FP)
  recall: number;                           // TP / (TP + FN)
  f1_score: number;
  true_positives: number;
  false_positives: number;
  true_negatives: number;
  false_negatives: number;
  by_risk_level?: {                         // Breakdown by risk level
    [level: string]: {
      precision: number;
      recall: number;
    };
  };
}
```

### PatternEffectiveness
Effectiveness of a recommended pattern:

```typescript
{
  pattern_id: string;
  pattern_description: string;
  times_recommended: number;
  times_applied: number;
  limitation_reduction_rate: number;        // % that reduced limitations
  performance_impact: {
    avg_ctr_delta: number;
    avg_conv_rate_delta: number;
    statistical_significance: number;       // p-value
  };
  recommendation: "continue" | "modify" | "retire";
}
```

### ProposedUpdate
L3 proposed change to prompts/rules:

```typescript
{
  update_type: "prompt" | "l1_rule" | "trial_design" | "action_threshold";
  component: string;                        // Which component to update
  current_value: string | Record<string, unknown>;
  proposed_value: string | Record<string, unknown>;
  rationale: string;
  expected_impact: string;
  confidence: number;                       // 0-1
}
```

### TrialOutcome
Results from a completed trial:

```typescript
{
  trial_id: string;
  trial_group_name: string;
  hypothesis: string;
  policy_class_probed: string;
  control_outcomes: Array<{
    serving_status: ServingStatus;
    metrics?: PerformanceMetrics;
  }>;
  variant_outcomes: Array<{
    variant_label: string;
    serving_status: ServingStatus;
    metrics?: PerformanceMetrics;
  }>;
  conclusion: string;
  learned_patterns: string[];               // Patterns learned from this trial
}
```

## CSV & HTML Generation Schemas

### CSVBatch
A single CSV file for Ads Editor import:

```typescript
{
  batch_number: number;                     // 001-005
  batch_name: string;                       // e.g., "create-trial-campaigns-and-ad-groups"
  description: string;
  rows: CSVRow[];
  validation_status: "valid" | "invalid" | "warning";
  validation_messages: string[];
}
```

### CSVRow
A single row in a CSV batch:

```typescript
{
  row_number: number;
  data: Record<string, string | number>;    // Column name → value
  source_action_id?: string;                // Reference to AdAction
  source_trial_id?: string;                 // Reference to TrialPlan
  notes?: string;                           // Internal notes (not in CSV)
}
```

## Run Metadata Schema

### RunMetadata
Metadata tracking for a full run:

```typescript
{
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
```

## Validation

All schemas include Zod validators for runtime validation. Example usage:

```typescript
import { AdSnapshotSchema } from './lib/shared/schemas.js';

const adData = JSON.parse(jsonString);
const validatedAd = AdSnapshotSchema.parse(adData); // Throws if invalid
```

## Schema Versioning

Schemas are versioned using config version strings:
- `l1_config_version`: L1 feature extractor configuration version (e.g., "1.0.0")
- `l2_prompt_version`: L2 LLM prompt version (e.g., "1.2.0")
- `l3_prompt_version`: L3 LLM prompt version (e.g., "1.0.0")

Version changes trigger schema migrations and ensure backward compatibility tracking.
