# Bootstrap Guide - Google Ads Optimization System

**Date**: 2026-05-15  
**Goal**: Get the system operational for first production run

---

## Prerequisites

```bash
# 1. Install dependencies
cd /home/amp-local/src/automation
npm install google-ads-api zod dotenv

# 2. Setup environment variables
cp ads/google/.env.example ads/google/.env
# Edit .env with:
# - GADS_* credentials
# - HELIOS_* database connection
# - LLM_ENDPOINT URLs
```

---

## Step 1: Deploy Helios Schema

```bash
# Connect to Helios database
psql $HELIOS_DATABASE_URL

# Deploy schema
\i /home/amp-local/src/automation/ads/google/lib/helios/schema.sql

# Verify tables created
\dt gads.*
```

**Expected tables**:
- `gads.ads_snapshot`
- `gads.trial_ads`
- `gads.trial_checks`
- `gads.l2_analysis_runs`
- `gads.l3_evaluations`

---

## Step 2: Configure Google Ads API

```bash
# Create credentials file
cat > ads/google/config/gads-credentials.json <<EOF
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET",
  "refresh_token": "YOUR_REFRESH_TOKEN",
  "developer_token": "YOUR_DEVELOPER_TOKEN"
}
EOF

# Or set environment variables in .env:
# GADS_CLIENT_ID=...
# GADS_CLIENT_SECRET=...
# GADS_REFRESH_TOKEN=...
# GADS_DEVELOPER_TOKEN=...
# GADS_CUSTOMER_ID=...
```

---

## Step 3: First Snapshot Export

```bash
cd /home/amp-local/src/automation/ads/google

# Run snapshot export (exports from Helios → JSONL)
npx tsx scripts/helios-export-snapshot.ts

# Verify output
ls -lh snapshots/
cat snapshots/ads-snapshot-YYYYMMDD-HHMMSS.jsonl | jq '.' | head -50
```

**Expected**: JSONL file with ad snapshots from Helios database.

---

## Step 4: First L1→L2 Analysis

```bash
# Run analysis pipeline
npx tsx scripts/run-analysis.ts

# Check outputs
ls -lh outputs/json/
ls -lh outputs/csv/
ls -lh outputs/html/
```

**Expected outputs**:
- `outputs/json/l2-predictions-TIMESTAMP.json` - L2 analysis results
- `outputs/csv/001-repairs.csv` through `005-new-trials.csv` - Ads Editor imports
- `outputs/html/review-packet-TIMESTAMP.html` - Human review interface

---

## Step 5: Review HTML Packet

```bash
# Serve HTML for review
python3 -m http.server 8000 --directory outputs/html/

# Or copy to mss-one-offs
cp outputs/html/review-packet-*.html $MSS_ONE_OFFS_PATH/
```

**Manual action**: Open HTML in browser, review:
- Policy risk predictions
- Recommended actions (repair/replace/pause/trial)
- CSV batches to import
- Trial experiments planned

**Decision**: Approve or modify CSVs before import.

---

## Step 6: Import CSV Batches

```bash
# Review CSVs
for csv in outputs/csv/*.csv; do
  echo "=== $csv ==="
  head -20 "$csv"
done
```

**Manual action**: 
1. Open **Google Ads Editor**
2. Import CSVs in order: `001-repairs.csv`, `002-replacements.csv`, etc.
3. Review changes in editor
4. Post changes to Google Ads

**Expected**: Changes propagate to Google Ads within minutes.

---

## Step 7: Monitor First Trial Batch

```bash
# Wait 1 hour, then check trial status
sleep 3600
npx tsx scripts/monitor-trials.ts --interval=1hr

# Check again at 4hr, 24hr, 48hr
npx tsx scripts/monitor-trials.ts --interval=4hr
npx tsx scripts/monitor-trials.ts --interval=24hr
npx tsx scripts/monitor-trials.ts --interval=48hr

# After 48hr, cleanup completed trials
npx tsx scripts/cleanup-trials.ts
```

**Expected**: Trial status recorded in Helios → used for L3 meta-analysis.

---

## Step 8: First L3 Meta-Analysis

```bash
# After trials complete (48hr+), run L3
npx tsx scripts/run-l3-analysis.ts

# Review L3 proposals
cat outputs/json/l3-evaluation-*.json | jq '.prompt_updates'
```

**Manual action**: 
1. Review L3 proposals for prompt/rule updates
2. Approve changes to `config/l2-prompts.yaml` and `config/l1-config.yaml`
3. Increment version numbers
4. Commit configuration changes

---

## Step 9: Setup Automation (Cron)

```bash
# Add to crontab
crontab -e
```

```cron
# Daily snapshot export (00:00)
0 0 * * * cd /home/amp-local/src/automation/ads/google && npx tsx scripts/helios-export-snapshot.ts

# Daily L1→L2 analysis (09:00)
0 9 * * * cd /home/amp-local/src/automation/ads/google && npx tsx scripts/run-analysis.ts

# Trial monitoring (hourly for 1hr checks)
0 * * * * cd /home/amp-local/src/automation/ads/google && npx tsx scripts/monitor-trials.ts --interval=1hr

# Trial monitoring (every 4hr for 4hr checks)
0 */4 * * * cd /home/amp-local/src/automation/ads/google && npx tsx scripts/monitor-trials.ts --interval=4hr

# Trial monitoring (daily for 24hr checks, 01:00)
0 1 * * * cd /home/amp-local/src/automation/ads/google && npx tsx scripts/monitor-trials.ts --interval=24hr

# Trial monitoring (daily for 48hr checks, 02:00)
0 2 * * * cd /home/amp-local/src/automation/ads/google && npx tsx scripts/monitor-trials.ts --interval=48hr

# Trial cleanup (daily, 03:00)
0 3 * * * cd /home/amp-local/src/automation/ads/google && npx tsx scripts/cleanup-trials.ts

# Weekly L3 meta-analysis (Sunday 04:00)
0 4 * * 0 cd /home/amp-local/src/automation/ads/google && npx tsx scripts/run-l3-analysis.ts
```

---

## Step 10: Operational Monitoring

```bash
# Setup litalerts integration
# Add monitoring for:
# - Snapshot export failures
# - L2 analysis errors
# - Trial creation failures
# - API rate limit errors
```

---

## Troubleshooting

### Snapshot export fails
- Check Helios database connection
- Verify `gads.ads_snapshot` table exists
- Check for recent data in Helios

### L2 analysis fails
- Check LLM endpoint configuration
- Verify snapshot JSONL file exists
- Check L1 config file syntax

### CSV import fails in Ads Editor
- Verify CSV format matches Ads Editor requirements
- Check for special characters in ad copy
- Ensure campaign/ad group IDs are correct

### Trial monitoring fails
- Check Google Ads API credentials
- Verify trial ads were created successfully
- Check API rate limits

---

## Success Criteria

✅ **Day 1**: Snapshot → L1→L2 → CSV → Import complete  
✅ **Day 2-3**: First trial batch monitored at all intervals  
✅ **Week 1**: L3 meta-analysis produces first proposals  
✅ **Week 2**: System running on cron, no manual intervention  

---

## Reference

- **Architecture**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Deployment**: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- **Operations**: [docs/OPERATOR_RUNBOOK.md](docs/OPERATOR_RUNBOOK.md)
- **Data Schemas**: [docs/DATA_SCHEMAS.md](docs/DATA_SCHEMAS.md)
