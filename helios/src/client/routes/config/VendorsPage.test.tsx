import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { Role, SessionEnvelope, Vendor } from '../../../shared/contracts/index.js'
import {
  MAX_VENDOR_ASSOCIATIONS,
  VendorEditor,
  VendorReadOnlyDetails,
  brandSummaryLabel,
  canEditVendors,
  canSearchVendors,
  distributorSummaryLabel,
  filterVendors,
  findVendorConflict,
  normalizeVendorDraft,
  uniqueBrandCountLabel,
  vendorCountLabel,
  vendorToDraft,
} from './VendorsPage.js'
import { buildConfigSidebarSubtree } from './configSidebarSubtree.js'

function vendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 1,
    name: 'Hudson Supply',
    isMso: false,
    isMicro: true,
    codOnly: true,
    associations: [{
      id: 11,
      brandName: 'North Star',
      isPrimary: true,
      targetDaysOnHand: 21,
      assetUrl: 'https://assets.example.test/north-star',
      codRequired: true,
      codDiscountSource: 'Two percent for payment on delivery',
      minimumOrderDollars: 1250.5,
      comments: 'Order on Tuesday mornings.',
    }],
    observedDistributors: [{
      name: 'Metro Distribution',
      purchaseCount: 4,
      lastDeliveryDate: '2026-03-08',
      siteKeys: ['bronx', 'midtown'],
    }],
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-07-19T12:00:00.000Z',
    ...overrides,
  }
}

function sessionForRole(role: Role): SessionEnvelope {
  return {
    authMode: 'session',
    localDevSignInAvailable: false,
    pendingMigrations: [],
    permissions: {
      canApprove: role === 'approver' || role === 'admin',
      canEditProposals: role !== 'viewer',
      canForceReconcile: role === 'admin',
      canManageUsers: role === 'admin',
      canUndo: role === 'admin',
    },
    runtimeDependencies: [],
    user: {
      active: true,
      email: `${role}@example.com`,
      id: 5,
      metricGrants: [],
      name: role,
      role,
    },
  }
}

describe('vendor draft normalization', () => {
  it('builds the complete atomic association payload and normalizes blank values', () => {
    const draft = vendorToDraft(vendor())
    draft.name = '  Hudson Supply  '
    draft.associations[0]!.targetDaysOnHand = '30'
    draft.associations[0]!.minimumOrderDollars = ' 1500.25 '
    draft.associations[0]!.assetUrl = '   '
    draft.associations[0]!.codRequired = 'false'

    expect(normalizeVendorDraft(draft)).toEqual({
      input: {
        name: 'Hudson Supply',
        isMso: false,
        isMicro: true,
        codOnly: true,
        associations: [{
          brandName: 'North Star',
          isPrimary: true,
          targetDaysOnHand: 30,
          assetUrl: null,
          codRequired: false,
          codDiscountSource: 'Two percent for payment on delivery',
          minimumOrderDollars: 1500.25,
          comments: 'Order on Tuesday mornings.',
        }],
      },
      errors: {},
    })
  })

  it('returns field-addressable errors instead of a mutation payload', () => {
    const draft = vendorToDraft(vendor())
    draft.name = ''
    draft.associations[0]!.targetDaysOnHand = '1.5'
    const result = normalizeVendorDraft(draft)
    expect(result.input).toBeNull()
    expect(result.errors.name).toBeDefined()
    expect(result.errors['associations.0.targetDaysOnHand']).toBeDefined()
  })
})

describe('loaded-vendor conflict checks', () => {
  it('finds case-insensitive vendor names and primary-brand owners', () => {
    const existing = vendor()
    const duplicateName = normalizeVendorDraft({ ...vendorToDraft(), name: 'HUDSON SUPPLY' }).input!
    expect(findVendorConflict(duplicateName, [existing], null)).toMatchObject({
      fieldPath: 'name',
      vendorId: existing.id,
    })

    const primaryDraft = vendorToDraft(vendor({ id: 2, name: 'Other Vendor' }))
    const primaryInput = normalizeVendorDraft(primaryDraft).input!
    expect(findVendorConflict(primaryInput, [existing], 2)).toMatchObject({
      fieldPath: 'associations.0.isPrimary',
      vendorId: existing.id,
    })
  })

  it('excludes the vendor currently being edited', () => {
    const existing = vendor()
    const input = normalizeVendorDraft(vendorToDraft(existing)).input!
    expect(findVendorConflict(input, [existing], existing.id)).toBeNull()
  })
})

describe('vendor directory presentation', () => {
  it('searches vendor, brand, and observed distributor names', () => {
    const row = vendor()
    expect(filterVendors([row], 'hudson')).toEqual([row])
    expect(filterVendors([row], 'north star')).toEqual([row])
    expect(filterVendors([row], 'metro distribution')).toEqual([row])
    expect(filterVendors([row], 'missing')).toEqual([])
  })

  it('bounds collapsed summaries and labels capped distributor results honestly', () => {
    const row = vendor({
      associations: ['A', 'B', 'C', 'D', 'E'].map((brandName, index) => ({
        ...vendor().associations[0]!, id: index + 1, brandName,
      })),
      observedDistributors: Array.from({ length: 20 }, (_, index) => ({
        name: `Distributor ${index}`,
        purchaseCount: 1,
        lastDeliveryDate: null,
        siteKeys: [],
      })),
    })
    expect(brandSummaryLabel(row)).toBe('A, B, C +2 more')
    expect(distributorSummaryLabel(row)).toBe('20+ observed distributors')
  })

  it('uses singular and lower-bound count labels accurately', () => {
    expect(vendorCountLabel(1)).toBe('1 vendor')
    expect(vendorCountLabel(500)).toBe('500+ vendors')
    expect(vendorCountLabel(501)).toBe('501+ vendors')
    expect(uniqueBrandCountLabel(1)).toBe('1 unique brand loaded')
  })

  it('renders every read-only association field and preserves the delivery calendar date', () => {
    const html = renderToStaticMarkup(<VendorReadOnlyDetails vendor={vendor()} />)
    expect(html).toContain('North Star')
    expect(html).toContain('primary vendor')
    expect(html).toContain('21')
    expect(html).toContain('$1,250.50')
    expect(html).toContain('Required')
    expect(html).toContain('Two percent for payment on delivery')
    expect(html).toContain('https://assets.example.test/north-star')
    expect(html).toContain('Order on Tuesday mornings.')
    expect(html).toContain('Metro Distribution')
    expect(html).toContain('Mar 8, 2026')
    expect(html).toContain('bronx')
    expect(html).toContain('midtown')
  })

  it('registers the canonical Purchasing > Vendors navigation leaf', () => {
    const purchasing = buildConfigSidebarSubtree().find((node) => node.navKey === 'config.purchasing')
    expect(purchasing).toMatchObject({
      kind: 'branch',
      label: 'Purchasing',
      children: [{
        kind: 'leaf',
        navKey: 'config.purchasing.vendors',
        label: 'Vendors',
        to: '/config/vendors',
      }],
    })
  })

  it('keeps viewer and unresolved sessions read-only while permitting every editor role', () => {
    expect(canEditVendors(undefined)).toBe(false)
    expect(canEditVendors(sessionForRole('viewer'))).toBe(false)
    expect(canEditVendors(sessionForRole('editor'))).toBe(true)
    expect(canEditVendors(sessionForRole('approver'))).toBe(true)
    expect(canEditVendors(sessionForRole('admin'))).toBe(true)
  })

  it('keeps search from hiding an active create or edit form', () => {
    expect(canSearchVendors(null)).toBe(true)
    expect(canSearchVendors({ kind: 'create' })).toBe(false)
    expect(canSearchVendors({ kind: 'edit', vendorId: 1 })).toBe(false)
  })

  it('renders and focuses the association-level cap instead of allowing a hidden 301st row', () => {
    const baseAssociation = vendorToDraft(vendor()).associations[0]!
    const draft = {
      ...vendorToDraft(vendor()),
      associations: Array.from({ length: MAX_VENDOR_ASSOCIATIONS }, (_, index) => ({
        ...baseAssociation,
        key: `association-${index}`,
        brandName: `Brand ${index}`,
      })),
    }
    const html = renderToStaticMarkup(
      <VendorEditor
        draft={draft}
        errors={{ associations: 'A vendor can contain at most 300 brands.' }}
        busy={false}
        unchanged={false}
        conflict={null}
        submitLabel="Save vendor"
        onChange={() => undefined}
        onCancel={() => undefined}
        onOpenConflict={() => undefined}
        onSubmit={() => undefined}
      />,
    )
    expect(html).toContain('300 of 300')
    expect(html).toContain('A vendor can contain at most 300 brands.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add brand<\/button>/)
  })
})
