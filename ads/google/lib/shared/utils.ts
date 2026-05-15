/**
 * Shared utility functions for Google Ads optimization system
 */

import * as crypto from 'crypto';

/**
 * Generate a unique run ID
 */
export function generateRunId(): string {
  return `run-${new Date().toISOString().split('T')[0]}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Calculate Jaccard similarity between two sets of words
 */
export function jaccardSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));
  
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Calculate average Jaccard similarity across multiple texts
 */
export function calculateRedundancy(texts: string[]): number {
  if (texts.length < 2) return 0;
  
  let total = 0;
  let comparisons = 0;
  
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      total += jaccardSimilarity(texts[i], texts[j]);
      comparisons++;
    }
  }
  
  return comparisons === 0 ? 0 : total / comparisons;
}

/**
 * Count occurrences of keywords in text (case-insensitive)
 */
export function countKeywords(text: string, keywords: string[]): number {
  const lowerText = text.toLowerCase();
  return keywords.reduce((count, keyword) => {
    const regex = new RegExp(`\\b${keyword.toLowerCase()}\\b`, 'g');
    const matches = lowerText.match(regex);
    return count + (matches ? matches.length : 0);
  }, 0);
}

/**
 * Calculate capitalization score (0-1)
 */
export function capitalizationScore(text: string, ignoreAcronyms: boolean = true): number {
  // Remove common acronyms if requested
  let cleanText = text;
  if (ignoreAcronyms) {
    cleanText = text.replace(/\b[A-Z]{2,}\b/g, '');
  }
  
  const letters = cleanText.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return 0;
  
  const upperCount = (cleanText.match(/[A-Z]/g) || []).length;
  return upperCount / letters.length;
}

/**
 * Count punctuation occurrences
 */
export function countPunctuation(text: string, punctuation: string): number {
  const regex = new RegExp(`\\${punctuation}`, 'g');
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return '';
  }
}

/**
 * Clamp value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Format family key as string
 */
export function formatFamilyKey(key: { account_id: string; campaign_name?: string; creative_theme?: string; product_tag?: string }): string {
  const parts = [key.account_id];
  if (key.campaign_name) parts.push(key.campaign_name);
  if (key.creative_theme) parts.push(key.creative_theme);
  if (key.product_tag) parts.push(key.product_tag);
  return parts.join('/');
}

/**
 * Generate trial group name
 */
export function generateTrialGroupName(originalAdGroupName: string, sequence: number): string {
  return `${originalAdGroupName}-trial-${String(sequence).padStart(3, '0')}`;
}

/**
 * Generate trial label
 */
export function generateTrialLabel(date: string, sequence: number): string {
  return `FB_POLICY_PROBE_${date}_${String(sequence).padStart(3, '0')}`;
}

/**
 * Truncate text to max length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Create snippet from ad text
 */
export function createAdSnippet(headlines: string[], descriptions: string[], maxLength: number = 100): string {
  const headline = headlines[0] || '';
  const description = descriptions[0] || '';
  const combined = `${headline} | ${description}`;
  return truncate(combined, maxLength);
}

/**
 * Calculate percentage
 */
export function percentage(value: number, total: number): number {
  return total === 0 ? 0 : (value / total) * 100;
}

/**
 * Round to decimal places
 */
export function round(value: number, decimals: number = 2): number {
  const multiplier = Math.pow(10, decimals);
  return Math.round(value * multiplier) / multiplier;
}
