# Google Ads Content Optimization - Deployment Guide

## System Overview

The three-layer agentic system for Google Ads content optimization is now complete and ready for deployment.

## Prerequisites

### 1. Helios Database
```sql
-- Run schema migration
psql -h <helios-host> -U <user> -d helios < ads/google/lib/helios/schema.sql
```

### 2. Google Ads API Credentials
Required environment variables:
```bash
export GADS_CLIENT_ID="..."
export GADS_CLIENT_SECRET="..."
export GADS_DEVELOPER_TOKEN="..."
export GADS_REFRESH_TOKEN="..."
export GADS_CUSTOMER_ID="123-456-7890"
```

### 3. Dependencies
```bash
cd ads/google
pnpm install  # Install google-ads-api, zod, and other dependencies
```

### 4. Configuration
Update config files with production values:
- `config/l1-config.yaml`: Update restricted vocab buckets (not committed)
- `config/l2-prompts.yaml`: Update for production LLM endpoints

## Deployment Steps

### Step 1: Deploy Helios Schema
```bash
# In helios directory
./scripts/runMigrations.ts ads/google/lib/helios/schema.sql
```

### Step 2: Configure Google Ads API Access
```bash
# Create credentials file
cat > ads/google/config/gads-credentials.json <<EOF
{
  "client_id": "${GADS_CLIENT_ID}",
  "client_secret": "${GADS_CLIENT_SECRET}",
  "developer_token": "${GADS_DEVELOPER_TOKEN}",
  "refresh_token": "${GADS_REFRESH_TOKEN}",
  "customer_id": "${GADS_CUSTOMER_ID}"
}
EOF

chmod 600 ads/google/config/gads-credentials.json
```

### Step 3: Initial Snapshot
```bash
# Export first snapshot
./ads/google/scripts/helios-export-snapshot.ts \
  --date $(date +%Y-%m-%d) \
  --output ads/google/snapshots/gads_ads_$(date +%Y-%m-%d).jsonl
```

### Step 4: Run Initial Analysis
```bash
# Run L1 → L2 analysis
./ads/google/scripts/run-analysis.ts \
  --snapshot ads/google/snapshots/gads_ads_$(date +%Y-%m-%d).jsonl \
  --output-dir ads/google/outputs/production
```

### Step 5: Review and Import CSVs
```bash
# Review HTML packet
open ads/google/outputs/production/html/*-review-packet.html

# Import CSVs into Google Ads Editor (sequential):
# 1. Open Google Ads Editor
# 2. Import 001-create-trial-campaigns-and-ad-groups.csv
# 3. Import 002-repair-existing-ads.csv
# 4. Import 003-replace-and-new-ads.csv
# 5. Import 004-pause-high-risk-ads.csv
# 6. Import 005-create-trial-ads.csv
# 7. Post changes to Google Ads
```

### Step 6: Setup Monitoring Cron Jobs
```bash
# Add to crontab
# Check trials at 1hr mark (every hour)
0 * * * * cd /path/to/automation && ./ads/google/scripts/monitor-trials.ts --interval 1

# Check trials at 4hr mark (every 4 hours)
0 */4 * * * cd /path/to/automation && ./ads/google/scripts/monitor-trials.ts --interval 4

# Check trials at 24hr mark (once per day at 1am)
0 1 * * * cd /path/to/automation && ./ads/google/scripts/monitor-trials.ts --interval 24

# Check trials at 48hr mark and cleanup (once per day at 2am)
0 2 * * * cd /path/to/automation && ./ads/google/scripts/monitor-trials.ts --interval 48
0 3 * * * cd /path/to/automation && ./ads/google/scripts/cleanup-trials.ts
```

### Step 7: Setup Nightly Snapshot Export
```bash
# Add to crontab (run at midnight)
0 0 * * * cd /path/to/automation && ./ads/google/scripts/helios-export-snapshot.ts --date $(date +%Y-%m-%d)
```

### Step 8: Weekly L3 Analysis
```bash
# Add to crontab (run Sunday at 3am)
0 3 * * 0 cd /path/to/automation && ./ads/google/scripts/run-l3-analysis.ts --l2-runs $(cat outputs/l2-runs-this-week.txt)
```

## Operational Workflow

### Daily Cycle
1. **00:00**: Helios exports snapshot to JSONL
2. **On demand**: Human runs L1→L2 analysis
3. **Manual**: Human reviews HTML packet
4. **Manual**: Human imports CSVs 001-005 into Ads Editor
5. **Hourly**: Monitor trials at 1hr, 4hr marks
6. **03:00**: Monitor trials at 48hr mark + cleanup

### Weekly Cycle
1. **Sunday 03:00**: L3 meta-analysis on past week's trials
2. **Monday**: Human reviews L3 proposals
3. **Monday**: Human approves/rejects prompt updates
4. **Monday**: Apply approved changes to config
5. **Continuous**: Improved prompts used in next L2 runs

## Monitoring

### Check Active Trials
```sql
SELECT * FROM gads_active_trials ORDER BY started_at DESC;
```

### Check Trial Outcomes
```sql
SELECT * FROM gads_trial_outcomes 
WHERE trial_id = 'trial-xyz'
ORDER BY check_interval_hours, is_control DESC;
```

### Check L2 Runs
```sql
SELECT run_id, snapshot_date, status, families_analyzed, trials_created
FROM gads_l2_runs
ORDER BY started_at DESC
LIMIT 10;
```

### Check L3 Evaluations
```sql
SELECT 
  evaluation_id,
  evaluation_date,
  prediction_accuracy->>'precision' as precision,
  prediction_accuracy->>'recall' as recall,
  array_length(proposed_updates, 1) as proposal_count,
  governance_status
FROM gads_l3_evaluations
ORDER BY evaluation_date DESC;
```

## Troubleshooting

### Snapshot Export Fails
- Check Helios database connectivity
- Verify Google Ads API credentials
- Check API rate limits

### L2 Analysis Fails
- Check JSONL format validity
- Verify all required fields present
- Check LLM API connectivity

### CSV Import Fails
- Validate CSV format
- Check for required columns
- Review validation_messages in HTML packet

### Trial Monitoring Fails
- Check Google Ads API credentials
- Verify trial ad group IDs exist
- Check rate limit delays

### Trial Cleanup Fails
- Verify 48hr has passed
- Check all 4 checks completed
- Verify API permissions for ad group deletion

## Alerts

### Setup litalerts Integration
```typescript
// When L2 run completes
if (highRiskFamilies > 5 || trialsCreated > 0) {
  await sendLitalert({
    title: `Google Ads Analysis Complete - ${snapshotDate}`,
    message: `${highRiskFamilies} high-risk families, ${trialsCreated} trials`,
    link: htmlPacketUrl,
    priority: highRiskFamilies > 10 ? 'high' : 'medium'
  });
}
```

## Backup and Recovery

### Backup L2 Outputs
```bash
# Daily backup
rsync -av ads/google/outputs/production/ backup/gads-outputs-$(date +%Y-%m-%d)/
```

### Backup Configuration Versions
```bash
# Before applying L3 proposals
cp config/l1-config.yaml config/backups/l1-config-$(date +%Y-%m-%d).yaml
cp config/l2-prompts.yaml config/backups/l2-prompts-$(date +%Y-%m-%d).yaml
```

## Success Metrics

### Short-term (Week 1)
- [ ] First snapshot exported successfully
- [ ] First L2 analysis completes
- [ ] CSVs imported into Ads Editor
- [ ] First trial batch created (batch 00001)
- [ ] Trial monitoring running at all intervals

### Medium-term (Month 1)
- [ ] L2 precision/recall >60/50
- [ ] 10+ trial batches completed
- [ ] First L3 analysis completes
- [ ] First L3 proposals approved and applied
- [ ] Measurable reduction in limited ads

### Long-term (Month 3)
- [ ] L2 precision/recall >70/60
- [ ] 100+ trial batches completed
- [ ] L3 improvements applied 8+ times
- [ ] System running autonomously with weekly L3 reviews

## Production Checklist

- [ ] Helios schema deployed
- [ ] Google Ads API credentials configured
- [ ] First snapshot exported
- [ ] First L2 analysis successful
- [ ] HTML packet reviewed
- [ ] CSVs imported and posted
- [ ] Trial monitoring cron jobs active
- [ ] Trial cleanup cron job active
- [ ] Nightly snapshot export scheduled
- [ ] Weekly L3 analysis scheduled
- [ ] litalerts integration configured
- [ ] Backup procedures in place
- [ ] Monitoring dashboards set up
- [ ] Team trained on workflow

## Status

**Current**: System fully implemented, ready for production deployment
**Next**: Deploy Helios schema and configure API credentials
