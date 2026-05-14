# Google Ads Content Optimization - Implementation Plan

## Executive Summary

This document outlines the detailed implementation plan for migrating the three-layer agentic hill-climbing approach from the mostly-static-sites repository to the automation repository for Google Ads content optimization.

**Target**: Issue #8 - Migrate three-layer agentic approach for Google Ads hill-climbing
**Epic Task SHA**: `90c06c8`
**Estimated Effort**: XL (3–5 days for initial milestone)

## Milestone Breakdown

### Milestone 1: Architecture & Foundation
**Goal**: Establish directory structure, documentation, and data schemas
**Deliverables**:
- [x] Architecture documentation
- [ ] Implementation plan
- [ ] Data schemas and TypeScript interfaces
- [ ] Directory structure setup
- [ ] Update LLM use registry
- [ ] Create policy review compliance docs

**Effort**: S (0.5 days)

### Milestone 2: Helios Integration & Snapshot Export
**Goal**: Build the pipeline from Google Ads → Helios → Automation
**Deliverables**:
- [ ] Helios schema design for Google Ads tables
- [ ] Snapshot export script (`scripts/gads/export-ads-snapshot.ts`)
- [ ] Canonical JSONL format specification
- [ ] Initial test snapshot generation

**Effort**: M (1 day)

### Milestone 3: Layer 1 - Ads Content Analysis Engine
**Goal**: Implement deterministic extractors and LLM spot-checks
**Deliverables**:
- [ ] `lib/l1/ad-text-patterns.ts`
- [ ] `lib/l1/ad-structure.ts`
- [ ] `lib/l1/ad-landing-linkage.ts`
- [ ] `lib/l1/policy-status-extractor.ts`
- [ ] `lib/l1/family-aggregation.ts`
- [ ] `lib/l1/llm-spot-check.ts`
- [ ] L1 test suite

**Effort**: L (2 days)

### Milestone 4: Layer 2 - Content Strategy & CSV Generation
**Goal**: Build risk prediction, action planning, and CSV generation
**Deliverables**:
- [ ] `lib/l2/risk-predictor.ts`
- [ ] `lib/l2/action-planner.ts`
- [ ] `lib/l2/trial-designer.ts`
- [ ] `lib/l2/csv-generator.ts`
- [ ] L2 LLM orchestration
- [ ] White-/grey-hat constraints validation

**Effort**: L (2 days)

### Milestone 5: HTML Review Packet Generator
**Goal**: Create human-readable review interface
**Deliverables**:
- [ ] `lib/html/packet-generator.ts`
- [ ] HTML templates (executive summary, family sections, appendix)
- [ ] CSS styling (responsive, printable)
- [ ] Interactive features (collapsible sections, tooltips)
- [ ] CSV download bundling (ZIP)

**Effort**: M (1 day)

### Milestone 6: MSS Integration & Orchestration
**Goal**: Connect automation repo to MSS scanner
**Deliverables**:
- [ ] MSS script: `scripts/scan-gads-ads-content.ts`
- [ ] Automation orchestrator: `scripts/gads/run-full-scan.ts`
- [ ] Inter-repo data contracts
- [ ] Run metadata tracking

**Effort**: M (1 day)

### Milestone 7: mss-one-offs Integration
**Goal**: Serve HTML review packets via one-offs service
**Deliverables**:
- [ ] mss-one-offs client integration
- [ ] 24-hour TTL configuration
- [ ] Nonce generation and tracking
- [ ] litalerts payload generation

**Effort**: S (0.5 days)

### Milestone 8: litalerts Integration
**Goal**: Automated alerting for new review packets
**Deliverables**:
- [ ] litalerts trigger logic
- [ ] Alert template with HTML link, CSV link, summary
- [ ] Priority calculation (based on risk levels)
- [ ] Test alert generation

**Effort**: S (0.5 days)

### Milestone 9: Layer 3 - Meta-Analysis Framework
**Goal**: Build self-improvement loop
**Deliverables**:
- [ ] `lib/l3/outcome-collector.ts`
- [ ] `lib/l3/prediction-evaluator.ts`
- [ ] `lib/l3/prompt-updater.ts`
- [ ] Governance approval workflow
- [ ] Version tracking system

**Effort**: L (2 days)

### Milestone 10: Testing & Validation
**Goal**: End-to-end testing and production readiness
**Deliverables**:
- [ ] Unit tests for all L1/L2/L3 modules
- [ ] Integration tests for full pipeline
- [ ] Mock Helios data generation
- [ ] Dry-run mode testing
- [ ] CSV validation tests
- [ ] HTML packet review

**Effort**: M (1 day)

### Milestone 11: Documentation & Handoff
**Goal**: Complete documentation for operations
**Deliverables**:
- [ ] Operator runbook
- [ ] Troubleshooting guide
- [ ] CSV import instructions
- [ ] Trial monitoring guide
- [ ] Post to GitHub issue comments

**Effort**: S (0.5 days)

## Total Estimated Effort: 13 days

Breakdown:
- Foundation: 0.5 days
- Helios Integration: 1 day
- L1 Implementation: 2 days
- L2 Implementation: 2 days
- HTML Generator: 1 day
- MSS Integration: 1 day
- one-offs Integration: 0.5 days
- litalerts Integration: 0.5 days
- L3 Implementation: 2 days
- Testing: 1 day
- Documentation: 0.5 days

## Dependency Graph

```
M1 (Foundation)
  ↓
M2 (Helios) ──────┐
  ↓               │
M3 (L1) ──────┐   │
  ↓           │   │
M4 (L2) ──────┼───┼── M5 (HTML)
  ↓           │   │      ↓
M6 (MSS) ←────┴───┘      ↓
  ↓                      ↓
M7 (one-offs) ←──────────┘
  ↓
M8 (litalerts)
  ↓
M9 (L3) ←── (requires multiple runs)
  ↓
M10 (Testing)
  ↓
M11 (Documentation)
```

## Critical Path

1. M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M10 → M11
2. M9 (L3) can be developed in parallel after M3/M4 but requires operational data

## Implementation Details

### Phase 1: Foundation Setup

#### Directory Structure
```
automation/
├── ads/
│   └── google/
│       ├── docs/
│       │   ├── ARCHITECTURE.md
│       │   ├── IMPLEMENTATION_PLAN.md
│       │   ├── DATA_SCHEMAS.md
│       │   └── OPERATOR_RUNBOOK.md
│       ├── lib/
│       │   ├── l1/
│       │   │   ├── ad-text-patterns.ts
│       │   │   ├── ad-structure.ts
│       │   │   ├── ad-landing-linkage.ts
│       │   │   ├── policy-status-extractor.ts
│       │   │   ├── family-aggregation.ts
│       │   │   └── llm-spot-check.ts
│       │   ├── l2/
│       │   │   ├── risk-predictor.ts
│       │   │   ├── action-planner.ts
│       │   │   ├── trial-designer.ts
│       │   │   └── csv-generator.ts
│       │   ├── l3/
│       │   │   ├── outcome-collector.ts
│       │   │   ├── prediction-evaluator.ts
│       │   │   └── prompt-updater.ts
│       │   ├── html/
│       │   │   ├── packet-generator.ts
│       │   │   └── templates/
│       │   └── shared/
│       │       ├── types.ts
│       │       ├── schemas.ts
│       │       └── utils.ts
│       ├── scripts/
│       │   ├── export-ads-snapshot.ts
│       │   ├── run-full-scan.ts
│       │   └── analyze-trial-results.ts
│       ├── snapshots/
│       ├── outputs/
│       │   ├── json/
│       │   ├── html/
│       │   └── csv/
│       └── config/
│           ├── l1-config.yaml
│           ├── l2-prompts.yaml
│           └── trial-templates.yaml
```

#### Key Files to Create

1. **Data Schemas** (`lib/shared/schemas.ts`):
```typescript
// Ad snapshot from Helios
export interface AdSnapshot {
  account_id: string;
  campaign_id: string;
  campaign_name: string;
  ad_group_id: string;
  ad_group_name: string;
  ad_id: string;
  ad_type: AdType;
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

// L1 feature vector
export interface L1Features {
  ad_id: string;
  text_patterns: TextPatternFeatures;
  structure: StructureFeatures;
  landing_linkage: LandingLinkageFeatures;
  policy_status: NormalizedPolicyStatus;
}

// L1 family summary
export interface L1FamilySummary {
  family_key: FamilyKey;
  ads_total: number;
  policy_status_counts: Record<string, number>;
  pattern_stats: Record<string, {count: number; pct: number}>;
  anomalies: Anomaly[];
  sample_ad_ids: string[];
}

// L2 prediction output
export interface L2PredictionOutput {
  families: FamilyPrediction[];
  l1_rule_updates: L1RuleUpdate[];
  prompt_notes_for_l3?: string[];
}

export interface FamilyPrediction {
  family_key: FamilyKey;
  family_risk: "high" | "medium" | "low";
  issues: FamilyIssue[];
  ad_actions: AdAction[];
  trial_plans: TrialPlan[];
}

export interface AdAction {
  ad_id: string;
  action_type: "repair" | "replace" | "pause" | "monitor_only";
  issue_codes: string[];
  justification: string;
  suggested_new_creatives?: SuggestedCreative[];
  csv_batch_number: number;
}

export interface TrialPlan {
  trial_group_name: string;
  original_campaign_name: string;
  original_ad_group_name: string;
  trial_budget_usd: number;
  control_ads: ControlRef[];
  variant_creatives: SuggestedCreative[];
  hypothesis: string;
  success_criteria: SuccessCriteria;
  csv_batch_number: number;
}

// L3 evaluation
export interface L3EvaluationOutput {
  run_id: string;
  evaluation_date: string;
  prediction_accuracy: PredictionAccuracy;
  pattern_effectiveness: PatternEffectiveness[];
  proposed_updates: ProposedUpdate[];
  governance_status: "pending_review" | "approved" | "rejected";
}
```

2. **LLM Use Registry Update** (`config/llm_use/registry.yaml`):
```yaml
use_cases:
  gads-ads-l1-spot-check:
    description: Sample-based anomaly detection on ads per creative family
    scope: Per-family (3-5 ads sampled)
    shape: structured-json-findings
    governance: policy-review-compliance
    cost_per_call: 0.02
    
  gads-ads-l2-content-optimization:
    description: Predict Google Ads policy risks and propose repair/replace/trial actions
    scope: Per-family aggregated summaries
    shape: structured-json-predictions-and-actions
    governance: policy-review-compliance
    cost_per_call: 0.50-2.00
    
  gads-ads-l3-prompt-improvement:
    description: Meta-analyze L2 predictions vs outcomes, propose prompt/rule updates
    scope: Full run across all families
    shape: structured-json-prompt-updates
    governance: policy-review-compliance-plus-human-approval
    cost_per_call: 5.00-10.00
```

### Phase 2: Helios Integration

#### Helios Schema Additions
```sql
-- ads/google/helios-schema.sql

CREATE TABLE IF NOT EXISTS gads_accounts (
  account_id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  currency TEXT,
  time_zone TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gads_campaigns (
  campaign_id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES gads_accounts(account_id),
  campaign_name TEXT NOT NULL,
  campaign_status TEXT,
  campaign_type TEXT,
  daily_budget NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gads_ad_groups (
  ad_group_id TEXT PRIMARY KEY,
  campaign_id TEXT REFERENCES gads_campaigns(campaign_id),
  ad_group_name TEXT NOT NULL,
  ad_group_status TEXT,
  default_cpc NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gads_ads (
  ad_id TEXT PRIMARY KEY,
  ad_group_id TEXT REFERENCES gads_ad_groups(ad_group_id),
  ad_type TEXT NOT NULL,
  ad_status TEXT,
  headlines JSONB,
  descriptions JSONB,
  paths JSONB,
  final_url TEXT,
  policy_status TEXT,
  policy_topics JSONB,
  serving_status TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gads_performance_snapshots (
  snapshot_id SERIAL PRIMARY KEY,
  ad_id TEXT REFERENCES gads_ads(ad_id),
  snapshot_date DATE NOT NULL,
  impressions INTEGER,
  clicks INTEGER,
  conversions NUMERIC,
  cost NUMERIC,
  ctr NUMERIC,
  conversion_rate NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(ad_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS gads_family_tags (
  ad_id TEXT REFERENCES gads_ads(ad_id),
  tag_key TEXT NOT NULL,
  tag_value TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (ad_id, tag_key)
);

CREATE INDEX idx_gads_ads_ad_group ON gads_ads(ad_group_id);
CREATE INDEX idx_gads_ad_groups_campaign ON gads_ad_groups(campaign_id);
CREATE INDEX idx_gads_campaigns_account ON gads_campaigns(account_id);
CREATE INDEX idx_gads_performance_date ON gads_performance_snapshots(snapshot_date);
```

#### Export Script (`scripts/gads/export-ads-snapshot.ts`)
```typescript
#!/usr/bin/env tsx
import { getPool } from '../../helios/src/server/db/pool.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface ExportOptions {
  snapshotDate: string;
  accountIds?: string[];
  outputPath: string;
}

async function exportAdsSnapshot(options: ExportOptions): Promise<void> {
  const pool = getPool();
  
  try {
    const query = `
      SELECT 
        a.account_id,
        c.campaign_id,
        c.campaign_name,
        ag.ad_group_id,
        ag.ad_group_name,
        ad.ad_id,
        ad.ad_type,
        ad.headlines,
        ad.descriptions,
        ad.paths,
        ad.final_url,
        ad.policy_status,
        ad.policy_topics,
        ad.serving_status,
        p.impressions,
        p.clicks,
        p.conversions,
        p.ctr,
        p.conversion_rate,
        jsonb_object_agg(ft.tag_key, ft.tag_value) as family_tags
      FROM gads_ads ad
      JOIN gads_ad_groups ag ON ad.ad_group_id = ag.ad_group_id
      JOIN gads_campaigns c ON ag.campaign_id = c.campaign_id
      JOIN gads_accounts a ON c.account_id = a.account_id
      LEFT JOIN gads_performance_snapshots p 
        ON ad.ad_id = p.ad_id AND p.snapshot_date = $1
      LEFT JOIN gads_family_tags ft ON ad.ad_id = ft.ad_id
      WHERE ($2::text[] IS NULL OR a.account_id = ANY($2))
      GROUP BY a.account_id, c.campaign_id, c.campaign_name, 
               ag.ad_group_id, ag.ad_group_name, ad.ad_id, ad.ad_type,
               ad.headlines, ad.descriptions, ad.paths, ad.final_url,
               ad.policy_status, ad.policy_topics, ad.serving_status,
               p.impressions, p.clicks, p.conversions, p.ctr, p.conversion_rate
      ORDER BY a.account_id, c.campaign_name, ag.ad_group_name, ad.ad_id
    `;
    
    const result = await pool.query(query, [
      options.snapshotDate,
      options.accountIds || null
    ]);
    
    // Write as JSONL
    const lines = result.rows.map(row => JSON.stringify({
      ...row,
      snapshot_date: options.snapshotDate
    }));
    
    await fs.writeFile(options.outputPath, lines.join('\n'), 'utf-8');
    
    console.log(`Exported ${result.rows.length} ads to ${options.outputPath}`);
  } finally {
    await pool.end();
  }
}

// CLI interface
const snapshotDate = process.argv[2] || new Date().toISOString().split('T')[0];
const outputPath = process.argv[3] || `snapshots/gads_ads_${snapshotDate}.jsonl`;

exportAdsSnapshot({ snapshotDate, outputPath });
```

### Phase 3-11: Detailed Implementation

(Details for remaining phases available upon request - this is getting quite long!)

## Testing Strategy

### Unit Tests
- All L1 extractors with mock ad data
- L2 action planning logic
- CSV generation and validation
- HTML template rendering

### Integration Tests
- Full pipeline: Helios export → L1 → L2 → CSV + HTML
- MSS scanner integration
- mss-one-offs upload
- litalerts trigger

### End-to-End Tests
- Mock Helios database with test ads
- Run full scan
- Validate CSV output structure
- Verify HTML packet completeness
- Test import into Ads Editor (manual)

## Success Criteria

### Milestone 1 Complete When:
- [ ] Architecture doc reviewed and approved
- [ ] Implementation plan accepted
- [ ] Directory structure created
- [ ] LLM use registry updated

### Initial Milestone (M1-M8) Complete When:
- [ ] Can export snapshot from Helios
- [ ] L1 extracts features from snapshot
- [ ] L2 generates risk predictions and actions
- [ ] HTML review packet renders correctly
- [ ] CSVs 001-005 generated
- [ ] HTML served via mss-one-offs
- [ ] litalert sent with correct payload
- [ ] Manual CSV import succeeds in Ads Editor test account

### Full System Complete When:
- [ ] L3 meta-analysis running
- [ ] First trial results analyzed
- [ ] Prompt improvements proposed and approved
- [ ] Documentation complete
- [ ] System running in production

## Next Steps

1. Review this implementation plan
2. Query available tasks: `scripts/task-dag frontier --issue=8`
3. Begin Milestone 1 implementation
4. Create GitHub issue comment with architecture summary
5. Proceed with Helios integration

## Notes

- This is an epic-level task that will spawn multiple subtasks
- Each milestone can be a separate task in the Git-DAG system
- Oracle consultation available for complex design decisions
- Private LLM approval required for all public-facing copy
