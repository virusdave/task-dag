/**
 * L1: Family Aggregation
 * Rolls up ad-level features to creative family summaries
 */

import type {
  AdSnapshot,
  L1Features,
  L1FamilySummary,
  FamilyKey,
  Anomaly,
  PerformanceMetrics,
} from '../shared/types.js';
import { formatFamilyKey, percentage, round } from '../shared/utils.js';

export interface FamilyAggregationConfig {
  family_tag_keys: string[];
  min_family_size: number;
  pattern_threshold: number;
  sample_size: number;
  sample_strategy: 'mixed' | 'random' | 'risky_only';
}

/**
 * Group ads by family and create summaries
 */
export function aggregateByFamily(
  ads: AdSnapshot[],
  features: Map<string, L1Features>,
  config: FamilyAggregationConfig
): L1FamilySummary[] {
  // Group ads by family key
  const families = new Map<string, AdSnapshot[]>();
  
  for (const ad of ads) {
    const familyKey = extractFamilyKey(ad, config.family_tag_keys);
    const keyStr = formatFamilyKey(familyKey);
    
    if (!families.has(keyStr)) {
      families.set(keyStr, []);
    }
    families.get(keyStr)!.push(ad);
  }
  
  // Create summaries for each family
  const summaries: L1FamilySummary[] = [];
  
  for (const [keyStr, familyAds] of families.entries()) {
    if (familyAds.length < config.min_family_size) {
      continue; // Skip small families
    }
    
    const familyKey = extractFamilyKey(familyAds[0], config.family_tag_keys);
    const summary = createFamilySummary(familyKey, familyAds, features, config);
    summaries.push(summary);
  }
  
  return summaries;
}

/**
 * Extract family key from ad
 */
function extractFamilyKey(ad: AdSnapshot, tagKeys: string[]): FamilyKey {
  const familyKey: FamilyKey = {
    account_id: ad.account_id,
  };
  
  for (const key of tagKeys) {
    if (ad.family_tags[key]) {
      if (key === 'creative_theme') {
        familyKey.creative_theme = ad.family_tags[key];
      } else if (key === 'product_tag') {
        familyKey.product_tag = ad.family_tags[key];
      } else if (key === 'campaign_name') {
        familyKey.campaign_name = ad.campaign_name;
      }
    }
  }
  
  // Default to campaign name if no theme/product tags
  if (!familyKey.creative_theme && !familyKey.product_tag) {
    familyKey.campaign_name = ad.campaign_name;
  }
  
  return familyKey;
}

/**
 * Create family summary
 */
function createFamilySummary(
  familyKey: FamilyKey,
  ads: AdSnapshot[],
  features: Map<string, L1Features>,
  config: FamilyAggregationConfig
): L1FamilySummary {
  const policyStatusCounts: Record<string, number> = {};
  const patternStats: Record<string, { count: number; pct: number }> = {};
  const anomalies: Anomaly[] = [];
  
  // Count policy statuses
  for (const ad of ads) {
    const status = ad.serving_status;
    policyStatusCounts[status] = (policyStatusCounts[status] || 0) + 1;
  }
  
  // Aggregate pattern statistics
  const patternCounts: Record<string, number> = {};
  
  for (const ad of ads) {
    const adFeatures = features.get(ad.ad_id);
    if (!adFeatures) continue;
    
    // Count text patterns
    for (const bucket of adFeatures.text_patterns.has_restricted_vocab_buckets) {
      const key = `has_restricted_vocab_buckets.${bucket}`;
      patternCounts[key] = (patternCounts[key] || 0) + 1;
    }
    
    if (adFeatures.text_patterns.urgency_score > 0.8) {
      patternCounts['urgency_score>0.8'] = (patternCounts['urgency_score>0.8'] || 0) + 1;
    }
    
    if (adFeatures.text_patterns.hype_score > 0.8) {
      patternCounts['hype_score>0.8'] = (patternCounts['hype_score>0.8'] || 0) + 1;
    }
    
    if (adFeatures.landing_linkage.final_url_family_risk === 'high') {
      patternCounts['final_url_family_risk.high'] = (patternCounts['final_url_family_risk.high'] || 0) + 1;
    }
    
    // Detect anomalies
    const adAnomalies = detectAnomalies(ad, adFeatures);
    anomalies.push(...adAnomalies);
  }
  
  // Calculate pattern percentages
  for (const [pattern, count] of Object.entries(patternCounts)) {
    const pct = count / ads.length;
    if (pct >= config.pattern_threshold) {
      patternStats[pattern] = { count, pct: round(pct, 2) };
    }
  }
  
  // Sample ads for spot-checking
  const sampleAdIds = sampleAds(ads, config.sample_size, config.sample_strategy);
  
  // Calculate average performance
  const avgPerformance = calculateAveragePerformance(ads);
  
  return {
    family_key: familyKey,
    ads_total: ads.length,
    policy_status_counts: policyStatusCounts,
    pattern_stats: patternStats,
    anomalies,
    sample_ad_ids: sampleAdIds,
    avg_performance: avgPerformance,
  };
}

/**
 * Detect anomalies in an ad
 */
function detectAnomalies(ad: AdSnapshot, features: L1Features): Anomaly[] {
  const anomalies: Anomaly[] = [];
  
  // Disapproved with no obvious restricted vocab
  if (ad.serving_status === 'not_eligible' &&
      features.text_patterns.has_restricted_vocab_buckets.length === 0) {
    anomalies.push({
      ad_id: ad.ad_id,
      anomaly_type: 'disapproved_with_no_restricted_vocab',
      severity: 'high',
      details: {
        serving_status: ad.serving_status,
        policy_topics: ad.policy_topics,
      },
      suggested_action: 'Review policy topics to identify hidden issues',
    });
  }
  
  // Eligible but high risk pattern combination
  if (ad.serving_status === 'eligible' &&
      features.text_patterns.urgency_score > 0.8 &&
      features.text_patterns.hype_score > 0.8) {
    anomalies.push({
      ad_id: ad.ad_id,
      anomaly_type: 'eligible_but_high_risk_pattern_combo',
      severity: 'medium',
      details: {
        urgency_score: features.text_patterns.urgency_score,
        hype_score: features.text_patterns.hype_score,
      },
      suggested_action: 'Monitor closely, may get limited',
    });
  }
  
  return anomalies;
}

/**
 * Sample ads for spot-checking
 */
function sampleAds(
  ads: AdSnapshot[],
  sampleSize: number,
  strategy: 'mixed' | 'random' | 'risky_only'
): string[] {
  const sampled: string[] = [];
  
  if (strategy === 'mixed') {
    // 2 disapproved/limited, 2 eligible-but-risky, 1 random
    const limited = ads.filter(a => 
      a.serving_status === 'eligible_limited' || a.serving_status === 'not_eligible'
    );
    const eligible = ads.filter(a => a.serving_status === 'eligible');
    
    sampled.push(...limited.slice(0, 2).map(a => a.ad_id));
    sampled.push(...eligible.slice(0, 2).map(a => a.ad_id));
    
    if (sampled.length < sampleSize && ads.length > sampled.length) {
      const remaining = ads.filter(a => !sampled.includes(a.ad_id));
      sampled.push(remaining[0].ad_id);
    }
  } else if (strategy === 'random') {
    for (let i = 0; i < Math.min(sampleSize, ads.length); i++) {
      sampled.push(ads[i].ad_id);
    }
  } else if (strategy === 'risky_only') {
    const risky = ads.filter(a => 
      a.serving_status !== 'eligible'
    );
    sampled.push(...risky.slice(0, sampleSize).map(a => a.ad_id));
  }
  
  return sampled;
}

/**
 * Calculate average performance metrics
 */
function calculateAveragePerformance(ads: AdSnapshot[]): PerformanceMetrics | undefined {
  const withMetrics = ads.filter(a => a.metrics);
  if (withMetrics.length === 0) return undefined;
  
  const totals: PerformanceMetrics = {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    cost: 0,
    ctr: 0,
    conversion_rate: 0,
  };
  
  for (const ad of withMetrics) {
    if (!ad.metrics) continue;
    totals.impressions! += ad.metrics.impressions || 0;
    totals.clicks! += ad.metrics.clicks || 0;
    totals.conversions! += ad.metrics.conversions || 0;
    totals.cost! += ad.metrics.cost || 0;
  }
  
  const count = withMetrics.length;
  totals.ctr = totals.clicks! / totals.impressions! || 0;
  totals.conversion_rate = totals.conversions! / totals.clicks! || 0;
  
  return {
    impressions: Math.round(totals.impressions! / count),
    clicks: Math.round(totals.clicks! / count),
    conversions: round(totals.conversions! / count, 2),
    cost: round(totals.cost! / count, 2),
    ctr: round(totals.ctr, 4),
    conversion_rate: round(totals.conversion_rate, 4),
  };
}
