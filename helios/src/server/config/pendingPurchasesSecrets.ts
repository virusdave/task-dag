/**
 * Pending Purchases Secrets Configuration
 * Centralized access to external service credentials
 */

export interface PendingPurchasesSecrets {
  sweed: {
    authToken: string
    baseUrl: string
  }
  litAlerts: {
    bearerToken: string
    cookie: string
  }
  mantle: {
    bearerToken: string
    endpoint: string
  }
}

/**
 * Load secrets from environment variables
 * Falls back to legacy locations during transition
 */
export function loadPendingPurchasesSecrets(): PendingPurchasesSecrets {
  return {
    sweed: {
      authToken: process.env.SWEED_AUTH_TOKEN || loadLegacySweedToken(),
      baseUrl: process.env.SWEED_API_URL || 'https://prime.sweedpos.com/api/',
    },
    litAlerts: {
      bearerToken: process.env.LITALERTS_BEARER_TOKEN || '',
      cookie: process.env.LITALERTS_COOKIE || '',
    },
    mantle: {
      bearerToken: process.env.MANTLE_BEARER_TOKEN || loadMantleBearerToken(),
      endpoint: process.env.MANTLE_ENDPOINT || 'https://bedrock-mantle.internal/',
    },
  }
}

/**
 * Load legacy Sweed token from hardcoded location
 * TODO: Remove once migrated to environment variables
 */
function loadLegacySweedToken(): string {
  // Legacy: hardcoded in bulk_additions/2026-04-10/generate_product_catalog_attribute_analysis.py:18
  // For security, return empty string - must be set via env var
  console.warn('SWEED_AUTH_TOKEN not set, falling back to legacy (not recommended)')
  return ''
}

/**
 * Load Mantle bearer token from file
 * TODO: Migrate to environment variable
 */
function loadMantleBearerToken(): string {
  try {
    const fs = require('fs')
    const path = process.env.MANTLE_BEARER_PATH || '/Users/amp-local/.secret/bedrock/mantle-bearer-token'
    return fs.readFileSync(path, 'utf-8').trim()
  } catch (error) {
    console.warn('Failed to load Mantle bearer token from file:', error)
    return ''
  }
}

/**
 * Validate secrets are present
 */
export function validateSecrets(secrets: PendingPurchasesSecrets): string[] {
  const missing: string[] = []
  
  if (!secrets.sweed.authToken) {
    missing.push('SWEED_AUTH_TOKEN')
  }
  
  // Mantle is optional (fallback parser only)
  if (!secrets.mantle.bearerToken) {
    console.warn('Mantle bearer token not available - LLM fallback parsing disabled')
  }
  
  // Lit Alerts is required for market research
  if (!secrets.litAlerts.bearerToken) {
    missing.push('LITALERTS_BEARER_TOKEN')
  }
  
  return missing
}
