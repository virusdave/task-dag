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

import { describe, expect, it, vi } from 'vitest'

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
// Legacy `parseProductName` is imported dynamically per parity test
// case (see below) to isolate the shared-state mutation bug in
// `parseCuraleafName` from earlier cases in the same run.

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
// Tenant: Curaleaf
//   Legacy: parseCuraleafName in generatePendingPurchasePacketJob.ts
//
//   Header:   ^(Pr\(Pre-Roll(?: Pack)?\)|F\(Whole Flower\)|V\(BRIQ\))-(.+)$
//   Body:     dash-separated:
//             brand - [maybe leading-mod] - mods+ - size - prevalence
//
//   Brand-conditional fixups (legacy):
//     Grassroots                          -> brand 'Grass Roots'
//     Anthem    + leading 'Bold'          -> drop 'Bold', subcategory='Infused'
//     Grassroots+ leading 'Dark Heart'    -> drop 'Dark Heart'
//     Select    + leading 'Essentials'    -> drop, groupName prefixed with 'Essentials Briq '
//
//   Output composition is category-keyed:
//     Pre-Rolls: size = formatGrams(grams / packCount), variantTab packs-aware
//     Vapes/Flower: size = raw sizeToken, variantTab = size
//
//   This config models the legacy with rule explosion + the
//   captureMany/fromList/mapValue/filter/find/joinTokens/stripSuffix/removeSubstrings
//   features from commit 307a0c4 (and the new tokens added alongside this port).
//
//   No conditional transform DSL — every per-brand or per-category
//   asymmetry is expressed as a separate rule (priority-ranked).
// ---------------------------------------------------------------------

const CURALEAF_BRAND_TABLE = { Grassroots: 'Grass Roots' } as const

const PREVALENCE_TABLE = { I: 'Indica', S: 'Sativa', H: 'Hybrid' } as const

const CURALEAF_GROUP_CLEAN = [
  { name: 'filterTokens', version: 1, args: { pattern: '^\\d+PK$', caseInsensitive: true } },
  { name: 'joinTokens', version: 1, args: { sep: '-' } },
  { name: 'removeSubstrings', version: 1, args: { values: ['Diamond Infused', 'Glass Tip Infused'] } },
  { name: 'cleanCultivar', version: 1 },
] as const

type CuraleafRuleOpts = {
  id: string
  priority: number
  prefix: string
  category: string
  subcategory: string
  formatSize: boolean
  /** Parser literal that must match in the input. */
  brandLit?: string
  /** Projection literal — defaults to brandLit. Use when the source
   *  brand token differs from the canonical brand (e.g. parser
   *  'Grassroots' → output 'Grass Roots'). */
  brandOut?: string
  leadingMod?: string
  groupNamePrefix?: string
}

function buildCuraleafRule(opts: CuraleafRuleOpts) {
  // Parser: prefix - [brand-lit or capture] - [leading-mod lit -]? - mods - size - prev - optWs
  const items: Array<Record<string, unknown>> = [
    { kind: 'lit', value: opts.prefix },
    { kind: 'token', token: 'dash' },
  ]
  if (opts.brandLit !== undefined) {
    items.push({ kind: 'lit', value: opts.brandLit })
  } else {
    items.push({ kind: 'capture', name: 'brand', expr: { kind: 'token', token: 'cultivarText' } })
  }
  items.push({ kind: 'token', token: 'dash' })
  if (opts.leadingMod !== undefined) {
    items.push({ kind: 'lit', value: opts.leadingMod })
    items.push({ kind: 'token', token: 'dash' })
  }
  items.push({
    kind: 'captureMany',
    name: 'mods',
    expr: {
      kind: 'sepBy',
      min: 1,
      max: 10,
      expr: { kind: 'token', token: 'modToken' },
      // Lookahead-aware dash that refuses to commit before the trailing
      // `-<size>-<prev>` slots. Required because arcsecond's sepBy is
      // non-backtracking once a separator is consumed.
      sep: { kind: 'token', token: 'modDash' },
    },
  })
  items.push({ kind: 'token', token: 'dash' })
  items.push({ kind: 'capture', name: 'size', expr: { kind: 'token', token: 'sizeText' } })
  items.push({ kind: 'token', token: 'dash' })
  items.push({ kind: 'capture', name: 'prev', expr: { kind: 'token', token: 'prevToken' } })
  items.push({ kind: 'token', token: 'optWs' })

  // Projection:
  //   brand        -> literal (specialized) or mapValue table (generic, passthrough)
  //   category     -> literal
  //   subcategory  -> literal
  //   packCount    -> mods -> findToken(\d+PK, default '1PK') -> stripSuffix('PK') -> parseIntStrict
  //                   (default '1PK' so stripSuffix yields '1' -> parseInt 1 when no pack token)
  //   groupName    -> mods -> filter(pack) -> join('-') -> removeSubstrings -> cleanCultivar
  //                   + optional `prepend({prefix: 'Essentials Briq '})` for vape-select
  //   strainName   -> same as groupName (legacy mirrors strainName = groupName)
  //   searchTerm   -> mods -> same cleaning pipeline + removeSubstrings(['Essentials Briq '])
  //                   (no-op outside vape-select; matches legacy literal scrub)
  //   prevalence   -> prev -> mapValue({I:'Indica',S:'Sativa',H:'Hybrid'})
  //   size/variantTab/variantName -> placeholders, computed by rule transforms below.
  const brandExpr = opts.brandLit !== undefined
    ? { literal: opts.brandOut ?? opts.brandLit }
    : {
        from: 'brand',
        transforms: [
          { name: 'mapValue', version: 1, args: { table: { ...CURALEAF_BRAND_TABLE } } },
        ],
      }

  const cleanedMods: Array<Record<string, unknown>> = [...CURALEAF_GROUP_CLEAN]
  const groupNameTransforms: Array<Record<string, unknown>> = [...cleanedMods]
  if (opts.groupNamePrefix !== undefined) {
    groupNameTransforms.push({ name: 'prepend', version: 1, args: { prefix: opts.groupNamePrefix } })
  }
  // Legacy mirrors strainName from the LOCAL (unprefixed) groupName
  // even when the output `groupName` carries the 'Essentials Briq ' prefix
  // (vape-select). So strainName always uses the cleaned-but-unprefixed
  // mod text, never the prepend.
  const strainNameTransforms: Array<Record<string, unknown>> = [...cleanedMods]

  const searchTermTransforms: Array<Record<string, unknown>> = [
    ...CURALEAF_GROUP_CLEAN,
    { name: 'removeSubstrings', version: 1, args: { values: ['Essentials Briq '] } },
    { name: 'cleanCultivar', version: 1 },
  ]

  const project: Record<string, unknown> = {
    brand: brandExpr,
    category: { literal: opts.category },
    subcategory: { literal: opts.subcategory },
    packCount: {
      fromList: 'mods',
      transforms: [
        { name: 'findToken', version: 1, args: { pattern: '^\\d+PK$', caseInsensitive: true, default: '1PK' } },
        { name: 'stripSuffix', version: 1, args: { suffix: 'PK', caseInsensitive: true } },
        { name: 'parseIntStrict', version: 1 },
      ],
    },
    groupName: { fromList: 'mods', transforms: groupNameTransforms },
    strainName: { fromList: 'mods', transforms: strainNameTransforms },
    searchTerm: { fromList: 'mods', transforms: searchTermTransforms },
    prevalence: {
      from: 'prev',
      transforms: [
        { name: 'mapValue', version: 1, args: { table: { ...PREVALENCE_TABLE } } },
      ],
    },
    size: { literal: '__placeholder__' },
    variantTab: { literal: '__placeholder__' },
    variantName: { literal: '__placeholder__' },
  }

  // Rule transforms:
  //   Pre-Rolls:  size = sizeFromTotalAndPack(grams/packCount); variantTab + variantName composed.
  //   Vapes/Flower: copy raw size capture into output.size (no formatGrams); then compose.
  const ruleTransforms: Array<Record<string, unknown>> = []
  if (opts.formatSize) {
    ruleTransforms.push({
      name: 'sizeFromTotalAndPack',
      version: 1,
      args: { totalCapture: 'size' },
    })
  } else {
    // The capture name is 'size' and the output field is also 'size'; we
    // need the raw capture text rather than the placeholder. Easiest: a
    // setLiteral-by-reference doesn't exist, so reach into ctx via a
    // tiny copy through prepend with empty prefix on a from:size value.
    // Simpler: replace the placeholder projection with a from-projection.
    project.size = { from: 'size' }
  }
  ruleTransforms.push({ name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } })
  ruleTransforms.push({ name: 'composeVariantName', version: 1 })

  return {
    id: opts.id,
    priority: opts.priority,
    parser: { kind: 'seq', items } as Record<string, unknown>,
    project,
    transforms: ruleTransforms,
    goldens: [],
  }
}

const curaleafConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.curaleaf',
  scope: { tenantId: 'curaleaf', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ['Pr(', 'F(', 'V('] },
  rules: [
    // -- Pre-Roll (single, infused) ----------------------------------
    buildCuraleafRule({
      id: 'curaleaf.preroll-anthem-bold',
      priority: 200,
      prefix: 'Pr(Pre-Roll)',
      category: 'Pre-Rolls',
      subcategory: 'Infused',
      formatSize: true,
      brandLit: 'Anthem',
      leadingMod: 'Bold',
    }),
    buildCuraleafRule({
      id: 'curaleaf.preroll-grass-dh',
      priority: 200,
      prefix: 'Pr(Pre-Roll)',
      category: 'Pre-Rolls',
      subcategory: 'Infused',
      formatSize: true,
      brandLit: 'Grassroots',
      brandOut: 'Grass Roots',
      leadingMod: 'Dark Heart',
    }),
    buildCuraleafRule({
      id: 'curaleaf.preroll-default',
      priority: 100,
      prefix: 'Pr(Pre-Roll)',
      category: 'Pre-Rolls',
      subcategory: 'Infused',
      formatSize: true,
    }),
    // -- Pre-Roll Pack (multi) ---------------------------------------
    // Anthem+Bold under Pre-Roll Pack overrides subcategory to 'Infused'.
    buildCuraleafRule({
      id: 'curaleaf.preroll-pack-anthem-bold',
      priority: 200,
      prefix: 'Pr(Pre-Roll Pack)',
      category: 'Pre-Rolls',
      subcategory: 'Infused',
      formatSize: true,
      brandLit: 'Anthem',
      leadingMod: 'Bold',
    }),
    buildCuraleafRule({
      id: 'curaleaf.preroll-pack-grass-dh',
      priority: 200,
      prefix: 'Pr(Pre-Roll Pack)',
      category: 'Pre-Rolls',
      subcategory: '',
      formatSize: true,
      brandLit: 'Grassroots',
      brandOut: 'Grass Roots',
      leadingMod: 'Dark Heart',
    }),
    buildCuraleafRule({
      id: 'curaleaf.preroll-pack-default',
      priority: 100,
      prefix: 'Pr(Pre-Roll Pack)',
      category: 'Pre-Rolls',
      subcategory: '',
      formatSize: true,
    }),
    // -- Whole Flower ------------------------------------------------
    buildCuraleafRule({
      id: 'curaleaf.flower-default',
      priority: 100,
      prefix: 'F(Whole Flower)',
      category: 'Flower',
      subcategory: 'Pre-Packaged Flower',
      formatSize: false,
    }),
    // -- BRIQ Vapes --------------------------------------------------
    buildCuraleafRule({
      id: 'curaleaf.vape-select-essentials',
      priority: 200,
      prefix: 'V(BRIQ)',
      category: 'Vapes',
      subcategory: '',
      formatSize: false,
      brandLit: 'Select',
      leadingMod: 'Essentials',
      groupNamePrefix: 'Essentials Briq ',
    }),
    buildCuraleafRule({
      id: 'curaleaf.vape-default',
      priority: 100,
      prefix: 'V(BRIQ)',
      category: 'Vapes',
      subcategory: '',
      formatSize: false,
    }),
  ] as never,
}

// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Tenant: Cannabals
//   Legacy: parseCannabalsName in generatePendingPurchasePacketJob.ts
//
//   Header:  parts[0] must be /^cannabals$/i
//   Family:  parts[1] — branches by lowercased substring match:
//              'chubby puff'  -> Vapes branch
//              'gummy brick'  -> Edibles branch
//
//   Chubby Puff:
//     parts = [Cannabals, <family>, <cultivar parts...>, <NgSize>]
//     cultivar = parts.slice(2, -1).join(' ')
//     size     = formatGrams(parseFloat(sizeText.replace('g','')))
//     output groupName = 'Chubby Puff <cultivar>'
//
//   Gummy Brick:
//     parts = [Cannabals, Gummy Brick, ...unordered bag...]
//     For each part in parts.slice(2):
//       /^(\d+)\s*pk$/i               -> packCount (legacy: '1pk' becomes 10)
//       /^(\d+)\s*(?:MG\s*THC|mg)$/i  -> dosageText
//       /distillate|fast[-\s]acting/  -> skip
//       else                          -> cultivar = part   (LAST WINS!)
//     packCount defaults to 10; size = perPieceMg = totalMg/packCount if even,
//     else 10; variantTab = `${packCount}x ${size}`
//     output groupName = '<cultivar> Gummy Brick'
//
//   This port uses captureMany over the modifier bag + the new
//   `lastToken` list transform to mirror the "last unrecognized part
//   wins" cultivar semantic; pack/dosage/skip tokens are pulled via
//   findToken/filterTokens.
// ---------------------------------------------------------------------

const PACK_PATTERN_CANNABALS = '^\\d+\\s*[Pp][Kk]$'
const DOSAGE_PATTERN_CANNABALS = '^\\d+\\s*(?:MG(?:\\s*THC)?|mg(?:\\s*THC)?)$'
const SKIP_PATTERN_CANNABALS = '(?:distillate|fast[-\\s]acting)'

const cannabalsConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.cannabals',
  scope: { tenantId: 'cannabals', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: { prefixes: ['Cannabals'] },
  rules: [
    // -- Chubby Puff (Vapes) ----------------------------------------
    {
      id: 'cannabals.chubby-puff',
      priority: 200,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Cannabals' },
          { kind: 'token', token: 'dash' },
          { kind: 'lit', value: 'Chubby Puff', caseInsensitive: true },
          // Eat any extras in the family slot (e.g. " Vape") until the
          // next dash. minLen:0 because "Chubby Puff" alone is valid.
          { kind: 'consumeUntil', terminator: { kind: 'token', token: 'dash' }, minLen: 0 },
          { kind: 'token', token: 'dash' },
          {
            kind: 'captureMany',
            name: 'cultivarParts',
            expr: {
              kind: 'sepBy',
              min: 1,
              max: 10,
              expr: { kind: 'token', token: 'modToken' },
              sep: { kind: 'token', token: 'modDash' },
            },
          },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'grams', expr: { kind: 'token', token: 'decimal' } },
          { kind: 'token', token: 'gramsSuffix' },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Cannabals' },
        category: { literal: 'Vapes' },
        subcategory: { literal: 'All In One / Disposable' },
        packCount: { literal: 1 },
        prevalence: { literal: null },
        groupName: {
          fromList: 'cultivarParts',
          transforms: [
            { name: 'joinTokens', version: 1, args: { sep: ' ' } },
            { name: 'cleanCultivar', version: 1 },
            { name: 'prepend', version: 1, args: { prefix: 'Chubby Puff ' } },
          ],
        },
        strainName: {
          fromList: 'cultivarParts',
          transforms: [
            { name: 'joinTokens', version: 1, args: { sep: ' ' } },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
        searchTerm: {
          fromList: 'cultivarParts',
          transforms: [
            { name: 'joinTokens', version: 1, args: { sep: ' ' } },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
        size: { from: 'grams', transforms: [{ name: 'formatGrams', version: 1 }] },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1 },
      ],
      goldens: [],
    },
    // -- Gummy Brick (Edibles) --------------------------------------
    {
      id: 'cannabals.gummy-brick',
      priority: 200,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Cannabals' },
          { kind: 'token', token: 'dash' },
          { kind: 'lit', value: 'Gummy Brick', caseInsensitive: true },
          { kind: 'consumeUntil', terminator: { kind: 'token', token: 'dash' }, minLen: 0 },
          { kind: 'token', token: 'dash' },
          {
            kind: 'captureMany',
            name: 'mods',
            expr: {
              kind: 'sepBy',
              min: 1,
              max: 10,
              expr: { kind: 'token', token: 'modToken' },
              sep: { kind: 'token', token: 'modDash' },
            },
          },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Cannabals' },
        category: { literal: 'Edibles' },
        subcategory: { literal: '' },
        prevalence: { literal: null },
        // packCount: findToken(\d+pk) -> stripSuffix('pk') -> mapValue
        // (legacy quirk: '1pk' becomes 10) -> parseIntStrict.
        packCount: {
          fromList: 'mods',
          transforms: [
            { name: 'findToken', version: 1, args: { pattern: PACK_PATTERN_CANNABALS, caseInsensitive: true, default: '10pk' } },
            { name: 'stripSuffix', version: 1, args: { suffix: 'pk', caseInsensitive: true } },
            { name: 'mapValue', version: 1, args: { table: { '1': '10' } } },
            { name: 'parseIntStrict', version: 1 },
          ],
        },
        // Surface the raw dosage text (e.g. '100mg' or '100mg THC') into
        // size; the rule transform below splits the leading digits and
        // divides by packCount.
        size: {
          fromList: 'mods',
          transforms: [
            { name: 'findToken', version: 1, args: { pattern: DOSAGE_PATTERN_CANNABALS, default: '100mg' } },
          ],
        },
        // Cultivar: filter pack/dosage/skip tokens then take LAST
        // unrecognized item (mirrors legacy `cultivar = part` loop).
        strainName: { literal: '' },
        searchTerm: {
          fromList: 'mods',
          transforms: [
            { name: 'filterTokens', version: 1, args: { pattern: PACK_PATTERN_CANNABALS, caseInsensitive: true } },
            { name: 'filterTokens', version: 1, args: { pattern: DOSAGE_PATTERN_CANNABALS } },
            { name: 'filterTokens', version: 1, args: { pattern: SKIP_PATTERN_CANNABALS, caseInsensitive: true } },
            { name: 'lastToken', version: 1 },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
        // groupName = '<cultivar> Gummy Brick' (the `append` transform
        // tacks on the suffix in the per-field pipeline).
        groupName: {
          fromList: 'mods',
          transforms: [
            { name: 'filterTokens', version: 1, args: { pattern: PACK_PATTERN_CANNABALS, caseInsensitive: true } },
            { name: 'filterTokens', version: 1, args: { pattern: DOSAGE_PATTERN_CANNABALS } },
            { name: 'filterTokens', version: 1, args: { pattern: SKIP_PATTERN_CANNABALS, caseInsensitive: true } },
            { name: 'lastToken', version: 1 },
            { name: 'cleanCultivar', version: 1 },
            { name: 'append', version: 1, args: { suffix: ' Gummy Brick' } },
          ],
        },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        // Compute per-piece mg = total / pack (fallback 10 if not
        // evenly divisible). Reads + writes output.size in place.
        { name: 'mgPerPieceFromTotalAndPack', version: 1 },
        // variantTab + variantName composition.
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1 },
      ],
      goldens: [],
    },
  ],
}

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
  curaleafConfig,
  cannabalsConfig,
]

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

    it(`${c.parserId}: "${c.input}" matches legacy parseProductName`, async () => {
      const compiled = compiledBy.get(c.parserId)!
      const result = parseWith(compiled, c.input)
      expect(result.ok).toBe(true)
      if (result.ok) {
        // Re-import the legacy module per case so the shared
        // CURALEAF_CATEGORY_MAP mutation in parseCuraleafName
        // (mapping.subcategory = 'Infused' for the Anthem+Bold branch)
        // can't leak between parity cases. parsekit does NOT reproduce
        // that mutation bug — see Oracle critique notes.
        vi.resetModules()
        const fresh = await import('../../../worker/jobs/generatePendingPurchasePacketJob.js')
        const legacy = fresh.parseProductName(c.input)
        expect(result.output).toEqual(legacy)
      }
    })
  }
})
