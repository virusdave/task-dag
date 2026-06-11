// Load APPROVED blog posts from the control-plane DB into the shape the SEO
// bundle compiler consumes (contracts.ts BlogPostContent[]). This is the
// layer that turns operator-approved DB content into bundle candidates —
// used by the `seo-bundle build --posts-from-db` dry-run path.
//
// The pure compiler (compile.ts) stays I/O-free; ALL ledger verification
// lives here. We do not TRUST `seo_posts.approval_id`: we join the
// append-only `seo_approvals` ledger and re-verify, for every approved row,
// that
//   • a ledger row exists for the bound approval_id,
//   • it is a `post` approval for THIS post_id,
//   • its recorded content_sha256 matches the row's stored fingerprint,
//   • and that fingerprint matches a freshly recomputed hash of the row's
//     actual content.
// Any mismatch fails the build LOUDLY (never silently omitted) — a broken
// approval record must stop a publish, not quietly drop content.
//
// The canonical_url is DERIVED from scope+slug (routeRegistry.blogCanonicalUrl)
// so it can never drift from the route the post renders at.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import { BlogPostContentSchema, type BlogPostContent } from './contracts.js'
import { postContentSha256, type PostContentInput } from './postContent.js'
import { blogCanonicalUrl } from './routeRegistry.js'
import type { Queryable } from '../db/pool.js'

export class PostBundleSourceError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Approved post verification failed:\n  - ${problems.join('\n  - ')}`)
    this.name = 'PostBundleSourceError'
  }
}

interface ApprovedPostRow {
  post_id: string
  scope: string
  slug: string
  title: string
  meta_description: string
  excerpt: string
  author: string
  tags: unknown
  body_raw: string
  body_sanitized: string
  noindex: boolean
  published_at: Date | string
  updated_at: Date | string
  scheduled_publish_at: Date | string | null
  reviewer: string | null
  content_sha256: string
  approval_id: string | null
  approval_kind: string | null
  approval_ref: string | null
  approval_sha256: string | null
}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.filter((t): t is string => typeof t === 'string')
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function rowToContentInput(row: ApprovedPostRow): PostContentInput {
  return {
    post_id: row.post_id,
    scope: row.scope,
    slug: row.slug,
    title: row.title,
    meta_description: row.meta_description,
    excerpt: row.excerpt,
    author: row.author,
    tags: parseTags(row.tags),
    body_raw: row.body_raw,
    body_sanitized: row.body_sanitized,
    noindex: row.noindex,
  }
}

/**
 * Fetch every `approved` post whose scheduled release time has arrived
 * (scheduled_publish_at is null or <= now), verify the approval ledger join
 * + hash for each, and return them as validated contract BlogPostContent
 * objects ready for compileSeoBundle(). A future-scheduled post simply does
 * not appear until a later bundle build after its release time. Throws
 * PostBundleSourceError if any approved row is inconsistent.
 */
export async function loadApprovedPostsForBundle(
  db: Queryable,
  now: Date = new Date(),
): Promise<BlogPostContent[]> {
  const result = await db.query<ApprovedPostRow>(
    `
      select
        p.post_id,
        p.scope,
        p.slug,
        p.title,
        p.meta_description,
        p.excerpt,
        p.author,
        p.tags,
        p.body_raw,
        p.body_sanitized,
        p.noindex,
        p.published_at,
        p.updated_at,
        p.scheduled_publish_at,
        p.reviewer,
        p.content_sha256,
        p.approval_id,
        a.content_kind as approval_kind,
        a.content_ref  as approval_ref,
        a.content_sha256 as approval_sha256
      from seo_posts p
      left join seo_approvals a on a.approval_id = p.approval_id
      where p.status = 'approved'
        and (p.scheduled_publish_at is null or p.scheduled_publish_at <= $1)
      order by p.post_id
    `,
    [now.toISOString()],
  )

  const problems: string[] = []
  const posts: BlogPostContent[] = []

  for (const row of result.rows) {
    const id = row.post_id

    if (row.approval_id === null) {
      problems.push(`${id}: status=approved but approval_id is null.`)
      continue
    }
    if (row.approval_kind === null || row.approval_ref === null || row.approval_sha256 === null) {
      problems.push(`${id}: no seo_approvals ledger row for approval_id ${row.approval_id}.`)
      continue
    }
    if (row.approval_kind !== 'post') {
      problems.push(
        `${id}: approval ${row.approval_id} has content_kind '${row.approval_kind}', expected 'post'.`,
      )
      continue
    }
    if (row.approval_ref !== id) {
      problems.push(
        `${id}: approval ${row.approval_id} references content_ref '${row.approval_ref}', not this post.`,
      )
      continue
    }
    if (row.approval_sha256 !== row.content_sha256) {
      problems.push(
        `${id}: stored content_sha256 ${row.content_sha256} does not match the approved fingerprint ${row.approval_sha256}.`,
      )
      continue
    }
    if (row.reviewer === null || row.reviewer.length === 0) {
      problems.push(`${id}: approved post has no reviewer stamped.`)
      continue
    }

    const content = rowToContentInput(row)
    const recomputed = postContentSha256(content)
    if (recomputed !== row.content_sha256) {
      problems.push(
        `${id}: actual content hashes to ${recomputed} but the stored/approved fingerprint is ${row.content_sha256} (content changed without re-approval).`,
      )
      continue
    }

    let canonicalUrl: string
    try {
      canonicalUrl = blogCanonicalUrl(row.scope, row.slug)
    } catch (e) {
      problems.push(`${id}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    const candidate: Record<string, unknown> = {
      post_id: id,
      scope: row.scope,
      slug: row.slug,
      title: row.title,
      meta_description: row.meta_description,
      excerpt: row.excerpt,
      canonical_url: canonicalUrl,
      published_at: toIso(row.published_at),
      updated_at: toIso(row.updated_at),
      author: row.author,
      reviewer: row.reviewer,
      tags: parseTags(row.tags),
      body_raw: row.body_raw,
      body_sanitized: row.body_sanitized,
      approval_id: row.approval_id,
    }
    if (row.noindex === true) {
      candidate.noindex = true
    }

    const parsed = BlogPostContentSchema.safeParse(candidate)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${id}: ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      }
      continue
    }
    posts.push(parsed.data)
  }

  if (problems.length > 0) {
    throw new PostBundleSourceError(problems)
  }
  return posts
}
