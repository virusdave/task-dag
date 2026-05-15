/**
 * L1: Policy Status Extractor
 * Normalizes Google Ads policy information
 */

import type { AdSnapshot, NormalizedPolicyStatus, ServingStatus } from '../shared/types.js';

export interface PolicyConfig {
  topic_mapping: Record<string, string>;
  limit_reason_mapping: Record<string, string>;
}

/**
 * Extract and normalize policy status from an ad
 */
export function extractPolicyStatus(ad: AdSnapshot, config: PolicyConfig): NormalizedPolicyStatus {
  return {
    serving_status: ad.serving_status,
    policy_topics: normalizePolicyTopics(ad.policy_topics, config.topic_mapping),
    policy_limit_reasons: extractLimitReasons(ad.policy_status, ad.policy_topics, config.limit_reason_mapping),
  };
}

/**
 * Normalize policy topic codes to internal categories
 */
function normalizePolicyTopics(topics: string[], mapping: Record<string, string>): string[] {
  return topics.map(topic => mapping[topic] || topic).filter(Boolean);
}

/**
 * Extract and normalize limitation reasons
 */
function extractLimitReasons(
  policyStatus: string,
  policyTopics: string[],
  mapping: Record<string, string>
): string[] {
  const reasons: string[] = [];
  
  // If status is limited, try to extract reasons
  if (policyStatus === 'approved_limited') {
    for (const topic of policyTopics) {
      const limitKey = `${topic}_LIMITED`;
      if (mapping[limitKey]) {
        reasons.push(mapping[limitKey]);
      }
    }
  }
  
  return reasons;
}
