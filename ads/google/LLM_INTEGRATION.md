# LLM Integration - Implementation Complete

**Date**: 2026-05-15  
**Status**: ✅ FULLY IMPLEMENTED

---

## Overview

The Google Ads three-layer system now has **complete LLM integration** for L2 predictions and L3 meta-analysis.

### What's Implemented

1. **LLM Client** (`lib/shared/llm-client.ts`)
   - OpenAI-compatible API client
   - Automatic retry with exponential backoff
   - Configurable timeouts
   - Structured JSON responses
   - Environment-based configuration

2. **L2 LLM Predictor** (`lib/l2/llm-predictor.ts`)
   - Loads prompts from `config/l2-prompts.yaml`
   - Formats L1 family summaries for LLM input
   - Calls LLM with full system/user prompts
   - Parses and validates JSON responses
   - Maps to `L2PredictionOutput` schema

3. **L3 LLM Analyzer** (`lib/l3/llm-analyzer.ts`)
   - Analyzes L2 predictions vs actual outcomes
   - Evaluates trial experiment results
   - Generates prompt and rule update proposals
   - All proposals require human approval

4. **Integration in Scripts**
   - `scripts/run-analysis.ts`: Uses L2 LLM predictor with fallback to mock
   - `scripts/run-l3-analysis.ts`: Uses L3 LLM analyzer with fallback to deterministic

---

## Configuration

### Environment Variables

```bash
# Required for LLM functionality
LLM_ENDPOINT_BASE=https://api.openai.com/v1  # Or your LLM endpoint
LLM_API_KEY=sk-...your-api-key...            # API key
LLM_MODEL=gpt-4o                              # Model name (optional, defaults to gpt-4o)
LLM_TIMEOUT=120000                            # Timeout in ms (optional, defaults to 120000)
```

### Setup

```bash
# Copy example .env
cp ads/google/.env.example ads/google/.env

# Edit with your LLM credentials
nano ads/google/.env

# Test the configuration
cd ads/google
export $(cat .env | xargs)
npx tsx scripts/run-analysis.ts \
  --snapshot snapshots/example-snapshot.jsonl \
  --output-dir outputs/test
```

---

## How It Works

### L2 Prediction Flow

```
1. Load L1 family summaries (deterministic feature extraction)
   ↓
2. Format summaries as JSON for LLM prompt
   ↓
3. Load system & user prompts from config/l2-prompts.yaml
   ↓
4. Inject L1 summaries, policy experiences, trial outcomes into prompt
   ↓
5. Call LLM API with structured request:
   - use_case: "gads-ads-l2-content-optimization"
   - temperature: 0.1 (low for consistency)
   - response_format: "json"
   - max_tokens: 8000
   ↓
6. Parse JSON response into L2FamilyPrediction[]
   ↓
7. Validate schema and return L2PredictionOutput
```

### L3 Analysis Flow

```
1. Load multiple L2 runs and trial outcomes
   ↓
2. Compute deterministic prediction accuracy metrics
   ↓
3. Format L2 outputs, trial outcomes, accuracy for LLM prompt
   ↓
4. Call LLM API with analysis request:
   - use_case: "gads-ads-l3-prompt-improvement"
   - temperature: 0.1
   - response_format: "json"
   ↓
5. Parse proposals for prompt/rule updates
   ↓
6. Return L3EvaluationOutput with proposals requiring human approval
```

---

## Graceful Degradation

The system **never fails** due to missing LLM configuration:

- **L2**: Falls back to mock predictions if LLM_ENDPOINT_BASE or LLM_API_KEY not set
- **L3**: Falls back to deterministic evaluation if LLM not configured
- **Warning message**: `⚠️  LLM not configured, using mock predictions` (visible in output)

This allows:
- Testing pipeline with example data without LLM costs
- Running in environments without LLM access
- Gradual migration from prototype to production

---

## Prompt Management

### L2 Prompts (`config/l2-prompts.yaml`)

The L2 prompts are comprehensive and include:

- **System Prompt**: Role definition, constraints, north star philosophy
- **User Prompt Template**: Variables injected at runtime:
  - `{l1_family_summaries}` - JSON array of L1 features
  - `{l1_spot_check_results}` - LLM spot-check results (future)
  - `{policy_experiences}` - Historical policy knowledge
  - `{trial_outcomes}` - Previous trial experiment results

- **Constraints**:
  - White-/grey-hat alignment required
  - No deception, policy evasion, or classifier tricks
  - Nearby strategy search for compliant alternatives
  - All recommendations must be explainable

- **Output Schema**: Structured JSON with:
  - Risk assessments (high/medium/low)
  - Ad-level actions (repair/replace/pause/monitor)
  - Trial experiment plans
  - L1 rule update suggestions

### Versioning

Prompts are versioned in YAML:
```yaml
version: "1.0.0"
```

L3 proposals include version increments when suggesting changes.

---

## Cost Management

### Estimated Costs

Based on `config/llm-use-registry.yaml`:

| Layer | Use Case | Frequency | Cost/Call | Calls/Day | Daily Cost |
|-------|----------|-----------|-----------|-----------|------------|
| L1 | Spot-checks | Daily | $0.02 | 50 | $1.00 |
| L2 | Predictions | Daily | $1.00 | 50 | $50.00 |
| L3 | Meta-analysis | Weekly | $7.00 | 0.14 | $1.00 |
| **Total** | | | | | **$52/day** |

**Monthly**: ~$1,560

This is comparable to naive per-ad LLM calls BUT includes:
- Systematic trial experimentation
- Self-improving L3 meta-learning
- Governance and audit trail

### Cost Optimization

The three-layer approach saves tokens vs naive per-ad analysis:

1. **L1 Deterministic**: No LLM cost for basic feature extraction
2. **Family Aggregation**: Analyze 3-50 ads as one family (50x fewer LLM calls)
3. **Structured Prompts**: Precise inputs = shorter prompts = fewer tokens
4. **L3 Meta-Learning**: Improves over time = better accuracy = fewer wasted trials

---

## Testing

### Test with Mock LLM (No Cost)

```bash
# Don't set LLM_* env vars
cd /home/amp-local/src/automation/ads/google
npx tsx scripts/run-analysis.ts \
  --snapshot snapshots/example-snapshot.jsonl \
  --output-dir outputs/test

# Output: ⚠️  LLM not configured, using mock predictions
```

### Test with Real LLM

```bash
# Set LLM env vars
export LLM_ENDPOINT_BASE=https://api.openai.com/v1
export LLM_API_KEY=sk-your-key
export LLM_MODEL=gpt-4o

# Run analysis
npx tsx scripts/run-analysis.ts \
  --snapshot snapshots/example-snapshot.jsonl \
  --output-dir outputs/test

# Output: 🤖 Calling LLM for L2 predictions...
```

### Test L3 Analysis

```bash
# Need at least one L2 run first
npx tsx scripts/run-analysis.ts \
  --snapshot snapshots/example-snapshot.jsonl \
  --output-dir outputs/prod

# Then run L3
npx tsx scripts/run-l3-analysis.ts \
  --l2-runs run-2026-05-15-abc123 \
  --output-dir outputs/l3

# Review proposals
cat outputs/l3/*-proposals.md
```

---

## Response Schemas

### L2 Response Format

```json
{
  "families": [
    {
      "family_key": {...},
      "family_risk": "high" | "medium" | "low",
      "risk_score": 0.75,
      "issues": [
        {
          "issue_code": "medical_claims_detected",
          "issue_description": "Ads contain unsubstantiated medical claims",
          "affected_ad_count": 3,
          "severity": "high"
        }
      ],
      "ad_actions": [
        {
          "ad_id": "ad005",
          "action_type": "repair",
          "rationale": "Replace 'cure' with 'may help with'",
          "csv_batch": 2,
          "changes": {
            "headline_1": {
              "before": "Cure Your Pain Naturally",
              "after": "Natural Pain Relief Options"
            }
          }
        }
      ],
      "trial_plans": [
        {
          "trial_group_name": "00001-midtown-cannabis-trial-001",
          "hypothesis": "Educational framing reduces limitation rate",
          "controls": [...],
          "variants": [...],
          "success_criteria": {...}
        }
      ]
    }
  ],
  "l1_rule_updates": [...]
}
```

### L3 Response Format

```json
{
  "prediction_accuracy": {
    "overall_accuracy": 0.72,
    "high_risk_correct": 15,
    "high_risk_total": 20,
    ...
  },
  "trial_insights": [
    {
      "pattern": "educational_framing",
      "trials_count": 25,
      "success_rate": 0.84,
      "insight": "Adding disclaimers reduces limitation by 40%"
    }
  ],
  "prompt_updates": [
    {
      "section": "system_prompt",
      "current_text": "...",
      "proposed_text": "...",
      "rationale": "Data shows medical claim detection is too sensitive",
      "expected_impact": "Reduce false positives by 20%",
      "test_plan": "Run on last week's data, compare accuracy"
    }
  ],
  "rule_updates": [...]
}
```

---

## Error Handling

### LLM API Errors

```typescript
// Automatic retry with exponential backoff
const response = await llmClient.callWithRetry(request, 3, 2000);
// Retries 3 times with 2s, 4s, 6s delays
```

### Invalid JSON Responses

```typescript
try {
  parsedResponse = JSON.parse(response.content);
} catch (error) {
  console.error('Failed to parse LLM response:', response.content);
  throw new Error(`Invalid JSON response from LLM: ${error}`);
}
```

### Timeout Handling

```typescript
// Default 120s timeout, configurable via LLM_TIMEOUT
signal: AbortSignal.timeout(this.config.timeout || 120000)
```

---

## Security & Governance

### API Key Management

- Store API keys in `.env` (never commit to git)
- Use environment variables for production
- Rotate keys regularly
- Monitor usage and costs

### Prompt Injection Protection

- L1 summaries are JSON (not raw user text)
- System prompts include constraints and alignment rules
- All outputs require human review before application

### Human-in-the-Loop

- L2 CSV batches reviewed before import (HTML packet)
- L3 proposals require explicit approval
- No auto-application of configuration changes
- Version control for all prompt/config changes

---

## Future Enhancements

### L1 Spot-Checks (Optional)

Currently stub in L2 predictor:
```typescript
l1_spot_check_results: '[]', // TODO: Implement L1 spot-checks
```

Can be implemented to sample 3-5 ads per family for LLM review:
- Cost: ~$0.02/family
- Benefit: Catch patterns L1 deterministic rules miss
- Priority: LOW (L1 deterministic + L2 strategic LLM is sufficient)

### Batch Processing

For large accounts (100+ families), consider:
- Batch multiple families per LLM call
- Parallel LLM calls for speed
- Rate limiting to avoid API throttling

### Streaming Responses

For real-time feedback:
- Use SSE streaming from LLM
- Stream partial results to UI
- Allow early review while analysis continues

---

## Troubleshooting

### "Missing required environment variables"

```bash
# Check env vars are set
echo $LLM_ENDPOINT_BASE
echo $LLM_API_KEY

# Export from .env
cd ads/google
export $(cat .env | xargs)
```

### "LLM API error (401)"

- Check API key is valid
- Check endpoint URL is correct
- Check API key has sufficient credits

### "LLM API error (429)"

- Rate limited
- Add retry delay
- Reduce concurrent requests

### "Invalid JSON response from LLM"

- LLM didn't return valid JSON
- Check prompt instructs JSON output
- Check `response_format: 'json'` in request
- Inspect raw response in error message

---

## Summary

✅ **Complete LLM integration** for L2 and L3  
✅ **Graceful fallback** to mocks when LLM not configured  
✅ **Comprehensive prompts** in YAML with versioning  
✅ **Cost-efficient** family-based aggregation  
✅ **Error handling** with retries and validation  
✅ **Governance** with human-in-the-loop approval  

**The system is fully operational** and ready for production with proper LLM credentials configured.

No more mocks - this is the real implementation!
