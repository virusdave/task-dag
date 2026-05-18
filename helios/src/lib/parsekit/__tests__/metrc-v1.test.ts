/**
 * End-to-end parity tests for parsekit + metrc-v1 dialect vs the legacy
 * hardcoded parsers in generatePendingPurchasePacketJob.ts.
 *
 * Each tenant parser config under test is the JSONC-shape destined to
 * live in the `helios-parser-configs` repo at
 *   `use-cases/pending-purchases/parsers/<tenantId>.jsonc`
 * once the runtime loader lands. The configs themselves are kept in
 * `./metrc-v1-fixtures.ts` so the export script for the configs repo
 * can import them without dragging vitest along.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  compileParser,
  parseWith,
  verifyParser,
} from '../index.js'
import {
  pendingPurchasesContract,
  pendingPurchasesOutputFields,
} from '../contracts/pendingPurchases.js'
import { metrcV1Dialect } from '../dialects/metrc-v1.js'
// Legacy `parseProductNameLegacy` (the un-shadowed waterfall parser,
// renamed when the parsekit reverse-shadow harness took over the
// exported `parseProductName`) is imported dynamically per parity test
// case (see below) to isolate the shared-state mutation bug in
// `parseCuraleafName` from earlier cases in the same run.

// Tenant-parser configs + helpers live in the fixtures module so the
// helios-parser-configs export script can import them without dragging
// the vitest test scaffolding along.
import { TENANT_CONFIGS } from './metrc-v1-fixtures.js'

describe('metrc-v1 dialect: static safety verify', () => {
  for (const cfg of TENANT_CONFIGS) {
    it(`${cfg.parserId} passes verifyParser`, () => {
      const report = verifyParser(
        cfg,
        metrcV1Dialect,
        pendingPurchasesOutputFields,
        pendingPurchasesContract.useCase,
      )
      if (!report.ok) {
        console.error(report.issues)
      }
      expect(report.ok).toBe(true)
    })
  }
})

describe('metrc-v1 dialect: end-to-end goldens', () => {
  for (const cfg of TENANT_CONFIGS) {
    const compiled = compileParser(cfg, metrcV1Dialect, pendingPurchasesContract)
    for (const rule of cfg.rules) {
      for (const golden of rule.goldens) {
        if (golden.kind !== 'match') continue
        it(`${cfg.parserId} / ${golden.id}`, () => {
          const result = parseWith(compiled, golden.input, {
            snapshotSha: 'test',
          })
          if (!result.ok) {
            // eslint-disable-next-line no-console
            console.error(result)
          }
          expect(result.ok).toBe(true)
          if (result.ok) {
            expect(result.output).toEqual(golden.expected)
            expect(result.ruleId).toBe(rule.id)
          }
        })
      }
    }
  }
})

describe('metrc-v1 dialect: parity with legacy parseProductNameLegacy', () => {
  // Compile once.
  const compiledBy = new Map(
    TENANT_CONFIGS.map((c) => [c.parserId, compileParser(c, metrcV1Dialect, pendingPurchasesContract)]),
  )

  // (tenantParserId, raw name) pairs that the legacy hardcoded parsers
  // accept today. The expected outputs were captured by running the
  // legacy parser; if these drift, the parity gate (Phase 7) will catch
  // it.
  const cases: Array<{ parserId: string; input: string; expected: unknown }> = [
    {
      parserId: 'pending-purchases.bytes',
      input: 'Bytes - Sour Diesel - Edibles - 20',
      expected: {
        brand: 'Bytes',
        category: 'Edibles',
        groupName: 'Sour Diesel',
        packCount: 20,
        prevalence: null,
        searchTerm: 'Sour Diesel',
        size: '10mg',
        strainName: '',
        subcategory: 'Chews/Gummies',
        variantName: 'Bytes Sour Diesel 20x 10mg',
        variantTab: '20x 10mg',
      },
    },
    {
      parserId: 'pending-purchases.outrankd',
      input: 'Outrankd - Pineapple Express - Disposable Vape - 0.5g',
      expected: {
        brand: 'Outrankd',
        category: 'Vapes',
        groupName: 'Pineapple Express',
        packCount: 1,
        prevalence: null,
        searchTerm: 'Pineapple Express',
        size: '0.5g',
        strainName: 'Pineapple Express',
        subcategory: '',
        variantName: 'Outrankd Pineapple Express 0.5g',
        variantTab: '0.5g',
      },
    },
    {
      parserId: 'pending-purchases.the-gram',
      input: 'The Gram - Wedding Cake - Flower - 3.5g',
      expected: {
        brand: 'The Gram',
        category: 'Pre-Rolls',
        groupName: 'Wedding Cake',
        packCount: 1,
        prevalence: null,
        searchTerm: 'Wedding Cake',
        size: '3.5g',
        strainName: 'Wedding Cake',
        subcategory: '',
        variantName: 'The Gram Wedding Cake 3.5g',
        variantTab: '3.5g',
      },
    },
    {
      parserId: 'pending-purchases.herb',
      input: '1O-PR-H26-DBUR',
      expected: {
        brand: 'Herb',
        category: 'Pre-Rolls',
        groupName: 'Donny Burger',
        packCount: 1,
        prevalence: null,
        searchTerm: 'Donny Burger',
        size: '1g',
        strainName: 'Donny Burger',
        subcategory: '',
        variantName: 'Herb Donny Burger 1g',
        variantTab: '1g',
      },
    },
    {
      parserId: 'pending-purchases.herb',
      input: '1O-PR-H26-WIOG',
      expected: {
        brand: 'Herb',
        category: 'Pre-Rolls',
        groupName: 'WiFi OG',
        packCount: 1,
        prevalence: null,
        searchTerm: 'WiFi OG',
        size: '1g',
        strainName: 'WiFi OG',
        subcategory: '',
        variantName: 'Herb WiFi OG 1g',
        variantTab: '1g',
      },
    },
    {
      parserId: 'pending-purchases.layup',
      input: 'LayUp - Beverage - Mango - 10mg',
      expected: {
        brand: 'LayUp',
        category: 'Beverages',
        groupName: 'Mango',
        packCount: 1,
        prevalence: null,
        searchTerm: 'Mango',
        size: '10mg',
        strainName: '',
        subcategory: '',
        variantName: 'LayUp Mango 10mg',
        variantTab: '10mg',
      },
    },
    {
      parserId: 'pending-purchases.layup',
      input: 'LayUp - Beverage - Strawberry Lemonade - 5 MG THC',
      expected: {
        brand: 'LayUp',
        category: 'Beverages',
        groupName: 'Strawberry Lemonade',
        packCount: 1,
        prevalence: null,
        searchTerm: 'Strawberry Lemonade',
        size: '5mg',
        strainName: '',
        subcategory: '',
        variantName: 'LayUp Strawberry Lemonade 5mg',
        variantTab: '5mg',
      },
    },
    {
      parserId: 'pending-purchases.moonlit',
      // Note: legacy toTitleCase lowercases then upper-cases first char
      // of each token, so "OG" -> "Og". parsekit must match (this
      // documents the legacy quirk).
      input: 'MOONLIT- BANANA OG 1G INFUSED PREROLL',
      expected: {
        brand: 'Moonlit Hash Co',
        category: 'Pre-Rolls',
        groupName: 'Banana Og',
        packCount: 1,
        prevalence: null,
        searchTerm: 'Banana Og',
        size: '1g',
        strainName: 'Banana Og',
        subcategory: 'Infused',
        variantName: 'Moonlit Hash Co Banana Og 1g',
        variantTab: '1g',
      },
    },
    {
      parserId: 'pending-purchases.jennys',
      input: "Jenny's J 0.5g OG Kush Pre-Roll",
      expected: {
        brand: "Jenny's",
        category: 'Pre-Rolls',
        groupName: 'OG Kush',
        packCount: 1,
        prevalence: null,
        searchTerm: 'OG Kush',
        size: '0.5g',
        strainName: 'OG Kush',
        subcategory: '',
        variantName: "Jenny's OG Kush 0.5g",
        variantTab: '0.5g',
      },
    },
    {
      parserId: 'pending-purchases.smartbud',
      input: 'Smartbud - 10Pk Preroll - Banana OG - 3.5g',
      expected: {
        brand: 'Smartbud',
        category: 'Pre-Rolls',
        groupName: 'Banana OG',
        packCount: 10,
        prevalence: null,
        searchTerm: 'Banana OG',
        size: '0.35g',
        strainName: 'Banana OG',
        subcategory: '',
        variantName: 'Smartbud Banana OG 10x 0.35g',
        variantTab: '10x 0.35g',
      },
    },
    {
      parserId: 'pending-purchases.posh-puff',
      // Leading-dot decimal (`.5`) + composite groupName + brand
      // override to "Jenny's" — covered by Posh Puff's legacy quirks.
      input: 'Posh Puff .5g Banana OG Vape',
      expected: {
        brand: "Jenny's",
        category: 'Vapes',
        groupName: 'Posh Puff Banana OG',
        packCount: 1,
        prevalence: null,
        searchTerm: 'Banana OG',
        size: '0.5g',
        strainName: 'Banana OG',
        subcategory: 'All In One / Disposable',
        variantName: "Jenny's Posh Puff Banana OG 0.5g",
        variantTab: '0.5g',
      },
    },
    // -- Curaleaf parity cases ---------------------------------------
    // The real-corpus seed (also pinned in EXACT_REUSE_PRODUCT_IDS).
    {
      parserId: 'pending-purchases.curaleaf',
      input: 'Pr(Pre-Roll Pack)-Anthem-Indica Blend-10PK-3.5g-I',
      expected: {
        brand: 'Anthem',
        category: 'Pre-Rolls',
        groupName: 'Indica Blend',
        packCount: 10,
        prevalence: 'Indica',
        searchTerm: 'Indica Blend',
        size: '0.35g',
        strainName: 'Indica Blend',
        subcategory: '',
        variantName: 'Anthem Indica Blend 10x 0.35g',
        variantTab: '10x 0.35g',
      },
    },
    // Pre-Roll (single, infused) default — no leading mod, no pack token.
    {
      parserId: 'pending-purchases.curaleaf',
      input: 'Pr(Pre-Roll)-Anthem-Sour Diesel-1g-S',
      expected: {
        brand: 'Anthem',
        category: 'Pre-Rolls',
        groupName: 'Sour Diesel',
        packCount: 1,
        prevalence: 'Sativa',
        searchTerm: 'Sour Diesel',
        size: '1g',
        strainName: 'Sour Diesel',
        subcategory: 'Infused',
        variantName: 'Anthem Sour Diesel 1g',
        variantTab: '1g',
      },
    },
    // Anthem + Bold under Pre-Roll Pack overrides subcategory to 'Infused'.
    {
      parserId: 'pending-purchases.curaleaf',
      input: 'Pr(Pre-Roll Pack)-Anthem-Bold-Sour Diesel-10PK-3.5g-I',
      expected: {
        brand: 'Anthem',
        category: 'Pre-Rolls',
        groupName: 'Sour Diesel',
        packCount: 10,
        prevalence: 'Indica',
        searchTerm: 'Sour Diesel',
        size: '0.35g',
        strainName: 'Sour Diesel',
        subcategory: 'Infused',
        variantName: 'Anthem Sour Diesel 10x 0.35g',
        variantTab: '10x 0.35g',
      },
    },
    // Grassroots + Dark Heart under Pre-Roll Pack -> brand alias.
    {
      parserId: 'pending-purchases.curaleaf',
      input: 'Pr(Pre-Roll Pack)-Grassroots-Dark Heart-Cookies-2PK-1g-H',
      expected: {
        brand: 'Grass Roots',
        category: 'Pre-Rolls',
        groupName: 'Cookies',
        packCount: 2,
        prevalence: 'Hybrid',
        searchTerm: 'Cookies',
        size: '0.5g',
        strainName: 'Cookies',
        subcategory: '',
        variantName: 'Grass Roots Cookies 2x 0.5g',
        variantTab: '2x 0.5g',
      },
    },
    // Grassroots brand alias under generic Pre-Roll (no leading mod).
    {
      parserId: 'pending-purchases.curaleaf',
      input: 'Pr(Pre-Roll)-Grassroots-Wedding Cake-1g-H',
      expected: {
        brand: 'Grass Roots',
        category: 'Pre-Rolls',
        groupName: 'Wedding Cake',
        packCount: 1,
        prevalence: 'Hybrid',
        searchTerm: 'Wedding Cake',
        size: '1g',
        strainName: 'Wedding Cake',
        subcategory: 'Infused',
        variantName: 'Grass Roots Wedding Cake 1g',
        variantTab: '1g',
      },
    },
    // Whole Flower — raw size (no formatGrams), subcategory 'Pre-Packaged Flower'.
    {
      parserId: 'pending-purchases.curaleaf',
      input: 'F(Whole Flower)-Grassroots-Pineapple Express-3.5g-S',
      expected: {
        brand: 'Grass Roots',
        category: 'Flower',
        groupName: 'Pineapple Express',
        packCount: 1,
        prevalence: 'Sativa',
        searchTerm: 'Pineapple Express',
        size: '3.5g',
        strainName: 'Pineapple Express',
        subcategory: 'Pre-Packaged Flower',
        variantName: 'Grass Roots Pineapple Express 3.5g',
        variantTab: '3.5g',
      },
    },
    // Vapes default (non-Select) — raw size, groupName not prefixed.
    {
      parserId: 'pending-purchases.curaleaf',
      input: 'V(BRIQ)-Anthem-Indica Blend-0.5g-I',
      expected: {
        brand: 'Anthem',
        category: 'Vapes',
        groupName: 'Indica Blend',
        packCount: 1,
        prevalence: 'Indica',
        searchTerm: 'Indica Blend',
        size: '0.5g',
        strainName: 'Indica Blend',
        subcategory: '',
        variantName: 'Anthem Indica Blend 0.5g',
        variantTab: '0.5g',
      },
    },
    // Vape + Select + Essentials — groupName prefixed with 'Essentials Briq ',
    // searchTerm strips that prefix back off; strainName mirrors groupName.
    {
      parserId: 'pending-purchases.curaleaf',
      input: 'V(BRIQ)-Select-Essentials-Cookies-0.5g-H',
      expected: {
        brand: 'Select',
        category: 'Vapes',
        groupName: 'Essentials Briq Cookies',
        packCount: 1,
        prevalence: 'Hybrid',
        searchTerm: 'Cookies',
        size: '0.5g',
        // strainName mirrors the LOCAL (unprefixed) groupName in legacy,
        // even though the output `groupName` carries the 'Essentials Briq '
        // prefix for vape-select.
        strainName: 'Cookies',
        subcategory: '',
        variantName: 'Select Essentials Briq Cookies 0.5g',
        variantTab: '0.5g',
      },
    },
    // Diamond Infused substring scrub inside a modifier token body.
    {
      parserId: 'pending-purchases.curaleaf',
      input: 'Pr(Pre-Roll Pack)-Anthem-Sour Diesel Diamond Infused-10PK-3.5g-I',
      expected: {
        brand: 'Anthem',
        category: 'Pre-Rolls',
        groupName: 'Sour Diesel',
        packCount: 10,
        prevalence: 'Indica',
        searchTerm: 'Sour Diesel',
        size: '0.35g',
        strainName: 'Sour Diesel',
        subcategory: '',
        variantName: 'Anthem Sour Diesel 10x 0.35g',
        variantTab: '10x 0.35g',
      },
    },
    // -- Cannabals parity cases (covers both real fixtures from
    //    pendingPurchaseParser.test.ts + the 1pk-becomes-10 quirk). ---
    {
      parserId: 'pending-purchases.cannabals',
      input: 'Cannabals - Chubby Puff Vape - Strawberry Cough - 6g',
      expected: {
        brand: 'Cannabals',
        category: 'Vapes',
        groupName: 'Chubby Puff Strawberry Cough',
        packCount: 1,
        prevalence: null,
        searchTerm: 'Strawberry Cough',
        size: '6g',
        strainName: 'Strawberry Cough',
        subcategory: 'All In One / Disposable',
        variantName: 'Cannabals Chubby Puff Strawberry Cough 6g',
        variantTab: '6g',
      },
    },
    {
      parserId: 'pending-purchases.cannabals',
      input: 'Cannabals - Gummy Brick - Orange Soda - 100mg THC',
      expected: {
        brand: 'Cannabals',
        category: 'Edibles',
        groupName: 'Orange Soda Gummy Brick',
        packCount: 10,
        prevalence: null,
        searchTerm: 'Orange Soda',
        size: '10mg',
        // legacy parser sets strainName='' for Gummy Brick.
        strainName: '',
        subcategory: '',
        variantName: 'Cannabals Orange Soda Gummy Brick 10x 10mg',
        variantTab: '10x 10mg',
      },
    },
    {
      parserId: 'pending-purchases.cannabals',
      // The "1pk" -> 10 quirk + skip tokens (Fast-Acting Distillate) +
      // "last unrecognized part wins" (Playoff Punch beats Fast-Acting).
      input: 'Cannabals - Gummy Brick - Fast-Acting Distillate - 1pk - 100 MG THC - Playoff Punch',
      expected: {
        brand: 'Cannabals',
        category: 'Edibles',
        groupName: 'Playoff Punch Gummy Brick',
        packCount: 10,
        prevalence: null,
        searchTerm: 'Playoff Punch',
        size: '10mg',
        strainName: '',
        subcategory: '',
        variantName: 'Cannabals Playoff Punch Gummy Brick 10x 10mg',
        variantTab: '10x 10mg',
      },
    },
  ]

  for (const c of cases) {
    it(`${c.parserId}: "${c.input}" matches baked expectation`, () => {
      const compiled = compiledBy.get(c.parserId)!
      const result = parseWith(compiled, c.input)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.output).toEqual(c.expected)
      }
    })

    it(`${c.parserId}: "${c.input}" matches legacy parseProductNameLegacy`, async () => {
      const compiled = compiledBy.get(c.parserId)!
      const result = parseWith(compiled, c.input)
      expect(result.ok).toBe(true)
      if (result.ok) {
        // Re-import the legacy module per case so the shared
        // CURALEAF_CATEGORY_MAP mutation in parseCuraleafName
        // (mapping.subcategory = 'Infused' for the Anthem+Bold branch)
        // can't leak between parity cases. parsekit does NOT reproduce
        // that mutation bug — see Oracle critique notes.
        //
        // We call `parseProductNameLegacy` (not `parseProductName`) here:
        // `parseProductName` is now the reverse-shadow entry point that
        // *runs parsekit first* and would make this comparison circular.
        vi.resetModules()
        const fresh = await import('../../../worker/jobs/generatePendingPurchasePacketJob.js')
        const legacy = fresh.parseProductNameLegacy(c.input)
        expect(result.output).toEqual(legacy)
      }
    })
  }
})
