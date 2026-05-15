/**
 * Unit tests for SKU Parser
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SKUParser } from '../skuParser.js'

describe('SKUParser', () => {
  let parser: SKUParser

  beforeEach(() => {
    parser = new SKUParser()
  })

  describe('manifest override', () => {
    it('returns manifest data when available', async () => {
      parser.addManifestOverride('1O-HIFCIV.5', {
        distributorProductName: '1O-HIFCIV.5',
        brand: 'Herb',
        category: 'Vapes',
        subcategory: 'Cartridge',
        variantName: 'Herb Forbidden Fruit Infused Vape 0.5g',
        strainName: 'Forbidden Fruit',
        packSize: '0.5g',
        packCount: 1,
        metrcTag: '1A4...',
      })

      const result = await parser.parse('1O-HIFCIV.5')
      
      expect(result.brand).toBe('Herb')
      expect(result.category).toBe('Vapes')
      expect(result.variantName).toBe('Herb Forbidden Fruit Infused Vape 0.5g')
    })
  })

  describe('cache lookup', () => {
    it('returns cached parse when manifest not available', async () => {
      parser.addToCache('BS Ice Cream Swirl 14g', {
        brand: 'Smartbud',
        category: 'Flower',
        subcategory: 'Shake',
        variantName: 'Smartbud Ice Cream Swirl Shake 14g',
        strainName: 'Ice Cream Swirl',
        packSize: '14g',
        packCount: 1,
      })

      const result = await parser.parse('BS Ice Cream Swirl 14g')
      
      expect(result.brand).toBe('Smartbud')
      expect(result.category).toBe('Flower')
      expect(result.subcategory).toBe('Shake')
    })
  })

  describe('waterfall priority', () => {
    it('prefers manifest over cache', async () => {
      const sku = 'TEST-SKU-123'
      
      parser.addToCache(sku, {
        brand: 'CachedBrand',
        category: 'CachedCat',
        subcategory: '',
        variantName: 'Cached Variant',
      })
      
      parser.addManifestOverride(sku, {
        distributorProductName: sku,
        brand: 'ManifestBrand',
        category: 'ManifestCat',
        variantName: 'Manifest Variant',
      })

      const result = await parser.parse(sku)
      
      expect(result.brand).toBe('ManifestBrand')
      expect(result.category).toBe('ManifestCat')
    })
  })
})
