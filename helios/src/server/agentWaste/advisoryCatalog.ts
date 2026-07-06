/**
 * Server-side advisory-catalog contract validation + safe editing
 * (issue #61 — the promote-to-advisory button).
 *
 * The reviewed advisory catalog lives in `advisories.yaml` in
 * virusdave/top-level. Its contract is
 * `docs/agent-runtime/ADVISORY_CATALOG.md`: schema v1, hard budget caps,
 * ranking inputs, per-entry id/enum/token rules. The github-worker selector
 * injects ONLY the `text` of top-ranked, in-budget entries into future
 * agents; a catalog that parses but violates a hard rule is a LOUD failure,
 * never a silent skip.
 *
 * This module is the server-side gate the promote path runs BEFORE any git
 * write: it validates the whole resulting catalog against the contract and
 * rejects invalid promotions before anything is committed. It also owns the
 * SAFE textual edit (append one single-line flow-mapping entry) that
 * preserves the file's comments and one-line-per-entry convention — a full
 * js-yaml re-dump would destroy both.
 */

import yaml from 'js-yaml'

import {
  ADVISORY_BUDGET_MAX_ADVISORIES_CEILING,
  ADVISORY_BUDGET_MAX_TOTAL_TOKENS_CEILING,
  ADVISORY_DEFAULT_EXPIRES_AFTER_DAYS_MAX,
  ADVISORY_DEFAULT_EXPIRES_AFTER_DAYS_MIN,
  ADVISORY_ID_PATTERN,
  estimateAdvisoryTokens,
} from '../../shared/contracts/api/agentWaste.js'

/** A fully-formed catalog entry as it appears in `advisories.yaml`. */
export interface AdvisoryEntry {
  id: string
  status: 'active' | 'permanent-safety' | 'retired'
  scope: string
  severity: 'low' | 'medium' | 'high' | 'safety'
  max_tokens: number
  text: string
  trigger_ids: string[]
  expires_after_days?: number
  promote_to_guardrail?: boolean
  added: string
  notes?: string
}

export interface AdvisoryCatalog {
  version: number
  budget: {
    max_total_tokens: number
    max_advisories: number
    default_expires_after_days: number
  }
  ranking: {
    severity_weights: Record<string, number>
    recurrence_window_days: number
    age_halflife_days: number
  }
  advisories: AdvisoryEntry[]
}

export interface CatalogValidationResult {
  ok: boolean
  /** Human-readable violations; empty iff ok. */
  errors: string[]
  /** The parsed catalog when structurally sound enough to inspect. */
  catalog?: AdvisoryCatalog
}

const ALLOWED_TOP_LEVEL_KEYS = new Set(['version', 'budget', 'ranking', 'advisories'])
const ALLOWED_BUDGET_KEYS = new Set([
  'max_total_tokens',
  'max_advisories',
  'default_expires_after_days',
])
const ALLOWED_RANKING_KEYS = new Set([
  'severity_weights',
  'recurrence_window_days',
  'age_halflife_days',
])
const ALLOWED_ENTRY_KEYS = new Set([
  'id',
  'status',
  'scope',
  'severity',
  'max_tokens',
  'text',
  'trigger_ids',
  'expires_after_days',
  'promote_to_guardrail',
  'added',
  'notes',
])
const VALID_STATUSES = new Set(['active', 'permanent-safety', 'retired'])
const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'safety'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(obj).filter((k) => !allowed.has(k))
}

function isValidScope(scope: unknown): boolean {
  return typeof scope === 'string' && (scope === 'global' || /^repo:[^\s/]+\/[^\s/]+$/.test(scope))
}

/**
 * Parse + fully validate a catalog YAML string against the contract. Returns
 * every violation found (not just the first) so the caller can surface a
 * complete rejection reason. `ok` is true only for a contract-clean catalog.
 */
export function validateCatalogYaml(raw: string): CatalogValidationResult {
  let doc: unknown
  try {
    doc = yaml.load(raw)
  } catch (err) {
    return { ok: false, errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`] }
  }
  return validateCatalog(doc)
}

/** Validate an already-parsed catalog object against the contract. */
export function validateCatalog(doc: unknown): CatalogValidationResult {
  const errors: string[] = []

  if (!isPlainObject(doc)) {
    return { ok: false, errors: ['catalog root must be a mapping'] }
  }

  const extraTop = unknownKeys(doc, ALLOWED_TOP_LEVEL_KEYS)
  if (extraTop.length > 0) errors.push(`unknown top-level key(s): ${extraTop.join(', ')}`)

  if (doc.version !== 1) errors.push(`version must be 1 (got ${JSON.stringify(doc.version)})`)

  // ── budget ──
  const budget = doc.budget
  if (!isPlainObject(budget)) {
    errors.push('budget must be a mapping')
  } else {
    const extra = unknownKeys(budget, ALLOWED_BUDGET_KEYS)
    if (extra.length > 0) errors.push(`unknown budget key(s): ${extra.join(', ')}`)
    if (!isInteger(budget.max_total_tokens) || budget.max_total_tokens <= 0) {
      errors.push('budget.max_total_tokens must be a positive integer')
    } else if (budget.max_total_tokens > ADVISORY_BUDGET_MAX_TOTAL_TOKENS_CEILING) {
      errors.push(
        `budget.max_total_tokens must be ≤ ${ADVISORY_BUDGET_MAX_TOTAL_TOKENS_CEILING} (got ${budget.max_total_tokens})`,
      )
    }
    if (!isInteger(budget.max_advisories) || budget.max_advisories <= 0) {
      errors.push('budget.max_advisories must be a positive integer')
    } else if (budget.max_advisories > ADVISORY_BUDGET_MAX_ADVISORIES_CEILING) {
      errors.push(
        `budget.max_advisories must be ≤ ${ADVISORY_BUDGET_MAX_ADVISORIES_CEILING} (got ${budget.max_advisories})`,
      )
    }
    if (!isInteger(budget.default_expires_after_days)) {
      errors.push('budget.default_expires_after_days must be an integer')
    } else if (
      budget.default_expires_after_days < ADVISORY_DEFAULT_EXPIRES_AFTER_DAYS_MIN ||
      budget.default_expires_after_days > ADVISORY_DEFAULT_EXPIRES_AFTER_DAYS_MAX
    ) {
      errors.push(
        `budget.default_expires_after_days must be in [${ADVISORY_DEFAULT_EXPIRES_AFTER_DAYS_MIN}, ${ADVISORY_DEFAULT_EXPIRES_AFTER_DAYS_MAX}] (got ${budget.default_expires_after_days})`,
      )
    }
  }

  // ── ranking ──
  const ranking = doc.ranking
  let severityWeightKeys: Set<string> = new Set()
  if (!isPlainObject(ranking)) {
    errors.push('ranking must be a mapping')
  } else {
    const extra = unknownKeys(ranking, ALLOWED_RANKING_KEYS)
    if (extra.length > 0) errors.push(`unknown ranking key(s): ${extra.join(', ')}`)
    if (!isPlainObject(ranking.severity_weights)) {
      errors.push('ranking.severity_weights must be a mapping')
    } else {
      severityWeightKeys = new Set(Object.keys(ranking.severity_weights))
      for (const [k, v] of Object.entries(ranking.severity_weights)) {
        if (!VALID_SEVERITIES.has(k)) {
          errors.push(`unknown ranking.severity_weights key "${k}" (must be one of low|medium|high|safety)`)
        }
        if (typeof v !== 'number' || !(v > 0)) {
          errors.push(`ranking.severity_weights.${k} must be a number > 0`)
        }
      }
    }
    if (!isInteger(ranking.recurrence_window_days) || ranking.recurrence_window_days <= 0) {
      errors.push('ranking.recurrence_window_days must be a positive integer')
    }
    if (typeof ranking.age_halflife_days !== 'number' || !(ranking.age_halflife_days > 0)) {
      errors.push('ranking.age_halflife_days must be a number > 0')
    }
  }

  const budgetMaxTotalTokens =
    isPlainObject(budget) && isInteger(budget.max_total_tokens) ? budget.max_total_tokens : undefined

  // ── advisories ──
  const advisories = doc.advisories
  if (!Array.isArray(advisories)) {
    errors.push('advisories must be a list')
  } else {
    const seenIds = new Set<string>()
    advisories.forEach((entry, i) => {
      const at = `advisories[${i}]`
      if (!isPlainObject(entry)) {
        errors.push(`${at} must be a mapping`)
        return
      }
      const extra = unknownKeys(entry, ALLOWED_ENTRY_KEYS)
      if (extra.length > 0) errors.push(`${at} has unknown field(s): ${extra.join(', ')}`)

      // id
      if (typeof entry.id !== 'string' || entry.id.length === 0) {
        errors.push(`${at}.id must be a non-empty string`)
      } else {
        if (!ADVISORY_ID_PATTERN.test(entry.id)) errors.push(`${at}.id "${entry.id}" must be kebab-case`)
        if (seenIds.has(entry.id)) errors.push(`${at}.id "${entry.id}" is duplicated`)
        seenIds.add(entry.id)
      }

      // status
      if (typeof entry.status !== 'string' || !VALID_STATUSES.has(entry.status)) {
        errors.push(`${at}.status must be one of active|permanent-safety|retired`)
      }
      // scope
      if (!isValidScope(entry.scope)) {
        errors.push(`${at}.scope must be "global" or "repo:<owner>/<repo>"`)
      }
      // severity
      const severityOk = typeof entry.severity === 'string' && VALID_SEVERITIES.has(entry.severity)
      if (!severityOk) {
        errors.push(`${at}.severity must be one of low|medium|high|safety`)
      } else if (severityWeightKeys.size > 0 && !severityWeightKeys.has(entry.severity as string)) {
        errors.push(`${at}.severity "${entry.severity}" has no ranking.severity_weights entry`)
      }
      // max_tokens
      const maxTokensOk = isInteger(entry.max_tokens) && entry.max_tokens > 0
      if (!maxTokensOk) {
        errors.push(`${at}.max_tokens must be a positive integer`)
      } else if (budgetMaxTotalTokens !== undefined && (entry.max_tokens as number) > budgetMaxTotalTokens) {
        errors.push(`${at}.max_tokens (${entry.max_tokens}) must be ≤ budget.max_total_tokens (${budgetMaxTotalTokens})`)
      }
      // text
      if (typeof entry.text !== 'string' || entry.text.trim().length === 0) {
        errors.push(`${at}.text must be a non-empty string`)
      } else if (maxTokensOk) {
        const tk = estimateAdvisoryTokens(entry.text)
        if (tk > (entry.max_tokens as number)) {
          errors.push(`${at}.text is ~${tk} tokens, over max_tokens=${entry.max_tokens}`)
        }
      }
      // trigger_ids
      if (entry.trigger_ids !== undefined) {
        if (!Array.isArray(entry.trigger_ids) || entry.trigger_ids.some((t) => typeof t !== 'string')) {
          errors.push(`${at}.trigger_ids must be a list of strings`)
        }
      }
      // status-conditional rules
      if (entry.status === 'active') {
        const hasTriggers = Array.isArray(entry.trigger_ids) && entry.trigger_ids.length > 0
        if (!hasTriggers) errors.push(`${at} is active but has no trigger_ids`)
      }
      if (entry.status === 'permanent-safety' && entry.expires_after_days !== undefined) {
        errors.push(`${at} is permanent-safety and must not set expires_after_days`)
      }
      if (entry.expires_after_days !== undefined && (!isInteger(entry.expires_after_days) || entry.expires_after_days <= 0)) {
        errors.push(`${at}.expires_after_days must be a positive integer`)
      }
      if (entry.promote_to_guardrail !== undefined && typeof entry.promote_to_guardrail !== 'boolean') {
        errors.push(`${at}.promote_to_guardrail must be a boolean`)
      }
      if (typeof entry.added !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.added)) {
        errors.push(`${at}.added must be a YYYY-MM-DD date`)
      }
      if (entry.notes !== undefined && typeof entry.notes !== 'string') {
        errors.push(`${at}.notes must be a string`)
      }
    })
  }

  const ok = errors.length === 0
  return { ok, errors, catalog: ok ? (doc as unknown as AdvisoryCatalog) : undefined }
}

/**
 * Serialize a single advisory entry as a one-line YAML flow mapping, indented
 * as a block-sequence item (`  - { ... }`). Field order follows the contract
 * (`ADVISORY_CATALOG.md`) so the file stays readable. Optional fields are
 * emitted only when present. Throws if the result is not a single line
 * (which would indicate an unexpected control char that slipped validation).
 */
export function renderAdvisoryEntryLine(entry: AdvisoryEntry): string {
  // Build with keys in contract order; js-yaml preserves insertion order.
  const ordered: Record<string, unknown> = {
    id: entry.id,
    status: entry.status,
    scope: entry.scope,
    severity: entry.severity,
    max_tokens: entry.max_tokens,
    text: entry.text,
    trigger_ids: entry.trigger_ids,
  }
  if (entry.expires_after_days !== undefined) ordered.expires_after_days = entry.expires_after_days
  if (entry.promote_to_guardrail !== undefined) ordered.promote_to_guardrail = entry.promote_to_guardrail
  ordered.added = entry.added
  if (entry.notes !== undefined) ordered.notes = entry.notes

  const flow = yaml
    .dump(ordered, { flowLevel: 0, lineWidth: -1, quotingType: '"', forceQuotes: false })
    .trim()
  if (flow.includes('\n')) {
    throw new Error('advisory entry did not serialize to a single line')
  }
  return `  - ${flow}`
}

export type InsertResult =
  | { ok: true; text: string }
  | { ok: false; code: 'catalog_edit_unsupported'; message: string }

/**
 * Insert a rendered entry line into the `advisories:` block of the catalog
 * file, preserving all comments and existing entries. Handles both the empty
 * inline form (`advisories: []`) and an existing block sequence. Refuses
 * (rather than guessing) if the section shape is ambiguous. The caller MUST
 * re-parse + re-validate the returned text as the final safety net.
 */
export function insertAdvisoryEntry(fileText: string, entryLine: string): InsertResult {
  const lines = fileText.split('\n')

  // Locate the top-level `advisories:` key (column 0).
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^advisories:\s*(.*)$/.test(lines[i])) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) {
    return { ok: false, code: 'catalog_edit_unsupported', message: 'no top-level `advisories:` key found' }
  }

  const inlineValue = lines[headerIdx].match(/^advisories:\s*(.*)$/)![1].trim()

  // Existing block sequence: insert after the last `  - ` item, regardless of
  // whether the header line carried an empty inline value.
  const lastItem = findLastBlockItem(lines, headerIdx)
  if (lastItem !== -1) {
    const next = [...lines]
    next.splice(lastItem + 1, 0, entryLine)
    return { ok: true, text: next.join('\n') }
  }

  // No block items yet. Only the empty inline list (`[]`) or a bare
  // `advisories:` header can be safely converted to a one-item sequence.
  if (inlineValue === '[]' || inlineValue === '') {
    const next = [...lines]
    next.splice(headerIdx, 1, 'advisories:', entryLine)
    return { ok: true, text: next.join('\n') }
  }

  // Any other inline value (e.g. a flow list `[ {..} ]`) is not a shape we
  // safely append to line-by-line.
  return {
    ok: false,
    code: 'catalog_edit_unsupported',
    message: `advisories: has an unsupported inline value: ${inlineValue.slice(0, 40)}`,
  }
}

/**
 * Index of the last `  - ` block-sequence item belonging to the advisories
 * section (which ends at the next top-level key at column 0), or -1 if the
 * section has no block items.
 */
function findLastBlockItem(lines: string[], headerIdx: number): number {
  let lastItem = -1
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^ {2}- /.test(line)) {
      lastItem = i
      continue
    }
    // Blank lines and comments do not end the section.
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    // Any other content at column 0 is the next top-level key: section over.
    if (/^\S/.test(line)) break
  }
  return lastItem
}
