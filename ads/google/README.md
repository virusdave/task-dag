# Google Ads Content Optimization System

Three-layer agentic hill-climbing system for optimizing Google Ads content to minimize policy limitations while maximizing performance.

## Quick Start

```bash
# Run analysis on a snapshot
./scripts/run-analysis.ts --snapshot snapshots/gads_ads_2026-05-14.jsonl --output-dir outputs

# Outputs:
# - outputs/json/<run-id>-l2-output.json (L2 predictions)
# - outputs/csv/001-*.csv through 005-*.csv (Ads Editor import files)
# - outputs/html/<run-id>-review-packet.html (Human review interface)
```

## Architecture

### Layer 1: Content Analysis Engine (Cheap)
- **Text Patterns**: Urgency, hype, medical claims, superlatives, restricted vocab
- **Structure**: Character counts, completeness, redundancy
- **Policy Status**: Normalized serving status and limitation reasons
- **Landing Linkage**: Domain risk assessment
- **Family Aggregation**: Roll up to creative families

Cost: ~$0.02 per family

### Layer 2: Strategy & Action Planning (Strategic LLM)
- **Risk Prediction**: High/medium/low risk scoring
- **Action Planning**: Repair/replace/pause/monitor recommendations
- **Trial Design**: $1-budget experiments to probe policy boundaries
- **CSV Generation**: Numbered batches (001-005) for Ads Editor

Cost: ~$0.50-2 per family

### Layer 3: Meta-Analysis (Self-Improvement)
- **Evaluation**: Prediction accuracy, pattern effectiveness
- **Learning**: Trial outcome analysis
- **Improvement**: Prompt/rule update proposals

Cost: ~$5-10 per full run

## Data Flow

```
Google Ads → Helios → Snapshot Export → L1 → L2 → CSV + HTML → Human → Ads Editor → Google Ads
                                                                                           ↓
                                                                                      Helios → L3
```

## CSV Batches

Import sequentially into Google Ads Editor:

1. **001-create-trial-campaigns-and-ad-groups.csv**: Trial infrastructure
2. **002-repair-existing-ads.csv**: Inline edits to existing ads
3. **003-replace-and-new-ads.csv**: New compliant creatives
4. **004-pause-high-risk-ads.csv**: Pause obviously-bad assets (small batch)
5. **005-create-trial-ads.csv**: Trial controls + variants

## HTML Review Packet

Human-readable interface with:
- Executive summary (metrics, checklist)
- Global overview table
- Per-campaign sections (actions, trials, risks)
- Issue taxonomy and risk definitions
- CSV reference links

## Trial Groups

**Policy probe experiments** (NOT ad serving campaigns):

Format: `{global_batch:05d}-{ad-group}-trial-{seq:03d}`
- Example: `00001-midtown-cannabis-trial-001` through `00001-midtown-cannabis-107`
- Next batch: `00002-bronx-edibles-trial-001`, etc.

Characteristics:
- **Budget**: $0.01/day (microscopic - just for policy review)
- **Scale**: 10-1000 parallel experiments per batch
- **Control**: 1 baseline ad
- **Variants**: 1-1000 systematic pattern permutations
- **Lifecycle**: Check at 1hr, 4hr, 24hr, 48hr → Remove completely
- **Labels**: `FB_POLICY_PROBE_YYYY-MM-DD-{batch:05d}`

Goal: Learn which patterns trigger approval/limitation/disapproval, then discard.

## Configuration

- **L1 Config**: `config/l1-config.yaml` (feature thresholds, vocab buckets)
- **L2 Prompts**: `config/l2-prompts.yaml` (risk scoring, action logic, constraints)

## White-/Grey-Hat Constraints

System optimizes `(limitation_avoidance × user_clarity × performance)` with strict constraints:
- No deception or policy evasion
- No classifier-only tricks
- Honest representation required
- Compliance-first when uncertain
- Nearby strategy search for compliant alternatives

## Directory Structure

```
ads/google/
├── docs/              Documentation
│   ├── ARCHITECTURE.md
│   ├── IMPLEMENTATION_PLAN.md
│   └── DATA_SCHEMAS.md
├── lib/               Core implementation
│   ├── l1/            Feature extractors
│   ├── l2/            Strategy & CSV generation
│   ├── l3/            Meta-analysis (future)
│   ├── html/          HTML packet generator
│   └── shared/        Types, schemas, utils
├── scripts/           Orchestration scripts
│   └── run-analysis.ts
├── config/            Configuration files
├── snapshots/         Helios exports (JSONL)
└── outputs/           Generated artifacts
    ├── json/
    ├── csv/
    └── html/
```

## Development

```bash
# Install dependencies
pnpm install

# Run analysis
./scripts/run-analysis.ts --snapshot <file> --output-dir outputs

# View HTML packet
open outputs/html/<run-id>-review-packet.html
```

## Related Documentation

- **Architecture**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Implementation Plan**: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- **Data Schemas**: [docs/DATA_SCHEMAS.md](docs/DATA_SCHEMAS.md)
- **North Star Philosophy**: See mostly-static-sites repo
- **Issue**: https://github.com/FreshlyBakedNYC/automation/issues/8
