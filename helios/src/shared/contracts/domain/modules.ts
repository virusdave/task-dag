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

// Top-level nav order matches the operator-facing IA in the AppShell:
//   [Ads, Catalog, CRM, Screens, Scheduling, Utilities, Config]
// Pricing is still a routed module (its existing /pricing/* pages keep
// working and audit/job rows still carry module='pricing') but it is
// rendered as a SUB-section of Catalog in the sidebar rather than as
// its own top-level branch — pricing is just one of the things a
// catalog reviewer does. The AppShell explicitly skips the 'pricing'
// entry when building the top-level branch list; catalog's sidebar
// subtree (catalogSidebarSubtree.ts) registers the New run / Run
// history / Review queue leaves under the Catalog branch instead.
export const HELIOS_MODULES: ReadonlyArray<HeliosModuleDefinition> = [
  {
    code: 'communications',
    label: 'Ads',
    routePrefix: 'communications',
    rolloutStatus: 'active',
    summary: 'Google Ads review surfaces (currently the policy-limited asset replacement review) live in Helios with server-persisted reviewer drafts and append-only audit. Live Google Ads mutates still run through a separate narrow resolver pass after review submission.',
  },
  {
    code: 'catalog',
    label: 'Catalog',
    routePrefix: 'catalog',
    rolloutStatus: 'active',
    summary: 'Review, mirror, reconcile, LLM rerun, pricing runs, jobs, and audit workflows are now live inside Helios.',
  },
  {
    code: 'crm',
    label: 'CRM & Segments',
    routePrefix: 'crm',
    rolloutStatus: 'planned',
    summary: 'Planned migration for customer segmentation and CRM sync with data provenance, job history, and review outputs.',
  },
  {
    code: 'screens',
    label: 'Screens',
    routePrefix: 'screens',
    rolloutStatus: 'active',
    summary: 'Banner refresh, chained banner-health maintenance, healthy-banner enable sweeps, Bronx-to-Midtown image fallback clone, and Midtown promo rebinding workflows now queue through Helios jobs and audit surfaces.',
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
    rolloutStatus: 'active',
    summary: 'Cross-cutting operator utilities that do not fit cleanly inside the other Helios modules. Currently: Staff (editorial approve/reject for the public Meet The Team surface).',
  },
  {
    code: 'config',
    label: 'Config',
    routePrefix: 'config',
    rolloutStatus: 'active',
    summary: 'Operator-editable Helios configuration: background worker schedules and other meta-settings that drive recurring Helios behavior.',
  },
  // Pricing is intentionally last and is hidden from the top-level
  // sidebar (see AppShell.tsx). Its routes still live at /pricing/*
  // and existing audit/job rows still validate against the module
  // enum, so removing it from HELIOS_MODULE_CODES would be breaking.
  {
    code: 'pricing',
    label: 'Pricing',
    routePrefix: 'pricing',
    rolloutStatus: 'active',
    summary: 'Pricing run generation, run history, and pricing review. Rendered under Catalog in the sidebar — pricing is a catalog reviewer workflow.',
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
