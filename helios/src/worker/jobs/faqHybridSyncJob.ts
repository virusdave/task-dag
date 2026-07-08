// FAQ hybrid sync / change-detection job — the runtime executor
// (child FreshlyBakedNYC/automation#46, P1, task cfa2dc0).
//
// One scheduler tick = one job. The handler:
//   1. Re-imports the managed FBUS source(s) idempotently as DRAFTS
//      (path b's change detection): unchanged content is a no-op; changed
//      content resets the set to draft + clears any approval.
//   2. Builds an observation per source-keyed set (status, current /
//      approved / published fingerprints, this-pass import outcome).
//   3. Runs the PURE planner (planFaqHybridSync) to classify each source.
//   4. Executes the plan:
//        • path (b) review pages  → page-dave (a human must review the draft);
//        • path (a) publish       → rebuild the bundle from the LEDGER-VERIFIED
//          approved sets and publish it through a validated staged promotion.
//
// IRONCLAD gate (canon §1): this job NEVER approves anything. Imports only
// ever produce drafts; publishing rebuilds exclusively from
// loadApprovedFaqSetsForBundle (which re-verifies the approval ledger and
// recomputes hashes, failing loud on any mismatch). The planner suppresses
// publish for any source that changed this pass, so an observed source
// change can never auto-publish.
//
// Customer-dark by default: publishing requires SEO_BUNDLE_SIGNING_KEY_FILE
// to be wired (operator-gated, reuses the LP bundle signing key). Until it
// is, the change-detection / draft / page-dave half still runs; the publish
// half is inert (logged, never paged-spammed).
//
// Satisfies: virusdave/top-level#17 · Phase: P1

import { readFileSync } from 'node:fs'

import type { ConfigWorkersFaqHybridSyncJobPayload, JsonValue } from '../../shared/contracts/index.js'
import { deriveBasePathFromAppBaseUrl, joinBasePath } from '../../shared/config/appBasePath.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import type { Queryable } from '../../server/db/pool.js'
import {
  getSeoFaqSetBySourceKey,
  importFaqSetBySourceKey,
  type ImportFaqSetBySourceKeyResult,
} from '../../server/db/queries/seoFaqQueries.js'
import { publicKeyPemFromPrivate } from '../../server/lp/signing.js'
import { buildFaqHybridBundleInput } from '../../server/seo/faqHybridSyncBundleInput.js'
import { loadApprovedFaqSetsForBundle } from '../../server/seo/faqBundleSource.js'
import { faqSetContentSha256 } from '../../server/seo/faqContent.js'
import {
  FB_NYC_FAQ_SCOPE,
  FB_NYC_FAQ_SOURCE_KEY,
  fbNycFaqImportMeta,
  fbNycFaqItemInputs,
} from '../../server/seo/faqImportFbNyc.js'
import {
  planFaqHybridSync,
  type FaqSourceImportOutcome,
  type FaqSyncPlan,
  type FaqSyncSourceObservation,
} from '../../server/seo/faqHybridSyncPlan.js'
import {
  readPublishedFaqContentShas,
  type PublishedFaqContentState,
} from '../../server/seo/faqPublishedState.js'
import { compileSeoBundle } from '../../server/seo/compile.js'
import type { FaqSet, SeoEnvironment } from '../../server/seo/contracts.js'
import { SeoEnvironmentSchema } from '../../server/seo/contracts.js'
import { publishSeoBundleStaged } from '../../server/seo/publishStaged.js'
import { pageDave } from '../runtime/pageDave.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// ── env-driven publish configuration (operator-gated) ──────────────────

const DEFAULT_SEO_ARTIFACT_ROOT = '/cloud/seo'
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/
const FALLBACK_GIT_SHA = '0000000'

export interface FaqHybridSyncPublishConfig {
  readonly artifactRoot: string
  readonly environment: SeoEnvironment
  readonly privateKeyPem: string
  readonly publicKeyPem: string
  readonly automationGitSha: string
}

/**
 * Resolve the publish configuration from env, or null when publishing is
 * not wired (no signing key) — the customer-dark default.
 */
export function resolveFaqHybridSyncPublishConfig(
  env: NodeJS.ProcessEnv = process.env,
): FaqHybridSyncPublishConfig | null {
  const signingKeyPath = env.SEO_BUNDLE_SIGNING_KEY_FILE
  if (!signingKeyPath) {
    return null
  }
  const privateKeyPem = readFileSync(signingKeyPath, 'utf8')
  const publicKeyPem = env.SEO_BUNDLE_PUBLIC_KEY_FILE
    ? readFileSync(env.SEO_BUNDLE_PUBLIC_KEY_FILE, 'utf8')
    : publicKeyPemFromPrivate(privateKeyPem)
  const rawGitSha = env.SEO_BUNDLE_AUTOMATION_GIT_SHA ?? ''
  const automationGitSha = GIT_SHA_RE.test(rawGitSha) ? rawGitSha : FALLBACK_GIT_SHA
  if (automationGitSha === FALLBACK_GIT_SHA) {
    // eslint-disable-next-line no-console
    console.warn(
      '[faq-hybrid-sync] SEO_BUNDLE_AUTOMATION_GIT_SHA unset/invalid; ' +
        `stamping manifest with ${FALLBACK_GIT_SHA}`,
    )
  }
  const environment = SeoEnvironmentSchema.parse(env.SEO_BUNDLE_ENVIRONMENT ?? 'prod')
  return {
    artifactRoot: env.SEO_ARTIFACT_ROOT ?? DEFAULT_SEO_ARTIFACT_ROOT,
    environment,
    privateKeyPem,
    publicKeyPem,
    automationGitSha,
  }
}

// ── operator deep-link (page-dave) ─────────────────────────────────────

/**
 * Prod Helios origin, used as the fallback base for the review deep link
 * when the worker process has no `APP_BASE_URL` in its environment (the
 * page is a convenience link, so a missing env must never crash the job).
 */
const DEFAULT_HELIOS_APP_BASE_URL = 'https://helios.freshlybaked.us'

/** Resolve the Helios app base URL for building operator links. */
export function resolveAppBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.APP_BASE_URL?.trim()
  if (!raw) {
    return DEFAULT_HELIOS_APP_BASE_URL
  }
  // Guard against a malformed env value — fall back rather than throw from
  // inside a notification path.
  try {
    new URL(raw)
    return raw
  } catch {
    return DEFAULT_HELIOS_APP_BASE_URL
  }
}

/**
 * Build the absolute URL of the Helios FAQ-set review page for `faqSetId`
 * (`<base>/seo/faq/<faqSetId>/review`), honoring any base path baked into
 * `appBaseUrl`. Pure + unit-tested so the operator page always deep-links
 * to the exact review/approve surface.
 */
export function buildFaqReviewUrl(appBaseUrl: string, faqSetId: string): string {
  const basePath = deriveBasePathFromAppBaseUrl(appBaseUrl)
  const path = joinBasePath(basePath, `/seo/faq/${encodeURIComponent(faqSetId)}/review`)
  return new URL(path, appBaseUrl).toString()
}

// ── pure helpers (unit-tested) ─────────────────────────────────────────

/** One managed source's state for a planning pass. */
export interface ManagedFaqSetSnapshot {
  readonly sourceKey: string
  readonly faqSetId: string
  readonly status: 'draft' | 'needs_review' | 'approved' | 'rejected'
  readonly contentSha256: string
}

/**
 * Build the planner observation for one managed set. `approvedContentSha256`
 * is the row fingerprint only when the set is approved (the approve gate
 * binds content_sha256 to the ledgered approval; any edit resets to draft).
 */
export function toFaqSyncObservation(
  snapshot: ManagedFaqSetSnapshot,
  importOutcome: FaqSourceImportOutcome | null,
  publishedShaByFaqSetId: ReadonlyMap<string, string>,
): FaqSyncSourceObservation {
  return {
    sourceKey: snapshot.sourceKey,
    faqSetId: snapshot.faqSetId,
    status: snapshot.status,
    contentSha256: snapshot.contentSha256,
    approvedContentSha256: snapshot.status === 'approved' ? snapshot.contentSha256 : null,
    publishedContentSha256: publishedShaByFaqSetId.get(snapshot.faqSetId) ?? null,
    importOutcome,
  }
}

/**
 * Re-plan safety check (Oracle review): the planner said "publish these
 * candidates", but the ledger-verified bundle is loaded separately and a
 * concurrent edit could have moved a candidate back to draft. Require every
 * publish candidate to still be present in the loaded approved sets with
 * EXACTLY its expected approved fingerprint. Returns problems; empty = safe.
 */
export function verifyPublishCandidatesPresent(
  plan: FaqSyncPlan,
  approvedFaqSets: readonly FaqSet[],
): string[] {
  const shaByFaqSetId = new Map<string, string>()
  for (const set of approvedFaqSets) {
    shaByFaqSetId.set(
      set.faq_set_id,
      faqSetContentSha256({
        faq_set_id: set.faq_set_id,
        scope: set.scope,
        items: set.items.map((i) => ({
          question: i.question,
          answer_raw: i.answer_raw,
          answer_sanitized: i.answer_sanitized,
        })),
      }),
    )
  }
  const problems: string[] = []
  for (const candidate of plan.publishCandidates) {
    const actual = shaByFaqSetId.get(candidate.faqSetId)
    if (actual === undefined) {
      problems.push(
        `publish candidate ${candidate.sourceKey} (${candidate.faqSetId}) is no longer in the approved set`,
      )
    } else if (actual !== candidate.approvedContentSha256) {
      problems.push(
        `publish candidate ${candidate.sourceKey} (${candidate.faqSetId}) approved fingerprint changed ` +
          `(${candidate.approvedContentSha256} → ${actual})`,
      )
    }
  }
  return problems
}

// ── the executor ───────────────────────────────────────────────────────

export async function runFaqHybridSyncJob(
  context: JobHandlerContext,
  payload: ConfigWorkersFaqHybridSyncJobPayload,
): Promise<void> {
  const pool = getPool()
  const now = new Date()
  const publishConfig = resolveFaqHybridSyncPublishConfig()

  // 1. Re-import the managed source(s) idempotently as drafts (path b).
  const importOutcomeBySourceKey = new Map<string, FaqSourceImportOutcome>()
  const fbNycImport = await importFaqSetBySourceKey(pool, {
    sourceKey: FB_NYC_FAQ_SOURCE_KEY,
    scope: FB_NYC_FAQ_SCOPE,
    items: fbNycFaqItemInputs(),
    source: 'generated',
    generationMeta: fbNycFaqImportMeta(now),
    userId: null, // system-run write; no human actor (migration 071 nullable)
  })
  importOutcomeBySourceKey.set(FB_NYC_FAQ_SOURCE_KEY, importKindToOutcome(fbNycImport))

  // 2. Read published state from the LIVE bundle (only when publishing is
  //    wired — we need the public key to validate it). When dark, treat all
  //    sets as unpublished; publish is skipped anyway below.
  let publishedState: PublishedFaqContentState | null = null
  if (publishConfig) {
    publishedState = readPublishedFaqContentShas({
      artifactRoot: publishConfig.artifactRoot,
      environment: publishConfig.environment,
      publicKeyPem: publishConfig.publicKeyPem,
    })
  }
  // A present-but-invalid live bundle MUST block publish (we never publish
  // over a bundle we cannot validate), but it must NOT abort the run before
  // the change-detection / page-dave half — otherwise a source change that
  // was already committed by the import above would never page a human (the
  // retry sees `unchanged`). Defer the throw until after review pages run.
  const liveInvalidErrors =
    publishedState?.status === 'invalid' ? publishedState.errors : null
  const publishedShaByFaqSetId =
    publishedState?.status === 'ok' ? publishedState.shaByFaqSetId : new Map<string, string>()

  // 3. Gather observations for the managed source(s). P1 manages only the
  //    global FB-NYC loyalty FAQ; family sources are P5.
  const observations: FaqSyncSourceObservation[] = []
  const snapshots = await loadManagedSnapshots(pool, [FB_NYC_FAQ_SOURCE_KEY])
  for (const snapshot of snapshots) {
    observations.push(
      toFaqSyncObservation(
        snapshot,
        importOutcomeBySourceKey.get(snapshot.sourceKey) ?? null,
        publishedShaByFaqSetId,
      ),
    )
  }

  // 4. Plan (pure).
  const plan = planFaqHybridSync(observations)

  // The global loyalty FAQ set id, only when it is currently approved (its
  // widget is placed in the bundle only then).
  const globalApprovedFaqSetId =
    snapshots.find((s) => s.sourceKey === FB_NYC_FAQ_SOURCE_KEY && s.status === 'approved')
      ?.faqSetId ?? null

  // 5a. Path (b): page-dave for each changed source needing review. Naturally
  //     at-most-once across runs — a re-import of unchanged content yields no
  //     review page, so steady-state runs page nobody.
  const appBaseUrl = resolveAppBaseUrl()
  for (const reviewPage of plan.reviewPages) {
    const reviewUrl = buildFaqReviewUrl(appBaseUrl, reviewPage.faqSetId)
    await pageDave(
      `FAQ source "${reviewPage.sourceKey}" ${reviewPage.reason} a draft (set ${reviewPage.faqSetId}, ` +
        `content ${reviewPage.contentSha256.slice(0, 12)}). Review + approve before it can publish: ${reviewUrl}`,
      { priority: 3, title: 'FAQ source change needs review' },
    )
    await appendAuditEvent(pool, {
      actorType: 'system',
      actorUserId: null,
      entityId: reviewPage.faqSetId,
      entityType: 'seo_faq_set',
      eventType: 'config.workers.faq_hybrid_sync.review_paged',
      module: 'config',
      payload: {
        sourceKey: reviewPage.sourceKey,
        reason: reviewPage.reason,
        contentSha256: reviewPage.contentSha256,
        reviewUrl,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  }

  // Now that review pages have been delivered, fail-closed on a live bundle
  // we could not validate — never publish over it.
  if (liveInvalidErrors) {
    throw new Error(
      `[faq-hybrid-sync] live SEO bundle failed validation; refusing to publish: ${liveInvalidErrors.join('; ')}`,
    )
  }

  // 5b. Path (a): publish the approved bundle when warranted.
  let publishSummary: Record<string, JsonValue> = { shouldPublish: plan.shouldPublishBundle }
  if (plan.shouldPublishBundle) {
    if (!publishConfig) {
      // eslint-disable-next-line no-console
      console.warn(
        `[faq-hybrid-sync] job=${context.id} ${plan.publishCandidates.length} approved FAQ set(s) ` +
          'await publish but SEO_BUNDLE_SIGNING_KEY_FILE is not configured (customer-dark); skipping publish.',
      )
      publishSummary = {
        ...publishSummary,
        published: false,
        reason: 'publishing-not-configured',
        candidates: plan.publishCandidates.length,
      }
    } else {
      publishSummary = await publishApprovedBundle(
        pool,
        plan,
        globalApprovedFaqSetId,
        publishConfig,
        now,
      )
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[faq-hybrid-sync] job=${context.id} trigger=${payload.trigger} ` +
      `imports=${[...importOutcomeBySourceKey.entries()].map(([k, v]) => `${k}:${v}`).join(',')} ` +
      `reviewPages=${plan.reviewPages.length} ${JSON.stringify(publishSummary)}`,
  )

  await appendAuditEvent(pool, {
    actorType: 'system',
    actorUserId: null,
    entityId: 'singleton',
    entityType: 'job',
    eventType: 'config.workers.faq_hybrid_sync.completed',
    module: 'config',
    payload: {
      trigger: payload.trigger,
      imports: Object.fromEntries(importOutcomeBySourceKey),
      reviewPages: plan.reviewPages.length,
      noops: plan.noops.length,
      publish: publishSummary,
    },
    requestId: null,
    scope: null,
    undoPayload: null,
  })
}

async function publishApprovedBundle(
  pool: Queryable,
  plan: FaqSyncPlan,
  globalApprovedFaqSetId: string | null,
  config: FaqHybridSyncPublishConfig,
  now: Date,
): Promise<Record<string, JsonValue>> {
  // Rebuild ONLY from the ledger-verified approved sets (re-checks the
  // approval ledger + recomputes hashes; throws loud on any mismatch).
  const approvedFaqSets = await loadApprovedFaqSetsForBundle(pool)

  // Re-plan safety: the candidates the planner chose must still be approved
  // with their expected fingerprint; otherwise abort and let the next run
  // re-plan against the new state (never publish a bundle missing its cause).
  const candidateProblems = verifyPublishCandidatesPresent(plan, approvedFaqSets)
  if (candidateProblems.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[faq-hybrid-sync] aborting publish; candidate state changed mid-pass: ${candidateProblems.join('; ')}`,
    )
    return { published: false, reason: 'candidate-changed', problems: candidateProblems }
  }

  // The loyalty-FAQ widget is placed only when the global set is approved
  // AND actually present in the ledger-verified approved sets.
  const globalFaqSetId =
    globalApprovedFaqSetId !== null &&
    approvedFaqSets.some((s) => s.faq_set_id === globalApprovedFaqSetId)
      ? globalApprovedFaqSetId
      : null

  const input = buildFaqHybridBundleInput({ approvedFaqSets, globalFaqSetId })
  const compiled = compileSeoBundle({ ...input, now })

  const result = publishSeoBundleStaged({
    compiled,
    privateKeyPem: config.privateKeyPem,
    publicKeyPem: config.publicKeyPem,
    artifactRoot: config.artifactRoot,
    environment: config.environment,
    minRendererVersion: 'mss-seo-runtime>=0.1.0',
    automationGitSha: config.automationGitSha,
    generatedFrom: { seo_policy_version_id: input.policy.seo_policy_version_id },
    now,
  })

  await appendAuditEvent(pool, {
    actorType: 'system',
    actorUserId: null,
    entityId: result.seoBundleId,
    entityType: 'seo_bundle',
    eventType: 'config.workers.faq_hybrid_sync.published',
    module: 'config',
    payload: {
      seoBundleId: result.seoBundleId,
      version: result.version,
      previousVersion: result.previousVersion,
      environment: config.environment,
      faqSetCount: approvedFaqSets.length,
      candidates: plan.publishCandidates.map((c) => c.sourceKey),
    },
    requestId: null,
    scope: null,
    undoPayload: null,
  })

  return {
    published: true,
    seoBundleId: result.seoBundleId,
    version: result.version,
    faqSetCount: approvedFaqSets.length,
  }
}

function importKindToOutcome(result: ImportFaqSetBySourceKeyResult): FaqSourceImportOutcome {
  return result.kind
}

async function loadManagedSnapshots(
  db: Queryable,
  sourceKeys: readonly string[],
): Promise<ManagedFaqSetSnapshot[]> {
  const snapshots: ManagedFaqSetSnapshot[] = []
  for (const sourceKey of sourceKeys) {
    const record = await getSeoFaqSetBySourceKey(db, sourceKey)
    if (record) {
      snapshots.push({
        sourceKey,
        faqSetId: record.faqSetId,
        status: record.status,
        contentSha256: record.contentSha256,
      })
    }
  }
  return snapshots
}
