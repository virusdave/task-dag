/**
 * Unit tests for Pricing Calculator
 */

import { describe, it, expect } from 'vitest'
import {
  calculateGMPercent,
  calculatePriceFromGM,
  roundToQuarterDollar,
  calculateProposedPricing,
} from '../pricingCalculator.js'

describe('pricingCalculator', () => {
  describe('calculateGMPercent', () => {
    it('calculates GM% correctly for MSO target', () => {
      const gm = calculateGMPercent(25, 55)
      expect(gm).toBeCloseTo(48.64, 1)
    })

    it('calculates GM% correctly for 67.5% target', () => {
      const cost = 20
      const price = calculatePriceFromGM(cost, 67.5)
      const actualGM = calculateGMPercent(cost, price)
      expect(actualGM).toBeCloseTo(67.5, 1)
    })
  })

  describe('roundToQuarterDollar', () => {
    it('rounds to nearest quarter', () => {
      expect(roundToQuarterDollar(45.12)).toBe(45.0)
      expect(roundToQuarterDollar(45.38)).toBe(45.5)
      expect(roundToQuarterDollar(45.62)).toBe(45.5)
      expect(roundToQuarterDollar(45.88)).toBe(46.0)
    })

    it('prefers .00 and .50 over .25 and .75', () => {
      expect(roundToQuarterDollar(45.25, true)).toBe(45.0)
      expect(roundToQuarterDollar(45.75, true)).toBe(46.0)
    })
  })

  describe('calculateProposedPricing', () => {
    it('uses GM target for MSO brand without market data', () => {
      const result = calculateProposedPricing({
        costPerUnit: 20,
        brand: 'Herb',
        isMSO: true,
      })
      
      expect(result.proposedRetailPrice).toBeGreaterThan(0)
      expect(result.gmPercent).toBeCloseTo(67.5, 1)
      expect(result.appliedRule).toBe('gm-target')
    })

    it('uses GM target for non-MSO brand', () => {
      const result = calculateProposedPricing({
        costPerUnit: 20,
        brand: 'LocalBrand',
        isMSO: false,
      })
      
      expect(result.gmPercent).toBeGreaterThanOrEqual(55)
      expect(result.gmPercent).toBeLessThanOrEqual(64.5)
    })

    it('applies market pressure override when competitor price is lower', () => {
      const result = calculateProposedPricing({
        costPerUnit: 25,
        marketAvgPrice: 45,
        brand: 'Test',
        isMSO: false,
      })
      
      const marketPressure = 45 * 1.13
      expect(result.proposedRetailPrice).toBeLessThanOrEqual(marketPressure)
      expect(result.appliedRule).toBe('market-pressure')
    })

    it('flags missing MSO classification', () => {
      const result = calculateProposedPricing({
        costPerUnit: 20,
        brand: 'UnknownBrand',
        // isMSO undefined
      })
      
      expect(result.reviewFlags).toContain('No MSO classification available')
    })

    it('flags below-floor GM when market pressure forces it', () => {
      const result = calculateProposedPricing({
        costPerUnit: 30,
        marketAvgPrice: 40, // Very tight market
        brand: 'Test',
        isMSO: false,
      })
      
      if (result.gmPercent < 55) {
        expect(result.reviewFlags.some((f) => f.includes('below target floor'))).toBe(true)
      }
    })
  })
})
