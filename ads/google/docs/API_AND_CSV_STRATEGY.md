# Google Ads API and CSV Strategy

## Hybrid Approach

We use a hybrid approach to respect API rate limits while maintaining flexibility:

### API Usage: Data Retrieval & Complex Changes

**Use API for**:
- **Snapshot Exports**: Retrieve current ad state (campaigns, ad groups, ads, policy status, metrics)
- **Semi-Complex Data Retrieval**: Query specific ads, performance data, policy details
- **Complex Individual Changes**: One-off updates that require precise targeting
- **Status Monitoring**: Check trial approval status at intervals (1hr, 4hr, 24hr, 48hr)
- **Cleanup Operations**: Remove trial groups after final check

**Why API**:
- Precise targeting
- Complex queries
- Real-time status checks
- Automated cleanup

### CSV Usage: Bulk Changes via Ads Editor

**Use CSV for**:
- **Repair Actions**: Inline edits to existing ads (CSV 002)
- **Replacement Ads**: Create new compliant creatives (CSV 003)
- **Pause Actions**: Pause high-risk ads (CSV 004)
- **Trial Creation**: Create trial campaigns/groups and ads (CSV 001, 005)
- **Any bulk operations**: 10-1000 changes at once

**Why CSV**:
- No API rate limit concerns
- Bulk operations are fast
- Human review before import
- Unlimited capacity
- Sequential import workflow

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ API: Snapshot Export (Helios ingestion)                    │
│   - Campaigns, ad groups, ads                               │
│   - Policy status, metrics                                  │
│   - Export to JSONL                                         │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Analysis: L1 → L2 (offline)                                │
│   - Feature extraction                                      │
│   - Risk prediction                                         │
│   - Action planning                                         │
│   - CSV + HTML generation                                   │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ CSV: Bulk Changes (Human imports via Ads Editor)          │
│   - 001: Create trial infrastructure                        │
│   - 002: Repair existing ads                                │
│   - 003: Replace with new ads                               │
│   - 004: Pause high-risk ads                                │
│   - 005: Create trial ads                                   │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ API: Monitoring & Cleanup                                  │
│   - Check trial status at intervals (1hr, 4hr, 24hr, 48hr) │
│   - Collect policy + performance data                       │
│   - Remove trial groups after 48hr                          │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Analysis: L3 (offline)                                     │
│   - Compare predictions vs outcomes                         │
│   - Learn patterns (policy + performance)                   │
│   - Update prompts/rules                                    │
└─────────────────────────────────────────────────────────────┘
```

## Specific Operations

### Snapshot Export (API)
```typescript
// Helios pulls ad data via Google Ads API
const campaigns = await adsApi.campaigns.list();
const ads = await adsApi.ads.list();
const metrics = await adsApi.reports.query({
  metrics: ['impressions', 'clicks', 'conversions', 'ctr']
});

// Export to JSONL snapshot
writeSnapshot('gads_ads_2026-05-15.jsonl', ads);
```

### Bulk Changes (CSV)
```bash
# Human imports via Ads Editor
# 1. Open Ads Editor
# 2. Import 001-create-trial-campaigns-and-ad-groups.csv
# 3. Import 002-repair-existing-ads.csv
# 4. Import 003-replace-and-new-ads.csv
# 5. Import 004-pause-high-risk-ads.csv
# 6. Import 005-create-trial-ads.csv
# 7. Post changes to Google Ads
```

### Trial Monitoring (API)
```typescript
// Check trial status at intervals
const trialAds = await adsApi.ads.list({
  filter: `name CONTAINS "00001-" AND name CONTAINS "-trial-"`
});

for (const ad of trialAds) {
  const status = ad.policyStatus;
  const metrics = await adsApi.reports.query({
    adId: ad.id,
    metrics: ['impressions', 'ctr', 'conversions']
  });
  
  // Store for L3 analysis
  recordTrialOutcome(ad.id, status, metrics);
}
```

### Trial Cleanup (API)
```typescript
// After 48hr, remove trial groups
const oldTrials = await adsApi.adGroups.list({
  filter: `name CONTAINS "-trial-" AND created_at < 48_hours_ago`
});

for (const trialGroup of oldTrials) {
  await adsApi.adGroups.remove(trialGroup.id);
}
```

## API Rate Limit Management

### Current Limits
- Google Ads API has strict rate limits
- Snapshot export: Once per day (overnight)
- Trial monitoring: 4 checks per trial (1hr, 4hr, 24hr, 48hr)
- Cleanup: Once at 48hr mark

### Strategies
1. **Batch Queries**: Retrieve multiple entities in single API call
2. **Incremental Exports**: Only export changed entities
3. **Caching**: Cache policy status, only update on changes
4. **Backoff**: Exponential backoff on rate limit errors

## CSV Capacity

### Unlimited Changes
- No rate limits on CSV imports
- Can create 1000+ trial ads in single import
- Human review ensures quality control
- Sequential workflow (001→002→003→004→005) ensures correct order

### CSV Best Practices
1. **Validate before import**: L2 validates all CSV rows
2. **Sequential import**: Follow numbered order
3. **Review warnings**: Check validation_status in HTML packet
4. **Batch size**: Keep CSVs under 10,000 rows for Ads Editor performance

## When to Use Which

| Operation | Use API | Use CSV | Reason |
|-----------|---------|---------|--------|
| Export snapshot | ✅ | ❌ | Need current data |
| Create 100 trial ads | ❌ | ✅ | Bulk operation |
| Check trial status | ✅ | ❌ | Real-time monitoring |
| Repair 50 ads | ❌ | ✅ | Bulk operation |
| Remove 1 trial group | ✅ | ❌ | Simple deletion |
| Remove 100 trial groups | ✅ | ❌ | API batch delete is fine |
| Create 1 campaign | Either | Either | Preference: CSV for consistency |
| Update 500 headlines | ❌ | ✅ | Bulk operation |
| Get performance metrics | ✅ | ❌ | Query operation |

## Implementation Notes

### Helios Integration
- Helios runs nightly API export
- Stores in `gads_*` tables
- Automation repo exports to JSONL

### Trial Lifecycle
- **Create**: CSV (001, 005)
- **Monitor**: API (intervals at 1hr, 4hr, 24hr, 48hr)
- **Cleanup**: API (after 48hr)

### Human-in-Loop
- All bulk changes reviewed via HTML packet
- Human imports CSVs into Ads Editor
- Human posts to Google Ads
- Full visibility and control

This hybrid approach provides:
- **Scalability**: CSV handles bulk operations
- **Flexibility**: API handles complex queries
- **Control**: Human review before changes
- **Efficiency**: Respects rate limits
