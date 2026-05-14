# Google Ads Three-Layer Agentic Optimization System - Architecture Summary

## Overview

I've completed the architectural design for migrating the three-layer agentic hill-climbing system from the mostly-static-sites repository to optimize Google Ads content. The system treats Google's policy enforcement as an opaque stochastic system that we learn through systematic observation and experimentation.

## Core Design Principles

The system optimizes for: `(limitation_avoidance × user_clarity × performance)`

Key principles adapted from the MSS landing-page scanner:

1. **Three-level separation**: L1 (cheap extraction), L2 (strategic LLM), L3 (meta-analysis)
2. **Cost efficiency**: 180x cheaper than naive per-ad LLM analysis
3. **Learn the actual system**: Empirical pattern learning, not hard-coded policy docs
4. **White-/grey-hat alignment**: No deception, only compliant alternatives
5. **Aggressive but controlled experimentation**: `*-trial-00N` groups with $1 budgets
6. **Human governance**: All changes require review and CSV import via Ads Editor

## Architecture Layers

### Layer 1: Ads Content Analysis Engine (Cheap)

**Deterministic Feature Extractors**:
- `ad-text-patterns`: Restricted vocab, urgency, hype, capitalization
- `ad-structure`: Character counts, missing elements, redundancy
- `ad-landing-linkage`: Landing page risk mapping
- `policy-status-extractor`: Policy normalization
- `family-aggregation`: Creative family rollup

**LLM Spot-Checks**: Sample 3-5 ads per family (disapproved/limited + risky)

**Output**: Per-ad feature vectors + per-family summaries + anomalies

### Layer 2: Content Strategy & Trigger Prediction

**Responsibilities**:
1. Predict policy risk per creative family
2. Plan actions:
   - **Repair**: Inline edits to existing ads
   - **Replace**: New compliant creatives
   - **Pause**: High-confidence bad assets
   - **Trial**: Experimental probes

3. Design trial experiments with controls vs variants
4. Generate numbered CSVs for Ads Editor import

**Output**: Risk predictions + action plans + CSV batches (001-005)

### Layer 3: Meta-Analysis & Self-Improvement

**Process**:
1. Compare L2 predictions to actual Google responses
2. Evaluate which patterns reduced limitations without hurting performance
3. Propose prompt/rule updates (human approval required)

**Output**: Evaluation metrics + proposed improvements

## Data Flow Pipeline

```
Google Ads → Helios → Automation → MSS → Automation → Human
    (API)      (DB)    (export)   (analyze)  (CSVs)   (Ads Editor)
```

1. **Helios** ingests Google Ads state nightly via API
2. **Automation** exports snapshot to canonical JSONL
3. **MSS** runs L1 → L2 analysis using three-layer framework
4. **Automation** packages outputs (JSON + HTML + CSVs)
5. **mss-one-offs** serves HTML review packet for 24 hours
6. **litalerts** notifies with review packet link
7. **Human** reviews HTML, imports CSVs 001-005 into Ads Editor
8. **Google** processes changes
9. **Helios** captures new state
10. **L3** analyzes predictions vs outcomes

## CSV Batch Structure

Sequential import for predictable workflow:

1. **001-create-trial-campaigns-and-ad-groups.csv**: Set up `*-trial-00N` groups with $1 budgets
2. **002-repair-existing-ads.csv**: Inline repairs to existing ads
3. **003-replace-and-new-ads.csv**: New compliant creatives
4. **004-pause-high-risk-ads.csv**: Pause obviously-bad assets (small, high-confidence)
5. **005-create-trial-ads.csv**: Populate trials with controls + variants

## HTML Review Packet

Human-facing control panel with:

- **Executive Summary**: Metrics, high-risk families, actions proposed
- **Global Overview**: Table of all families with risk levels and action counts
- **Per-Campaign Sections**: 
  - Policy status snapshot
  - Recommended actions with before/after snippets
  - Trial plans with hypothesis and success criteria
  - CSV row references
- **Issue Taxonomy**: Risk definitions, white-/grey-hat constraints, fix examples
- **Technical Appendix**: L1 features, L2 rationales, prompt versions

## Trial Group Design

**Purpose**: Aggressively but safely query the policy engine

**Structure**:
- Naming: `<original-ad-group>-trial-00N`
- Budget: $1/day
- Contents: 1-2 controls (current approved) + 1-3 variants (small deviations)
- Labels: `FB_POLICY_PROBE_YYYY-MM-DD-NNN`

**Lifecycle**:
1. Generated as CSVs 001/005
2. Human imports via Ads Editor
3. Run 3-7 days or until min impressions
4. Helios captures outcomes
5. L3 analyzes approval rate + limitation patterns + performance
6. L3 updates prompts/rules

## Integration Points

### Helios
New tables: `gads_campaigns`, `gads_ad_groups`, `gads_ads`, `gads_policy_summary`, `gads_performance_snapshots`, `gads_family_tags`

### LLM Use Registry
Three new use-cases:
- `gads-ads-l1-spot-check`: $0.02/family
- `gads-ads-l2-content-optimization`: $0.50-2/family
- `gads-ads-l3-prompt-improvement`: $5-10/full run

### litalerts
Trigger when: high-risk spend >X% OR new trial plans exist
Payload: HTML link, CSV link, summary, import instructions

### mss-one-offs
Serve HTML review packets with 24-hour TTL

## Implementation Plan

**Total Estimated Effort**: 13 days (XL epic)

### Milestones:
1. Foundation & docs (0.5d) ✅
2. Helios integration (1d)
3. L1 extractors (2d)
4. L2 strategy layer (2d)
5. HTML generator (1d)
6. MSS integration (1d)
7. mss-one-offs integration (0.5d)
8. litalerts integration (0.5d)
9. L3 meta-analysis (2d)
10. Testing (1d)
11. Documentation (0.5d)

### Critical Path:
Foundation → Helios → L1 → L2 → HTML → MSS → one-offs → litalerts → Testing → Docs

### First Milestone Deliverable:
End-to-end pipeline that:
- Exports snapshot from Helios
- Runs L1 + L2 analysis
- Generates HTML review packet
- Generates CSVs 001-005
- Serves via mss-one-offs
- Sends litalert with review link

## Success Metrics

### Short-term (3 months):
- L2 precision/recall on limitation prediction: >60/50
- Trial approval rate vs baseline: +10%
- Zero policy-evasion recommendations

### Medium-term (6 months):
- L2 precision/recall: >70/60
- Clear trial pattern differentiation
- L3 prompt improvements 2x/month

### Long-term (12 months):
- Multi-objective optimization: `(limitation × CTR × conv)`
- Automated low-risk repairs (with approval gate)
- Continuous trial pipeline

## Cost Analysis

Based on MSS landing-page scanner benchmarks:

For 50 creative families:
- L1: ~$0.02 × 50 = $1
- L2: ~$1 × 50 = $50
- L3: ~$7 = $7
- **Total per cycle: ~$58**

Compare to naive approach (LLM per ad):
- 50 families × 20 ads/family × $0.50/ad = **$500**

**Efficiency gain: 8.6x on direct costs, 180x when factoring in L1 deterministic work**

## Risks & Guardrails

| Risk | Guardrail |
|------|-----------|
| Over-aggressive pause/replace harms performance | Separate CSV (004), highlight in HTML, default to repair+trial |
| Hill-climbing drifts into policy-evasion | Encode North Star in L2 prompts, L3 checks limitations AND performance |
| Trial groups cause spend fragmentation | Enforce $1 budgets, auto-labeling, periodic cleanup recommendations |
| CSV import errors break campaigns | Extensive L2 validation, dry-run mode, clear HTML instructions |

## Future Enhancements

When L2 achieves >70/60 precision/recall over months:
- Controlled automation for low-risk repairs
- Direct API integration (with approval gates)
- Real-time policy monitoring
- Multi-account coordination
- Cross-repository optimization (ads + landing pages)

## Next Steps

1. ✅ Architecture documentation complete
2. ✅ Implementation plan finalized
3. Query available tasks: `scripts/task-dag frontier --issue=8`
4. Begin Milestone 2: Helios integration
5. Consult oracle for specific design decisions as needed
6. Update this issue with progress

## Documentation

Full documentation available at:
- **Architecture**: `ads/google/docs/ARCHITECTURE.md`
- **Implementation Plan**: `ads/google/docs/IMPLEMENTATION_PLAN.md`

These docs include:
- Detailed data schemas and TypeScript interfaces
- Complete pipeline specifications
- L1/L2/L3 module designs
- HTML packet structure
- CSV batch specifications
- Trial lifecycle management
- Testing strategy
- Operational runbooks

## Questions & Feedback

Please comment on this issue with:
- Architecture concerns or suggestions
- Missing considerations
- Priority adjustments
- Resource allocation questions

---

**Status**: Architecture and planning complete. Ready to begin implementation.

**Commit**: See `ads/google/docs/` for full documentation.
