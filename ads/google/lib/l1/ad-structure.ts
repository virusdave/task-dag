/**
 * L1: Ad Structure Analyzer
 * Analyzes structural aspects of ads (character counts, completeness, redundancy)
 */

import type { AdSnapshot, StructureFeatures } from '../shared/types.js';
import { calculateRedundancy } from '../shared/utils.js';

export interface StructureConfig {
  rsa: {
    min_headlines: number;
    max_headlines: number;
    min_descriptions: number;
    max_descriptions: number;
    min_headline_length: number;
    max_headline_length: number;
    min_description_length: number;
    max_description_length: number;
  };
  eta: {
    min_headlines: number;
    max_headlines: number;
    min_descriptions: number;
    max_descriptions: number;
    min_headline_length: number;
    max_headline_length: number;
    min_description_length: number;
    max_description_length: number;
  };
  redundancy: {
    jaccard_threshold: number;
  };
}

/**
 * Extract structure features from an ad
 */
export function extractStructure(ad: AdSnapshot, config: StructureConfig): StructureFeatures {
  const adConfig = ad.ad_type === 'responsive_search_ad' ? config.rsa : config.eta;
  
  const headlineLengths = ad.headlines.map(h => h.length);
  const descriptionLengths = ad.descriptions.map(d => d.length);
  
  const missingHeadlines = Math.max(0, adConfig.min_headlines - ad.headlines.length);
  const missingDescriptions = Math.max(0, adConfig.min_descriptions - ad.descriptions.length);
  
  const allTexts = [...ad.headlines, ...ad.descriptions];
  const redundancyScore = calculateRedundancy(allTexts);
  
  const totalCharCount = allTexts.reduce((sum, text) => sum + text.length, 0);
  
  return {
    headline_lengths: headlineLengths,
    description_lengths: descriptionLengths,
    missing_headlines: missingHeadlines,
    missing_descriptions: missingDescriptions,
    redundancy_score: redundancyScore,
    total_char_count: totalCharCount,
  };
}
