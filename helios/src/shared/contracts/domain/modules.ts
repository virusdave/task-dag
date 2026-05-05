import { z } from 'zod'

export const HELIOS_MODULE_CODES = ['catalog', 'screens', 'crm', 'communications', 'pricing', 'scheduling', 'utilities', 'config'] as const
export const HeliosModuleCodeSchema = z.enum(HELIOS_MODULE_CODES)
export type HeliosModuleCode = z.infer<typeof HeliosModuleCodeSchema>

export const HeliosModuleRolloutStatusSchema = z.enum(['active', 'planned'])
export type HeliosModuleRolloutStatus = z.infer<typeof HeliosModuleRolloutStatusSchema>

export const HeliosModuleScopeSchema = z.object({
  entityId: z.string().trim().min(1),
  entityType: z.string().trim().min(1),
})
export type HeliosModuleScope = z.infer<typeof HeliosModuleScopeSchema>

export const HeliosModuleDefinitionSchema = z.object({
  code: HeliosModuleCodeSchema,
  label: z.string().trim().min(1),
  routePrefix: z.string().trim().min(1),
  rolloutStatus: HeliosModuleRolloutStatusSchema,
  summary: z.string().trim().min(1),
})
export type HeliosModuleDefinition = z.infer<typeof HeliosModuleDefinitionSchema>

export const HELIOS_MODULES: ReadonlyArray<HeliosModuleDefinition> = [
  {
    code: 'catalog',
    label: 'Catalog',
    routePrefix: 'catalog',
    rolloutStatus: 'active',
    summary: 'Review, mirror, reconcile, LLM rerun, jobs, and audit workflows are now live inside Helios.',
  },
  {
    code: 'screens',
    label: 'Screens',
    routePrefix: 'screens',
    rolloutStatus: 'active',
    summary: 'Banner refresh, chained banner-health maintenance, healthy-banner enable sweeps, Bronx-to-Midtown image fallback clone, and Midtown promo rebinding workflows now queue through Helios jobs and audit surfaces.',
  },
  {
    code: 'crm',
    label: 'CRM & Segments',
    routePrefix: 'crm',
    rolloutStatus: 'planned',
    summary: 'Planned migration for customer segmentation and CRM sync with data provenance, job history, and review outputs.',
  },
  {
    code: 'communications',
    label: 'Ads',
    routePrefix: 'communications',
    rolloutStatus: 'active',
    summary: 'Google Ads review surfaces (currently the policy-limited asset replacement review) live in Helios with server-persisted reviewer drafts and append-only audit. Live Google Ads mutates still run through a separate narrow resolver pass after review submission.',
  },
  {
    code: 'pricing',
    label: 'Pricing',
    routePrefix: 'pricing',
    rolloutStatus: 'active',
    summary: 'Dedicated pricing run generation, run history, and pricing-specific review now sit on top of the shared proposal, job, and reconcile model.',
  },
  {
    code: 'scheduling',
    label: 'Scheduling',
    routePrefix: 'scheduling',
    rolloutStatus: 'active',
    summary: 'Employee schedule runs now queue through Helios with Mantle-based constraint extraction, human review of normalized inputs, and candidate schedule comparison before approval.',
  },
  {
    code: 'utilities',
    label: 'Utilities',
    routePrefix: 'utilities',
    rolloutStatus: 'planned',
    summary: 'Planned migration for high-frequency one-off utilities that should become typed Helios worker entrypoints.',
  },
  {
    code: 'config',
    label: 'Config',
    routePrefix: 'config',
    rolloutStatus: 'active',
    summary: 'Operator-editable Helios configuration: background worker schedules and other meta-settings that drive recurring Helios behavior.',
  },
]

export function getHeliosModuleDefinition(code: HeliosModuleCode): HeliosModuleDefinition {
  const moduleDefinition = HELIOS_MODULES.find((candidate) => candidate.code === code)
  if (!moduleDefinition) {
    throw new Error(`Unknown Helios module: ${code}`)
  }

  return moduleDefinition
}

export function buildHeliosModulePath(code: HeliosModuleCode, childPath?: string): string {
  const { routePrefix } = getHeliosModuleDefinition(code)
  if (!childPath) {
    return `/${routePrefix}`
  }

  return `/${routePrefix}/${childPath.replace(/^\/+/, '')}`
}

export function buildCatalogGroupModuleScope(catalogGroupId: number): HeliosModuleScope {
  return {
    entityId: String(catalogGroupId),
    entityType: 'catalog_group',
  }
}

export function parseCatalogGroupIdFromModuleScope(
  module: HeliosModuleCode,
  scope: HeliosModuleScope | null | undefined,
): number | null {
  if (module !== 'catalog' || scope?.entityType !== 'catalog_group') {
    return null
  }

  const catalogGroupId = Number(scope.entityId)
  if (!Number.isInteger(catalogGroupId) || catalogGroupId <= 0) {
    return null
  }

  return catalogGroupId
}
