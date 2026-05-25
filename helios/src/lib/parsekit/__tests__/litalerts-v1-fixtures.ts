/**
 * Parsekit tenant-parser fixture configs for the litalerts-v1 dialect
 * and the LitAlerts use case.
 *
 * Destined to live in the helios-parser-configs repo at
 *   `use-cases/litalerts/parsers/<tenantId>.jsonc`
 * once we cut over from the inline placeholder
 * (`helios/src/shared/marketMatch/listingParse.ts`) to parsekit on
 * the read path. Kept as TypeScript fixtures for now so the
 * `metrc-v1`-style end-to-end test harness can exercise them
 * without dragging an .jsonc loader.
 *
 * Data + pure helpers only — do not add behavior or test
 * scaffolding here.
 */

import { type TenantParserConfig } from '../index.js'

// ---------------------------------------------------------------------
// Tenant: Bayside Cannabis (Queens, NY)
//
// Listing-name shape (observed):
//   "<Brand> - <Description> - <Size>"
//   e.g. "5boro - Fuel Pump Dime Bag - .7g"
//        "Anthem - Hybrid Blend 10pk Prerolls - 3.5g"
//
// listing.brand / listing.category / listing.subcategory are also
// provided by the LitAlerts harvest; the dialect's `parseSize`
// handles `g` / `mg` / `oz` via the `sizeToken` token. This first
// rule covers the dominant "<text> - <text> - <size>g" shape;
// follow-up rules can add multipack-token, ounce, and edible-mg
// variants without changing the contract.
// ---------------------------------------------------------------------

export const baysideCannabisConfig: TenantParserConfig = {
  configVersion: 1,
  parserId: 'litalerts.bayside-cannabis',
  scope: { tenantId: 'bayside-cannabis', useCase: 'litalerts' },
  dialectRef: { id: 'litalerts-v1', version: 1 },
  detect: {},
  rules: [
    {
      id: 'bayside.brand-desc-size',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          {
            kind: 'capture',
            name: 'brand',
            expr: {
              kind: 'consumeUntil',
              terminator: { kind: 'token', token: 'dash' },
            },
          },
          { kind: 'token', token: 'dash' },
          {
            kind: 'capture',
            name: 'description',
            expr: {
              kind: 'consumeUntil',
              terminator: {
                kind: 'seq',
                items: [
                  { kind: 'token', token: 'dash' },
                  { kind: 'token', token: 'sizeToken' },
                  { kind: 'token', token: 'optWs' },
                ],
              },
            },
          },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'size', expr: { kind: 'token', token: 'sizeToken' } },
          { kind: 'token', token: 'optWs' },
        ],
      },
      project: {
        brand: { from: 'brand', transforms: [{ name: 'cleanText', version: 1 }] },
        productLine: { literal: null },
        variantName: { from: 'description', transforms: [{ name: 'cleanText', version: 1 }] },
        category: { literal: 'other' },
        packCount: { literal: 1 },
        unitSize: { from: 'size', transforms: [{ name: 'parseSize', version: 1 }] },
        totalSize: { from: 'size', transforms: [{ name: 'parseSize', version: 1 }] },
        prevalence: { literal: null },
        searchTerm: { literal: null },
      },
      transforms: [],
      goldens: [
        {
          kind: 'match',
          id: 'bayside.5boro-fuel-pump-dime-bag',
          input: '5boro - Fuel Pump Dime Bag - .7g',
          expected: {
            brand: '5boro',
            productLine: null,
            variantName: 'Fuel Pump Dime Bag',
            category: 'other',
            packCount: 1,
            unitSize: { value: 0.7, unit: 'g' },
            totalSize: { value: 0.7, unit: 'g' },
            prevalence: null,
            searchTerm: null,
          },
        },
        {
          kind: 'match',
          id: 'bayside.anthem-hybrid-blend-3.5g',
          input: 'Anthem - Hybrid Blend 10pk Prerolls - 3.5g',
          expected: {
            brand: 'Anthem',
            productLine: null,
            variantName: 'Hybrid Blend 10pk Prerolls',
            category: 'other',
            packCount: 1,
            unitSize: { value: 3.5, unit: 'g' },
            totalSize: { value: 3.5, unit: 'g' },
            prevalence: null,
            searchTerm: null,
          },
        },
        {
          kind: 'match',
          id: 'bayside.bonanza-baja-splash-1g',
          input: 'Bonanza - Baja Splash Cart - 1g',
          expected: {
            brand: 'Bonanza',
            productLine: null,
            variantName: 'Baja Splash Cart',
            category: 'other',
            packCount: 1,
            unitSize: { value: 1, unit: 'g' },
            totalSize: { value: 1, unit: 'g' },
            prevalence: null,
            searchTerm: null,
          },
        },
      ],
    },
  ],
}

/** All in-test tenant configs for the litalerts-v1 dialect. */
export const LITALERTS_TENANT_CONFIGS: TenantParserConfig[] = [baysideCannabisConfig]
