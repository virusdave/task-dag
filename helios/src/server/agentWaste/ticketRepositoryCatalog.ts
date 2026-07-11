import { AgentWasteTicketRepositorySchema } from '../../shared/contracts/api/agentWaste.js'

/**
 * Curated ticket targets seeded from the fleet inventory at
 * virusdave/top-level:scripts/ephemeral_checkout.d/repos.conf. This is not a
 * clone registry: the descriptions are Helios-owned drafting guidance, and
 * upstream additions must be reviewed here before a model may select them.
 */
const CATALOG_INPUT = [
  { repository: 'virusdave/agent-pain-points', description: 'Agent runtime pain-point observations, reviewed advisories, and waste-reduction guidance.' },
  { repository: 'FreshlyBakedNYC/automation', description: 'Helios, store automation, operational dashboards, and business workflows.' },
  { repository: 'FreshlyBakedNYC/helios-parser-configs', description: 'Versioned parser configurations consumed by Helios.' },
  { repository: 'Nicponskis/mostly-static-sites', description: 'Public websites, content, and static-site publishing.' },
  { repository: 'Nicponskis/nixos-sbc', description: 'NixOS fleet configuration, hosts, services, secrets wiring, and deployment packages.' },
  { repository: 'Nicponskis/shared-workflows', description: 'Reusable GitHub Actions workflows shared across repositories.' },
  { repository: 'virusdave/task-dag', description: 'Canonical Git-backed task graph CLI, workflows, and task lifecycle invariants.' },
  { repository: 'virusdave/top-level', description: 'Fleet-wide canon, runtime guidance, repository registry, designs, and runbooks.' },
  { repository: 'Nicponskis/github-worker', description: 'GitHub task dispatcher, prepared workspaces, guardrails, and agent-waste recording.' },
] as const

export const MAX_TICKET_REPOSITORIES = 16
export const MAX_TICKET_REPOSITORY_CONTEXT_BYTES = 8 * 1024
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,38})\/[A-Za-z0-9_.-]+$/u

if (CATALOG_INPUT.length > MAX_TICKET_REPOSITORIES) {
  throw new Error(`Ticket repository catalog exceeds ${MAX_TICKET_REPOSITORIES} entries.`)
}

const seen = new Set<string>()
const catalog = Object.freeze(
  CATALOG_INPUT.map((entry) => {
    const parsed = AgentWasteTicketRepositorySchema.parse(entry)
    if (!REPOSITORY_PATTERN.test(parsed.repository)) {
      throw new Error(`Invalid ticket repository slug: ${parsed.repository}`)
    }
    if (seen.has(parsed.repository)) {
      throw new Error(`Duplicate ticket repository slug: ${parsed.repository}`)
    }
    seen.add(parsed.repository)
    return Object.freeze(parsed)
  }),
)

const allowedRepositories = new Set(catalog.map((entry) => entry.repository))

/** Cached once because every draft sends this same bounded context. */
export const TICKET_REPOSITORY_MODEL_CONTEXT = JSON.stringify(catalog)
if (new TextEncoder().encode(TICKET_REPOSITORY_MODEL_CONTEXT).length > MAX_TICKET_REPOSITORY_CONTEXT_BYTES) {
  throw new Error(`Ticket repository model context exceeds ${MAX_TICKET_REPOSITORY_CONTEXT_BYTES} bytes.`)
}

export function listTicketRepositories() {
  return catalog.map((entry) => ({ ...entry }))
}

export function isTicketRepository(repository: string): boolean {
  return allowedRepositories.has(repository)
}
