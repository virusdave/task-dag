/**
 * Parsekit tenant-parser fixture configs for the metrc-v1 dialect and
 * the pending-purchases use case.
 *
 * These configs are the JSONC-shape destined to live in the
 * `helios-parser-configs` repo at
 *   `use-cases/pending-purchases/parsers/<tenantId>.jsonc`
 * once the runtime loader is wired up. Until then they are checked
 * in here as TypeScript so the existing test suite (and the
 * `scripts/export-parsekit-configs.mts` extractor) can consume them.
 *
 * Do **not** add behavior or test scaffolding to this file — it is
 * deliberately data + small pure helpers only.
 */

import { type TenantParserConfig } from '../index.js'

// ---------------------------------------------------------------------
// Tenant: Bytes
//   Legacy: ^Bytes\s*-\s*(.+?)\s*-\s*Edibles\s*-\s*(\d+)\s*$
// ---------------------------------------------------------------------

export const bytesConfig: TenantParserConfig = {
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

export const outrankdConfig: TenantParserConfig = {
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

export const theGramConfig: TenantParserConfig = {
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

export function herbRule(
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

export const herbConfig: TenantParserConfig = {
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

export const layUpConfig: TenantParserConfig = {
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

export const moonlitConfig: TenantParserConfig = {
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

export const jennysConfig: TenantParserConfig = {
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

export const smartbudConfig: TenantParserConfig = {
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

export const poshPuffConfig: TenantParserConfig = {
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

export const CURALEAF_BRAND_TABLE = { Grassroots: 'Grass Roots' } as const

export const PREVALENCE_TABLE = { I: 'Indica', S: 'Sativa', H: 'Hybrid' } as const

export const CURALEAF_GROUP_CLEAN = [
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

export function buildCuraleafRule(opts: CuraleafRuleOpts) {
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

export const curaleafConfig: TenantParserConfig = {
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

export const PACK_PATTERN_CANNABALS = '^\\d+\\s*[Pp][Kk]$'
export const DOSAGE_PATTERN_CANNABALS = '^\\d+\\s*(?:MG(?:\\s*THC)?|mg(?:\\s*THC)?)$'
export const SKIP_PATTERN_CANNABALS = '(?:distillate|fast[-\\s]acting)'

export const cannabalsConfig: TenantParserConfig = {
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

// ---------------------------------------------------------------------
// Tenant: HR Botanical
//   Legacy: parseHrBotanicalName in generatePendingPurchasePacketJob.ts
//
//   HR Botanical is the LEGACY fallback tenant: the legacy waterfall
//   routes every distributor name that doesn't match one of the other
//   10 tenant prefixes into `parseHrBotanicalName`, which then itself
//   waterfalls across 8 brand sub-prefixes (and throws on anything
//   else). This parsekit port models each of those 8 brand families
//   as its own rule, prioritized in the same order as the legacy
//   if/else chain.
//
//   Brand family rules (in priority order):
//     200  hr-botanical.revert-edible-gummy        'Revert Edible Gummy '
//     200  hr-botanical.revert-ground-flower-2pack 'Revert Distillate Infused Ground Flower Pre Roll 2 Pack '
//     150  hr-botanical.revert-preroll-half-g      'Revert Pre Roll <cultivar> .5g'
//     150  hr-botanical.smack-infused-prefix       'SMACK Infused <size> Pre-Roll <cultivar>'
//     150  hr-botanical.smack-uninfused-prefix     'SMACK Uninfused <size> Pre-Roll <cultivar>'
//     100  hr-botanical.juan-roll-dash-last        '#Juan Roll - … - <cultivar>'    (also '#JUAN-ROLL')
//     100  hr-botanical.ichi-roll-dash-last        'Ichi Roll - … - <cultivar>'
//      90  hr-botanical.chopsticks-after-2pack     '(Chopsticks|Chopstix) … 2-Pack <cultivar>'
//      90  hr-botanical.o-yeah-after-paren-size    'O-Yeah … (2.5g) <cultivar>'
//      90  hr-botanical.state-of-mind-after-paren  '(STATE OF MIND|State of Mind) … (2.5g) <cultivar>'
//      90  hr-botanical.sushi-hash-after-paren     'Sushi Hash … (2.5g) <cultivar>'
//      90  hr-botanical.sushi-hash-single          'Sushi Hash Single <cultivar>'
//
//   Inputs that none of those rules match still fall through to the
//   reverse-shadow harness's "no-detect" silent legacy fallback (the
//   harness dispatches by detect-prefix, then by parser rule), so a
//   missed shape is logged as a regression instead of crashing.
//
//   The cultivar/groupName/variantName/strainName shaping mirrors the
//   legacy per-brand quirks (e.g. Revert-gummy groupName is
//   '<cultivar> Gummy', strainName is ''; everything else has
//   groupName === strainName === cleanCultivar(<cultivar>)).
//
//   Limitation: the legacy parser pre-normalizes input with
//   .replace('Pre-roll', 'Preroll') and .replace('#JUAN-ROLL', '#Juan Roll')
//   before brand dispatch. We don't reproduce that pre-normalization
//   inside parsekit; instead each affected rule accepts both raw
//   spellings via `choice`/multiple prefixes. Cases that mix the
//   spellings in ways the rules don't anticipate will fall through to
//   legacy.
// ---------------------------------------------------------------------

const REVERT_BRAND = 'Revert Cannabis'

export const hrBotanicalConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'pending-purchases.hr-botanical',
  scope: { tenantId: 'hr-botanical', useCase: 'pending-purchases' },
  dialectRef: { id: 'metrc-v1', version: 1 },
  detect: {
    prefixes: [
      '#Juan Roll',
      '#JUAN-ROLL',
      'Revert ',
      'Ichi Roll',
      'Chopsticks',
      'Chopstix',
      'O-Yeah',
      'SMACK',
      'STATE OF MIND',
      'State of Mind',
      'Sushi Hash',
    ],
  },
  rules: [
    // -- Revert Edible Gummy -----------------------------------------
    {
      id: 'hr-botanical.revert-edible-gummy',
      priority: 200,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Revert Edible Gummy' },
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
                  { kind: 'lit', value: '100mg', caseInsensitive: true },
                ],
              },
            },
          },
          { kind: 'token', token: 'ws' },
          { kind: 'lit', value: '100mg', caseInsensitive: true },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: REVERT_BRAND },
        category: { literal: 'Edibles' },
        groupName: {
          from: 'cultivar',
          transforms: [
            { name: 'cleanCultivar', version: 1 },
            { name: 'append', version: 1, args: { suffix: ' Gummy' } },
          ],
        },
        packCount: { literal: 1 },
        prevalence: { literal: null },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { literal: '100mg' },
        strainName: { literal: '' },
        subcategory: { literal: 'Chews/Gummies' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1, args: { fields: ['brand', 'groupName', 'size'] } },
      ],
      goldens: [],
    },

    // -- Revert Distillate Infused Ground Flower Pre Roll 2 Pack -----
    {
      id: 'hr-botanical.revert-ground-flower-2pack',
      priority: 200,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Revert Distillate Infused Ground Flower Pre Roll 2 Pack' },
          { kind: 'token', token: 'ws' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: REVERT_BRAND },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 2 },
        prevalence: { from: 'cultivar', transforms: [{ name: 'prevalenceFromParen', version: 1 }] },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { literal: '0.5g' },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        subcategory: { literal: 'Infused' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1 },
      ],
      goldens: [],
    },

    // -- Revert Pre Roll <cultivar> .5g ------------------------------
    {
      id: 'hr-botanical.revert-preroll-half-g',
      priority: 150,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Revert Pre Roll' },
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
                      { kind: 'lit', value: '.5g', caseInsensitive: true },
                      { kind: 'lit', value: '0.5g', caseInsensitive: true },
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
              { kind: 'lit', value: '.5g', caseInsensitive: true },
              { kind: 'lit', value: '0.5g', caseInsensitive: true },
            ],
          },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: REVERT_BRAND },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 1 },
        prevalence: { from: 'cultivar', transforms: [{ name: 'prevalenceFromParen', version: 1 }] },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { literal: '0.5g' },
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

    // -- SMACK Infused <size> Pre-Roll <cultivar> --------------------
    {
      id: 'hr-botanical.smack-infused',
      priority: 150,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'SMACK' },
          { kind: 'token', token: 'ws' },
          { kind: 'lit', value: 'Infused', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          { kind: 'capture', name: 'grams', expr: { kind: 'token', token: 'decimal' } },
          { kind: 'lit', value: 'g', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          {
            kind: 'choice',
            items: [
              { kind: 'lit', value: 'Pre-Roll', caseInsensitive: true },
              { kind: 'lit', value: 'Pre Roll', caseInsensitive: true },
              { kind: 'lit', value: 'Preroll', caseInsensitive: true },
            ],
          },
          { kind: 'token', token: 'ws' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Smack' },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 1 },
        prevalence: { from: 'cultivar', transforms: [{ name: 'prevalenceFromParen', version: 1 }] },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { from: 'grams', transforms: [{ name: 'formatGrams', version: 1 }] },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
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

    // -- SMACK Uninfused <size> Pre-Roll <cultivar> ------------------
    {
      id: 'hr-botanical.smack-uninfused',
      priority: 150,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'SMACK' },
          { kind: 'token', token: 'ws' },
          { kind: 'lit', value: 'Uninfused', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          { kind: 'capture', name: 'grams', expr: { kind: 'token', token: 'decimal' } },
          { kind: 'lit', value: 'g', caseInsensitive: true },
          { kind: 'token', token: 'ws' },
          {
            kind: 'choice',
            items: [
              { kind: 'lit', value: 'Pre-Roll', caseInsensitive: true },
              { kind: 'lit', value: 'Pre Roll', caseInsensitive: true },
              { kind: 'lit', value: 'Preroll', caseInsensitive: true },
            ],
          },
          { kind: 'token', token: 'ws' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Smack' },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 1 },
        prevalence: { from: 'cultivar', transforms: [{ name: 'prevalenceFromParen', version: 1 }] },
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

    // -- #Juan Roll / #JUAN-ROLL — split on dash, last segment wins --
    //
    //   Legacy: `cleaned.split('-')` then `parts[parts.length - 1]`,
    //   then cleanCultivar. We use sepBy(cultivarText, dash) and
    //   lastToken to mirror that "last segment wins" semantic.
    //
    //   Subcategory hard-coded to 'Infused' because Juan-Roll dash-last
    //   names in legacy data are dominated by Live Resin / Rosin /
    //   Hash Hole shapes (which legacy detects via input-substring
    //   sniff). Non-infused names will surface as `regression_diff`
    //   in the reverse-shadow UI and can be split off into a new rule
    //   if they prove non-trivial in volume.
    {
      id: 'hr-botanical.juan-roll-dash-last',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          {
            kind: 'choice',
            items: [
              { kind: 'lit', value: '#Juan Roll' },
              { kind: 'lit', value: '#JUAN-ROLL' },
            ],
          },
          { kind: 'token', token: 'dash' },
          {
            kind: 'captureMany',
            name: 'parts',
            expr: {
              kind: 'sepBy',
              min: 1,
              max: 10,
              expr: { kind: 'token', token: 'cultivarText' },
              sep: { kind: 'token', token: 'dash' },
            },
          },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: '#Juan Roll' },
        category: { literal: 'Pre-Rolls' },
        groupName: {
          fromList: 'parts',
          transforms: [
            { name: 'lastToken', version: 1 },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
        packCount: { literal: 1 },
        prevalence: { literal: null },
        searchTerm: {
          fromList: 'parts',
          transforms: [
            { name: 'lastToken', version: 1 },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
        size: { literal: '1g' },
        strainName: {
          fromList: 'parts',
          transforms: [
            { name: 'lastToken', version: 1 },
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

    // -- Ichi Roll — split on dash, last segment wins ----------------
    //   Same dash-last semantic as Juan Roll. Subcategory='' here
    //   because Ichi Roll legacy data trends non-infused.
    {
      id: 'hr-botanical.ichi-roll-dash-last',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Ichi Roll' },
          { kind: 'token', token: 'dash' },
          {
            kind: 'captureMany',
            name: 'parts',
            expr: {
              kind: 'sepBy',
              min: 1,
              max: 10,
              expr: { kind: 'token', token: 'cultivarText' },
              sep: { kind: 'token', token: 'dash' },
            },
          },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Ichi Roll' },
        category: { literal: 'Pre-Rolls' },
        groupName: {
          fromList: 'parts',
          transforms: [
            { name: 'lastToken', version: 1 },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
        packCount: { literal: 1 },
        prevalence: { literal: null },
        searchTerm: {
          fromList: 'parts',
          transforms: [
            { name: 'lastToken', version: 1 },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
        size: { literal: '1g' },
        strainName: {
          fromList: 'parts',
          transforms: [
            { name: 'lastToken', version: 1 },
            { name: 'cleanCultivar', version: 1 },
          ],
        },
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

    // -- Chopsticks/Chopstix — '... 2-Pack <cultivar>' ---------------
    {
      id: 'hr-botanical.chopsticks-after-2pack',
      priority: 90,
      parser: {
        kind: 'seq',
        items: [
          {
            kind: 'choice',
            items: [
              { kind: 'lit', value: 'Chopsticks' },
              { kind: 'lit', value: 'Chopstix' },
            ],
          },
          {
            kind: 'consumeUntil',
            terminator: {
              kind: 'seq',
              items: [
                { kind: 'lit', value: '2-Pack' },
                { kind: 'token', token: 'ws' },
              ],
            },
          },
          { kind: 'lit', value: '2-Pack' },
          { kind: 'token', token: 'ws' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Chopsticks' },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 2 },
        prevalence: { from: 'cultivar', transforms: [{ name: 'prevalenceFromParen', version: 1 }] },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { literal: '0.5g' },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        subcategory: { literal: '' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1 },
      ],
      goldens: [],
    },

    // -- O-Yeah — '... (2.5g) <cultivar>' ----------------------------
    {
      id: 'hr-botanical.o-yeah-after-paren',
      priority: 90,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'O-Yeah' },
          {
            kind: 'consumeUntil',
            terminator: {
              kind: 'seq',
              items: [
                { kind: 'lit', value: '(2.5g)' },
                { kind: 'token', token: 'optWs' },
              ],
            },
          },
          { kind: 'lit', value: '(2.5g)' },
          { kind: 'token', token: 'optWs' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'O-YEAH!' },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 5 },
        prevalence: { from: 'cultivar', transforms: [{ name: 'prevalenceFromParen', version: 1 }] },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { literal: '0.5g' },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        subcategory: { literal: '' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1 },
      ],
      goldens: [],
    },

    // -- State of Mind / STATE OF MIND — '... (2.5g) <cultivar>' -----
    {
      id: 'hr-botanical.state-of-mind-after-paren',
      priority: 90,
      parser: {
        kind: 'seq',
        items: [
          {
            kind: 'choice',
            items: [
              { kind: 'lit', value: 'STATE OF MIND' },
              { kind: 'lit', value: 'State of Mind' },
            ],
          },
          {
            kind: 'consumeUntil',
            terminator: {
              kind: 'seq',
              items: [
                { kind: 'lit', value: '(2.5g)' },
                { kind: 'token', token: 'optWs' },
              ],
            },
          },
          { kind: 'lit', value: '(2.5g)' },
          { kind: 'token', token: 'optWs' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'State of Mind' },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 5 },
        prevalence: { from: 'cultivar', transforms: [{ name: 'prevalenceFromParen', version: 1 }] },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { literal: '0.5g' },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        subcategory: { literal: '' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1 },
      ],
      goldens: [],
    },

    // -- Sushi Hash — '(2.5g) <cultivar>' or 'Single <cultivar>' -----
    {
      id: 'hr-botanical.sushi-hash-after-paren',
      priority: 90,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Sushi Hash' },
          {
            kind: 'consumeUntil',
            terminator: {
              kind: 'seq',
              items: [
                { kind: 'lit', value: '(2.5g)' },
                { kind: 'token', token: 'optWs' },
              ],
            },
          },
          { kind: 'lit', value: '(2.5g)' },
          { kind: 'token', token: 'optWs' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Sushi Hash' },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 5 },
        prevalence: { from: 'cultivar', transforms: [{ name: 'prevalenceFromParen', version: 1 }] },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { literal: '0.5g' },
        strainName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        subcategory: { literal: '' },
        variantTab: { literal: '__placeholder__' },
        variantName: { literal: '__placeholder__' },
      },
      transforms: [
        { name: 'composeVariantTab', version: 1, args: { sizeField: 'size' } },
        { name: 'composeVariantName', version: 1 },
      ],
      goldens: [],
    },
    {
      id: 'hr-botanical.sushi-hash-single',
      priority: 90,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Sushi Hash Single' },
          { kind: 'token', token: 'ws' },
          { kind: 'capture', name: 'cultivar', expr: { kind: 'token', token: 'cultivarText' } },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { literal: 'Sushi Hash' },
        category: { literal: 'Pre-Rolls' },
        groupName: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        packCount: { literal: 1 },
        prevalence: { from: 'cultivar', transforms: [{ name: 'prevalenceFromParen', version: 1 }] },
        searchTerm: { from: 'cultivar', transforms: [{ name: 'cleanCultivar', version: 1 }] },
        size: { literal: '1g' },
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

export const TENANT_CONFIGS: TenantParserConfig[] = [
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
  hrBotanicalConfig,
]
