/**
 * Parsekit dispatch + ParsedListing adapter for the LitAlerts
 * use case. Used by the /config/parsing/litalerts read path and
 * by any other code that wants to swap the inline placeholder
 * (`shared/marketMatch/listingParse.ts`) for the runtime
 * tenant-config parser when one is loaded for a competitor.
 *
 * Contract:
 *   - If no parser-configs release is loaded, OR the competitor
 *     has no tenant config, OR the tenant parser fails on this
 *     input, we return `null`. Callers fall back to the placeholder
 *     (`parseListingToFuzzy`) so the read path always produces a
 *     ParsedListing — we never block the UI on parsekit.
 *   - When a tenant parser succeeds, we adapt the
 *     FuzzyVariantDescriptor it emits down to the smaller
 *     ParsedListing shape the UI currently consumes. Adding new
 *     fields to ParsedListing later means widening this adapter,
 *     NOT widening every caller of parseListingToFuzzy.
 */

import { parseWith } from '../../lib/parsekit/engine.js'
import { getParserRegistry } from '../../lib/parsekit/node/parserRegistry.js'
import type {
  FuzzyVariantDescriptor,
} from '../../lib/parsekit/contracts/litalerts.js'
import type { CompiledRelease } from '../../lib/parsekit/types.js'
import type { ParsedListing } from '../../shared/marketMatch/listingParse.js'

const USE_CASE = 'litalerts'

export interface ParsekitParseAttempt {
  /** Adapted ParsedListing if the tenant parser succeeded. */
  parsed: ParsedListing | null
  /** parserId we tried, or `null` if no config matched the competitor. */
  parserId: string | null
  /** release sha at the time of the attempt, or `null` if no registry release. */
  snapshotSha: string | null
  /** Free-form reason when `parsed === null`. Useful for the UI debug strip. */
  reason: 'no_registry' | 'no_tenant_config' | 'parse_failed' | null
  /** Diagnostic detail when reason === 'parse_failed'. */
  failureDetail?: string
}

/**
 * Slugify a competitor display name into a parsekit tenant id.
 * Mirrors the convention used in the parser-configs repo
 * (`use-cases/litalerts/parsers/<tenant-slug>.jsonc`).
 *
 * Examples:
 *   "Bayside Cannabis"           -> "bayside-cannabis"
 *   "Long Island Cannabis Club"  -> "long-island-cannabis-club"
 *   "ZenZest - Queens"           -> "zenzest-queens"
 */
export function dispensaryToTenantId(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Look up a parsekit tenant parser for a competitor and attempt to
 * parse a single listing name. Returns a structured result so callers
 * can both consume the parsed output AND surface what happened in
 * debug UIs.
 */
export function tryParseLitalertsListing(
  dispensaryName: string | null | undefined,
  listingName: string | null | undefined,
): ParsekitParseAttempt {
  const release = getParserRegistry().current()
  if (!release) {
    return { parsed: null, parserId: null, snapshotSha: null, reason: 'no_registry' }
  }
  const cleanedListingName = (listingName ?? '').trim()
  if (cleanedListingName.length === 0) {
    return {
      parsed: null,
      parserId: null,
      snapshotSha: release.sha,
      reason: 'no_tenant_config',
    }
  }
  const tenantId = dispensaryToTenantId(dispensaryName ?? '')
  const parserId = `${USE_CASE}.${tenantId}`
  const parser = findTenantParser(release, parserId)
  if (!parser) {
    return {
      parsed: null,
      parserId: null,
      snapshotSha: release.sha,
      reason: 'no_tenant_config',
    }
  }

  let result
  try {
    result = parseWith(parser, cleanedListingName, { snapshotSha: release.sha })
  } catch (err) {
    return {
      parsed: null,
      parserId,
      snapshotSha: release.sha,
      reason: 'parse_failed',
      failureDetail: `threw: ${errMessage(err)}`,
    }
  }
  if (!result.ok) {
    return {
      parsed: null,
      parserId,
      snapshotSha: release.sha,
      reason: 'parse_failed',
      failureDetail: result.diagnostics?.length
        ? result.diagnostics.map((d) => `${d.ruleId || '-'}=${d.reason}`).join('; ')
        : result.reason,
    }
  }
  return {
    parsed: descriptorToParsedListing(result.output as FuzzyVariantDescriptor),
    parserId,
    snapshotSha: release.sha,
    reason: null,
  }
}

function findTenantParser(release: CompiledRelease, parserId: string) {
  const parser = release.parsers.get(parserId)
  if (!parser) return null
  if (parser.config.scope.useCase !== USE_CASE) return null
  return parser
}

/**
 * Adapter from the rich parsekit FuzzyVariantDescriptor shape down
 * to the smaller ParsedListing the existing read path consumes.
 */
export function descriptorToParsedListing(
  d: FuzzyVariantDescriptor,
): ParsedListing {
  const total = d.totalSize
  return {
    brandNorm: d.brand,
    categoryNorm: d.category,
    subcategoryNorm: null,
    sizeGNorm: total.unit === 'g' ? total.value : null,
    sizeMgNorm: total.unit === 'mg' ? total.value : null,
    packCountNorm: d.packCount,
    strainNorm: d.variantName ?? d.productLine ?? null,
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
