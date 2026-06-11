// Compile loose config inputs into validated, seo_bundle_id-stamped
// content artifacts (widgets/content/policy/assets/sitemaps.json). The
// pure, in-memory half of the SEO publisher (parent EPIC_PLAN §5, P1);
// publish.ts adds signing, checksums, and the atomic pointer.

import {
  AssetsSchema,
  ContentSchema,
  PolicySchema,
  SitemapsSchema,
  WidgetsSchema,
  type Assets,
  type Content,
  type DisabledContent,
  type Policy,
  type SeoSite,
  type Sitemaps,
  type Widgets,
} from './contracts.js'
import { checkSeoConsistency } from './consistency.js'
import { newSeoBundleId } from './ids.js'
import type { z } from 'zod'

export interface CompileInput {
  readonly sites: Record<string, SeoSite>
  readonly widgets: ReadonlyArray<Widgets['widgets'][number]>
  readonly content: Pick<Content, 'faq_sets' | 'posts' | 'related_link_sets' | 'heads'>
  readonly policy: Pick<Policy, 'seo_policy_version_id' | 'selection_algorithm_version' | 'rules'>
  readonly assets: ReadonlyArray<Assets['assets'][number]>
  readonly sitemaps: ReadonlyArray<Sitemaps['urls'][number]>
  readonly disabledContent?: readonly DisabledContent[]
  readonly seoBundleId?: string
  readonly now?: Date
}

export interface CompiledSeoBundle {
  readonly seoBundleId: string
  readonly sites: Record<string, SeoSite>
  readonly widgets: Widgets
  readonly content: Content
  readonly policy: Policy
  readonly assets: Assets
  readonly sitemaps: Sitemaps
}

export class SeoCompileError extends Error {
  constructor(public readonly problems: string[]) {
    super(`SEO bundle compile failed:\n  - ${problems.join('\n  - ')}`)
    this.name = 'SeoCompileError'
  }
}

export function compileSeoBundle(input: CompileInput): CompiledSeoBundle {
  const seoBundleId = input.seoBundleId ?? newSeoBundleId(input.now)

  const widgetsParsed = WidgetsSchema.safeParse({
    schema: 'freshlybaked.seo.widgets.v1',
    seo_bundle_id: seoBundleId,
    widgets: input.widgets,
  })
  const contentParsed = ContentSchema.safeParse({
    schema: 'freshlybaked.seo.content.v1',
    seo_bundle_id: seoBundleId,
    faq_sets: input.content.faq_sets,
    posts: input.content.posts,
    related_link_sets: input.content.related_link_sets,
    heads: input.content.heads,
  })
  const policyParsed = PolicySchema.safeParse({
    schema: 'freshlybaked.seo.policy.v1',
    seo_policy_version_id: input.policy.seo_policy_version_id,
    selection_algorithm_version: input.policy.selection_algorithm_version,
    rules: input.policy.rules,
  })
  const assetsParsed = AssetsSchema.safeParse({
    schema: 'freshlybaked.seo.assets.v1',
    seo_bundle_id: seoBundleId,
    assets: input.assets,
  })
  const sitemapsParsed = SitemapsSchema.safeParse({
    schema: 'freshlybaked.seo.sitemaps.v1',
    seo_bundle_id: seoBundleId,
    urls: input.sitemaps,
  })

  const problems: string[] = []
  if (!widgetsParsed.success) problems.push(...zodProblems('widgets', widgetsParsed.error))
  if (!contentParsed.success) problems.push(...zodProblems('content', contentParsed.error))
  if (!policyParsed.success) problems.push(...zodProblems('policy', policyParsed.error))
  if (!assetsParsed.success) problems.push(...zodProblems('assets', assetsParsed.error))
  if (!sitemapsParsed.success) problems.push(...zodProblems('sitemaps', sitemapsParsed.error))
  if (problems.length > 0) throw new SeoCompileError(problems)

  const widgets = widgetsParsed.data!
  const content = contentParsed.data!
  const policy = policyParsed.data!
  const assets = assetsParsed.data!
  const sitemaps = sitemapsParsed.data!

  const consistency = checkSeoConsistency({
    sites: input.sites,
    widgets,
    content,
    policy,
    assets,
    sitemaps,
    disabledContent: input.disabledContent,
  })
  if (consistency.length > 0) throw new SeoCompileError(consistency)

  return { seoBundleId, sites: input.sites, widgets, content, policy, assets, sitemaps }
}

function zodProblems(label: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${label}.${i.path.join('.') || '<root>'}: ${i.message}`)
}
