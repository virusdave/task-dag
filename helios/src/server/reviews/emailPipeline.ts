// Customer-Sentiment Capture (issue #13, A3 phase) — email pipeline.
//
// Resolves an LLM-gated submission → template bucket → recipient
// set → rendered subject/text/html, then queues one row per recipient
// into review_emails. Optionally attempts SMTP delivery via the
// minimal smtpSender module; without SMTP configured every row lands
// as send_status='queued' so the operator UI can still surface that
// the would-be send happened.
//
// Bucket → template (per issue #13 / A3 spec):
//   negative                       → 'negative'
//   lukewarm                       → 'lukewarm'
//   strong-with-text               → 'strong_with_text'
//   strong-no-text                 → (no email — drawing-form-only path)
//   error + degraded_pass=true     → 'lukewarm' (operator-settled fallback)
//   error + degraded_pass=false    → 'negative'
//
// Template kind → recipients (per issue #13 / A3 spec):
//   negative          → review_email_dave + review_email_ops
//   lukewarm          → review_email_dave + review_email_support
//   strong_with_text  → review_email_dave + review_email_ops
//
// The template-file convention lives in renderTemplate():
//   helios/email_templates/reviews/<key>.txt   — first line is subject
//                                                 template, rest is
//                                                 plain-text body.
//   helios/email_templates/reviews/<key>.html  — html body only.
// Substitutions are mustache-lite "{{var}}" tokens (no logic, no
// nesting); unknown vars render as the empty string so a template
// can omit them safely.

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Queryable } from '../db/pool.js'
import type {
  CustomerReviewContactInfoInput,
} from '../../shared/contracts/index.js'
import type { SiteReviewSettingsRow } from '../db/queries/customerReviewsQueries.js'
import { insertReviewEmail } from '../db/queries/customerReviewsQueries.js'
import type { ReviewLlmVerdict } from '../llm/reviewSentimentGate.js'
import { sendEmail, type SendEmailResult } from './smtpSender.js'

export type ReviewEmailTemplateKind =
  | 'negative'
  | 'lukewarm'
  | 'strong_with_text'
  | 'other'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Resolve to repo-root/helios/email_templates/reviews/. Works in
// both the source layout (helios/src/server/reviews/) and the
// compiled layout (helios/dist/server/server/reviews/). We walk up
// to the helios/ directory.
function templatesDir(): string {
  // Walk up to the directory whose name is 'helios' OR whose child
  // 'email_templates' exists. Most callers will land in helios/src/
  // or helios/dist/server/.
  let dir = __dirname
  // Limit climb to avoid an unbounded loop if something is mis-laid.
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, 'email_templates/reviews')
    if (candidate.endsWith('helios/email_templates/reviews') || candidate.endsWith('helios\\email_templates\\reviews')) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fallback to the source-tree location.
  return resolve(__dirname, '../../../email_templates/reviews')
}

// Pure function: render a template string with mustache-lite
// substitutions. Exported so the pipeline tests can exercise the
// substitution layer without touching the filesystem.
export function renderMustacheLite(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : ''
  })
}

// Map A2 verdict + degraded-pass bit to the A3 email template
// bucket. Pure function — exported for tests.
export function pickTemplateKind(
  verdict: ReviewLlmVerdict | null,
  degradedPass: boolean | null,
): ReviewEmailTemplateKind | null {
  if (verdict === null) return null
  if (verdict === 'negative') return 'negative'
  if (verdict === 'lukewarm') return 'lukewarm'
  if (verdict === 'strong-with-text') return 'strong_with_text'
  if (verdict === 'strong-no-text') return null
  if (verdict === 'error') {
    return degradedPass === true ? 'lukewarm' : 'negative'
  }
  return null
}

// Recipient set per template kind. Returns a deduplicated list of
// email addresses from the per-site site_review_settings row;
// drops nulls / empties so a site that hasn't filled in (say)
// review_email_support still works for the buckets that don't need
// it. Exported for tests.
export function resolveRecipients(
  templateKind: ReviewEmailTemplateKind,
  settings: Pick<
    SiteReviewSettingsRow,
    'review_email_dave' | 'review_email_support' | 'review_email_ops'
  >,
): string[] {
  const result: string[] = []
  const push = (addr: string | null) => {
    if (addr === null) return
    const trimmed = addr.trim()
    if (trimmed.length === 0) return
    if (!result.includes(trimmed)) result.push(trimmed)
  }
  if (templateKind === 'negative') {
    push(settings.review_email_dave)
    push(settings.review_email_ops)
  } else if (templateKind === 'lukewarm') {
    push(settings.review_email_dave)
    push(settings.review_email_support)
  } else if (templateKind === 'strong_with_text') {
    push(settings.review_email_dave)
    push(settings.review_email_ops)
  }
  return result
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function indentBlock(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

export interface BuildTemplateVarsInput {
  submissionId: string
  dealerId: number
  siteLabel: string
  starRating: number | null
  reviewText: string | null
  contacts: CustomerReviewContactInfoInput[]
  llmVerdict: ReviewLlmVerdict | null
  degradedPass: boolean | null
  llmRationale: string | null
  providerReviewUrl: string | null
  createdAt: Date
  adminBaseUrl: string
}

// Pure function — produces the variable map fed into the template
// renderer. Exported for tests.
export function buildTemplateVars(input: BuildTemplateVarsInput): Record<string, string> {
  const reviewText = input.reviewText ?? '(no text provided)'
  const contactsLines =
    input.contacts.length === 0
      ? '(no contact info provided)'
      : input.contacts.map((c) => `${c.kind}: ${c.value}`).join('\n')
  const contactsHtml =
    input.contacts.length === 0
      ? '<em>(no contact info provided)</em>'
      : `<ul style="margin: 0; padding-left: 1.25rem;">${input.contacts
          .map((c) => `<li><strong>${escapeHtml(c.kind)}:</strong> ${escapeHtml(c.value)}</li>`)
          .join('')}</ul>`
  const degradedSuffix =
    input.llmVerdict === 'error' && input.degradedPass === true
      ? ' (degraded-pass)'
      : input.llmVerdict === 'error' && input.degradedPass === false
        ? ' (no degraded-pass)'
        : ''
  const adminUrl = new URL(`/reviews/${input.submissionId}`, input.adminBaseUrl).toString()
  return {
    submission_id: input.submissionId,
    dealer_id: String(input.dealerId),
    site_label: input.siteLabel,
    star_rating: input.starRating === null ? '—' : String(input.starRating),
    created_at: input.createdAt.toISOString(),
    review_text_block: indentBlock(reviewText, '  '),
    review_text_html: escapeHtml(reviewText),
    contacts_block: indentBlock(contactsLines, '  '),
    contacts_html: contactsHtml,
    llm_verdict: input.llmVerdict ?? '—',
    degraded_pass_suffix: degradedSuffix,
    llm_rationale: input.llmRationale ?? '(no rationale captured)',
    provider_review_url: input.providerReviewUrl ?? '(none)',
    admin_url: adminUrl,
  }
}

export interface RenderedTemplate {
  subject: string
  text: string
  html: string
}

// Load and render one template kind. The .txt file convention is:
// the first non-empty line is the subject template; the rest is the
// plain-text body template. The .html file is the full HTML body.
// Same vars map drives both substitutions.
export async function renderTemplate(
  templateKind: ReviewEmailTemplateKind,
  vars: Record<string, string>,
): Promise<RenderedTemplate> {
  if (templateKind === 'other') {
    throw new Error(`renderTemplate: 'other' is not a real A3 template kind`)
  }
  const fileKey = templateKind === 'strong_with_text' ? 'strong-with-text' : templateKind
  const dir = templatesDir()
  const [txtRaw, htmlRaw] = await Promise.all([
    readFile(resolve(dir, `${fileKey}.txt`), 'utf8'),
    readFile(resolve(dir, `${fileKey}.html`), 'utf8'),
  ])
  const lines = txtRaw.split('\n')
  // First non-empty line is the subject template; everything after
  // the first blank-line break is the body. Tolerant of a trailing
  // newline on the subject line and an arbitrary number of blank
  // lines between subject and body.
  let subjectLine: string | null = null
  let bodyStart = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      subjectLine = lines[i]
      bodyStart = i + 1
      // Skip subsequent blank lines.
      while (bodyStart < lines.length && lines[bodyStart].trim().length === 0) {
        bodyStart++
      }
      break
    }
  }
  if (subjectLine === null) {
    throw new Error(`renderTemplate: ${fileKey}.txt had no subject line`)
  }
  const subjectTpl = subjectLine
  const textTpl = lines.slice(bodyStart).join('\n')
  return {
    subject: renderMustacheLite(subjectTpl, vars),
    text: renderMustacheLite(textTpl, vars),
    html: renderMustacheLite(htmlRaw, vars),
  }
}

export interface QueueReviewEmailsInput {
  db: Queryable
  submissionId: string
  templateKind: ReviewEmailTemplateKind
  recipients: string[]
  rendered: RenderedTemplate
  fromAddress: string
  sender?: (args: SendEmailArgs) => Promise<SendEmailResult>
}

export interface SendEmailArgs {
  to: string
  from: string
  subject: string
  text: string
  html: string
}

export interface QueueReviewEmailsResult {
  emailIds: string[]
  perRecipient: Array<{ to: string; sendStatus: 'queued' | 'sent' | 'failed' | 'skipped'; error: string | null }>
}

// Insert one row per recipient into review_emails. If a sender
// callback is provided (default: smtpSender.sendEmail), attempt
// delivery and capture the result; otherwise leave the row as
// 'queued'. Best-effort: a per-recipient send failure inserts the
// row with send_status='failed' + send_error set, but does not
// throw — callers (typically the public submit handler) should
// never let an email failure fail the underlying request.
export async function queueAndSendReviewEmails(
  input: QueueReviewEmailsInput,
): Promise<QueueReviewEmailsResult> {
  const send = input.sender ?? sendEmail
  const emailIds: string[] = []
  const perRecipient: QueueReviewEmailsResult['perRecipient'] = []
  for (const to of input.recipients) {
    let result: SendEmailResult
    try {
      result = await send({
        to,
        from: input.fromAddress,
        subject: input.rendered.subject,
        text: input.rendered.text,
        html: input.rendered.html,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = { status: 'failed', sentAt: null, error: message }
    }
    const row = await insertReviewEmail(input.db, {
      submissionId: input.submissionId,
      templateKind: input.templateKind,
      toAddress: to,
      subject: input.rendered.subject,
      bodyText: input.rendered.text,
      bodyHtml: input.rendered.html,
      sendStatus: result.status,
      sendError: result.error,
      sentAt: result.sentAt,
    })
    emailIds.push(row.id)
    perRecipient.push({ to, sendStatus: result.status, error: result.error })
  }
  return { emailIds, perRecipient }
}
