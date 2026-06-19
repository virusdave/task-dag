// Derive the per-post sitemap URLs from the approved blog posts already in
// the compiler's content.posts, and merge them with the static (non-post)
// sitemap URLs from the JSON config. This is the "sitemap/RSS update from
// the bundle" half of P4: when a new approved post enters content.json
// (via `--posts-from-db`), its sitemap entry is GENERATED here so it can
// never silently drift from — or duplicate — a hand-listed config URL.
//
// Pure, no I/O (like compile.ts/consistency.ts) — the CLI calls this after
// posts are loaded. RSS and the WhatsNewFeed widget are rendered by mss
// from content.json posts (filtered to indexable, non-killed posts), so
// there is deliberately NO separate feed file: the frozen P0 bundle layout
// is exactly five files (widgets/content/policy/assets/sitemaps).
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import type { BlogPostContent, SitemapUrl } from './contracts.js'
import { looksLikeBlogPostUrl } from './routeRegistry.js'

export class SitemapMergeError extends Error {
  constructor(public readonly problems: string[]) {
    super(`SEO sitemap generation failed:\n  - ${problems.join('\n  - ')}`)
    this.name = 'SitemapMergeError'
  }
}

const DEFAULT_CHANGEFREQ: SitemapUrl['changefreq'] = 'weekly'
const DEFAULT_PRIORITY = 0.7

export interface PostSitemapOptions {
  /** Post ids on the current.json kill-list — excluded from the sitemap. */
  readonly disabledPostIds?: ReadonlySet<string>
  readonly defaultChangefreq?: SitemapUrl['changefreq']
  readonly defaultPriority?: number
}

/**
 * One sitemap URL per INDEXABLE, non-killed post, derived from the post's
 * own canonical_url so the sitemap entry can never drift from the route the
 * post renders at. `noindex` and kill-listed posts are skipped (matching
 * the sitemap-hygiene rules consistency.ts enforces fail-closed), so the
 * generated set is always safe to publish.
 */
export function buildPostSitemapUrls(
  posts: readonly BlogPostContent[],
  opts: PostSitemapOptions = {},
): SitemapUrl[] {
  const disabledPostIds = opts.disabledPostIds ?? new Set<string>()
  const changefreq = opts.defaultChangefreq ?? DEFAULT_CHANGEFREQ
  const priority = opts.defaultPriority ?? DEFAULT_PRIORITY

  return posts.flatMap((post) => {
    if (post.noindex === true || disabledPostIds.has(post.post_id)) {
      return []
    }
    return [
      {
        loc: post.canonical_url,
        scope: post.scope,
        lastmod: post.updated_at ?? post.published_at,
        changefreq,
        priority,
        post_id: post.post_id,
      } satisfies SitemapUrl,
    ]
  })
}

/**
 * Merge the config's STATIC (non-post) sitemap URLs with freshly generated
 * per-post URLs. The generator OWNS every post-bound entry, so:
 *   • config URLs that carry a `post_id` are dropped (regenerated here),
 *   • a retained static URL that nonetheless points at a blog-post route
 *     (`/sites/<id>/whats-new/<slug>`) is rejected — a stale hand-entered
 *     post URL without a `post_id` would otherwise dodge the post-bound
 *     hygiene checks in consistency.ts, exactly the drift this eliminates,
 *   • any `loc` collision between a retained static URL and a generated
 *     post URL is rejected.
 * Throws SitemapMergeError (fail-closed) on any of the above.
 */
export function mergePostSitemaps(
  configSitemaps: readonly SitemapUrl[],
  posts: readonly BlogPostContent[],
  opts: PostSitemapOptions = {},
): SitemapUrl[] {
  const staticUrls = configSitemaps.filter((u) => u.post_id === undefined)
  const generated = buildPostSitemapUrls(posts, opts)
  const generatedLocs = new Set(generated.map((u) => u.loc))

  const problems: string[] = []
  for (const u of staticUrls) {
    if (looksLikeBlogPostUrl(u.loc)) {
      problems.push(
        `static sitemap url '${u.loc}' looks like a blog-post route but has no post_id; ` +
          `let --sitemaps-from-posts generate it from approved content instead of hand-listing it`,
      )
    } else if (generatedLocs.has(u.loc)) {
      problems.push(`static sitemap url '${u.loc}' collides with a generated post url`)
    }
  }
  if (problems.length > 0) {
    throw new SitemapMergeError(problems)
  }

  return [...staticUrls, ...generated]
}
