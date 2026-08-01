// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PermissionSet, Role, SessionEnvelope } from '../../shared/contracts/index.js'
import { getPermissionsForRole } from '../../shared/domain/permissions.js'
import { PendingMigrationsBanner } from './PendingMigrationsBanner.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function session(role: Role, permissions: PermissionSet = getPermissionsForRole(role)): SessionEnvelope {
  return {
    authMode: 'session',
    localDevSignInAvailable: false,
    pendingMigrations: [{ migrationId: '099', label: 'Operator-only migration' }],
    permissions,
    runtimeDependencies: [],
    user: {
      active: true,
      email: `${role}@example.com`,
      id: 1,
      metricGrants: [],
      name: `${role} user`,
      role,
    },
  }
}

describe('PendingMigrationsBanner', () => {
  let host: HTMLDivElement
  let root: Root
  const fetchMock = vi.fn()

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    sessionStorage.clear()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(session('admin')), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders initial admin data before the first poll resolves', async () => {
    let resolveFetch: ((response: Response) => void) | null = null
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      }),
    )
    await act(async () => root.render(<PendingMigrationsBanner session={session('admin')} />))
    expect(host.textContent).toContain('Database is behind this Helios build')
    expect(host.textContent).toContain('Operator-only migration')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFetch?.(
        new Response(JSON.stringify({ ...session('admin'), pendingMigrations: [] }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
      await Promise.resolve()
    })
    expect(host.textContent).toBe('')
  })

  it('polls for admin updates every 300 seconds', async () => {
    vi.useFakeTimers()
    await act(async () => root.render(<PendingMigrationsBanner session={session('admin')} />))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(300_000))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stays hidden for an admin with no pending migrations', async () => {
    const empty = { ...session('admin'), pendingMigrations: [] }
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(empty), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    )
    await act(async () => root.render(<PendingMigrationsBanner session={empty} />))
    expect(host.textContent).toBe('')
  })

  it.each(['viewer', 'editor', 'approver'] as const)(
    'does not render or fetch for a %s even if canManageUsers is true',
    async (role) => {
      const contradictory = {
        ...getPermissionsForRole(role),
        canManageUsers: true,
      }
      await act(async () =>
        root.render(<PendingMigrationsBanner session={session(role, contradictory)} />),
      )
      expect(host.textContent).toBe('')
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('does not render or fetch for an anonymous session', async () => {
    const anonymous: SessionEnvelope = {
      ...session('viewer'),
      authMode: 'anonymous',
      permissions: getPermissionsForRole(null),
      user: null,
    }
    await act(async () => root.render(<PendingMigrationsBanner session={anonymous} />))
    expect(host.textContent).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
