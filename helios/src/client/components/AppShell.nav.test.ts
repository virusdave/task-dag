import { describe, expect, it } from 'vitest'

import type { MetricGrantKey, Role } from '../../shared/contracts/domain/auth.js'
import type { SessionEnvelope } from '../../shared/contracts/index.js'
import { getPermissionsForRole } from '../../shared/domain/permissions.js'
import { buildPrimarySidebarNodes } from './AppShell.js'
import type { TreeNavNode } from './TreeNav.js'

// Admin-gated navbar entry for the agent-waste review queue (issue #57).
// The page + its server API are independently admin-gated; the nav entry
// is discoverability, so it must appear ONLY for admins.

function sessionForRole(role: Role | null): SessionEnvelope {
  return {
    authMode: role ? 'session' : 'anonymous',
    localDevSignInAvailable: false,
    pendingMigrations: [],
    permissions: getPermissionsForRole(role),
    runtimeDependencies: [],
    user: null,
  }
}

function viewerWithMetricGrants(metricGrants: MetricGrantKey[]): SessionEnvelope {
  return {
    ...sessionForRole('viewer'),
    user: {
      active: true,
      email: 'viewer@example.com',
      id: 1,
      metricGrants,
      name: 'Inventory Viewer',
      role: 'viewer',
    },
  }
}

function findByNavKey(nodes: TreeNavNode[], navKey: string): TreeNavNode | undefined {
  for (const node of nodes) {
    if (node.navKey === navKey) {
      return node
    }
    if (node.kind === 'branch') {
      const found = findByNavKey(node.children, navKey)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

describe('buildPrimarySidebarNodes — agent-waste review queue nav entry (#57)', () => {
  it('shows the admin-gated Waste review queue leaf for an admin', () => {
    const nodes = buildPrimarySidebarNodes({}, sessionForRole('admin'))
    const leaf = findByNavKey(nodes, 'config.agents.waste-review')
    expect(leaf).toBeDefined()
    expect(leaf?.kind).toBe('leaf')
    expect(leaf && leaf.kind === 'leaf' ? leaf.to : undefined).toBe('/config/agent-waste')
    // Nested under an Agents group inside Admin & Config.
    expect(findByNavKey(nodes, 'config.agents')).toBeDefined()
  })

  it('hides the leaf for a non-admin (viewer)', () => {
    const nodes = buildPrimarySidebarNodes({}, sessionForRole('viewer'))
    expect(findByNavKey(nodes, 'config.agents.waste-review')).toBeUndefined()
    expect(findByNavKey(nodes, 'config.agents')).toBeUndefined()
  })

  it('hides the leaf while the session is still loading (null)', () => {
    const nodes = buildPrimarySidebarNodes({}, null)
    expect(findByNavKey(nodes, 'config.agents.waste-review')).toBeUndefined()
  })
})

// Admin-gated navbar entry for the pending-migrations "Apply Now" page
// (automation#62, leaf 7). Same discoverability-not-access-control rule as
// the agent-waste queue: the page + both server APIs are independently
// admin-gated, so the nav entry must appear ONLY for admins.
describe('buildPrimarySidebarNodes — pending-migrations nav entry (#62)', () => {
  it('shows the admin-gated Pending migrations leaf for an admin', () => {
    const nodes = buildPrimarySidebarNodes({}, sessionForRole('admin'))
    const leaf = findByNavKey(nodes, 'config.database.pending-migrations')
    expect(leaf).toBeDefined()
    expect(leaf?.kind).toBe('leaf')
    expect(leaf && leaf.kind === 'leaf' ? leaf.to : undefined).toBe('/config/pending-migrations')
    // Nested under a Database group inside Admin & Config.
    expect(findByNavKey(nodes, 'config.database')).toBeDefined()
  })

  it('hides the leaf for a non-admin (viewer)', () => {
    const nodes = buildPrimarySidebarNodes({}, sessionForRole('viewer'))
    expect(findByNavKey(nodes, 'config.database.pending-migrations')).toBeUndefined()
    expect(findByNavKey(nodes, 'config.database')).toBeUndefined()
  })

  it('hides the leaf while the session is still loading (null)', () => {
    const nodes = buildPrimarySidebarNodes({}, null)
    expect(findByNavKey(nodes, 'config.database.pending-migrations')).toBeUndefined()
  })
})

describe('buildPrimarySidebarNodes — low-inventory site navigation', () => {
  it('provides direct Bronx and Midtown routes to a user with the reordering grant', () => {
    const nodes = buildPrimarySidebarNodes({}, viewerWithMetricGrants(['reordering']))
    expect(findByNavKey(nodes, 'catalog.low-inventory.bronx')).toMatchObject({
      kind: 'leaf',
      to: '/catalog/inventory/low/bronx',
    })
    expect(findByNavKey(nodes, 'catalog.low-inventory.midtown')).toMatchObject({
      kind: 'leaf',
      to: '/catalog/inventory/low/midtown',
    })
  })

  it('hides both routes from a viewer without the reordering grant', () => {
    const nodes = buildPrimarySidebarNodes({}, viewerWithMetricGrants([]))
    expect(findByNavKey(nodes, 'catalog.low-inventory.bronx')).toBeUndefined()
    expect(findByNavKey(nodes, 'catalog.low-inventory.midtown')).toBeUndefined()
  })
})
