import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { z } from 'zod'

import {
  collectPacketHierarchyGroupKeys,
  summarizePricingReviewDraft,
  type PricingReviewBrandMetadata,
  type PricingReviewDraftGroupFollowUp,
  type PricingReviewDraftRow,
  type PricingReviewDraftSummary,
} from './bronxMidtownPricingReviewShared.js'
import { getWorkerEnv } from '../src/worker/config/env.js'
import { editProductPrice, getProductDetail, readSweedDealerContext, waitForProductPrice } from '../src/worker/sweed/client.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PACKET_JSON_PATH = resolve(
  SCRIPT_DIR,
  '../../bulk_additions/2026-04-18/bronx_midtown_full_catalog_pricing_review_packet/packet.json',
)
const DEFAULT_PORT = 8787

const PacketRowSchema = z.object({
  actionLabel: z.string(),
  currentPrice: z.number().nullable(),
  groupId: z.number().int(),
  groupName: z.string(),
  hierarchy: z.object({
    brandKey: z.string().min(1),
    brandLabel: z.string().min(1),
    brandScopeLabel: z.string().min(1),
    categoryKey: z.string().min(1),
    categoryLabel: z.string().min(1),
    categoryScopeLabel: z.string().min(1),
    subcategoryKey: z.string().min(1),
    subcategoryLabel: z.string().min(1),
    subcategoryScopeLabel: z.string().min(1),
    variantKey: z.string().min(1),
    variantLabel: z.string().min(1),
    variantScopeLabel: z.string().min(1),
  }).optional(),
  isActionable: z.boolean(),
  productId: z.number().int(),
  productName: z.string(),
  proposedPrice: z.number().nullable(),
})

const PacketGroupSchema = z.object({
  generatedProducts: z.array(PacketRowSchema),
})

const PacketReportSchema = z.object({
  generatedAt: z.string(),
  groups: z.array(PacketGroupSchema),
  packetId: z.string(),
  summary: z.object({
    productCount: z.number().int(),
    actionableCount: z.number().int().optional(),
    reviewRowCount: z.number().int().optional(),
  }).passthrough(),
})

const SubmissionRowRequestSchema = z.object({
  productId: z.number().int(),
  reviewedPrice: z.number().nullable(),
})

const SubmissionRequestSchema = z.object({
  packetId: z.string(),
  rows: z.array(SubmissionRowRequestSchema).min(1),
})

const FollowUpNoteSchema = z.object({
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  id: z.string().min(1),
  text: z.string().trim().min(1).max(500),
})

const DraftRowSchema = z.object({
  followUpNotes: z.array(FollowUpNoteSchema).default([]),
  include: z.boolean(),
  productId: z.number().int(),
  reviewedPrice: z.string().nullable(),
  status: z.enum(['accepted', 'rejected', 'unreviewed']),
})

const DraftGroupFollowUpSchema = z.object({
  followUpNotes: z.array(FollowUpNoteSchema).default([]),
  groupKey: z.string().min(1),
  groupLevel: z.enum(['brand', 'category', 'subcategory', 'variant']),
  label: z.string().trim().min(1).max(500),
})

const DraftBrandMetadataSchema = z.object({
  brandKey: z.string().min(1),
  isMso: z.boolean(),
  label: z.string().trim().min(1).max(500),
  note: z.string().trim().max(500).nullable(),
})

const DraftRequestSchema = z.object({
  brandMetadata: z.array(DraftBrandMetadataSchema).default([]),
  groupFollowUpNotes: z.array(DraftGroupFollowUpSchema).default([]),
  note: z.string().trim().max(500).nullable().optional(),
  packetId: z.string(),
  rows: z.array(DraftRowSchema),
})

const PersistedDraftStateSchema = z.object({
  brandMetadata: z.array(DraftBrandMetadataSchema).default([]),
  draftId: z.string(),
  note: z.string().trim().max(500).nullable().optional(),
  packetGeneratedAt: z.string(),
  packetId: z.string(),
  packetPath: z.string(),
  resultsHref: z.string(),
  groupFollowUpNotes: z.array(DraftGroupFollowUpSchema).default([]),
  rows: z.array(DraftRowSchema),
  savedAt: z.string(),
}).passthrough()

const ProductDetailResponseSchema = z.object({
  product: z.object({
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
    price: z.coerce.number().nullable().optional(),
    priceInfo: z.object({ actualPrice: z.coerce.number().nullable().optional() }).passthrough().nullable().optional(),
    shortName: z.string().nullable().optional(),
  }).passthrough(),
})

type PacketReport = z.infer<typeof PacketReportSchema>
type PacketRow = z.infer<typeof PacketRowSchema>
type SubmissionStatus = 'completed' | 'completed_with_errors' | 'failed' | 'queued' | 'running'
type SubmissionRowStatus = 'already_matching' | 'applied' | 'blank' | 'failed' | 'pending'

interface LiveProductSummary {
  id: number
  name: string | null
  price: number | null
  shortName: string | null
}

interface SubmissionRowResult {
  actionLabel: string
  afterLivePrice: number | null
  beforeLivePrice: number | null
  currentPacketPrice: number | null
  editApplied: boolean
  errorMessage: string | null
  groupId: number
  groupName: string
  isActionable: boolean
  productId: number
  productName: string
  proposedPacketPrice: number | null
  reviewedPrice: number | null
  status: SubmissionRowStatus
  verifiedTargetPrice: boolean
}

interface SubmissionSummary {
  alreadyMatchingCount: number
  appliedCount: number
  blankCount: number
  failedCount: number
  plannedWriteCount: number
  processedCount: number
  requestedRowCount: number
}

interface SubmissionState {
  errorMessage: string | null
  finishedAt: string | null
  packetGeneratedAt: string
  packetId: string
  packetPath: string
  requestedAt: string
  resultsHref: string
  rows: SubmissionRowResult[]
  startedAt: string | null
  stateContext: { dealerId: number; dealerName: string | null } | null
  status: SubmissionStatus
  submissionId: string
  summary: SubmissionSummary
}

interface DraftSummary {
  acceptedCount: PricingReviewDraftSummary['acceptedCount']
  completedNoteCount: PricingReviewDraftSummary['completedNoteCount']
  groupTargetCount: PricingReviewDraftSummary['groupTargetCount']
  includedCount: PricingReviewDraftSummary['includedCount']
  outstandingNoteCount: PricingReviewDraftSummary['outstandingNoteCount']
  outstandingGroupCount: PricingReviewDraftSummary['outstandingGroupCount']
  outstandingProductCount: PricingReviewDraftSummary['outstandingProductCount']
  rejectedCount: PricingReviewDraftSummary['rejectedCount']
  reviewedCount: PricingReviewDraftSummary['reviewedCount']
  rowCount: PricingReviewDraftSummary['rowCount']
  totalNoteCount: PricingReviewDraftSummary['totalNoteCount']
  unreviewedCount: PricingReviewDraftSummary['unreviewedCount']
}

interface DraftState {
  brandMetadata: Array<z.infer<typeof DraftBrandMetadataSchema>>
  draftId: string
  groupFollowUpNotes: Array<z.infer<typeof DraftGroupFollowUpSchema>>
  note: string | null
  packetGeneratedAt: string
  packetId: string
  packetPath: string
  resultsHref: string
  rows: Array<z.infer<typeof DraftRowSchema>>
  savedAt: string
  summary: DraftSummary
}

async function main(): Promise<void> {
  const { packetJsonPath, port } = parseCliArgs(process.argv.slice(2))
  const packetPath = resolve(packetJsonPath)
  const packetDir = dirname(packetPath)
  const draftsDir = join(packetDir, 'drafts')
  const submissionsDir = join(packetDir, 'submissions')
  await mkdir(draftsDir, { recursive: true })
  await mkdir(submissionsDir, { recursive: true })

  const submissions = new Map<string, SubmissionState>()
  let activeSubmissionId: string | null = null

  const server = Fastify({ logger: false })

  server.get('/api/pricing-review/health', async () => {
    const packet = await readPacketReport(packetPath)
    return {
      activeSubmissionId,
      packetGeneratedAt: packet.generatedAt,
      packetId: packet.packetId,
      packetPath,
      packetProductCount: packet.summary.productCount,
    }
  })

  server.post('/api/pricing-review/submissions', async (request, reply) => {
    const { packet, packetRowByProductId } = await readPacketContext(packetPath)
    const body = SubmissionRequestSchema.parse(request.body ?? {})
    if (body.packetId !== packet.packetId) {
      return reply.status(409).send({ error: 'Packet id mismatch. Refresh the packet page and try again.' })
    }
    if (activeSubmissionId !== null) {
      const activeSubmission = submissions.get(activeSubmissionId)
      if (activeSubmission && (activeSubmission.status === 'queued' || activeSubmission.status === 'running')) {
        return reply.status(409).send({ error: 'Another reviewed-price submission is already running. Wait for it to finish first.' })
      }
      activeSubmissionId = null
    }

    const duplicateProductIds = findDuplicateProductIds(body.rows)
    if (duplicateProductIds.length > 0) {
      return reply.status(400).send({ error: `Duplicate reviewed-price rows were submitted for product ids: ${duplicateProductIds.slice(0, 10).join(', ')}` })
    }

    const missingProductIds = body.rows
      .map((row) => row.productId)
      .filter((productId) => !packetRowByProductId.has(productId))
    if (missingProductIds.length > 0) {
      return reply.status(400).send({ error: `The packet does not contain product ids: ${missingProductIds.slice(0, 10).join(', ')}` })
    }

    const submissionId = randomUUID()
    const resultsHref = `submissions/${submissionId}.json`
    const submission = buildSubmissionState(packet, packetPath, resultsHref, body.rows, packetRowByProductId)
    submission.submissionId = submissionId
    submissions.set(submissionId, submission)
    activeSubmissionId = submissionId
    try {
      await persistSubmission(submissionsDir, submission)
    } catch (error) {
      submissions.delete(submissionId)
      if (activeSubmissionId === submissionId) {
        activeSubmissionId = null
      }
      throw error
    }

    void processSubmission({
      packetPath,
      submission,
      submissions,
      submissionsDir,
    }).finally(() => {
      if (activeSubmissionId === submissionId) {
        activeSubmissionId = null
      }
    })

    return reply.status(202).send(buildSubmissionResponse(submission))
  })

  server.post('/api/pricing-review/drafts', async (request, reply) => {
    const { packet, packetRowByProductId } = await readPacketContext(packetPath)
    const validGroupKeys = collectPacketHierarchyGroupKeys(flattenPacketRows(packet))
    const body = DraftRequestSchema.parse(request.body ?? {})
    if (body.packetId !== packet.packetId) {
      return reply.status(409).send({ error: 'Packet id mismatch. Refresh the packet page and try saving again.' })
    }

    const missingProductIds = body.rows
      .map((row) => row.productId)
      .filter((productId) => !packetRowByProductId.has(productId))
    if (missingProductIds.length > 0) {
      return reply.status(400).send({ error: `The packet does not contain product ids: ${missingProductIds.slice(0, 10).join(', ')}` })
    }

    const invalidGroupKeys = body.groupFollowUpNotes
      .map((group) => group.groupKey)
      .filter((groupKey) => !validGroupKeys.has(groupKey))
    if (invalidGroupKeys.length > 0) {
      return reply.status(400).send({ error: `The packet does not contain hierarchy groups: ${invalidGroupKeys.slice(0, 10).join(', ')}` })
    }

    const draftId = randomUUID()
    const resultsHref = `drafts/${draftId}.json`
    const draft = buildDraftState(packet, packetPath, resultsHref, body)
    draft.draftId = draftId
    await persistDraft(draftsDir, draft)
    return reply.send(buildDraftResponse(draft, { includeRows: false }))
  })

  server.get('/api/pricing-review/drafts/latest', async (_request, reply) => {
    const packet = await readPacketReport(packetPath)
    const latestDraft = await readLatestDraft(draftsDir, packet)
    if (!latestDraft) {
      return reply.status(404).send({ error: 'No saved review draft exists for this packet yet.' })
    }
    return reply.send(buildDraftResponse(latestDraft, { includeRows: true }))
  })

  server.get('/api/pricing-review/submissions/:submissionId', async (request, reply) => {
    const submissionId = z.string().parse((request.params as { submissionId?: string }).submissionId)
    const liveSubmission = submissions.get(submissionId)
    if (liveSubmission) {
      return reply.send(buildSubmissionResponse(liveSubmission))
    }

    const persistedPath = join(submissionsDir, `${submissionId}.json`)
    try {
      const persisted = JSON.parse(await readFile(persistedPath, 'utf8')) as SubmissionState
      return reply.send(buildSubmissionResponse(persisted))
    } catch {
      return reply.status(404).send({ error: 'Submission not found.' })
    }
  })

  await server.register(fastifyStatic, {
    root: packetDir,
  })

  server.get('/', async (_request, reply) => reply.sendFile('index.html'))

  await server.listen({ host: '127.0.0.1', port })

  console.log(`Bronx + Midtown pricing review service listening at http://127.0.0.1:${port}`)
  console.log(`Serving packet from ${packetPath}`)
  console.log(`Draft ledgers will be written under ${draftsDir}`)
  console.log(`Submission ledgers will be written under ${submissionsDir}`)
}

function parseCliArgs(argv: string[]): { packetJsonPath: string; port: number } {
  let packetJsonPath = DEFAULT_PACKET_JSON_PATH
  let port = DEFAULT_PORT

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if ((argument === '--packet' || argument === '--packet-json') && argv[index + 1]) {
      packetJsonPath = argv[index + 1] as string
      index += 1
      continue
    }
    if (argument === '--port' && argv[index + 1]) {
      const parsed = Number.parseInt(argv[index + 1] as string, 10)
      if (Number.isInteger(parsed) && parsed > 0) {
        port = parsed
      }
      index += 1
    }
  }

  return { packetJsonPath, port }
}

async function readPacketReport(packetPath: string): Promise<PacketReport> {
  return PacketReportSchema.parse(JSON.parse(await readFile(packetPath, 'utf8')))
}

async function readPacketContext(packetPath: string): Promise<{
  packet: PacketReport
  packetRowByProductId: Map<number, PacketRow>
}> {
  const packet = await readPacketReport(packetPath)
  const packetRows = flattenPacketRows(packet)
  return {
    packet,
    packetRowByProductId: new Map(packetRows.map((row) => [row.productId, row])),
  }
}

function flattenPacketRows(packet: PacketReport): PacketRow[] {
  return packet.groups.flatMap((group) => group.generatedProducts)
}

function buildSubmissionState(
  packet: PacketReport,
  packetPath: string,
  resultsHref: string,
  requestedRows: Array<z.infer<typeof SubmissionRowRequestSchema>>,
  packetRowByProductId: Map<number, PacketRow>,
): SubmissionState {
  const rows = requestedRows.map((requestRow) => {
    const packetRow = packetRowByProductId.get(requestRow.productId)
    if (!packetRow) {
      throw new Error(`Missing packet row for product ${requestRow.productId}`)
    }
    return {
      actionLabel: packetRow.actionLabel,
      afterLivePrice: null,
      beforeLivePrice: null,
      currentPacketPrice: packetRow.currentPrice,
      editApplied: false,
      errorMessage: null,
      groupId: packetRow.groupId,
      groupName: packetRow.groupName,
      isActionable: packetRow.isActionable,
      productId: packetRow.productId,
      productName: packetRow.productName,
      proposedPacketPrice: packetRow.proposedPrice,
      reviewedPrice: normalizeReviewedPrice(requestRow.reviewedPrice),
      status: 'pending',
      verifiedTargetPrice: false,
    } satisfies SubmissionRowResult
  })

  const summary = summarizeSubmissionRows(rows)
  return {
    errorMessage: null,
    finishedAt: null,
    packetGeneratedAt: packet.generatedAt,
    packetId: packet.packetId,
    packetPath,
    requestedAt: nowIso(),
    resultsHref,
    rows,
    startedAt: null,
    stateContext: null,
    status: 'queued',
    submissionId: '',
    summary,
  }
}

function buildDraftState(
  packet: PacketReport,
  packetPath: string,
  resultsHref: string,
  request: z.infer<typeof DraftRequestSchema>,
): DraftState {
  return {
    brandMetadata: normalizeBrandMetadata(request.brandMetadata),
    draftId: '',
    groupFollowUpNotes: request.groupFollowUpNotes,
    note: request.note ?? null,
    packetGeneratedAt: packet.generatedAt,
    packetId: packet.packetId,
    packetPath,
    resultsHref,
    rows: request.rows,
    savedAt: nowIso(),
    summary: summarizeDraftRows(packet, request.rows, request.groupFollowUpNotes),
  }
}

async function processSubmission(input: {
  packetPath: string
  submission: SubmissionState
  submissions: Map<string, SubmissionState>
  submissionsDir: string
}): Promise<void> {
  const { submission, submissionsDir } = input

  try {
    const env = getWorkerEnv()
    submission.status = 'running'
    submission.startedAt = nowIso()
    submission.stateContext = await readSweedDealerContext(env.sweedStateDealerId)
    submission.summary = summarizeSubmissionRows(submission.rows)
    await persistSubmission(submissionsDir, submission)

    for (const row of submission.rows) {
      if (row.reviewedPrice === null) {
        row.status = 'blank'
        submission.summary = summarizeSubmissionRows(submission.rows)
        await persistSubmission(submissionsDir, submission)
        continue
      }

      try {
        const beforeDetail = await getProductDetail(row.productId)
        const beforeSummary = parseLiveProductSummary(beforeDetail)
        row.beforeLivePrice = beforeSummary.price

        if (pricesMatch(beforeSummary.price, row.reviewedPrice)) {
          row.afterLivePrice = beforeSummary.price
          row.status = 'already_matching'
          row.verifiedTargetPrice = true
        } else {
          await editProductPrice(row.productId, row.reviewedPrice)
          const settledDetail = await waitForProductPrice(row.productId, row.reviewedPrice)
          const settledSummary = parseLiveProductSummary(settledDetail)
          row.afterLivePrice = settledSummary.price
          row.editApplied = true
          row.status = pricesMatch(settledSummary.price, row.reviewedPrice) ? 'applied' : 'failed'
          row.verifiedTargetPrice = pricesMatch(settledSummary.price, row.reviewedPrice)
          if (!row.verifiedTargetPrice) {
            row.errorMessage = `Live verify failed for product ${row.productId}; expected ${formatMoney(row.reviewedPrice)}, observed ${formatMoney(settledSummary.price)}.`
          }
        }
      } catch (error) {
        row.status = 'failed'
        row.errorMessage = error instanceof Error ? error.message : 'Unknown row-level apply error.'
      }

      submission.summary = summarizeSubmissionRows(submission.rows)
      await persistSubmission(submissionsDir, submission)
    }

    submission.status = submission.summary.failedCount > 0 ? 'completed_with_errors' : 'completed'
    if (submission.summary.failedCount > 0) {
      submission.errorMessage = 'At least one reviewed price failed. Inspect the results ledger for row-level details.'
    }
  } catch (error) {
    submission.status = 'failed'
    submission.errorMessage = error instanceof Error ? error.message : 'Unknown submission failure.'
  } finally {
    submission.finishedAt = nowIso()
    submission.summary = summarizeSubmissionRows(submission.rows)
    input.submissions.set(submission.submissionId, submission)
    await persistSubmission(submissionsDir, submission)
  }
}

function summarizeSubmissionRows(rows: SubmissionRowResult[]): SubmissionSummary {
  return {
    alreadyMatchingCount: rows.filter((row) => row.status === 'already_matching').length,
    appliedCount: rows.filter((row) => row.status === 'applied').length,
    blankCount: rows.filter((row) => row.status === 'blank').length,
    failedCount: rows.filter((row) => row.status === 'failed').length,
    plannedWriteCount: rows.filter((row) => row.reviewedPrice !== null && !pricesMatch(row.currentPacketPrice, row.reviewedPrice)).length,
    processedCount: rows.filter((row) => row.status !== 'pending').length,
    requestedRowCount: rows.length,
  }
}

function buildDraftResponse(
  draft: DraftState,
  options: { includeRows: boolean },
): Record<string, unknown> {
  return {
    brandMetadata: draft.brandMetadata,
    draftId: draft.draftId,
    groupFollowUpNotes: draft.groupFollowUpNotes,
    note: draft.note,
    packetGeneratedAt: draft.packetGeneratedAt,
    packetId: draft.packetId,
    ...(options.includeRows ? { rows: draft.rows } : {}),
    resultsHref: draft.resultsHref,
    savedAt: draft.savedAt,
    summary: draft.summary,
  }
}

function buildSubmissionResponse(submission: SubmissionState): Record<string, unknown> {
  return {
    errorMessage: submission.errorMessage,
    finishedAt: submission.finishedAt,
    requestedAt: submission.requestedAt,
    resultsHref: submission.resultsHref,
    startedAt: submission.startedAt,
    stateContext: submission.stateContext,
    status: submission.status,
    submissionId: submission.submissionId,
    summary: submission.summary,
  }
}

async function persistSubmission(submissionsDir: string, submission: SubmissionState): Promise<void> {
  await mkdir(submissionsDir, { recursive: true })
  const outputPath = join(submissionsDir, `${submission.submissionId}.json`)
  await writeFile(outputPath, `${JSON.stringify(submission, null, 2)}\n`, 'utf8')
}

async function persistDraft(draftsDir: string, draft: DraftState): Promise<void> {
  await mkdir(draftsDir, { recursive: true })
  const outputPath = join(draftsDir, `${draft.draftId}.json`)
  await writeFile(outputPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8')
}

async function readLatestDraft(draftsDir: string, packet: PacketReport): Promise<DraftState | null> {
  const entries = await readdir(draftsDir, { withFileTypes: true })
  const drafts = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      try {
        const rawDraft = JSON.parse(await readFile(join(draftsDir, entry.name), 'utf8'))
        return normalizePersistedDraft(rawDraft, packet)
      } catch {
        return null
      }
    }))

  return drafts
    .filter((draft): draft is DraftState => draft !== null)
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt))[0] ?? null
}

function normalizePersistedDraft(rawDraft: unknown, packet: PacketReport): DraftState {
  const parsed = PersistedDraftStateSchema.parse(rawDraft)
  return {
    brandMetadata: normalizeBrandMetadata(parsed.brandMetadata),
    draftId: parsed.draftId,
    groupFollowUpNotes: parsed.groupFollowUpNotes,
    note: parsed.note ?? null,
    packetGeneratedAt: parsed.packetGeneratedAt,
    packetId: parsed.packetId,
    packetPath: parsed.packetPath,
    resultsHref: parsed.resultsHref,
    rows: parsed.rows,
    savedAt: parsed.savedAt,
    summary: summarizeDraftRows(packet, parsed.rows, parsed.groupFollowUpNotes),
  }
}

function summarizeDraftRows(
  packet: PacketReport,
  rows: Array<z.infer<typeof DraftRowSchema>>,
  groupFollowUpNotes: Array<z.infer<typeof DraftGroupFollowUpSchema>> = [],
): DraftSummary {
  return summarizePricingReviewDraft(
    flattenPacketRows(packet).map((row) => ({
      hierarchy: row.hierarchy ?? null,
      productId: row.productId,
    })),
    rows as PricingReviewDraftRow[],
    groupFollowUpNotes as PricingReviewDraftGroupFollowUp[],
  )
}

function normalizeBrandMetadata(
  metadata: Array<z.infer<typeof DraftBrandMetadataSchema>>,
): PricingReviewBrandMetadata[] {
  return metadata
    .map((entry) => ({
      brandKey: entry.brandKey,
      isMso: entry.isMso,
      label: entry.label,
      note: entry.note,
    }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.brandKey.localeCompare(right.brandKey))
}

function parseLiveProductSummary(detail: unknown): LiveProductSummary {
  const product = ProductDetailResponseSchema.parse(detail).product
  return {
    id: product.id,
    name: product.name ?? null,
    price: product.priceInfo?.actualPrice ?? product.price ?? null,
    shortName: product.shortName ?? null,
  }
}

function normalizeReviewedPrice(value: number | null): number | null {
  if (value === null) {
    return null
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Reviewed price ${value} is invalid.`)
  }
  return Math.round(value * 100) / 100
}

function findDuplicateProductIds(rows: Array<z.infer<typeof SubmissionRowRequestSchema>>): number[] {
  const seen = new Set<number>()
  const duplicates = new Set<number>()
  for (const row of rows) {
    if (seen.has(row.productId)) {
      duplicates.add(row.productId)
    }
    seen.add(row.productId)
  }
  return [...duplicates].sort((left, right) => left - right)
}

function pricesMatch(left: number | null, right: number | null): boolean {
  if (left === null || right === null) {
    return left === right
  }
  return Math.abs(left - right) < 0.01
}

function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a'
  }
  return `$${value.toFixed(2)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
