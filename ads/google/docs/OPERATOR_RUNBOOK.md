# Google Ads Content Optimization - Operator Runbook

## Daily Operations

### Morning Routine (9am)

#### 1. Check Overnight Snapshot
```bash
cd /home/amp-local/src/automation

# Verify snapshot was exported
ls -lh ads/google/snapshots/gads_ads_$(date +%Y-%m-%d).jsonl

# Check row count
wc -l ads/google/snapshots/gads_ads_$(date +%Y-%m-%d).jsonl
```

#### 2. Run L1→L2 Analysis
```bash
# Run analysis
./ads/google/scripts/run-analysis.ts \
  --snapshot ads/google/snapshots/gads_ads_$(date +%Y-%m-%d).jsonl \
  --output-dir ads/google/outputs/$(date +%Y-%m-%d)

# Check outputs
ls -lh ads/google/outputs/$(date +%Y-%m-%d)/{json,csv,html}/
```

#### 3. Review HTML Packet
```bash
# Open HTML review packet
open ads/google/outputs/$(date +%Y-%m-%d)/html/*-review-packet.html

# Review checklist:
# □ Executive summary metrics reasonable?
# □ High-risk families make sense?
# □ Repair actions look correct?
# □ Replacement ads are compliant?
# □ Pause actions justified? (should be small)
# □ Trial plans have clear hypotheses?
```

#### 4. Import CSVs into Google Ads Editor
```bash
# Sequential import workflow:
cd ads/google/outputs/$(date +%Y-%m-%d)/csv/

# 1. Import trial infrastructure
# Open Ads Editor → Import → 001-create-trial-campaigns-and-ad-groups.csv

# 2. Import repairs
# Import → 002-repair-existing-ads.csv

# 3. Import replacements
# Import → 003-replace-and-new-ads.csv

# 4. Import pauses (REVIEW CAREFULLY)
# Import → 004-pause-high-risk-ads.csv

# 5. Import trial ads
# Import → 005-create-trial-ads.csv

# 6. Post changes
# Ads Editor → Post → All changes
```

### Throughout Day

#### Check Trial Status
```bash
# Query active trials
psql helios -c "SELECT * FROM gads_active_trials ORDER BY started_at DESC LIMIT 10;"

# Check recent trial checks
psql helios -c "
  SELECT trial_group_name, check_interval_hours, 
         COUNT(*) as ads_checked,
         COUNT(*) FILTER (WHERE serving_status = 'eligible') as eligible,
         COUNT(*) FILTER (WHERE serving_status = 'eligible_limited') as limited,
         COUNT(*) FILTER (WHERE serving_status = 'not_eligible') as disapproved
  FROM gads_trial_checks tc
  JOIN gads_trials t ON tc.trial_id = t.trial_id
  WHERE tc.check_time >= NOW() - INTERVAL '24 hours'
  GROUP BY trial_group_name, check_interval_hours
  ORDER BY trial_group_name, check_interval_hours;
"
```

#### Monitor Trial Health
```bash
# Check for trials missing checks
psql helios -c "
  SELECT t.trial_group_name, t.started_at,
         COUNT(DISTINCT tc.check_interval_hours) as checks_done,
         EXTRACT(HOUR FROM NOW() - t.started_at) as hours_running
  FROM gads_trials t
  LEFT JOIN gads_trial_checks tc ON t.trial_id = tc.trial_id
  WHERE t.status = 'running'
  GROUP BY t.trial_id, t.trial_group_name, t.started_at
  HAVING COUNT(DISTINCT tc.check_interval_hours) < 
         CASE 
           WHEN EXTRACT(HOUR FROM NOW() - t.started_at) >= 48 THEN 4
           WHEN EXTRACT(HOUR FROM NOW() - t.started_at) >= 24 THEN 3
           WHEN EXTRACT(HOUR FROM NOW() - t.started_at) >= 4 THEN 2
           WHEN EXTRACT(HOUR FROM NOW() - t.started_at) >= 1 THEN 1
           ELSE 0
         END;
"
```

## Weekly Operations

### Sunday Evening (9pm)

#### Run L3 Meta-Analysis
```bash
# Get L2 run IDs from this week
psql helios -c "
  SELECT string_agg(run_id, ',')
  FROM gads_l2_runs
  WHERE started_at >= date_trunc('week', NOW())
    AND status = 'completed';
" -t > /tmp/l2-runs-this-week.txt

# Run L3 analysis
./ads/google/scripts/run-l3-analysis.ts \
  --l2-runs $(cat /tmp/l2-runs-this-week.txt) \
  --output-dir ads/google/outputs/l3
```

### Monday Morning (10am)

#### Review L3 Proposals
```bash
# Open latest L3 proposals
ls -t ads/google/outputs/l3/*-proposals.md | head -1 | xargs open

# Review checklist:
# □ Prediction accuracy acceptable?
# □ Pattern effectiveness makes sense?
# □ Proposed updates reasonable?
# □ Expected impacts credible?
# □ Confidence scores appropriate?
```

#### Apply Approved L3 Updates
```bash
# For each approved proposal:

# 1. Backup current config
cp config/l1-config.yaml config/backups/l1-config-$(date +%Y-%m-%d).yaml
cp config/l2-prompts.yaml config/backups/l2-prompts-$(date +%Y-%m-%d).yaml

# 2. Apply approved changes
# Edit config/l1-config.yaml or config/l2-prompts.yaml

# 3. Test with dry-run
./ads/google/scripts/run-analysis.ts \
  --snapshot ads/google/snapshots/gads_ads_$(date -d yesterday +%Y-%m-%d).jsonl \
  --output-dir ads/google/outputs/test-new-config

# 4. Compare results
diff <(jq -S . ads/google/outputs/$(date -d yesterday +%Y-%m-%d)/json/*-l2-output.json) \
     <(jq -S . ads/google/outputs/test-new-config/json/*-l2-output.json)

# 5. If good, commit config changes
git add config/
git commit -m "Apply L3 proposal: <description>"
git push

# 6. Update L3 evaluation governance status
psql helios -c "
  UPDATE gads_l3_evaluations
  SET governance_status = 'approved',
      approved_at = NOW(),
      approved_by = 'dave',
      governance_notes = '<notes>'
  WHERE evaluation_id = '<eval-id>';
"
```

## Monthly Operations

### First Monday of Month

#### System Health Review
```bash
# Generate monthly report
psql helios -c "
  WITH monthly_stats AS (
    SELECT 
      DATE_TRUNC('month', snapshot_date) as month,
      COUNT(DISTINCT run_id) as l2_runs,
      SUM(families_analyzed) as families_analyzed,
      SUM(trials_created) as trials_created
    FROM gads_l2_runs
    WHERE started_at >= NOW() - INTERVAL '3 months'
      AND status = 'completed'
    GROUP BY DATE_TRUNC('month', snapshot_date)
  ),
  l3_stats AS (
    SELECT
      DATE_TRUNC('month', evaluation_date) as month,
      COUNT(*) as l3_evaluations,
      AVG((prediction_accuracy->>'precision')::numeric) as avg_precision,
      AVG((prediction_accuracy->>'recall')::numeric) as avg_recall
    FROM gads_l3_evaluations
    WHERE evaluation_date >= NOW() - INTERVAL '3 months'
    GROUP BY DATE_TRUNC('month', evaluation_date)
  )
  SELECT 
    COALESCE(ms.month, ls.month) as month,
    COALESCE(ms.l2_runs, 0) as l2_runs,
    COALESCE(ms.families_analyzed, 0) as families,
    COALESCE(ms.trials_created, 0) as trials,
    COALESCE(ls.l3_evaluations, 0) as l3_evals,
    ROUND(COALESCE(ls.avg_precision, 0) * 100, 1) as avg_precision_pct,
    ROUND(COALESCE(ls.avg_recall, 0) * 100, 1) as avg_recall_pct
  FROM monthly_stats ms
  FULL OUTER JOIN l3_stats ls ON ms.month = ls.month
  ORDER BY month DESC;
"
```

#### Cost Analysis
```bash
# Estimate LLM costs
psql helios -c "
  SELECT 
    DATE_TRUNC('month', started_at) as month,
    SUM(families_analyzed) as families,
    SUM(families_analyzed) * 0.02 as l1_cost_usd,
    SUM(families_analyzed) * 1.00 as l2_cost_usd,
    COUNT(DISTINCT DATE(started_at)) * 7 as l3_cost_usd,
    SUM(families_analyzed) * 1.02 + COUNT(DISTINCT DATE(started_at)) * 7 as total_cost_usd
  FROM gads_l2_runs
  WHERE started_at >= NOW() - INTERVAL '3 months'
    AND status = 'completed'
  GROUP BY DATE_TRUNC('month', started_at)
  ORDER BY month DESC;
"
```

## Emergency Procedures

### Pause All Trials Immediately
```sql
-- If trials are causing issues
UPDATE gads_trials
SET status = 'paused'
WHERE status = 'running';
```

Then manually pause trial ad groups in Ads Editor.

### Rollback L3 Changes
```bash
# Restore previous config
cp config/backups/l1-config-<date>.yaml config/l1-config.yaml
cp config/backups/l2-prompts-<date>.yaml config/l2-prompts.yaml

git add config/
git commit -m "Rollback L3 changes - <reason>"
git push
```

### Disable Monitoring
```bash
# Comment out cron jobs temporarily
crontab -e
# Add # at start of each gads monitoring line
```

## Contact

**Primary**: Dave (page-dave -p 3 "<message>")
**Escalation**: Check litalerts dashboard
**Documentation**: ads/google/docs/

## Quick Reference

| Task | Command | Frequency |
|------|---------|-----------|
| Export snapshot | `./scripts/helios-export-snapshot.ts` | Daily 00:00 |
| Run analysis | `./scripts/run-analysis.ts --snapshot <file>` | Daily 09:00 |
| Monitor 1hr | `./scripts/monitor-trials.ts --interval 1` | Hourly |
| Monitor 4hr | `./scripts/monitor-trials.ts --interval 4` | Every 4hr |
| Monitor 24hr | `./scripts/monitor-trials.ts --interval 24` | Daily 01:00 |
| Monitor 48hr | `./scripts/monitor-trials.ts --interval 48` | Daily 02:00 |
| Cleanup | `./scripts/cleanup-trials.ts` | Daily 03:00 |
| L3 analysis | `./scripts/run-l3-analysis.ts --l2-runs <ids>` | Weekly Sun |

## Notes

- Always use `--dry-run` flag when testing
- Review HTML packet before importing CSVs
- Check validation_messages for warnings
- Keep config backups before applying L3 updates
- Monitor trial health daily
- Review L3 proposals weekly
