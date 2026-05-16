# Google Ads Automation - Status & Monitoring

**System**: Deployed to production on vps-nixos-3  
**Status**: ✅ Active (systemd timers running)

---

## Quick Status Check

```bash
# See all Google Ads timers and their next run times
systemctl list-timers | grep gads

# See detailed status of all services
systemctl status 'gads-*'

# Check specific service
systemctl status gads-snapshot-export.timer
systemctl status gads-run-analysis.service
```

---

## View Logs

### Recent Logs
```bash
# View logs from the last run of snapshot export
journalctl -u gads-snapshot-export.service -n 100

# View logs from L2 analysis
journalctl -u gads-run-analysis.service -n 100

# View logs from trial monitoring
journalctl -u gads-monitor-trials-1hr.service -n 100

# View logs from L3 analysis
journalctl -u gads-l3-analysis.service -n 100
```

### Live Logs (follow mode)
```bash
# Watch L2 analysis in real-time
journalctl -u gads-run-analysis.service -f

# Watch all gads services
journalctl -u 'gads-*' -f
```

### Logs Since Yesterday
```bash
journalctl -u 'gads-*' --since yesterday
```

---

## Output Files

### Generated Artifacts

```bash
# List all snapshots
ls -lht /home/amp-local/src/automation/ads/google/snapshots/

# List production outputs
ls -lht /home/amp-local/src/automation/ads/google/outputs/prod/

# View latest L2 predictions
cat /home/amp-local/src/automation/ads/google/outputs/prod/json/run-*.json | jq '.'

# View latest HTML review packet
ls -lht /home/amp-local/src/automation/ads/google/outputs/prod/html/

# View latest CSV batches
ls -lht /home/amp-local/src/automation/ads/google/outputs/prod/csv/

# List L3 analysis outputs
ls -lht /home/amp-local/src/automation/ads/google/outputs/l3/
```

### Quick File Check
```bash
# See what was generated today
find /home/amp-local/src/automation/ads/google/outputs -type f -mtime -1 -ls
```

---

## Manual Trigger (for testing)

### Run Services Manually

```bash
# Manually trigger snapshot export
sudo systemctl start gads-snapshot-export.service

# Manually trigger L2 analysis
sudo systemctl start gads-run-analysis.service

# Manually trigger trial monitoring
sudo systemctl start gads-monitor-trials-1hr.service

# Manually trigger L3 analysis
sudo systemctl start gads-l3-analysis.service
```

### Or Run Scripts Directly

```bash
cd /home/amp-local/src/automation/ads/google

# Export snapshot
npx tsx scripts/helios-export-snapshot.ts

# Run analysis with example data
npx tsx scripts/run-analysis.ts \
  --snapshot snapshots/example-snapshot.jsonl \
  --output-dir outputs/test

# Run analysis with latest snapshot
npx tsx scripts/run-analysis.ts \
  --snapshot snapshots/ads-snapshot-$(ls -t snapshots/ads-snapshot-*.jsonl | head -1 | cut -d/ -f2) \
  --output-dir outputs/manual
```

---

## Web Access

### HTML Review Packets

The system generates HTML review packets at:
```
/home/amp-local/src/automation/ads/google/outputs/prod/html/
```

**To view**:
```bash
# Copy to mss-one-offs for web access (if configured)
cp outputs/prod/html/run-*.html /path/to/mss-one-offs/public/gads-review/

# Or view locally
cd outputs/prod/html
python3 -m http.server 8000
# Then open http://vps-nixos-3.squeaker-court.ts.net:8000 in browser
```

---

## Timer Schedule

```
gads-snapshot-export        Daily at 00:00
gads-run-analysis           Daily at 09:00
gads-monitor-trials-1hr     Every hour
gads-monitor-trials-4hr     Every 4 hours
gads-monitor-trials-24hr    Daily at 01:00
gads-monitor-trials-48hr    Daily at 02:00
gads-cleanup-trials         Daily at 03:00
gads-l3-analysis            Sunday at 04:00
```

---

## Common Checks

### Did today's snapshot export run?
```bash
journalctl -u gads-snapshot-export.service --since today
ls -lht snapshots/ | head -5
```

### Did today's analysis run?
```bash
journalctl -u gads-run-analysis.service --since today
ls -lht outputs/prod/json/ | head -5
```

### Are trials being monitored?
```bash
journalctl -u gads-monitor-trials-1hr.service --since "1 hour ago"
```

### What's the next scheduled run?
```bash
systemctl list-timers | grep gads
```

---

## Troubleshooting

### Service Failed

```bash
# Check why a service failed
systemctl status gads-run-analysis.service

# View full error log
journalctl -u gads-run-analysis.service -xe

# Restart a timer
sudo systemctl restart gads-run-analysis.timer
```

### No Output Files

```bash
# Check if snapshot exists
ls -la snapshots/

# Check if analysis ran
journalctl -u gads-run-analysis.service -n 50

# Check permissions
ls -la outputs/
```

### LLM Not Working

```bash
# Verify Bedrock Mantle token is available
ls -la ~/.secret/bedrock/mantle-bearer-token

# Test LLM manually
cd /home/amp-local/src/automation/ads/google
npx tsx scripts/run-analysis.ts \
  --snapshot snapshots/example-snapshot.jsonl \
  --output-dir outputs/llm-test

# Check for "⚠️ LLM not configured" in output
```

### Database Connection Issues

```bash
# Check PostgreSQL secrets are available
ls -la ~/.secret/postgres/fbnyc/local/

# Test Helios connection
# (depends on how helios-export-snapshot.ts connects)
```

---

## Monitoring Dashboard (Future)

Consider adding to Helios web UI:
- Link to latest HTML review packet
- List of recent L2 runs with status
- Trial monitoring status
- L3 proposal review interface

---

## Quick Start Commands

```bash
# Status overview
systemctl list-timers | grep gads
systemctl status 'gads-*' | grep -E '(●|Active|Trigger)'

# Check last run
journalctl -u gads-run-analysis.service --since yesterday | tail -50

# View latest outputs
ls -lht outputs/prod/html/ | head -5
ls -lht outputs/prod/json/ | head -5

# Manual test run
cd /home/amp-local/src/automation/ads/google
npx tsx scripts/run-analysis.ts \
  --snapshot snapshots/example-snapshot.jsonl \
  --output-dir outputs/test
```
