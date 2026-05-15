import { describe, expect, it } from 'vitest'

import { parseProductName } from './generatePendingPurchasePacketJob.js'

describe("Jenny's pre-roll deterministic parser", () => {
  it("parses Jenny's J 1g <cultivar> Pre-Roll", () => {
    const parsed = parseProductName("Jenny's J 1g Acapulco Gold Pre-Roll")
    expect(parsed.brand).toBe("Jenny's")
    expect(parsed.category).toBe('Pre-Rolls')
    expect(parsed.groupName).toBe('Acapulco Gold')
    expect(parsed.size).toBe('1g')
    expect(parsed.variantTab).toBe('1g')
    expect(parsed.variantName).toBe("Jenny's Acapulco Gold 1g")
    expect(parsed.packCount).toBe(1)
  })

  it("parses Jenny's J 1g Biscotti Pre-Roll", () => {
    const parsed = parseProductName("Jenny's J 1g Biscotti Pre-Roll")
    expect(parsed.groupName).toBe('Biscotti')
    expect(parsed.variantName).toBe("Jenny's Biscotti 1g")
  })
})

describe("Posh Puff vape deterministic parser (Jenny's vape line)", () => {
  it('parses Posh Puff .5g Biscotti Vapes as a Jenny\'s vape line', () => {
    const parsed = parseProductName('Posh Puff .5g Biscotti Vapes')
    expect(parsed.brand).toBe("Jenny's")
    expect(parsed.category).toBe('Vapes')
    expect(parsed.subcategory).toBe('All In One / Disposable')
    expect(parsed.groupName).toBe('Posh Puff Biscotti')
    expect(parsed.size).toBe('0.5g')
    expect(parsed.variantTab).toBe('0.5g')
    expect(parsed.variantName).toBe("Jenny's Posh Puff Biscotti 0.5g")
  })

  it('parses Posh Puff .5G Biscotti Vapes (uppercase G)', () => {
    const parsed = parseProductName('Posh Puff .5G Biscotti Vapes')
    expect(parsed.size).toBe('0.5g')
    expect(parsed.groupName).toBe('Posh Puff Biscotti')
  })

  it('parses Posh Puff .5g Super Sour Diesel Vapes (multi-word cultivar)', () => {
    const parsed = parseProductName('Posh Puff .5g Super Sour Diesel Vapes')
    expect(parsed.groupName).toBe('Posh Puff Super Sour Diesel')
    expect(parsed.variantName).toBe("Jenny's Posh Puff Super Sour Diesel 0.5g")
  })

  it('parses Posh Puff .5g Blue Dream Vapes', () => {
    const parsed = parseProductName('Posh Puff .5g Blue Dream Vapes')
    expect(parsed.groupName).toBe('Posh Puff Blue Dream')
    expect(parsed.variantTab).toBe('0.5g')
  })
})

describe('LayUp beverage deterministic parser', () => {
  it('parses LayUp - Beverage - Peach Tea - 10mg', () => {
    const parsed = parseProductName('LayUp - Beverage - Peach Tea - 10mg')
    expect(parsed.brand).toBe('LayUp')
    expect(parsed.category).toBe('Beverages')
    expect(parsed.groupName).toBe('Peach Tea')
    expect(parsed.variantName).toBe('LayUp Peach Tea 10mg')
    expect(parsed.variantTab).toBe('10mg')
  })

  it('parses LayUp - Beverage - Peach Tea - 10 MG THC', () => {
    const parsed = parseProductName('LayUp - Beverage - Peach Tea - 10 MG THC')
    expect(parsed.variantName).toBe('LayUp Peach Tea 10mg')
  })
})

describe('Cannabals deterministic parser', () => {
  it('parses Cannabals - Chubby Puff Vape - Strawberry Cough - 6g', () => {
    const parsed = parseProductName('Cannabals - Chubby Puff Vape - Strawberry Cough - 6g')
    expect(parsed.brand).toBe('Cannabals')
    expect(parsed.category).toBe('Vapes')
    expect(parsed.subcategory).toBe('All In One / Disposable')
    expect(parsed.groupName).toBe('Chubby Puff Strawberry Cough')
    expect(parsed.size).toBe('6g')
    expect(parsed.variantTab).toBe('6g')
    expect(parsed.variantName).toBe('Cannabals Chubby Puff Strawberry Cough 6g')
  })

  it('parses Cannabals - Gummy Brick - Orange Soda - 100mg THC into a 10x 10mg variant', () => {
    const parsed = parseProductName('Cannabals - Gummy Brick - Orange Soda - 100mg THC')
    expect(parsed.brand).toBe('Cannabals')
    expect(parsed.category).toBe('Edibles')
    expect(parsed.groupName).toBe('Orange Soda Gummy Brick')
    expect(parsed.packCount).toBe(10)
    expect(parsed.size).toBe('10mg')
    expect(parsed.variantTab).toBe('10x 10mg')
    expect(parsed.variantName).toBe('Cannabals Orange Soda Gummy Brick 10x 10mg')
  })

  it('parses Cannabals - Gummy Brick - Fast-Acting Distillate - 1pk - 100 MG THC - Playoff Punch', () => {
    const parsed = parseProductName('Cannabals - Gummy Brick - Fast-Acting Distillate - 1pk - 100 MG THC - Playoff Punch')
    expect(parsed.brand).toBe('Cannabals')
    expect(parsed.category).toBe('Edibles')
    expect(parsed.groupName).toBe('Playoff Punch Gummy Brick')
    expect(parsed.packCount).toBe(10)
    expect(parsed.variantTab).toBe('10x 10mg')
  })
})

describe('parser semantic-validation gate', () => {
  it('rejects parser output whose variantName is generic like "Vape"', () => {
    expect(() => parseProductName('Posh Puff .5g Vapes')).toThrowError(
      /Semantically invalid|Posh Puff/i,
    )
  })
})
