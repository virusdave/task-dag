/**
 * L1: Ad Text Pattern Extractor
 * Detects text-based patterns that may trigger policy limitations
 */

import type { AdSnapshot, TextPatternFeatures } from '../shared/types.js';
import { countKeywords, capitalizationScore, countPunctuation, clamp } from '../shared/utils.js';

export interface TextPatternConfig {
  urgency: { keywords: string[]; weight: number; max_score: number };
  hype: { keywords: string[]; weight: number; max_score: number };
  superlatives: { patterns: string[]; require_qualifier: boolean };
  capitalization: { threshold: number; ignore_acronyms: boolean };
  punctuation: {
    max_exclamations: number;
    max_question_marks: number;
    max_consecutive_punctuation: number;
  };
}

export interface RestrictedVocabBuckets {
  [bucket: string]: string[];
}

/**
 * Extract text pattern features from an ad
 */
export function extractTextPatterns(
  ad: AdSnapshot,
  config: TextPatternConfig,
  restrictedVocabBuckets: RestrictedVocabBuckets
): TextPatternFeatures {
  const allText = [...ad.headlines, ...ad.descriptions].join(' ');
  
  return {
    has_restricted_vocab_buckets: detectRestrictedVocab(allText, restrictedVocabBuckets),
    urgency_score: calculateUrgencyScore(allText, config.urgency),
    hype_score: calculateHypeScore(allText, config.hype),
    capitalization_score: capitalizationScore(allText, config.capitalization.ignore_acronyms),
    punctuation_score: calculatePunctuationScore(allText, config.punctuation),
    medical_claim_patterns: detectMedicalClaims(allText),
    superlative_usage: detectSuperlatives(allText, config.superlatives),
  };
}

/**
 * Detect restricted vocabulary buckets
 */
function detectRestrictedVocab(text: string, buckets: RestrictedVocabBuckets): string[] {
  const detected: string[] = [];
  const lowerText = text.toLowerCase();
  
  for (const [bucketName, keywords] of Object.entries(buckets)) {
    const hasKeyword = keywords.some(keyword => 
      lowerText.includes(keyword.toLowerCase())
    );
    if (hasKeyword) {
      detected.push(bucketName);
    }
  }
  
  return detected;
}

/**
 * Calculate urgency score (0-1)
 */
function calculateUrgencyScore(text: string, config: { keywords: string[]; weight: number; max_score: number }): number {
  const count = countKeywords(text, config.keywords);
  const rawScore = count * config.weight;
  return clamp(rawScore, 0, config.max_score);
}

/**
 * Calculate hype score (0-1)
 */
function calculateHypeScore(text: string, config: { keywords: string[]; weight: number; max_score: number }): number {
  const count = countKeywords(text, config.keywords);
  const rawScore = count * config.weight;
  return clamp(rawScore, 0, config.max_score);
}

/**
 * Calculate punctuation score (0-1)
 */
function calculatePunctuationScore(text: string, config: {
  max_exclamations: number;
  max_question_marks: number;
  max_consecutive_punctuation: number;
}): number {
  const exclamations = countPunctuation(text, '!');
  const questions = countPunctuation(text, '?');
  const consecutive = hasConsecutivePunctuation(text, config.max_consecutive_punctuation);
  
  const violations = (
    (exclamations > config.max_exclamations ? 1 : 0) +
    (questions > config.max_question_marks ? 1 : 0) +
    (consecutive ? 1 : 0)
  ) / 3;
  
  return violations;
}

/**
 * Check for consecutive punctuation
 */
function hasConsecutivePunctuation(text: string, maxConsecutive: number): boolean {
  const consecutiveRegex = new RegExp(`[!?]{${maxConsecutive + 1},}`);
  return consecutiveRegex.test(text);
}

/**
 * Detect medical claim patterns
 */
function detectMedicalClaims(text: string): string[] {
  const patterns: { type: string; regex: RegExp }[] = [
    { type: 'cure', regex: /\b(cure|cures|curing)\b/i },
    { type: 'treat', regex: /\b(treat|treats|treatment)\b/i },
    { type: 'heal', regex: /\b(heal|heals|healing)\b/i },
    { type: 'prevent', regex: /\b(prevent|prevents|prevention)\b/i },
    { type: 'diagnose', regex: /\b(diagnose|diagnosis)\b/i },
    { type: 'medical_benefit', regex: /\b(medical (benefit|use|purpose))\b/i },
    { type: 'therapeutic', regex: /\b(therapeutic|therapy)\b/i },
  ];
  
  return patterns
    .filter(p => p.regex.test(text))
    .map(p => p.type);
}

/**
 * Detect superlative usage
 */
function detectSuperlatives(text: string, config: { patterns: string[]; require_qualifier: boolean }): string[] {
  const detected: string[] = [];
  const lowerText = text.toLowerCase();
  
  for (const pattern of config.patterns) {
    const regex = new RegExp(`\\b${pattern}\\b`, 'i');
    if (regex.test(text)) {
      // If qualifiers required, check for context
      if (config.require_qualifier) {
        const hasQualifier = /\b(in|of|for|at)\b/.test(lowerText);
        if (!hasQualifier) {
          detected.push(pattern);
        }
      } else {
        detected.push(pattern);
      }
    }
  }
  
  return detected;
}
