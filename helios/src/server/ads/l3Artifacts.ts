// GAds evolver introspection — L3 feedback-adoption read path (V1, P6).
//
// Backs the L3 section of GET /api/gads/enrichment
// (helios/src/server/routes/gadsEnrichment.ts), the "L3 feedback-adoption"
// panel of the per-site /metrics/gads-<site>/evolution page (parent epic
// virusdave/top-level#24, child automation#51, EPIC_PLAN §6 item 5).
//
// L3 is the meta-analysis layer: run-l3-analysis.ts evaluates the L2
// hill-climbing loop's predictions vs observed outcomes and writes prompt/
// rule update proposals plus a short natural-language `config/l3-addenda.md`
// the L2 predictor reads on its next run (closing the feedback loop). This
// reader indexes those on-disk artifacts and reports:
//   * the newest L3 evaluation summary (counts only — bounded free text),
//   * `l3-addenda.md` freshness + sha256 + parsed generated-by header,
//   * a best-effort "did a later L2 run consume the addenda?" heuristic.
//
// Hard rules (Oracle P6 design review):
//   * Fixed, server-resolved paths only — the endpoint accepts no file
//     name. Read under the explicitly configured automation checkout's
//     ads/google/{outputs/l3,
//     outputs/prod/json,config/l3-addenda.md}.
//   * Bounded reads: skip oversized files, cap parsed arrays, only read
//     regular files (no symlinks/dirs).
//   * Degrade gracefully: a missing outputs/ tree (it only exists on prod,
//     owned helios:helios) yields an honest empty state, never a throw.
//   * Deterministic ordering so the "latest" pick is stable.
//   * Do NOT import ads/google TS types (cross-package build hazard) —
//     parse only the few fields we need with local guards.

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { getConfiguredRepositoryRoot } from './configuredRepositoryRoot.js'

/** Max L3 evaluation JSON size we will read (bytes). */
const L3_EVAL_MAX_BYTES = 2 * 1024 * 1024
/** Max L2 output JSON size we will read just to pull run_id/generated_at. */
const L2_OUTPUT_MAX_BYTES = 16 * 1024 * 1024
/** Max addenda size we will hash/read (bytes). */
const ADDENDA_MAX_BYTES = 256 * 1024
/** Max evaluation files we will stat/scan (newest by mtime win). */
const L3_EVAL_SCAN_CAP = 500
/** Max L2 output files we will scan for the consumption heuristic. */
const L2_OUTPUT_SCAN_CAP = 500
/** Top proposals returned (by confidence). */
export const L3_TOP_PROPOSALS_LIMIT = 5
/** Top addenda bullets returned. */
export const L3_TOP_BULLETS_LIMIT = 3

const L3_DIR = path.join('ads', 'google', 'outputs', 'l3')
const L2_JSON_DIR = path.join('ads', 'google', 'outputs', 'prod', 'json')
const ADDENDA_FILE = path.join('ads', 'google', 'config', 'l3-addenda.md')

export interface L3Proposal {
  updateType: string
  component: string
  rationale: string
  expectedImpact: string
  confidence: number | null
}

export interface L3LatestEvaluation {
  evaluationId: string
  generatedAt: string | null
  l2RunsAnalyzedCount: number
  trialsAnalyzed: number
  promptUpdateCount: number
  ruleUpdateCount: number
  requiresHumanApproval: boolean
  /** Full bounded proposal list (free text); the route redacts per-site. */
  topProposals: L3Proposal[]
  topProposalsTruncated: boolean
}

export interface L3Addenda {
  exists: boolean
  sha256: string | null
  bytes: number | null
  modifiedAt: string | null
  generatedAt: string | null
  generatedByEvaluationId: string | null
  l2RunsReferencedCount: number | null
  /** Full bounded bullet list (free text); the route redacts per-site. */
  topBullets: string[]
}

export interface L3Consumption {
  status: 'likely_consumed' | 'not_yet_consumed' | 'unknown'
  basis: 'addenda_header_generated_at' | 'addenda_mtime' | 'none'
  newestL2RunId: string | null
  newestL2RunAt: string | null
}

/** The raw (un-redacted) L3 artifact summary. The route applies per-site
 *  redaction before shaping the contract response. */
export interface L3ArtifactSummary {
  available: boolean
  evaluationsIndexed: number
  evaluationParseErrors: number
  latest: L3LatestEvaluation | null
  addenda: L3Addenda
  consumption: L3Consumption
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)
}
function asIntField(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}
function asConfidence(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
function toIso(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function proposalFrom(v: unknown): L3Proposal {
  const r = isRecord(v) ? v : {}
  return {
    updateType: asStr(r.update_type) || 'unknown',
    component: asStr(r.component),
    rationale: asStr(r.rationale),
    expectedImpact: asStr(r.expected_impact),
    confidence: asConfidence(r.confidence),
  }
}

/** List regular files in `dir` matching `suffix`; [] if the dir is absent.
 *  Deterministic: matching names are sorted newest-first (descending — the
 *  `run-YYYY-MM-DD-...` / `eval-...` naming sorts sensibly) BEFORE the cap,
 *  so a >cap directory still keeps the freshest files rather than an
 *  arbitrary readdir-order prefix. Symlinks/dirs are skipped via the
 *  dirent type (never followed). */
async function listFiles(dir: string, suffix: string, cap: number): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw err
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(suffix))
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(0, cap)
}

/** Read + JSON.parse a bounded regular file; null on absent/oversized/bad. */
async function readBoundedJson(
  absPath: string,
  maxBytes: number,
): Promise<{ data: unknown; mtimeMs: number } | null> {
  let stat: import('node:fs').Stats
  try {
    stat = await fs.stat(absPath)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > maxBytes) return null
  let raw: string
  try {
    raw = await fs.readFile(absPath, 'utf-8')
  } catch {
    return null
  }
  // Re-check size after read (a file can grow between stat and read);
  // enforce the bound on what we actually parse.
  if (Buffer.byteLength(raw, 'utf-8') > maxBytes) return null
  try {
    return { data: JSON.parse(raw), mtimeMs: stat.mtimeMs }
  } catch {
    return null // malformed JSON — caller counts it as a parse error
  }
}

/** Index `*-l3-evaluation.json`, returning the newest valid evaluation. */
async function indexL3Evaluations(
  l3Dir: string,
): Promise<{ indexed: number; parseErrors: number; latest: L3LatestEvaluation | null }> {
  const files = await listFiles(l3Dir, '-l3-evaluation.json', L3_EVAL_SCAN_CAP)
  let parseErrors = 0
  let best: { eval: L3LatestEvaluation; sortKey: number; name: string } | null = null

  for (const name of files) {
    const parsed = await readBoundedJson(path.join(l3Dir, name), L3_EVAL_MAX_BYTES)
    if (parsed === null || !isRecord(parsed.data)) {
      parseErrors += 1
      continue
    }
    const d = parsed.data
    const promptUpdates = Array.isArray(d.prompt_updates) ? d.prompt_updates : []
    const ruleUpdates = Array.isArray(d.rule_updates) ? d.rule_updates : []
    const l2Runs = Array.isArray(d.l2_runs_analyzed) ? d.l2_runs_analyzed : []
    const generatedAt = toIso(d.generated_at)

    // Rank prompt AND rule proposals together (both are "what L3 wants to
    // change"); the per-kind counts above keep the breakdown. Deterministic
    // tie-break (confidence desc, then updateType, then component) so the
    // bounded top-N is stable across runs.
    const proposals = [...promptUpdates, ...ruleUpdates]
      .map(proposalFrom)
      .sort(
        (a, b) =>
          (b.confidence ?? -1) - (a.confidence ?? -1) ||
          a.updateType.localeCompare(b.updateType) ||
          a.component.localeCompare(b.component),
      )
    const topProposals = proposals.slice(0, L3_TOP_PROPOSALS_LIMIT)

    const summary: L3LatestEvaluation = {
      evaluationId: asStr(d.evaluation_id) || name.replace('-l3-evaluation.json', ''),
      generatedAt,
      l2RunsAnalyzedCount: l2Runs.length,
      trialsAnalyzed: asIntField(d.trials_analyzed),
      promptUpdateCount: promptUpdates.length,
      ruleUpdateCount: ruleUpdates.length,
      requiresHumanApproval: d.requires_human_approval !== false,
      topProposals,
      topProposalsTruncated: proposals.length > topProposals.length,
    }

    // Newest by generated_at (valid first), then file mtime, then name.
    const sortKey = generatedAt ? new Date(generatedAt).getTime() : parsed.mtimeMs
    if (
      best === null ||
      sortKey > best.sortKey ||
      (sortKey === best.sortKey && name > best.name)
    ) {
      best = { eval: summary, sortKey, name }
    }
  }

  return { indexed: files.length, parseErrors, latest: best?.eval ?? null }
}

/** Parse the generated-by header comment written by run-l3-analysis.ts:
 *    <!-- Generated by run-l3-analysis.ts at <ISO>.
 *         Evaluation: <id> over L2 runs: <a, b, c>.
 *         DO NOT EDIT BY HAND ... -->
 *  The seed file has no such header (returns nulls). */
function parseAddendaHeader(text: string): {
  generatedAt: string | null
  evaluationId: string | null
  l2RunsReferencedCount: number | null
} {
  const head = text.slice(0, 2048)
  // The ISO timestamp itself contains '.' (millis) and ends in 'Z', so
  // match the ISO-8601 shape rather than "up to the next dot".
  const genMatch = head.match(
    /Generated by run-l3-analysis\.ts at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/,
  )
  const generatedAt = genMatch ? toIso(genMatch[1].trim()) : null
  const evalMatch = head.match(/Evaluation:\s*([^\s]+)\s+over L2 runs:\s*([^\n]*)\./)
  const evaluationId = evalMatch ? evalMatch[1].trim() : null
  let l2RunsReferencedCount: number | null = null
  if (evalMatch) {
    const runs = evalMatch[2]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    l2RunsReferencedCount = runs.length
  }
  return { generatedAt, evaluationId, l2RunsReferencedCount }
}

/** Extract the top markdown "- " bullets (skips headings/comments/blanks). */
function extractBullets(text: string, limit: number): string[] {
  const bullets: string[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/)
    if (m) {
      bullets.push(m[1].trim())
      if (bullets.length >= limit) break
    }
  }
  return bullets
}

async function readAddenda(absPath: string): Promise<L3Addenda> {
  let stat: import('node:fs').Stats
  try {
    stat = await fs.stat(absPath)
  } catch {
    return {
      exists: false,
      sha256: null,
      bytes: null,
      modifiedAt: null,
      generatedAt: null,
      generatedByEvaluationId: null,
      l2RunsReferencedCount: null,
      topBullets: [],
    }
  }
  const modifiedAt = new Date(stat.mtimeMs).toISOString()
  // Present but oversized/irregular: report existence + size, no content.
  if (!stat.isFile() || stat.size > ADDENDA_MAX_BYTES) {
    return {
      exists: true,
      sha256: null,
      bytes: stat.isFile() ? stat.size : null,
      modifiedAt,
      generatedAt: null,
      generatedByEvaluationId: null,
      l2RunsReferencedCount: null,
      topBullets: [],
    }
  }
  let text: string
  try {
    text = await fs.readFile(absPath, 'utf-8')
  } catch {
    return {
      exists: true,
      sha256: null,
      bytes: stat.size,
      modifiedAt,
      generatedAt: null,
      generatedByEvaluationId: null,
      l2RunsReferencedCount: null,
      topBullets: [],
    }
  }
  // Re-check size after read (a file can grow between stat and read).
  if (Buffer.byteLength(text, 'utf-8') > ADDENDA_MAX_BYTES) {
    return {
      exists: true,
      sha256: null,
      bytes: stat.size,
      modifiedAt,
      generatedAt: null,
      generatedByEvaluationId: null,
      l2RunsReferencedCount: null,
      topBullets: [],
    }
  }
  const sha256 = crypto.createHash('sha256').update(text, 'utf-8').digest('hex')
  const header = parseAddendaHeader(text)
  return {
    exists: true,
    sha256,
    bytes: stat.size,
    modifiedAt,
    generatedAt: header.generatedAt,
    generatedByEvaluationId: header.evaluationId,
    l2RunsReferencedCount: header.l2RunsReferencedCount,
    topBullets: extractBullets(text, L3_TOP_BULLETS_LIMIT),
  }
}

/** Find the newest L2 run by generated_at under outputs/prod/json. */
async function newestL2Run(
  l2Dir: string,
): Promise<{ runId: string; generatedAt: string } | null> {
  const files = await listFiles(l2Dir, '-l2-output.json', L2_OUTPUT_SCAN_CAP)
  let best: { runId: string; generatedAt: string; ms: number } | null = null
  for (const name of files) {
    const parsed = await readBoundedJson(path.join(l2Dir, name), L2_OUTPUT_MAX_BYTES)
    if (parsed === null || !isRecord(parsed.data)) continue
    const generatedAt = toIso(parsed.data.generated_at)
    if (generatedAt === null) continue
    const runId = asStr(parsed.data.run_id) || name.replace('-l2-output.json', '')
    const ms = new Date(generatedAt).getTime()
    // Deterministic tie-break on equal timestamps: larger runId wins.
    if (best === null || ms > best.ms || (ms === best.ms && runId > best.runId)) {
      best = { runId, generatedAt, ms }
    }
  }
  return best ? { runId: best.runId, generatedAt: best.generatedAt } : null
}

/**
 * Whether a later L2 run looks to have consumed the current addenda.
 *
 * Heuristic (no addenda-hash is persisted into the L2 output, so this can
 * only be "likely"): compare the newest L2 run's generated_at against the
 * addenda's own timestamp — the header `Generated by ... at` line when
 * present, else the file mtime. `>` (strictly after) avoids counting the
 * very run that produced an addenda as having consumed it. Caveat: L2
 * `generated_at` is a completion time, so a long run that started before
 * but finished after the addenda write is a possible false positive.
 */
function deriveConsumption(
  addenda: L3Addenda,
  l2: { runId: string; generatedAt: string } | null,
): L3Consumption {
  const newestL2RunId = l2?.runId ?? null
  const newestL2RunAt = l2?.generatedAt ?? null
  if (!addenda.exists || l2 === null) {
    return { status: 'unknown', basis: 'none', newestL2RunId, newestL2RunAt }
  }
  const basis: L3Consumption['basis'] = addenda.generatedAt
    ? 'addenda_header_generated_at'
    : addenda.modifiedAt
      ? 'addenda_mtime'
      : 'none'
  const addendaTimeStr = addenda.generatedAt ?? addenda.modifiedAt
  if (basis === 'none' || addendaTimeStr === null) {
    return { status: 'unknown', basis: 'none', newestL2RunId, newestL2RunAt }
  }
  const consumed =
    new Date(l2.generatedAt).getTime() > new Date(addendaTimeStr).getTime()
  return {
    status: consumed ? 'likely_consumed' : 'not_yet_consumed',
    basis,
    newestL2RunId,
    newestL2RunAt,
  }
}

export interface ReadL3ArtifactsArgs {
  /** Override the automation repo root (tests inject a temp dir). */
  readonly repoRoot?: string
}

/** Read + summarise the on-disk L3 artifacts. Never throws on a missing
 *  outputs/ tree (prod-only, helios-owned); returns an honest empty state. */
export async function readL3Artifacts(
  args: ReadL3ArtifactsArgs = {},
): Promise<L3ArtifactSummary> {
  const root = args.repoRoot ?? getConfiguredRepositoryRoot('automation')
  const l3Dir = path.join(root, L3_DIR)
  const l2Dir = path.join(root, L2_JSON_DIR)
  const addendaPath = path.join(root, ADDENDA_FILE)

  const [evals, addenda, l2] = await Promise.all([
    indexL3Evaluations(l3Dir),
    readAddenda(addendaPath),
    newestL2Run(l2Dir),
  ])

  return {
    available: evals.latest !== null,
    evaluationsIndexed: evals.indexed,
    evaluationParseErrors: evals.parseErrors,
    latest: evals.latest,
    addenda,
    consumption: deriveConsumption(addenda, l2),
  }
}
