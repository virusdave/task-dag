/**
 * End-to-end parity tests for parsekit + metrc-v1 dialect vs the legacy
 * hardcoded parsers in generatePendingPurchasePacketJob.ts.
 *
 * Covers the three simplest tenants in this slice (Phase 4 of the
 * parsekit epic): Bytes, Outrankd, The Gram. Each tenant config below
 * is the JSONC-shape that will move into
 * parsekit-configs/use-cases/pending-purchases/parsers/<tenantId>.jsonc
 * in Phase 6; expressing it here in TS first lets us prove the
 * pipeline before the configs repo exists.
 */

import { describe, expect, it } from 'vitest'

import {
  compileParser,
  parseWith,
  verifyParser,
  type TenantParserConfig,
} from '../index.js'
import {
  pendingPurchasesContract,
  pendingPurchasesOutputFields,
} from '../contracts/pendingPurchases.js'
import { metrcV1Dialect } from '../dialects/metrc-v1.js'
import { parseProductName as legacyParseProductName } from '../../../worker/jobs/generatePendingPurchasePacketJob.js'

// ---------------------------------------------------------------------
// Tenant: Bytes
//   Legacy: ^Bytes\s*-\s*(.+?)\s*-\s*Edibles\s*-\s*(\d+)\s*$
// ---------------------------------------------------------------------

const bytesConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.bytes',
  scope: { tenantId: 'bytes', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ['Bytes'] },
  rules: [
    {
      id: 'bytes.default',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Bytes' },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'dash' },
          { kind: 'lit', value: 'Edibles' },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'pack', expr: { kind: 'token', token: 'int' } },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Bytes' },
        category: { literal: 'Edibles' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { from: 'pack', transforms: [{ name: 'parseIntStrict', version: 1 }] },
        prevalence: { literal: null },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { literal: '10mg' },
        strainName: { literal: '' },
        subcategory: { literal: 'Chews/Gummies' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1 },
      ],
      goldens: [
        {
          kind: 'match',
          id: 'bytes.watermelon-10',
          input: 'Bytes - Watermelon - Edibles - 10',
          expected: {
            brand: 'Bytes',
            category: 'Edibles',
            groupName: 'Watermelon',
            packCount: 10,
            prevalence: null,
            searchTerm: 'Watermelon',
            size: '10mg',
            strainName: '',
            subcategory: 'Chews/Gummies',
            variantName: 'Bytes Watermelon 10x 10mg',
            variantTab: '10x 10mg',
          },
        },
      ],
    },
  ],
}

// ---------------------------------------------------------------------
// Tenant: Outrankd
//   Legacy: ^Outrankd\s*-\s*(.+?)\s*-\s*Disposable Vape\s*-\s*(\d+(?:\.\d+)?)g\s*$
// ---------------------------------------------------------------------

const outrankdConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.outrankd',
  scope: { tenantId: 'outrankd', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ['Outrankd'] },
  rules: [
    {
      id: 'outrankd.default',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Outrankd' },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'dash' },
          { kind: 'lit', value: 'Disposable Vape' },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'grams', expr: { kind: 'token', token: 'decimal' } },
          { kind: 'token', token: 'gramsSuffix' },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Outrankd' },
        category: { literal: 'Vapes' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 1 },
        prevalence: { literal: null },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { from: 'grams', transforms: [{ name: 'formatGrams', version: 1 }] },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        subcategory: { literal: '' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1, args: { fields: ['brand', 'groupName', 'size'] } },
      ],
      goldens: [
        {
          kind: 'match',
          id: 'outrankd.banana-1g',
          input: 'Outrankd - Banana OG - Disposable Vape - 1g',
          expected: {
            brand: 'Outrankd',
            category: 'Vapes',
            groupName: 'Banana OG',
            packCount: 1,
            prevalence: null,
            searchTerm: 'Banana OG',
            size: '1g',
            strainName: 'Banana OG',
            subcategory: '',
            variantName: 'Outrankd Banana OG 1g',
            variantTab: '1g',
          },
        },
      ],
    },
  ],
}

// ---------------------------------------------------------------------
// Tenant: The Gram
//   Legacy: ^The Gram\s*-\s*(.+?)\s*-\s*Flower\s*-\s*(\d+(?:\.\d+)?)g\s*$
// ---------------------------------------------------------------------

const theGramConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.the-gram',
  scope: { tenantId: 'the-gram', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ['The Gram'] },
  rules: [
    {
      id: 'the-gram.default',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'The Gram' },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'dash' },
          { kind: 'lit', value: 'Flower' },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'grams', expr: { kind: 'token', token: 'decimal' } },
          { kind: 'token', token: 'gramsSuffix' },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'The Gram' },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 1 },
        prevalence: { literal: null },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { from: 'grams', transforms: [{ name: 'formatGrams', version: 1 }] },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        subcategory: { literal: '' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1, args: { fields: ['brand', 'groupName', 'size'] } },
      ],
      goldens: [
        {
          kind: 'match',
          id: 'the-gram.og-kush-1g',
          input: 'The Gram - OG Kush - Flower - 1g',
          expected: {
            brand: 'The Gram',
            category: 'Pre-Rolls',
            groupName: 'OG Kush',
            packCount: 1,
            prevalence: null,
            searchTerm: 'OG Kush',
            size: '1g',
            strainName: 'OG Kush',
            subcategory: '',
            variantName: 'The Gram OG Kush 1g',
            variantTab: '1g',
          },
        },
      ],
    },
  ],
}

// ---------------------------------------------------------------------
// Tenant: Herb (fixed-code lookup table — 3 hardcoded SKUs in legacy)
// ---------------------------------------------------------------------

function herbRule(
  code: string,
  cultivar: string,
): TenantParserConfig['rules'][number] {
  return {
    id: `herb.${code}`,
    priority: 100,
    parser: { kind: 'seq', items: [{ kind: 'lit', value: code }] },
    project: {
      brand: { literal: 'Herb' },
      category: { literal: 'Pre-Rolls' },
      groupName: { literal: cultivar },
      packCount: { literal: 1 },
      prevalence: { literal: null },
      searchTerm: { literal: cultivar },
      size: { literal: '1g' },
      strainName: { literal: cultivar },
      subcategory: { literal: '' },
      variantName: { literal: `Herb ${cultivar} 1g` },
      variantTab: { literal: '1g' },
    },
    goldens: [],
  }
}

const herbConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.herb',
  scope: { tenantId: 'herb', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ['1O-PR-H26-'] },
  rules: [
    herbRule('1O-PR-H26-DBUR', 'Donny Burger'),
    herbRule('1O-PR-H26-SDSL', 'Sour Diesel'),
    herbRule('1O-PR-H26-WIOG', 'WiFi OG'),
  ],
}

// ---------------------------------------------------------------------
// Tenant: LayUp
//   Legacy: ^LayUp\s*-\s*Beverage\s*-\s*(.+?)\s*-\s*(\d+)\s*(?:MG\s*THC|mg)\s*$
// ---------------------------------------------------------------------

const layUpConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.layup',
  scope: { tenantId: 'layup', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ['LayUp'] },
  rules: [
    {
      id: 'layup.default',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'LayUp' },
          { kind: 'token', token: 'dash' },
          { kind: 'lit', value: 'Beverage' },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'flavor', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'mg', expr: { kind: 'token', token: 'int' } },
          { kind: 'token', token: 'optWs' },
          {
            kind: 'choice',
            items: [
              { kind: 'lit', value: 'MG THC', caseInsensitive: true },
              { kind: 'lit', value: 'mg', caseInsensitive: true },
            ],
          },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'LayUp' },
        category: { literal: 'Beverages' },
        groupName: { from: 'flavor', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 1 },
        prevalence: { literal: null },
        searchTerm: { from: 'flavor', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { from: 'mg', transforms: [{ name: 'formatMilligrams', version: 1 }] },
        strainName: { literal: '' },
        subcategory: { literal: '' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1, args: { fields: ['brand', 'groupName', 'size'] } },
      ],
      goldens: [],
    },
  ],
}

// ---------------------------------------------------------------------
// Tenant: Moonlit
//   Legacy: ^MOONLIT-\s*(.+?)\s+(\d+(?:\.\d+)?)\s*G\s+INFUSED\s+PREROLL\s*$
//   Brand label: "Moonlit Hash Co"
// ---------------------------------------------------------------------

const moonlitConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.moonlit',
  scope: { tenantId: 'moonlit', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ['MOONLIT-', 'Moonlit-'] },
  rules: [
    {
      id: 'moonlit.default',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'MOONLIT-', caseInsensitive: true },
          { kind: 'token', token: 'optWs' },
          {
            kind: 'capture',
            name: 'cultivar',
            expr: {
              kind: 'consumeUntil',
              terminator: {
                kind: 'seq',
                items: [
                  { kind: 'token', token: 'ws' },
                  { kind: 'token', token: 'decimal' },
                ],
              },
            },
          },
          { kind: 'token', token: 'ws' },
          { kind: 'capture', name: 'grams', expr: { kind: 'token', token: 'decimal' } },
          { kind: 'token', token: 'optWs' },
          { kind: 'lit', value: 'G', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          { kind: 'lit', value: 'INFUSED', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          { kind: 'lit', value: 'PREROLL', caseInsensitive: true },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Moonlit Hash Co' },
        category: { literal: 'Pre-Rolls' },
        groupName: {
          from: 'cultivar',
          transforms: [
            { name: 'titleCaseIfAllUpper', version: 1 },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
        packCount: { literal: 1 },
        prevalence: { literal: null },
        searchTerm: {
          from: 'cultivar',
          transforms: [
            { name: 'titleCaseIfAllUpper', version: 1 },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
        size: { from: 'grams', transforms: [{ name: 'formatGrams', version: 1 }] },
        strainName: {
          from: 'cultivar',
          transforms: [
            { name: 'titleCaseIfAllUpper', version: 1 },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
        subcategory: { literal: 'Infused' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1, args: { fields: ['brand', 'groupName', 'size'] } },
      ],
      goldens: [],
    },
  ],
}

// ---------------------------------------------------------------------
// Tenant: Jenny's
//   Legacy: ^Jenny'?s\s+J\s+(\d+(?:\.\d+)?)\s*g\s+(.+?)\s+Pre[-\s]?Roll\s*$
// ---------------------------------------------------------------------

const jennysConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.jennys',
  scope: { tenantId: 'jennys', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ["Jenny's", 'Jennys '] },
  rules: [
    {
      id: 'jennys.default',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          {
            kind: 'choice',
            items: [
              { kind: 'lit', value: "Jenny's" },
              { kind: 'lit', value: 'Jennys' },
            ],
          },
          { kind: 'token', token: 'ws' },
          { kind: 'lit', value: 'J' },
          { kind: 'token', token: 'ws' },
          { kind: 'capture', name: 'grams', expr: { kind: 'token', token: 'decimal' } },
          { kind: 'token', token: 'optWs' },
          { kind: 'lit', value: 'g', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          {
            kind: 'capture',
            name: 'cultivar',
            expr: {
              kind: 'consumeUntil',
              terminator: {
                kind: 'seq',
                items: [
                  { kind: 'token', token: 'ws' },
                  {
                    kind: 'choice',
                    items: [
                      { kind: 'lit', value: 'Pre-Roll', caseInsensitive: true },
                      { kind: 'lit', value: 'Pre Roll', caseInsensitive: true },
                      { kind: 'lit', value: 'PreRoll', caseInsensitive: true },
                    ],
                  },
                ],
              },
            },
          },
          { kind: 'token', token: 'ws' },
          {
            kind: 'choice',
            items: [
              { kind: 'lit', value: 'Pre-Roll', caseInsensitive: true },
              { kind: 'lit', value: 'Pre Roll', caseInsensitive: true },
              { kind: 'lit', value: 'PreRoll', caseInsensitive: true },
            ],
          },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: "Jenny's" },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 1 },
        prevalence: { literal: null },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { from: 'grams', transforms: [{ name: 'formatGrams', version: 1 }] },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        subcategory: { literal: '' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1, args: { fields: ['brand', 'groupName', 'size'] } },
      ],
      goldens: [],
    },
  ],
}

// ---------------------------------------------------------------------
// Tenant: Smartbud
//   Legacy: ^Smartbud\s*-\s*(\d+)Pk\s+Preroll\s*-\s*(.+?)\s*-\s*(\d+(?:\.\d+)?)g\s*$
//   Derived: size = totalGrams / packCount, formatted via formatGrams.
// ---------------------------------------------------------------------

const smartbudConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.smartbud',
  scope: { tenantId: 'smartbud', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ['Smartbud'] },
  rules: [
    {
      id: 'smartbud.default',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Smartbud' },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'pack', expr: { kind: 'token', token: 'int' } },
          { kind: 'lit', value: 'Pk', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          { kind: 'lit', value: 'Preroll', caseInsensitive: true },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'totalGrams', expr: { kind: 'token', token: 'decimal' } },
          { kind: 'lit', value: 'g', caseInsensitive: true },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Smartbud' },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { from: 'pack', transforms: [{ name: 'parseIntStrict', version: 1 }] },
        prevalence: { literal: null },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { literal: '__placeholder__' },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        subcategory: { literal: '' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'sizeFromTotalAndPack', version: 1, args: { totalCapture: 'totalGrams' } },
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1 },
      ],
      goldens: [],
    },
  ],
}

// ---------------------------------------------------------------------
// Tenant: Posh Puff
//   Legacy: ^Posh\s+Puff\s+(\.?\d+(?:\.\d+)?)\s*g\s+(.+?)\s+Vapes?\s*$
//   Quirks: brand is "Jenny's" (not "Posh Puff"); groupName is
//           composite "Posh Puff <cultivar>".
// ---------------------------------------------------------------------

const poshPuffConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.posh-puff',
  scope: { tenantId: 'posh-puff', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ['Posh Puff'] },
  rules: [
    {
      id: 'posh-puff.default',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Posh', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          { kind: 'lit', value: 'Puff', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          { kind: 'capture', name: 'grams', expr: { kind: 'token', token: 'decimal' } },
          { kind: 'token', token: 'optWs' },
          { kind: 'lit', value: 'g', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          {
            kind: 'capture',
            name: 'cultivar',
            expr: {
              kind: 'consumeUntil',
              terminator: {
                kind: 'seq',
                items: [
                  { kind: 'token', token: 'ws' },
                  {
                    kind: 'choice',
                    items: [
                      { kind: 'lit', value: 'Vapes', caseInsensitive: true },
                      { kind: 'lit', value: 'Vape', caseInsensitive: true },
                    ],
                  },
                ],
              },
            },
          },
          { kind: 'token', token: 'ws' },
          {
            kind: 'choice',
            items: [
              { kind: 'lit', value: 'Vapes', caseInsensitive: true },
              { kind: 'lit', value: 'Vape', caseInsensitive: true },
            ],
          },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: "Jenny's" },
        category: { literal: 'Vapes' },
        groupName: {
          from: 'cultivar',
          transforms: [
            { name: 'cleanCultivar', version: 1 },
            { name: 'prepend', version: 1, args: { prefix: 'Posh Puff ' } },
          ],
        },
        packCount: { literal: 1 },
        prevalence: { literal: null },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { from: 'grams', transforms: [{ name: 'formatGrams', version: 1 }] },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        subcategory: { literal: 'All In One / Disposable' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1, args: { fields: ['brand', 'groupName', 'size'] } },
      ],
      goldens: [],
    },
  ],
}

// ---------------------------------------------------------------------

const TENANT_CONFIGS: TenantParserConfig[] = [
  bytesConfig,
  outrankdConfig,
  theGramConfig,
  herbConfig,
  layUpConfig,
  moonlitConfig,
  jennysConfig,
  smartbudConfig,
  poshPuffConfig,
]

describe('metrc-v1 dialect: static safety verify', () => {
  for (const cfg of TENANT_CONFIGS) {
    it(`${cfg.parserId} passes verifyParser`, () => {
      const report = verifyParser(cfg, metrcV1Dialect, pendingPurchasesOutputFields)
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

describe('metrc-v1 dialect: parity with legacy parseProductName', () => {
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

    it(`${c.parserId}: "${c.input}" matches legacy parseProductName`, () => {
      const compiled = compiledBy.get(c.parserId)!
      const result = parseWith(compiled, c.input)
      expect(result.ok).toBe(true)
      if (result.ok) {
        const legacy = legacyParseProductName(c.input)
        expect(result.output).toEqual(legacy)
      }
    })
  }
})
