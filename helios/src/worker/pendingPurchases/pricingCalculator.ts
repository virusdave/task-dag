/**
 * Pricing Calculator for Pending Purchases
 * Implements GM% calculation with market pressure and MSO classification
 */

export interface PricingInput {
  costPerUnit: number
  marketAvgPrice?: number
  brand: string
  isMSO?: boolean
}

export interface PricingOutput {
  proposedRetailPrice: number
  gmPercent: number
  appliedRule: 'gm-target' | 'market-pressure'
  reviewFlags: string[]
}

const TAX_MULTIPLIER = 1.13 // NY cannabis tax
const MSO_GM_MIN = 60
const MSO_GM_MAX = 67.5
const NON_MSO_GM_MIN = 55
const NON_MSO_GM_MAX = 64.5
const MARKET_PRESSURE_MULTIPLIER = 1.13

/**
 * Calculate GM% from cost and price
 * Formula: GM% = 1 - (1.13 × cost / price)
 */
export function calculateGMPercent(costPerUnit: number, price: number): number {
  return (1 - (TAX_MULTIPLIER * costPerUnit) / price) * 100
}

/**
 * Calculate price from cost and target GM%
 */
export function calculatePriceFromGM(costPerUnit: number, targetGM: number): number {
  return (TAX_MULTIPLIER * costPerUnit) / (1 - targetGM / 100)
}

/**
 * Round to quarter-dollar ending (.00, .25, .50, .75)
 * Prefer .00 and .50 over .25 and .75
 */
export function roundToQuarterDollar(price: number, preferHalf: boolean = true): number {
  const quarters = Math.round(price * 4) / 4
  
  if (preferHalf) {
    const cents = Math.round((quarters % 1) * 100)
    if (cents === 25) {
      return Math.floor(quarters) + 0.0
    } else if (cents === 75) {
      return Math.ceil(quarters)
    }
  }
  
  return quarters
}

/**
 * Calculate proposed pricing for a pending purchase row
 */
export function calculateProposedPricing(input: PricingInput): PricingOutput {
  const flags: string[] = []
  
  // Determine GM target based on MSO classification
  let targetGM: number
  if (input.isMSO === undefined) {
    targetGM = (NON_MSO_GM_MIN + NON_MSO_GM_MAX) / 2 // Default to non-MSO
    flags.push('No MSO classification available')
  } else if (input.isMSO) {
    targetGM = MSO_GM_MAX // Use top of MSO band
  } else {
    targetGM = (NON_MSO_GM_MIN + NON_MSO_GM_MAX) / 2
  }
  
  // Calculate price based on target GM
  let proposedPrice = calculatePriceFromGM(input.costPerUnit, targetGM)
  let appliedRule: 'gm-target' | 'market-pressure' = 'gm-target'
  
  // Check market pressure override
  if (input.marketAvgPrice && input.marketAvgPrice > 0) {
    const marketPressure = input.marketAvgPrice * MARKET_PRESSURE_MULTIPLIER
    const targetBelowMarket = marketPressure * 0.95 // Aim a few percent below
    
    // If target price exceeds market pressure, use market-based pricing
    if (proposedPrice > targetBelowMarket) {
      proposedPrice = targetBelowMarket
      appliedRule = 'market-pressure'
      
      const actualGM = calculateGMPercent(input.costPerUnit, proposedPrice)
      const minGM = input.isMSO ? MSO_GM_MIN : NON_MSO_GM_MIN
      
      if (actualGM < minGM) {
        flags.push(`GM% below target floor (market pressure override)`)
      }
    }
  }
  
  // Round to quarter-dollar
  proposedPrice = roundToQuarterDollar(proposedPrice, true)
  
  const finalGM = calculateGMPercent(input.costPerUnit, proposedPrice)
  
  return {
    proposedRetailPrice: proposedPrice,
    gmPercent: Math.round(finalGM * 100) / 100,
    appliedRule,
    reviewFlags: flags,
  }
}
