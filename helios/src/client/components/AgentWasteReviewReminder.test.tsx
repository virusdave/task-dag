// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionEnvelope } from '../../shared/contracts/index.js'
import { getPermissionsForRole } from '../../shared/domain/permissions.js'

const mocks = vi.hoisted(() => ({
  backlog: vi.fn(),
  session: null as SessionEnvelope | null,
}))

vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: '/catalog/warehouse-locations' }),
  useRouteLoaderData: () => mocks.session,
}))
vi.mock('../routes/config/agentWasteReviewShared.js', () => ({
  fetchAgentWasteBacklog: mocks.backlog,
}))

import { AgentWasteReviewReminder } from './AgentWasteReviewReminder.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function session(role: 'editor' | 'admin', canManageUsers: boolean): SessionEnvelope {
  return {
    authMode: 'session',
    localDevSignInAvailable: false,
    pendingMigrations: [],
    permissions: { ...getPermissionsForRole(role), canManageUsers },
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

describe('AgentWasteReviewReminder', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    localStorage.clear()
    mocks.backlog.mockReset()
    mocks.backlog.mockResolvedValue({
      observations: [
        {
          estimated_wasted_seconds: 60,
          estimated_wasted_tokens: 1_000,
          id: 'observation-1',
          kind: 'duplicate-work',
          time: new Date().toISOString(),
        },
      ],
      source: { available: true, detail: 'test' },
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    mocks.session = null
  })

  it('uses admin role identity rather than canManageUsers capability', async () => {
    mocks.session = session('editor', true)
    await act(async () => root.render(<AgentWasteReviewReminder />))
    expect(mocks.backlog).not.toHaveBeenCalled()
    expect(host.textContent).toBe('')

    mocks.session = session('admin', false)
    await act(async () => root.render(<AgentWasteReviewReminder />))
    await act(async () => Promise.resolve())
    expect(mocks.backlog).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('agent-waste queue')
  })
})
