// Query layer for the SEO auto-blog control plane (migration 072).
//
// Helios-driven SEO widgets — auto-blog MVP (parent EPIC_PLAN §6.2/§6.3/§7,
// child FreshlyBakedNYC/automation#44, P4, Satisfies: virusdave/top-level#15).
//
// Backs the /api/seo/posts routes and the approved-post bundle loader. The
// approve path is the IRONCLAD human-approval gate (canon §1): it runs
// under a row lock, re-checks the fingerprint the reviewer saw, writes an
// append-only ledger row, stamps the reviewer, and binds the post to that
// approval. Any edit recomputes the fingerprint and resets the post to
// `draft`.

import type { PoolClient } from 'pg'

import type {
  SeoPostRecord,
  SeoPostSource,
  SeoPostSummary,
} from '../../../shared/contracts/index.js'
import { newSeoApprovalId } from '../../seo/faqContent.js'
import {
  checkPostApprovable,
  newPostId,
  postContentSha256,
  type PostContentInput,
} from '../../seo/postContent.js'
import { blogCanonicalUrl } from '../../seo/routeRegistry.js'
import type { Queryable } from '../pool.js'
import { withTransaction } from '../tx.js'

interface SeoPostRow {
  post_id: string
  scope: string
  slug: string
  status: string
  title: string
  meta_description: string
  excerpt: string
  author: string
  tags: unknown
  body_raw: string
  body_sanitized: string
  noindex: boolean
  published_at: Date | string
  scheduled_publish_at: Date | string | null
  source: string
  content_sha256: string
  approval_id: string | null
  reviewer: string | null
  generation_meta: unknown
  created_by_user_id: string | number | null
  updated_by_user_id: string | number | null
  created_at: Date | string
  updated_at: Date | string
  // from the seo_approvals join
  approved_by_user_id: string | number | null
  approved_at: Date | string | null
  approval_note: string | null
}

const SELECT_POST = `
  select
    p.post_id,
    p.scope,
    p.slug,
    p.status,
    p.title,
    p.meta_description,
    p.excerpt,
    p.author,
    p.tags,
    p.body_raw,
    p.body_sanitized,
    p.noindex,
    p.published_at,
    p.scheduled_publish_at,
    p.source,
    p.content_sha256,
    p.approval_id,
    p.reviewer,
    p.generation_meta,
    p.created_by_user_id,
    p.updated_by_user_id,
    p.created_at,
    p.updated_at,
    a.approved_by_user_id,
    a.approved_at,
    a.note as approval_note
  from seo_posts p
  left join seo_approvals a on a.approval_id = p.approval_id
`

const RETURNING_POST = `
  returning
    post_id, scope, slug, status, title, meta_description, excerpt, author, tags,
    body_raw, body_sanitized, noindex, published_at, scheduled_publish_at, source,
    content_sha256, approval_id, reviewer, generation_meta, created_by_user_id,
    updated_by_user_id, created_at, updated_at,
    null::bigint as approved_by_user_id, null::timestamptz as approved_at,
    null::text as approval_note
`

function toIsoString(value: Date | string | null): string | null {
  if (value === null) {
    return null
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) {
    return null
  }
  return typeof value === 'number' ? value : Number.parseInt(value, 10)
}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.filter((t): t is string => typeof t === 'string')
}

function rowToContentInput(row: {
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
}): PostContentInput {
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

function mapRow(row: SeoPostRow): SeoPostRecord {
  return {
    postId: row.post_id,
    scope: row.scope,
    slug: row.slug,
    title: row.title,
    metaDescription: row.meta_description,
    excerpt: row.excerpt,
    author: row.author,
    tags: parseTags(row.tags),
    bodyRaw: row.body_raw,
    bodySanitized: row.body_sanitized,
    noindex: row.noindex === true,
    // Derived from scope+slug so it can never drift; blank until a valid
    // slug is set (a draft may not have one yet).
    canonicalUrl: row.slug ? safeCanonicalUrl(row.scope, row.slug) : '',
    publishedAt: toIsoString(row.published_at)!,
    scheduledPublishAt: toIsoString(row.scheduled_publish_at),
    status: row.status as SeoPostRecord['status'],
    source: row.source as SeoPostSource,
    contentSha256: row.content_sha256,
    approvalId: row.approval_id,
    reviewer: row.reviewer,
    approvedByUserId: toNumberOrNull(row.approved_by_user_id),
    approvedAt: toIsoString(row.approved_at),
    approvalNote: row.approval_note,
    generationMeta: row.generation_meta ?? null,
    createdByUserId: toNumberOrNull(row.created_by_user_id),
    updatedByUserId: toNumberOrNull(row.updated_by_user_id),
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
  }
}

// blogCanonicalUrl throws on an invalid slug; in the control plane a draft
// may carry a not-yet-valid slug, so fall back to '' rather than 500ing a
// list/get of an in-progress post.
function safeCanonicalUrl(scope: string, slug: string): string {
  try {
    return blogCanonicalUrl(scope, slug)
  } catch {
    return ''
  }
}

interface SeoPostSummaryRow {
  post_id: string
  scope: string
  slug: string
  title: string
  status: string
  source: string
  noindex: boolean
  published_at: Date | string
  updated_at: Date | string
}

export interface ListSeoPostsOptions {
  readonly limit: number
  readonly offset: number
}

export interface SeoPostListPage {
  readonly posts: SeoPostSummary[]
  readonly total: number
}

/**
 * Lean, newest-first, paginated list. Selects ONLY the summary columns
 * (never the large body variants) so the payload stays flat as the table
 * grows; the editor loads full content via getSeoPost. Ordered by
 * (updated_at desc, id desc) for a stable page window, backed by the
 * seo_posts_updated_at_id_desc_idx index (migration 075).
 */
export async function listSeoPosts(
  db: Queryable,
  options: ListSeoPostsOptions,
): Promise<SeoPostListPage> {
  const [pageResult, countResult] = await Promise.all([
    db.query<SeoPostSummaryRow>(
      `
        select post_id, scope, slug, title, status, source, noindex,
               published_at, updated_at
          from seo_posts
         order by updated_at desc, id desc
         limit $1 offset $2
      `,
      [options.limit, options.offset],
    ),
    db.query<{ total: string }>(`select count(*)::text as total from seo_posts`),
  ])
  const posts: SeoPostSummary[] = pageResult.rows.map((row) => ({
    postId: row.post_id,
    scope: row.scope,
    slug: row.slug,
    title: row.title,
    status: row.status as SeoPostSummary['status'],
    source: row.source as SeoPostSource,
    noindex: row.noindex === true,
    publishedAt: toIsoString(row.published_at)!,
    updatedAt: toIsoString(row.updated_at)!,
  }))
  return { posts, total: Number.parseInt(countResult.rows[0]?.total ?? '0', 10) }
}

export async function getSeoPost(db: Queryable, postId: string): Promise<SeoPostRecord | null> {
  const result = await db.query<SeoPostRow>(`${SELECT_POST} where p.post_id = $1`, [postId])
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export interface PostContentFields {
  readonly slug: string
  readonly title: string
  readonly metaDescription: string
  readonly excerpt: string
  readonly author: string
  readonly tags: readonly string[]
  readonly bodyRaw: string
  readonly bodySanitized: string
  readonly noindex: boolean
}

function contentInput(postId: string, scope: string, c: PostContentFields): PostContentInput {
  return {
    post_id: postId,
    scope,
    slug: c.slug,
    title: c.title,
    meta_description: c.metaDescription,
    excerpt: c.excerpt,
    author: c.author,
    tags: [...c.tags],
    body_raw: c.bodyRaw,
    body_sanitized: c.bodySanitized,
    noindex: c.noindex,
  }
}

export interface CreateSeoPostInput extends PostContentFields {
  readonly scope: string
  readonly source?: SeoPostSource
  readonly generationMeta?: unknown
  readonly userId: number
  readonly now?: Date
}

export async function createSeoPost(
  db: Queryable,
  input: CreateSeoPostInput,
): Promise<SeoPostRecord> {
  const now = input.now ?? new Date()
  const postId = newPostId(now)
  const contentSha256 = postContentSha256(contentInput(postId, input.scope, input))
  const result = await db.query<SeoPostRow>(
    `
      insert into seo_posts (
        post_id, scope, slug, status, title, meta_description, excerpt, author,
        tags, body_raw, body_sanitized, noindex, source, generation_meta,
        content_sha256, approval_id, reviewer, created_by_user_id, updated_by_user_id
      )
      values (
        $1, $2, $3, 'draft', $4, $5, $6, $7,
        $8::text[], $9, $10, $11, $12, $13::jsonb,
        $14, null, null, $15, $15
      )
      ${RETURNING_POST}
    `,
    [
      postId,
      input.scope,
      input.slug,
      input.title,
      input.metaDescription,
      input.excerpt,
      input.author,
      input.tags,
      input.bodyRaw,
      input.bodySanitized,
      input.noindex,
      input.source ?? 'manual',
      input.generationMeta === undefined ? null : JSON.stringify(input.generationMeta),
      contentSha256,
      input.userId,
    ],
  )
  return mapRow(result.rows[0]!)
}

export interface UpdateSeoPostInput extends PostContentFields {
  readonly scope: string
  readonly userId: number
}

/**
 * Replace a post's content. Always resets the post to `draft` and clears
 * its approval + reviewer (so an approval can never silently cover edited
 * content) and recomputes the content fingerprint. Returns null if the
 * post does not exist.
 */
export async function updateSeoPost(
  db: Queryable,
  postId: string,
  input: UpdateSeoPostInput,
): Promise<SeoPostRecord | null> {
  const contentSha256 = postContentSha256(contentInput(postId, input.scope, input))
  const result = await db.query<SeoPostRow>(
    `
      update seo_posts
         set scope = $2,
             slug = $3,
             title = $4,
             meta_description = $5,
             excerpt = $6,
             author = $7,
             tags = $8::text[],
             body_raw = $9,
             body_sanitized = $10,
             noindex = $11,
             content_sha256 = $12,
             status = 'draft',
             approval_id = null,
             reviewer = null,
             updated_by_user_id = $13,
             updated_at = now()
       where post_id = $1
      ${RETURNING_POST}
    `,
    [
      postId,
      input.scope,
      input.slug,
      input.title,
      input.metaDescription,
      input.excerpt,
      input.author,
      input.tags,
      input.bodyRaw,
      input.bodySanitized,
      input.noindex,
      contentSha256,
      input.userId,
    ],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export type PostStatusTransition = 'needs_review' | 'rejected'

/**
 * Move a post to `needs_review` (submit) or `rejected`. Never touches
 * content; clears approval + reviewer bindings. Returns null if not found.
 */
export async function setSeoPostStatus(
  db: Queryable,
  postId: string,
  status: PostStatusTransition,
  userId: number,
): Promise<SeoPostRecord | null> {
  const result = await db.query<SeoPostRow>(
    `
      update seo_posts
         set status = $2,
             approval_id = null,
             reviewer = null,
             updated_by_user_id = $3,
             updated_at = now()
       where post_id = $1
      ${RETURNING_POST}
    `,
    [postId, status, userId],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

/**
 * Set or clear the control-plane release time. Does NOT change content,
 * status, or the approval binding (scheduled_publish_at is excluded from
 * the content fingerprint), so rescheduling never invalidates an approval.
 * Returns null if not found.
 */
export async function scheduleSeoPost(
  db: Queryable,
  postId: string,
  scheduledPublishAt: string | null,
  userId: number,
): Promise<SeoPostRecord | null> {
  const result = await db.query<SeoPostRow>(
    `
      update seo_posts
         set scheduled_publish_at = $2,
             updated_by_user_id = $3,
             updated_at = now()
       where post_id = $1
      returning
        post_id, scope, slug, status, title, meta_description, excerpt, author,
        tags, body_raw, body_sanitized, noindex, published_at, scheduled_publish_at,
        source, content_sha256, approval_id, reviewer, generation_meta,
        created_by_user_id, updated_by_user_id, created_at, updated_at,
        (select approved_by_user_id from seo_approvals where approval_id = seo_posts.approval_id) as approved_by_user_id,
        (select approved_at from seo_approvals where approval_id = seo_posts.approval_id) as approved_at,
        (select note from seo_approvals where approval_id = seo_posts.approval_id) as approval_note
    `,
    [postId, scheduledPublishAt, userId],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export type ApprovePostResult =
  | { kind: 'ok'; record: SeoPostRecord }
  | { kind: 'not_found' }
  | { kind: 'stale'; currentSha256: string }
  | { kind: 'not_compliant'; problems: string[] }

export interface ApprovePostInput {
  readonly expectedContentSha256: string
  readonly reviewer: string
  readonly note?: string
  readonly userId: number
  readonly now?: Date
}

/**
 * The IRONCLAD human-approval gate (canon §1). Under a row lock:
 *   1. load the current row + recompute its fingerprint,
 *   2. reject if the reviewer's `expectedContentSha256` no longer matches
 *      (stale review — content changed after the page loaded),
 *   3. re-run the structural + sanitized-host compliance checks,
 *   4. mint a server-side approval id, write the append-only ledger row,
 *   5. bind the post to that approval + stamp the reviewer (status='approved').
 */
export async function approveSeoPost(
  postId: string,
  input: ApprovePostInput,
): Promise<ApprovePostResult> {
  return withTransaction(async (client: PoolClient) => {
    const locked = await client.query<{
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
    }>(
      `
        select post_id, scope, slug, title, meta_description, excerpt, author,
               tags, body_raw, body_sanitized, noindex
          from seo_posts
         where post_id = $1
         for update
      `,
      [postId],
    )
    const lockedRow = locked.rows[0]
    if (!lockedRow) {
      return { kind: 'not_found' }
    }

    const content = rowToContentInput(lockedRow)
    const currentSha256 = postContentSha256(content)
    if (currentSha256 !== input.expectedContentSha256) {
      return { kind: 'stale', currentSha256 }
    }

    const problems = checkPostApprovable(content)
    if (problems.length > 0) {
      return {
        kind: 'not_compliant',
        problems: problems.map((p) => `${p.field}: ${p.message}`),
      }
    }

    // Posts share the `seoapr_` ledger id space with FAQ sets.
    const approvalId = newSeoApprovalId(input.now ?? new Date())
    await client.query(
      `
        insert into seo_approvals (
          approval_id, content_kind, content_ref, content_sha256,
          approved_by_user_id, note
        )
        values ($1, 'post', $2, $3, $4, $5)
      `,
      [approvalId, postId, currentSha256, input.userId, input.note ?? null],
    )

    const updated = await client.query<SeoPostRow>(
      `
        update seo_posts
           set status = 'approved',
               approval_id = $2,
               reviewer = $3,
               content_sha256 = $4,
               updated_by_user_id = $5,
               updated_at = now()
         where post_id = $1
        returning
          post_id, scope, slug, status, title, meta_description, excerpt, author,
          tags, body_raw, body_sanitized, noindex, published_at, scheduled_publish_at,
          source, content_sha256, approval_id, reviewer, generation_meta,
          created_by_user_id, updated_by_user_id, created_at, updated_at,
          (select approved_by_user_id from seo_approvals where approval_id = $2) as approved_by_user_id,
          (select approved_at from seo_approvals where approval_id = $2) as approved_at,
          (select note from seo_approvals where approval_id = $2) as approval_note
      `,
      [postId, approvalId, input.reviewer, currentSha256, input.userId],
    )
    return { kind: 'ok', record: mapRow(updated.rows[0]!) }
  })
}
