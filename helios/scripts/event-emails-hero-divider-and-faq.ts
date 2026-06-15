// Surgical, idempotent polish for the state-level rewards/level-up emails:
//   1. Insert a gold leaf-divider hero accent directly under the logo
//      (echoes the brand hero look). Applied to all targeted emails.
//   2. (optional) Swap the "Learn More" CTA button hrefs to the
//      site-agnostic loyalty FAQ page, WITHOUT touching the logo's home
//      link or any other URL.
//
// Why surgical (not regenerate): the live emails differ in origin. 2473 /
// 2476 are hand-authored table HTML (single 560px card); 2475 is
// Unlayer-rendered (operator-edited, stacked u-row layout). We edit the
// live messageText.html (delivery) AND messageText.design (UI re-edit) in
// place so we preserve every operator edit exactly. A clean full card
// border is not feasible on 2475's stacked-row layout, so the gold leaf
// divider is used as the consistent hero accent across all three.
//
// SAFETY (canon §1): this edits content only and does NOT change any
// trigger/event enabled state, schedule, segment, or channel. Events stay
// as the operator left them; a human reviews the preview before enabling.
//
// Run from helios/:
//   DATABASE_URL=postgres://... npx tsx scripts/event-emails-hero-divider-and-faq.ts \
//     --event-id 2473 [--email-trigger-id 27541] \
//     [--faq-url https://freshlybaked.nyc/sites/all/loyalty-faq] [--no-swap] [--dry-run]

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const MARKER = 'fbnyc-hero-divider'
const PLACEHOLDER_URL = 'https://freshlybaked.nyc/'
const DEFAULT_FAQ_URL = 'https://freshlybaked.nyc/sites/all/loyalty-faq'

// The visual divider: a short gold rule, a gold leaf glyph, a short gold
// rule. Carries the idempotency marker as an HTML comment.
const DIVIDER_INNER =
  `<!-- ${MARKER} -->` +
  '<span style="display:inline-block;width:42px;border-top:2px solid #e8b265;vertical-align:middle;"></span>' +
  '<span style="color:#e8b265;font-size:15px;padding:0 12px;vertical-align:middle;">&#127811;</span>' +
  '<span style="display:inline-block;width:42px;border-top:2px solid #e8b265;vertical-align:middle;"></span>'

// Hand-authored table card (2473/2476): a <tr> row inside the 560px card.
const TABLE_DIVIDER =
  `\n      <!-- ${MARKER} -->\n      <tr><td class="pad" align="center" style="padding:2px 28px 14px 28px;">${DIVIDER_INNER}</td></tr>\n`

// Unlayer (2475): mimic a content u-row-container so it inherits the
// email's responsive media query and card width.
const UNLAYER_DIVIDER =
  `<!-- ${MARKER} --><div class="u-row-container" style="padding: 0 18px 0 18px;background-color: #161111">` +
  `<div style="margin: 0 auto;min-width: 320px;max-width: 560px;background-color: #1d1514;">` +
  `<div style="text-align:center;padding:2px 28px 14px 28px;">${DIVIDER_INNER}</div></div></div>`

function b64encode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}
function b64decode(s?: string): string {
  return s ? Buffer.from(s, 'base64').toString('utf8') : ''
}

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

// Insert the divider into the rendered HTML at the correct anchor.
function insertDividerHtml(html: string): string {
  if (html.includes(MARKER)) return html // idempotent
  if (html.includes('u-row-container')) {
    // Unlayer: insert before the 2nd u-row-container (1st is the logo row).
    const first = html.indexOf('<div class="u-row-container"')
    const second = html.indexOf('<div class="u-row-container"', first + 10)
    if (second < 0) throw new Error('could not find 2nd u-row-container anchor')
    return html.slice(0, second) + UNLAYER_DIVIDER + html.slice(second)
  }
  // Hand-authored: insert right before the eyebrow section, i.e. after logo.
  const anchor = '<!-- Eyebrow + heading + intro -->'
  const at = html.indexOf(anchor)
  if (at < 0) throw new Error('could not find hand-authored eyebrow anchor')
  return html.slice(0, at) + TABLE_DIVIDER + '      ' + html.slice(at)
}

// Insert a matching divider row into the Unlayer design at index 1
// (right after the logo row) so the Sweed UI re-render keeps it.
function insertDividerDesign(designJson: any): any {
  const rows = designJson?.body?.rows
  if (!Array.isArray(rows)) return designJson
  if (JSON.stringify(designJson).includes(MARKER)) return designJson // idempotent
  const dividerRow = {
    cells: [1],
    columns: [
      {
        contents: [
          {
            type: 'text',
            values: {
              containerPadding: '2px 28px 14px 28px',
              textAlign: 'center',
              color: '#e8b265',
              text: `<div style="text-align:center;">${DIVIDER_INNER}</div>`,
            },
          },
        ],
        values: { backgroundColor: '#1d1514' },
      },
    ],
    values: { backgroundColor: '#161111', columnsBackgroundColor: '#1d1514', padding: '0 18px 0 18px' },
  }
  rows.splice(1, 0, dividerRow)
  return designJson
}

// Swap only the Learn More CTA button hrefs (roundrect + anchor variants)
// to the FAQ url. Leaves the logo's home link untouched.
function swapLearnMoreHtml(html: string, faqUrl: string): { html: string; count: number } {
  let count = 0
  let out = html
  const repl = (needle: string) => {
    const replaced = out.split(needle)
    count += replaced.length - 1
    out = replaced.join(needle.replace(PLACEHOLDER_URL, faqUrl))
  }
  // mso roundrect button
  repl(`href="${PLACEHOLDER_URL}" style="height:48px`)
  // visible anchor button (gold background)
  repl(`href="${PLACEHOLDER_URL}" target="_blank" style="background:#e8b265`)
  return { html: out, count }
}

function swapLearnMoreDesign(designJson: any, faqUrl: string): number {
  let count = 0
  for (const row of designJson?.body?.rows ?? []) {
    for (const col of row.columns ?? []) {
      for (const block of col.contents ?? []) {
        if (block.type === 'button') {
          const text: string = block.values?.text ?? ''
          const href = block.values?.href?.values
          if (/Learn More/i.test(text) && href?.href === PLACEHOLDER_URL) {
            href.href = faqUrl
            count++
          }
        }
      }
    }
  }
  return count
}

async function main(): Promise<void> {
  const eventId = getArg('event-id')
  if (!eventId) throw new Error('--event-id required')
  const emailTriggerId = getArg('email-trigger-id')
  const faqUrl = getArg('faq-url') ?? DEFAULT_FAQ_URL
  const doSwap = !hasFlag('no-swap')
  const dryRun = hasFlag('dry-run')

  const env = getWorkerEnv()
  const dealerId = env.sweedStateDealerId

  await withSweedSession(async () => {
    const v = await callSweedRpc<any>(dealerId, 'store.marketing.event.get', { id: eventId })
    const email = emailTriggerId
      ? (v.triggers ?? []).find((t: any) => String(t.id) === emailTriggerId)
      : (v.triggers ?? []).find((t: any) => t.actionType?.id === 3)
    if (!email || email.actionType?.id !== 3) throw new Error('email trigger not found')

    const html0 = b64decode(email.messageText?.html)
    const design0 = b64decode(email.messageText?.design)
    if (!html0 || !design0) throw new Error('email trigger has empty messageText')
    const designJson = JSON.parse(design0)

    // 1) divider
    let html1 = insertDividerHtml(html0)
    insertDividerDesign(designJson)
    const dividerAdded = html1 !== html0

    // 2) optional URL swap
    let htmlSwapCount = 0
    let designSwapCount = 0
    if (doSwap) {
      const r = swapLearnMoreHtml(html1, faqUrl)
      html1 = r.html
      htmlSwapCount = r.count
      designSwapCount = swapLearnMoreDesign(designJson, faqUrl)
    }

    const html2 = html1
    const design2 = JSON.stringify(designJson)

    const fs = await import('node:fs')
    fs.writeFileSync(`/tmp/preview-email-${eventId}.html`, html2)

    console.log(
      `[hero+faq ${eventId}] emailTrigger=${email.id} enabled=${email.enabled} ` +
        `dividerAdded=${dividerAdded} htmlUrlSwaps=${htmlSwapCount} designUrlSwaps=${designSwapCount} ` +
        `| remaining placeholder root-URL in html=${(html2.match(/href="https:\/\/freshlybaked\.nyc\/"/g) || []).length} ` +
        `| faq-url count in html=${(html2.split(faqUrl).length - 1)} ` +
        `| preview=/tmp/preview-email-${eventId}.html`,
    )

    if (dryRun) {
      console.log('[hero+faq] DRY_RUN: no write.')
      return
    }

    await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
      id: email.id,
      messageText: { design: b64encode(design2), html: b64encode(html2) },
    })

    // verify round-trip
    const after = await callSweedRpc<any>(dealerId, 'store.marketing.event.get', { id: eventId })
    const e2 = (after.triggers ?? []).find((t: any) => String(t.id) === String(email.id))
    const h = b64decode(e2?.messageText?.html)
    console.log(
      `[hero+faq ${eventId}] verified: dividerPresent=${h.includes(MARKER)} ` +
        `faqUrlInHtml=${h.split(faqUrl).length - 1} ` +
        `placeholderRootHrefLeft=${(h.match(/href="https:\/\/freshlybaked\.nyc\/"/g) || []).length} ` +
        `enabled=${e2?.enabled}`,
    )
  })
}

main().catch((err: unknown) => {
  console.error('[hero+faq] FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
