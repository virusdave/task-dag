# Parallel Run Procedure - Python & Helios

**Task**: Run both systems in parallel  
**Issue**: #2  
**Created**: 2026-05-13

## Purpose

Execute Python and Helios implementations side-by-side to validate parity before cutover.

## Prerequisites

- [x] Helios implementation complete
- [x] Database schema deployed to TigerData
- [x] Secrets configured (Sweed, Lit Alerts, Mantle)
- [x] Monitoring enabled
- [ ] Test environment prepared
- [ ] Validation scripts ready

## Parallel Run Duration

**Recommended**: 7 days (1 week)
- Covers at least 7 daily generation cycles
- Multiple distributor deliveries
- Various order types and edge cases
- Sufficient data for statistical confidence

## Execution Steps

### Day 0: Preparation

1. **Deploy Helios to test environment**
   ```bash
   cd /home/amp-local/src/automation/helios
   # Deploy database migration
   psql $TIGERDATA_URL -f src/server/db/migrations/007_pending_purchases.sql
   
   # Build and deploy Helios
   npm run build
   # Deploy to test environment
   ```

2. **Configure job scheduling**
   ```bash
   # Enable daily generation for both systems
   # Python: Keep existing cron (if any) or manual trigger
   # Helios: Configure worker job schedule
   ```

3. **Set up output capture**
   ```bash
   mkdir -p /tmp/parallel-run/{python,helios}/{day-1..day-7}
   ```

### Days 1-7: Parallel Execution

**Each Day**:

1. **Trigger both systems** (manual or cron):
   ```bash
   # Python generation
   cd /home/amp-local/src/automation/catalog/purchases
   DATE=$(date +%Y-%m-%d)
   mkdir -p $DATE
   cd $DATE
   cp ../2026-05-11/generate_combined_pending_packet.py .
   cp ../2026-05-11/_legacy_patches.py .
   python generate_combined_pending_packet.py > /tmp/parallel-run/python/day-$DAY/output.log 2>&1
   cp combined_pending_purchases_proposal.json /tmp/parallel-run/python/day-$DAY/
   
   # Helios generation
   # Trigger via API or cron
   # curl -X POST http://helios/api/pending-purchases/packets/generate
   # Save output to /tmp/parallel-run/helios/day-$DAY/packet.json
   ```

2. **Run comparison**:
   ```bash
   python docs/pending_purchases/compare_outputs.py \
     /tmp/parallel-run/python/day-$DAY/combined_pending_purchases_proposal.json \
     /tmp/parallel-run/helios/day-$DAY/packet.json \
     > /tmp/parallel-run/comparison-day-$DAY.txt
   ```

3. **Review results**:
   - Check comparison output for discrepancies
   - Document any differences
   - Fix Helios if issues found
   - Re-run if needed

### Day 8: Analysis

1. **Aggregate results**:
   ```bash
   cat /tmp/parallel-run/comparison-day-*.txt > /tmp/parallel-run/SUMMARY.txt
   ```

2. **Calculate metrics**:
   - Total packets generated: Python ___ vs Helios ___
   - Total rows processed: Python ___ vs Helios ___
   - Average parity score: ___%
   - Discrepancies found: ___
   - Discrepancies resolved: ___

3. **Decision checkpoint**:
   - If parity >= 99% → Proceed to cutover
   - If parity < 99% → Extend parallel run or fix issues

## Comparison Checklist

For each day's output, verify:

- [ ] Row count matches
- [ ] All distributor product names present in both
- [ ] Pricing within tolerance (±$0.50)
- [ ] GM% within tolerance (±0.5 points)
- [ ] Brand/category parsing matches
- [ ] Evidence tier assignments match
- [ ] Review flags comparable (may differ in wording)
- [ ] Create vs link decisions match
- [ ] No critical data loss in either system

## Known Acceptable Differences

Document here as discovered:

- Timestamp formats (Python ISO vs TypeScript ISO)
- Field ordering in JSON
- Null representation (null vs omitted vs empty string)
- Float precision (pricing rounded differently)
- Image URL formats (if different sources used)

## Known Unacceptable Differences

Any of these require Helios fix:

- Different proposed prices (beyond ±$0.50)
- Different create/link decisions
- Missing distributor product names
- Incorrect GM% calculations
- Missing critical review flags
- Data corruption or loss

## Rollback Triggers

Stop parallel run and rollback to Python-only if:

- Helios generates corrupt data
- Helios fails to generate for >2 consecutive days
- Parity score drops below 90%
- Critical bug discovered in Helios
- Database corruption detected

## Documentation

Create after parallel run:
- `docs/pending_purchases/PARITY_VALIDATION_RESULTS.md`
- Include: day-by-day results, metrics, discrepancies, resolution

## Success Criteria

- [x] 7 days of parallel execution
- [ ] Parity >= 99% across all dimensions
- [ ] No unresolved critical discrepancies
- [ ] Helios performance acceptable (< 10min per packet)
- [ ] No data quality regressions
- [ ] Operator approval of Helios output quality

## Next Steps After Success

Proceed to: Traffic switch (task 39ed11d)
