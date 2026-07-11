import { describe, expect, it } from 'vitest'

import {
  MAX_TICKET_REPOSITORIES,
  MAX_TICKET_REPOSITORY_CONTEXT_BYTES,
  TICKET_REPOSITORY_MODEL_CONTEXT,
  isTicketRepository,
  listTicketRepositories,
} from './ticketRepositoryCatalog.js'

const EXPECTED_REPOSITORIES = [
  'virusdave/agent-pain-points',
  'FreshlyBakedNYC/automation',
  'FreshlyBakedNYC/helios-parser-configs',
  'Nicponskis/mostly-static-sites',
  'Nicponskis/nixos-sbc',
  'Nicponskis/shared-workflows',
  'virusdave/task-dag',
  'virusdave/top-level',
  'Nicponskis/github-worker',
]

describe('ticket repository catalog', () => {
  it('pins the reviewed ticket targets seeded from the fleet registry', () => {
    const repositories = listTicketRepositories()
    expect(repositories.map((entry) => entry.repository)).toEqual(EXPECTED_REPOSITORIES)
    expect(new Set(repositories.map((entry) => entry.repository)).size).toBe(repositories.length)
    expect(repositories.length).toBeLessThanOrEqual(MAX_TICKET_REPOSITORIES)
    expect(repositories.every((entry) => entry.description.length > 0)).toBe(true)
  })

  it('caches bounded model context and uses exact case-sensitive membership', () => {
    expect(new TextEncoder().encode(TICKET_REPOSITORY_MODEL_CONTEXT).length)
      .toBeLessThanOrEqual(MAX_TICKET_REPOSITORY_CONTEXT_BYTES)
    expect(JSON.parse(TICKET_REPOSITORY_MODEL_CONTEXT)).toEqual(listTicketRepositories())
    expect(isTicketRepository('FreshlyBakedNYC/automation')).toBe(true)
    expect(isTicketRepository('freshlybakednyc/automation')).toBe(false)
    expect(isTicketRepository('attacker/invented')).toBe(false)
  })

  it('returns independent copies rather than mutable catalog entries', () => {
    const first = listTicketRepositories()
    first[0].description = 'changed by caller'
    expect(listTicketRepositories()[0].description).not.toBe('changed by caller')
  })
})
