import { describe, expect, it } from 'vitest'

import { parseCannaCureName, parseProductName } from './generatePendingPurchasePacketJob.js'

describe('Canna Cure Farms brand-keyed deterministic parser', () => {
  const BRAND = 'Canna Cure Farms, LLC'

  it('parses a plain 1g pre-roll with a hyphen-glued strain', () => {
    const parsed = parseCannaCureName('Blue Dream- 1g Pre-roll')
    expect(parsed.brand).toBe(BRAND)
    expect(parsed.category).toBe('Pre-Rolls')
    expect(parsed.subcategory).toBe('')
    expect(parsed.groupName).toBe('Blue Dream')
    expect(parsed.strainName).toBe('Blue Dream')
    expect(parsed.size).toBe('1g')
    expect(parsed.variantTab).toBe('1g')
    expect(parsed.packCount).toBe(1)
    expect(parsed.variantName).toBe('Canna Cure Farms, LLC Blue Dream 1g')
  })

  it('parses a spaced-hyphen 1g pre-roll', () => {
    const parsed = parseCannaCureName('Purple Punch - 1g Pre-roll')
    expect(parsed.groupName).toBe('Purple Punch')
    expect(parsed.variantName).toBe('Canna Cure Farms, LLC Purple Punch 1g')
    expect(parsed.subcategory).toBe('')
  })

  it('strips a trailing (Sample) marker', () => {
    const parsed = parseCannaCureName('Purple Punch - 1g Pre-roll (Sample)')
    expect(parsed.groupName).toBe('Purple Punch')
    expect(parsed.variantName).toBe('Canna Cure Farms, LLC Purple Punch 1g')
  })

  it('classifies an infused 1g pre-roll into the Infused subcategory', () => {
    const parsed = parseCannaCureName('Blueberry OG- 1g infused Pre-roll')
    expect(parsed.category).toBe('Pre-Rolls')
    expect(parsed.subcategory).toBe('Infused')
    expect(parsed.groupName).toBe('Blueberry OG')
    expect(parsed.variantName).toBe('Canna Cure Farms, LLC Blueberry OG 1g')
  })

  it('handles "Infused" appearing before the size and plural Pre-rolls', () => {
    const parsed = parseCannaCureName('Bomb Pop 1g Infused Pre-rolls')
    expect(parsed.subcategory).toBe('Infused')
    expect(parsed.groupName).toBe('Bomb Pop')
    expect(parsed.size).toBe('1g')
  })

  it('keeps the strain (not the descriptor) as the group name', () => {
    const parsed = parseCannaCureName('Caramel Apple - Infused 1g Pre-roll')
    expect(parsed.groupName).toBe('Caramel Apple')
    expect(parsed.strainName).toBe('Caramel Apple')
    expect(parsed.subcategory).toBe('Infused')
  })

  it('parses a sub-gram pre-roll multipack as Pre-Rolls (not Flower)', () => {
    const parsed = parseCannaCureName('Sour Diesel .5g pre-roll 6 Pack')
    expect(parsed.category).toBe('Pre-Rolls')
    expect(parsed.groupName).toBe('Sour Diesel')
    expect(parsed.size).toBe('0.5g')
    expect(parsed.packCount).toBe(6)
    expect(parsed.variantTab).toBe('6x 0.5g')
    expect(parsed.variantName).toBe('Canna Cure Farms, LLC Sour Diesel 6x 0.5g')
  })

  it('parses a bare sub-gram multipack with no pre-roll token as Pre-Rolls', () => {
    const parsed = parseCannaCureName('Blue Zushi .5g 6 pack')
    expect(parsed.category).toBe('Pre-Rolls')
    expect(parsed.groupName).toBe('Blue Zushi')
    expect(parsed.size).toBe('0.5g')
    expect(parsed.packCount).toBe(6)
    expect(parsed.variantTab).toBe('6x 0.5g')
  })

  it('parses a gummies flavor/dose into Edibles with no subcategory', () => {
    const parsed = parseCannaCureName('Gummies (Honey Lemon/100mg)')
    expect(parsed.brand).toBe(BRAND)
    expect(parsed.category).toBe('Edibles')
    expect(parsed.subcategory).toBe('')
    expect(parsed.groupName).toBe('Honey Lemon Gummies')
    expect(parsed.strainName).toBe('')
    expect(parsed.size).toBe('100mg')
    expect(parsed.variantName).toBe('Canna Cure Farms, LLC Honey Lemon Gummies 100mg')
  })

  it('parses a second gummies flavor', () => {
    const parsed = parseCannaCureName('Gummies (Orange Cran/100mg)')
    expect(parsed.groupName).toBe('Orange Cran Gummies')
    expect(parsed.category).toBe('Edibles')
  })

  it('throws on shapes outside the known Canna Cure catalog', () => {
    expect(() => parseCannaCureName('Some Random Flower 3.5g Jar')).toThrowError(
      /Unhandled Canna Cure/,
    )
  })
})

describe('TTM deterministic parser', () => {
  it('parses TTM Flight multi-strain 3.0g flower', () => {
    const parsed = parseProductName(
      'TTM - Flower - Packaged - Flight - 3.0g - Cyber Diesel x Peanut Butter N Jealousy x Skywalker',
    )
    expect(parsed.brand).toBe('TTM')
    expect(parsed.category).toBe('Flower')
    expect(parsed.size).toBe('3g')
    expect(parsed.variantTab).toBe('3g')
    expect(parsed.variantName).toBe('3g')
    expect(parsed.groupName).toBe('Flight: Cyber Diesel × Peanut Butter N Jealousy × Skywalker')
    expect(parsed.strainName).toBe('Cyber Diesel × Peanut Butter N Jealousy × Skywalker')
  })

  it('parses a plain TTM flower 3.5g eighth without a Flight qualifier', () => {
    const parsed = parseProductName('TTM - Flower - Packaged - 3.5g - Pineapple Express')
    expect(parsed.brand).toBe('TTM')
    expect(parsed.category).toBe('Flower')
    expect(parsed.size).toBe('3.5g')
    expect(parsed.groupName).toBe('Pineapple Express')
    expect(parsed.strainName).toBe('Pineapple Express')
  })
})

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

describe('case-pack METRC deterministic parser (<brand> <size> <type> <N>cpk - <strain>)', () => {
  it('parses CRU 0.5g Infused PreRoll as an individual unit (cpk = case qty, not pack)', () => {
    const parsed = parseProductName('CRU 0.5g Infused PreRoll 16cpk - Amnesia Haze')
    expect(parsed.brand).toBe('CRU')
    expect(parsed.category).toBe('Pre-Rolls')
    expect(parsed.subcategory).toBe('Infused')
    expect(parsed.packCount).toBe(1)
    expect(parsed.size).toBe('0.5g')
    expect(parsed.variantTab).toBe('0.5g')
    expect(parsed.groupName).toBe('Amnesia Haze')
    expect(parsed.strainName).toBe('Amnesia Haze')
    expect(parsed.variantName).toBe('CRU Amnesia Haze 0.5g')
  })

  it('parses CRU 1ml Live Resin Disposable as a 1g (not 1ml) AIO vape', () => {
    const parsed = parseProductName('CRU 1ml Live Resin Disposable 12cpk - Granddaddy Purple')
    expect(parsed.brand).toBe('CRU')
    expect(parsed.category).toBe('Vapes')
    expect(parsed.subcategory).toBe('All In One / Disposable')
    expect(parsed.packCount).toBe(1)
    expect(parsed.size).toBe('1g')
    expect(parsed.variantTab).toBe('1g')
    expect(parsed.variantName).toBe('CRU Granddaddy Purple 1g')
  })

  it('classifies a Vape Cartridge as Vapes / Cartridge', () => {
    const parsed = parseProductName('Untitled 1g Vape Cartridge 12cpk - Mango Kush')
    expect(parsed.brand).toBe('Untitled')
    expect(parsed.category).toBe('Vapes')
    expect(parsed.subcategory).toBe('Cartridge')
    expect(parsed.variantName).toBe('Untitled Mango Kush 1g')
  })

  it('classifies Diamonds and Badder concentrates correctly', () => {
    const diamonds = parseProductName('Jetpacks 1g Diamonds 12cpk - Candyland')
    expect(diamonds.brand).toBe('Jetpacks')
    expect(diamonds.category).toBe('Concentrates')
    expect(diamonds.subcategory).toBe('Diamonds')
    expect(diamonds.packCount).toBe(1)

    const badder = parseProductName('Jetpacks 1g Badder 12cpk - Key Lime Gelato')
    expect(badder.category).toBe('Concentrates')
    expect(badder.subcategory).toBe('Badder')
    expect(badder.variantName).toBe('Jetpacks Key Lime Gelato 1g')
  })

  it('keeps the brand and folds a pre-size sub-line token into the group name', () => {
    const parsed = parseProductName('Jetpacks FJ-1 1g Infused PreRoll 12cpk - Cereal Milk')
    expect(parsed.brand).toBe('Jetpacks')
    expect(parsed.category).toBe('Pre-Rolls')
    expect(parsed.subcategory).toBe('Infused')
    expect(parsed.groupName).toBe('FJ-1 Cereal Milk')
    expect(parsed.variantName).toBe('Jetpacks FJ-1 Cereal Milk 1g')
  })

  it('preserves a flower nug-size tier (Bigs/Smalls) in the group name', () => {
    const parsed = parseProductName('Untitled 3.5g Bigs Flower 32cpk - Durban Poison')
    expect(parsed.brand).toBe('Untitled')
    expect(parsed.category).toBe('Flower')
    expect(parsed.subcategory).toBe('')
    expect(parsed.size).toBe('3.5g')
    expect(parsed.packCount).toBe(1)
    expect(parsed.groupName).toBe('Bigs Durban Poison')
    expect(parsed.variantName).toBe('Untitled Bigs Durban Poison 3.5g')
  })

  it('handles the multi-word "Vape Live Resin Disposable" type as an AIO vape', () => {
    const parsed = parseProductName('Littles 1ml Vape Live Resin Disposable 12cpk - Birthday Cake')
    expect(parsed.brand).toBe('Littles')
    expect(parsed.category).toBe('Vapes')
    expect(parsed.subcategory).toBe('All In One / Disposable')
    expect(parsed.size).toBe('1g')
  })

  it('derives prevalence from the raw strain marker and strips it from the name', () => {
    const parsed = parseProductName('Untitled 1g Infused PreRoll 25cpk - Blue Dream (H)')
    expect(parsed.strainName).toBe('Blue Dream')
    expect(parsed.prevalence).toBe('Hybrid')
    expect(parsed.variantName).toBe('Untitled Blue Dream 1g')
  })
})

describe('known brand-prefix deterministic parser (Alter / Hashtag Honey / Continental Exotics)', () => {
  it('parses an Alter 1g pre-roll (strain in the middle, explicit size)', () => {
    const parsed = parseProductName('Alter Amnesia Lemon Haze 1G preroll')
    expect(parsed.brand).toBe('Alter')
    expect(parsed.category).toBe('Pre-Rolls')
    expect(parsed.subcategory).toBe('')
    expect(parsed.groupName).toBe('Amnesia Lemon Haze')
    expect(parsed.strainName).toBe('Amnesia Lemon Haze')
    expect(parsed.size).toBe('1g')
    expect(parsed.variantTab).toBe('1g')
    expect(parsed.packCount).toBe(1)
    expect(parsed.variantName).toBe('Alter Amnesia Lemon Haze 1g')
  })

  it('parses an Alter gummy as a 10x 10mg edible and drops the terminal package code', () => {
    const parsed = parseProductName('Alter Cool Gummy AL-CG-1225-001')
    expect(parsed.brand).toBe('Alter')
    expect(parsed.category).toBe('Edibles')
    expect(parsed.subcategory).toBe('')
    expect(parsed.groupName).toBe('Cool Gummy')
    expect(parsed.size).toBe('10mg')
    expect(parsed.packCount).toBe(10)
    expect(parsed.variantTab).toBe('10x 10mg')
    expect(parsed.variantName).toBe('Alter Cool Gummy 10x 10mg')
  })

  it('maps the HH alias to Hashtag Honey and drops the plural "Gummies"', () => {
    const parsed = parseProductName('HH Cali Melon Gummies')
    expect(parsed.brand).toBe('Hashtag Honey')
    expect(parsed.category).toBe('Edibles')
    expect(parsed.subcategory).toBe('')
    expect(parsed.groupName).toBe('Cali Melon')
    expect(parsed.size).toBe('10mg')
    expect(parsed.packCount).toBe(10)
    expect(parsed.variantTab).toBe('10x 10mg')
    expect(parsed.variantName).toBe('Hashtag Honey Cali Melon 10x 10mg')
  })

  it('canonicalises the "Contintental" misspelling and classifies the disposable vape', () => {
    const parsed = parseProductName(
      'Contintental Exotics Lemon Cherry Gelato .5G Live Resin Disposable Vape',
    )
    expect(parsed.brand).toBe('Continental Exotics')
    expect(parsed.category).toBe('Vapes')
    expect(parsed.subcategory).toBe('All In One / Disposable')
    expect(parsed.groupName).toBe('Lemon Cherry Gelato')
    expect(parsed.size).toBe('0.5g')
    expect(parsed.packCount).toBe(1)
    expect(parsed.variantName).toBe('Continental Exotics Lemon Cherry Gelato 0.5g')
  })

  it('does not strip a legitimate dashed strain token (MAC-1) as a package code', () => {
    const parsed = parseProductName('Alter MAC-1 1G preroll')
    expect(parsed.brand).toBe('Alter')
    expect(parsed.strainName).toBe('MAC-1')
    expect(parsed.variantName).toBe('Alter MAC-1 1g')
  })

  it('declines brands outside the allowlist (no false positive)', () => {
    // "Alteration" is not the Alter brand — the prefix requires a word break.
    expect(() => parseProductName('Alteration Station Mystery Item')).toThrow()
  })
})

describe('parser semantic-validation gate', () => {
  it('rejects parser output whose variantName is generic like "Vape"', () => {
    expect(() => parseProductName('Posh Puff .5g Vapes')).toThrowError(
      /Semantically invalid|Posh Puff/i,
    )
  })
})
