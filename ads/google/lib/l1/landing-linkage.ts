/**
 * L1: Ad Landing Page Linkage Analyzer
 * Maps ads to landing pages and assesses LP risk
 */

import type { AdSnapshot, LandingLinkageFeatures } from '../shared/types.js';
import { extractDomain } from '../shared/utils.js';

export interface LandingLinkageConfig {
  high_risk_domains: string[];
  medium_risk_domains: string[];
  mss_integration: {
    enabled: boolean;
    api_endpoint: string;
  };
}

/**
 * Extract landing linkage features from an ad
 */
export function extractLandingLinkage(
  ad: AdSnapshot,
  config: LandingLinkageConfig
): LandingLinkageFeatures {
  const domain = extractDomain(ad.final_url);
  const risk = assessDomainRisk(domain, config);
  
  return {
    final_url_domain: domain,
    final_url_family_risk: risk,
  };
}

/**
 * Assess risk level of a domain
 */
function assessDomainRisk(
  domain: string,
  config: LandingLinkageConfig
): "high" | "medium" | "low" | "unknown" {
  if (config.high_risk_domains.includes(domain)) {
    return "high";
  }
  if (config.medium_risk_domains.includes(domain)) {
    return "medium";
  }
  if (!domain) {
    return "unknown";
  }
  return "low";
}
