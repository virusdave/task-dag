# Cutover Procedure - Switch to Helios

**Tasks**: Switch traffic, decommission Python  
**Issue**: #2  
**Created**: 2026-05-13

## Prerequisites

- [x] Parallel run completed successfully (parity >= 99%)
- [x] Operator approval of Helios implementation
- [x] Rollback plan tested and ready
- [ ] Production deployment complete
- [ ] Monitoring dashboards configured
- [ ] On-call rotation aware of cutover

## Cutover Window

**Recommended**: Non-peak hours, after successful generation
- Preferred: Monday morning after successful weekend test
- Backup: Any weekday morning after validation

## Step-by-Step Cutover

### Phase 1: Pre-Cutover Validation (T-1 day)

1. **Verify Helios is healthy**:
   ```bash
   # Check latest packet generation
   curl http://helios/api/pending-purchases/packets | jq '.[-1]'
   
   # Verify database connectivity
   psql $TIGERDATA_URL -c "SELECT COUNT(*) FROM pending_purchase_packets WHERE status='ready';"
   
   # Check worker jobs status
   curl http://helios/api/jobs | jq '.[] | select(.jobType | contains("PendingPurchase"))'
   ```

2. **Run final parity check**:
   ```bash
   # Generate with both systems
   # Compare outputs
   # Document results
   ```

3. **Notify stakeholders**:
   - Catalog operators
   - On-call team
   - Management (if required)

### Phase 2: Cutover Execution (T-0)

1. **Disable Python cron** (if exists):
   ```bash
   # Check for existing cron
   crontab -l | grep pending.*purchase
   
   # Comment out or remove
   crontab -e
   # Add: # DISABLED 2026-05-13 - migrated to Helios
   ```

2. **Enable Helios scheduling**:
   ```typescript
   // In helios/src/worker/config/pendingPurchasesSchedule.ts
   // Ensure enabled: true for generateDaily
   ```

3. **Restart Helios worker**:
   ```bash
   systemctl restart helios-worker
   # Or equivalent for your deployment
   ```

4. **Verify first Helios-only generation**:
   ```bash
   # Trigger immediately (don't wait for cron)
   curl -X POST http://helios/api/pending-purchases/packets/generate
   
   # Monitor job execution
   tail -f /var/log/helios/worker.log | grep -i "pending.*purchase"
   
   # Verify packet created
   curl http://helios/api/pending-purchases/packets | jq '.[-1]'
   ```

5. **Smoke test the output**:
   - Review packet in Helios UI
   - Check row count, pricing, flags
   - Verify no corruption or data loss
   - Test price slider interactions

### Phase 3: Monitoring (T+0 to T+7 days)

1. **Watch for errors**:
   ```bash
   # Monitor Helios logs
   tail -f /var/log/helios/*.log | grep -i error
   
   # Check job success rate
   curl http://helios/api/jobs/stats
   ```

2. **Validate daily packets**:
   - Each day's packet generated successfully
   - No missing data
   - Pricing calculations correct
   - Review flags appropriate

3. **Track metrics**:
   - Job duration (should be < 10 minutes)
   - Success rate (should be 100%)
   - API call counts (Sweed, Lit Alerts, Mantle)
   - Operator satisfaction

### Phase 4: Decommission Python (T+7 days)

**Only proceed if**: 7 days of successful Helios-only operation

1. **Archive Python scripts**:
   ```bash
   cd /home/amp-local/src/automation
   mkdir -p archive/pending-purchases-python-$(date +%Y-%m-%d)
   
   # Move Python generator and apply scripts
   mv catalog/purchases/2026-05-11/*.py archive/pending-purchases-python-*/
   mv categories/2026-04-13/*pending*.py archive/pending-purchases-python-*/
   
   # Keep manifests and caches (still useful)
   # Keep documentation (historical reference)
   ```

2. **Update documentation**:
   ```bash
   # Update AGENTS.md, runbooks, etc.
   # Mark Python path as deprecated/archived
   # Point to Helios for all new work
   ```

3. **Remove dependencies**:
   ```bash
   # Check if any other scripts import the Python modules
   grep -r "import.*generate_pending_order" .
   
   # Remove if no dependencies
   ```

4. **Commit archive**:
   ```bash
   git add archive/ catalog/ categories/
   git commit -m "Archive Python pending purchases implementation

Migrated to Helios - Python scripts archived for historical reference.

Migration completed: 2026-05-XX
Parallel run: 2026-05-XX to 2026-05-XX (7 days)
Parity achieved: XX.X%

Python implementation served 2026-04-13 to 2026-05-XX.

Archived to: archive/pending-purchases-python-2026-05-XX/"
   ```

5. **Final cleanup**:
   ```bash
   # Remove HAR files (secrets migrated to env vars)
   # Remove caches (no longer needed)
   # Keep manifests (may be reusable)
   ```

## Rollback Procedure

If issues discovered during cutover:

1. **Immediate**: Re-enable Python cron
   ```bash
   crontab -e
   # Uncomment the Python generation line
   ```

2. **Disable Helios**:
   ```typescript
   // Set enabled: false in pendingPurchasesSchedule.ts
   systemctl restart helios-worker
   ```

3. **Investigate and fix**:
   - Review error logs
   - Identify root cause
   - Fix Helios implementation
   - Re-test

4. **Retry cutover** when fixed

## Success Criteria

Cutover is successful when:

- [x] Python cron disabled
- [x] Helios scheduling enabled
- [x] 7 days of Helios-only operation
- [x] No generation failures
- [x] Operator satisfaction with output quality
- [x] No regression in review workflow
- [x] Performance acceptable
- [x] Python scripts archived
- [x] Documentation updated

## Communication Plan

**Before cutover**:
- Notify operators 48 hours in advance
- Share parallel run results
- Explain new workflow (Helios UI)

**During cutover**:
- Real-time status updates
- Available for questions
- Monitor first generation closely

**After cutover**:
- Daily check-ins for first week
- Gather operator feedback
- Address any concerns quickly

## Rollforward Plan

After successful 7-day monitoring:

1. Mark Python implementation as fully deprecated
2. Remove from operational runbooks
3. Train all operators on Helios workflow
4. Archive remaining Python artifacts
5. Celebrate successful migration! 🎉
