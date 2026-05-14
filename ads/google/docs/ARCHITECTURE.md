# Google Ads Content Optimization System Architecture

## Overview

This document describes the three-layer agentic hill-climbing system for optimizing Google Ads *content* (intra-gads assets), adapted from the landing-page optimization system in the mostly-static-sites repository.

## Philosophy & North Star

The system treats Google Ads' policy enforcement as an **opaque stochastic system** that we learn through systematic observation and experimentation. We optimize for:

```
(limitation_avoidance × user_clarity × performance)
```

### Core Principles

1. **White-/grey-hat alignment**: Never recommend deception or policy evasion. Use "nearby strategy search" to find compliant alternatives.
2. **Learn the actual system**: Don't hand-encode policy docs. Learn enforcement patterns from observed outcomes and historical interventions.
3. **Aggressive but controlled experimentation**: Use temporary `*-trial-00N` groups with $1 budgets to probe the policy engine in isolation.
4. **Cost efficiency**: Heavy LLM work only where it moves the needle. Batch, aggregate, and sample.
5. **Human governance**: All changes require human review and are applied via Ads Editor CSV imports.

## Three-Layer Architecture

### Layer 1: Ads Content Analysis Engine (Cheap)

**Goal**: Deterministically extract structured features from Google Ads state snapshots, plus light LLM spot-checks.

**Components**:

1. **Deterministic Feature Extractors** (TypeScript modules):
   - `ad-text-patterns.ts`: Flags restricted vocab, urgency, hype, capitalization, punctuation
   - `ad-structure.ts`: Character counts, missing elements, redundancy
   - `ad-landing-linkage.ts`: Link between ad and landing page risk
   - `policy-status-extractor.ts`: Normalize policy info
   - `family-aggregation.ts`: Roll up features to creative families

2. **LLM Spot-Checks**:
   - Sample 3–5 ads per family (disapproved/limited + eligible-but-risky)
   - Input: Ad text fields + L1 features + family summary + policy anecdotes
   - Output: Risk assessment + suggested new deterministic checks
   - Use case: `gads-ads-l1-spot-check`

**Outputs**:
- Per-ad feature vectors
- Per-family aggregated summaries
- Anomaly flags
- Suggested L1 rule updates

### Layer 2: Content Strategy & Trigger Prediction

**Goal**: Use L1 summaries + experiences to predict policy risk, propose repairs/replacements, and design experimental probes.

**Responsibilities**:

1. **Policy Risk Prediction**: Predict limitation/disapproval risk per creative family
2. **Action Planning**:
   - **Repair**: Small wording tweaks (inline edits to existing ads)
   - **Replace**: New compliant creatives for existing ad groups
   - **Pause**: High-confidence bad assets
   - **Monitor**: Borderline cases

3. **Experimental Design**: Create trial plans with:
   - `*-trial-00N` ad groups with $1 budgets
   - Control ads (clones of current approved ads)
   - Variant ads (L2 suggestions)
   - Hypothesis and success criteria

4. **CSV Generation**: Assign batch numbers and generate Ads Editor CSVs:
   - `001-create-trial-campaigns-and-ad-groups.csv`
   - `002-repair-existing-ads.csv`
   - `003-replace-and-new-ads.csv`
   - `004-pause-high-risk-ads.csv`
   - `005-create-trial-ads.csv`

**Use case**: `gads-ads-l2-content-optimization`

**Outputs**:
- Per-family risk predictions
- Structured action plans (repair/replace/pause/trial)
- Numbered CSV files for Ads Editor import
- L1 rule update suggestions

### Layer 3: Meta-Analysis & Self-Improvement

**Goal**: Compare L2 predictions to actual Google responses and performance, then improve prompts and rules.

**Process**:

1. **Evaluate**:
   - Precision/recall of risk predictions vs actual limitations
   - Which patterns reduced limitations without hurting performance
   - Which patterns L2 misjudged

2. **Suggest**:
   - Prompt modifications for L2
   - New/updated L1 rules
   - Changes to trial design

3. **Governance**:
   - L3 emits proposals, not live changes
   - Changes to prompts/configs require human review
   - Track versions and changes (who/when/why)

**Use case**: `gads-ads-l3-prompt-improvement`

**Outputs**:
- Evaluation metrics
- Proposed prompt/config changes
- Trial design recommendations

## Data Flow Pipeline

```
Google Ads → Helios → Automation → MSS → Automation → Human
    (API)      (DB)    (export)   (analyze)  (CSVs)   (Ads Editor)
```

### 1. Google Ads → Helios

Helios ingests Google Ads state via API (nightly) into tables:
- `gads_campaigns`
- `gads_ad_groups`
- `gads_ads`
- `gads_assets`
- `gads_policy_summary`
- `gads_performance`

Key fields:
- IDs and names
- Ad type (RSA, ETA, call ad)
- Text fields (headlines, descriptions, paths, CTA)
- Final URLs / tracking templates
- Policy summaries (topics, approval status, limitations)
- Serving status (eligible, limited, disapproved, under review)
- Performance metrics (impr, clicks, CTR, conv, quality score proxies)
- Labels / custom fields for family grouping

### 2. Helios → Automation

Script: `automation/scripts/gads/export-ads-snapshot.ts`

Responsibilities:
- Pull read-only snapshot from Helios for given date/account
- Normalize to canonical JSON/JSONL format
- Write to `snapshots/gads_ads_YYYY-MM-DD.jsonl`

### 3. Automation → MSS

Script: `mostly-static-sites/scripts/scan-gads-ads-content.ts`

CLI signature:
```bash
npx tsx scripts/scan-gads-ads-content.ts \
  --input /path/to/gads_ads_YYYY-MM-DD.jsonl \
  --output-json /path/to/gads_ads_scan_YYYY-MM-DD.json \
  --output-html /path/to/gads_ads_review_YYYY-MM-DD.html \
  --output-csv-dir /path/to/csv_batches/
```

Orchestrates L1 → L2 using MSS's three-layer framework.

### 4. MSS → Automation

After scan completes:
- Copy outputs to well-known location
- Record run entry (date, snapshot ID, output paths)
- Trigger litalert with review packet link

### 5. Automation → Human (via Ads Editor)

Human workflow:
1. Receive litalert with HTML review packet link
2. Review HTML packet
3. Import CSVs 001–005 in sequence into Ads Editor
4. Monitor trial groups with labels `FB_POLICY_PROBE_*`

### 6. Human → Google Ads → Helios (feedback loop)

After CSV import:
- Google processes changes
- Helios captures new state in next snapshot
- L3 analyzes predictions vs outcomes

## HTML Review Packet Structure

Top-level sections:

### 1. Header
- Title: `Google Ads Content Optimization – [Account] – [Date]`
- Metadata: Snapshot date, run ID, prompt versions
- Links to CSVs and prior runs

### 2. Executive Summary
- Total campaigns/ads analyzed
- Limited/disapproved counts
- Families at high risk
- Actions proposed (repair/replace/trial)
- "What to do" checklist

### 3. Global Risk & Actions Overview
Table per family/campaign:
- Account, Campaign, Family/Theme
- Family risk (L/M/H)
- Ad counts by status
- Action counts
- Links to detailed sections

### 4. Per-Campaign / Family Sections
For each campaign:
- Summary block (name, objective, budget, risk level)
- Policy status snapshot table
- Recommended actions:
  - **Repairs** (CSV 002): Before/after snippets, issue codes, CSV refs
  - **Replacements** (CSV 003) & **Pauses** (CSV 004): Original vs new, CSV refs
  - **Trial Plans** (CSVs 001 & 005): Hypothesis, controls vs variants, budget, CSV refs

### 5. Issue Taxonomy & Philosophy Appendix
- Risk level definitions
- White-/grey-hat constraints
- Issue codes → descriptions and example fixes

### 6. Technical Appendix
- L1 feature summaries
- L2 rationales
- Prompt versions, config hashes
- Trial labels and IDs

## CSV Batch Structure

Numbered CSVs for sequential Ads Editor import:

### 001: Create Trial Campaigns and Ad Groups
- Purpose: Set up experimental shell
- Rows: New campaigns/ad groups with `*-trial-00N` naming
- Budgets: $1/day

### 002: Repair Existing Ads
- Purpose: Inline repairs to existing ads
- Rows: One per ad with `action_type = "repair"`
- Includes: Ad ID, modified headlines/descriptions, issue codes

### 003: Replace and New Ads
- Purpose: New compliant creatives for existing ad groups
- Rows: New ads using `SuggestedCreative` from L2
- No Ad ID (new ads)

### 004: Pause High-Risk Ads
- Purpose: Pause obviously-bad assets
- Rows: Ads with `action_type = "pause"`
- Guardrail: Small and high-confidence only

### 005: Create Trial Ads
- Purpose: Populate trial ad groups with test variants
- Rows: 1–2 controls + 1–3 variants per trial
- Labels: `FB_POLICY_PROBE_YYYY-MM-DD-NNN`

## Trial Group Design

Principles:
- **Goal**: Aggressively but safely query the policy engine
- **Naming**: `<original-ad-group-name> - trial-00N`
- **Budget**: $1/day
- **Structure**:
  - Control(s): Text close to current approved ad or known safe baseline
  - Variant(s): Small, controlled deviations
- **Annotation**: Hypothesis, policy class being probed

Trial Lifecycle:
1. Generated as CSV 001/005
2. Human imports via Ads Editor
3. Run for minimum window (3–7 days or until `min_impressions`)
4. Helios captures outcomes in snapshot
5. L3 reads mapping from `trial_group_name` + labels → measures outcomes
6. L3 updates prompts/rules; HTML notes "Trial X results"

## Integration Points

### LLM Use Registry

Update `automation/config/llm_use/registry.yaml` with:
- `gads-ads-l1-spot-check`: Sample-based anomaly detection on 3–5 ads per family
- `gads-ads-l2-content-optimization`: Predict risks and propose actions
- `gads-ads-l3-prompt-improvement`: Meta-analyze predictions vs outcomes

### litalerts Integration

Trigger litalert when:
- Run completes AND (high-risk spend >X% OR new trial plans exist)

Payload:
- Link to HTML review packet
- Link to CSV directory
- High-level summary (N campaigns at risk, M actions, K trials)
- Instruction: "Review HTML then import CSVs 001–005 in Ads Editor"

### Policy Review Compliance

Governance doc: `automation/docs/policy-review-compliance-architecture.md`

All L2/L3 LLM use subject to:
- White-/grey-hat constraints
- Human-in-the-loop approval for prompt changes
- Audit trail for all recommendations

## Implementation Phases

### Phase 1: Foundation (Initial Milestone)
- [ ] Create directory structure: `ads/google/{scripts,lib,docs,snapshots,outputs}`
- [ ] Implement Helios export script: `scripts/gads/export-ads-snapshot.ts`
- [ ] Port L1 extractors from MSS to automation repo
- [ ] Create basic L2 orchestrator
- [ ] Build HTML packet generator
- [ ] Generate CSV batches
- [ ] Integration with mss-one-offs for HTML serving
- [ ] Update LLM use registry

### Phase 2: L1 Extractors
- [ ] `ad-text-patterns.ts`: Pattern detection
- [ ] `ad-structure.ts`: Structural analysis
- [ ] `ad-landing-linkage.ts`: LP risk mapping
- [ ] `policy-status-extractor.ts`: Policy normalization
- [ ] `family-aggregation.ts`: Family-level rollup
- [ ] L1 LLM spot-check integration

### Phase 3: L2 Strategy Layer
- [ ] Risk prediction model
- [ ] Action planning (repair/replace/pause)
- [ ] Trial plan generation
- [ ] CSV batch assignment
- [ ] White-/grey-hat constraints enforcement

### Phase 4: L3 Meta-Analysis
- [ ] Outcome collection from Helios
- [ ] Prediction evaluation
- [ ] Prompt/rule update proposals
- [ ] Governance workflow

### Phase 5: Production Readiness
- [ ] End-to-end testing
- [ ] Documentation finalization
- [ ] litalerts integration testing
- [ ] First production run with human review

## Cost & Performance Expectations

Based on MSS landing-page scanner:

- **L1**: ~$0.02 per family (mostly deterministic + 3–5 LLM spot-checks)
- **L2**: ~$0.50–2 per family (depending on complexity)
- **L3**: ~$5–10 per full meta-analysis run (across all families)

For 50 creative families:
- **Full cycle**: ~$1–$100 depending on L2/L3 depth
- **180x cheaper** than naive per-ad LLM analysis

## Success Metrics

### Short-term (first 3 months)
- L2 precision/recall on limitation prediction: >60/50
- Trial approval rate vs baseline: +10%
- Zero policy-evasion recommendations flagged

### Medium-term (6 months)
- L2 precision/recall: >70/60
- Trial groups show clear pattern differentiation
- L3 prompt improvements adopted 2x per month

### Long-term (12 months)
- Multi-objective optimization active: `(limitation × CTR × conv)`
- Automated low-risk repairs (with approval gate)
- Trial pipeline runs continuously

## Risks & Guardrails

### Risk: Over-aggressive pause/replace harms performance
**Guardrail**: Keep pauses in separate CSV (004), highlight in HTML, default to repair+trial

### Risk: Hill-climbing drifts into policy-evasion
**Guardrail**: Encode North Star philosophy in L2 prompts, L3 checks both limitations AND performance

### Risk: Trial groups cause spend fragmentation
**Guardrail**: Enforce $1 budgets, automatic labeling, periodic cleanup recommendations

### Risk: CSV import errors break campaigns
**Guardrail**: Extensive validation in L2, dry-run mode, clear HTML instructions

## Future Enhancements

When L2 achieves stable precision/recall (>70/60) over months and API quota supports writes:

- Controlled automation path for low-risk repairs
- Direct API integration (still with approval gates)
- Real-time policy monitoring and alerts
- Multi-account coordination
- Cross-repository optimization (ads + landing pages)

## References

- MSS Landing Page Scanner: `mostly-static-sites/LANDING_PAGE_SCANNER_SUMMARY.md`
- Three-Layer Architecture: `mostly-static-sites/docs/landing-page-google-trigger-scanner.md`
- North Star Philosophy: `mostly-static-sites/docs/NORTH_STAR_PHILOSOPHY.md`
- Policy Review Compliance: `automation/docs/policy-review-compliance-architecture.md`
- LLM Use Registry: `automation/config/llm_use/registry.yaml`
