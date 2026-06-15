// Reusable workflow: copy a polished marketing EMAIL's creative into the
// rich SMS / Text Notification trigger of the same Sweed marketing event.
//
// WHY: Sweed Prime "Text Notification" triggers (actionType.id === 5) carry
// the SAME rich Unlayer content shape as email triggers
// (messageText.design + messageText.html). Live, enabled SMS triggers
// across our dealers commonly contain full marketing creative (images,
// headings, buttons, styled HTML at 500-600px). A single plain <p> SMS is
// a fallback/anomaly, not the standard. So "make the SMS match the
// polished email" literally means: copy the email trigger's exact
// messageText onto the SMS trigger, after attaching an approved template +
// approved image (SMS writes are gated and rejected otherwise).
//
// See docs/sweed/marketing.md "Recipe: copy polished email creative into
// rich SMS" for the canonical write-up.
//
// SAFETY (canon §1 - no unreviewed customer sends):
//   This always writes the SMS trigger as enabled:false and never touches
//   the event's enabled state, schedule, segment, or channels. A human
//   reviews in Sweed Prime and enables the channel afterward. It refuses
//   to overwrite an already-enabled SMS trigger unless --force is given.
//
// IMPORTANT: the email payload is copied AS-IS (the raw base64 strings).
// We do not decode/re-encode (that would risk double-base64 / drift). We
// decode only to validate/report.
//
// Run from helios/:
//   DATABASE_URL=postgres://... npx tsx scripts/sweed-copy-email-to-rich-sms.ts \
//     --event-id 2474 \
//     [--dealer state|midtown|bronx | --dealer-id 210248] \
//     [--email-trigger-id 27544] [--sms-trigger-id 27545] \
//     [--approved-template-id 223] \
//     [--approved-image-id 2019999f-f859-4b52-c58b-08de9cc488b6] \
//     [--allow-small-html] [--force] [--dry-run]

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

// Carrier-safe (cannabis-stripped) FBNYC gold-coin SMS image and the
// catch-all approved SMS template. These are the defaults already approved
// on the state dealer; override per-campaign as needed. The rich body
// copied from the email may use the standard brand creative (incl. the
// leaf logo) when the operator has approved that creative; the
// approvedImage stays carrier-safe. See the doc for the carrier caveat.
const DEFAULT_APPROVED_TEMPLATE_ID = 223
const DEFAULT_APPROVED_IMAGE_ID = '2019999f-f859-4b52-c58b-08de9cc488b6'

const NAMED_DEALERS: Record<string, number> = {
  midtown: 210705,
  bronx: 210249,
  // state resolved from env at runtime
}

interface Args {
  dealerId: number
  eventId: string
  emailTriggerId?: string
  smsTriggerId?: string
  approvedTemplateId: number
  approvedImageId: string
  allowSmallHtml: boolean
  force: boolean
  dryRun: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (name: string): boolean => argv.includes(`--${name}`)

  const env = getWorkerEnv()
  const dealerName = get('dealer')
  const dealerIdArg = get('dealer-id')
  let dealerId: number
  if (dealerIdArg) {
    dealerId = Number(dealerIdArg)
  } else if (dealerName && dealerName !== 'state') {
    const mapped = NAMED_DEALERS[dealerName]
    if (!mapped) throw new Error(`unknown --dealer "${dealerName}" (use state|midtown|bronx or --dealer-id)`)
    dealerId = mapped
  } else {
    dealerId = env.sweedStateDealerId
  }

  const eventId = get('event-id')
  if (!eventId) throw new Error('--event-id is required')

  return {
    dealerId,
    eventId,
    emailTriggerId: get('email-trigger-id'),
    smsTriggerId: get('sms-trigger-id'),
    approvedTemplateId: Number(get('approved-template-id') ?? DEFAULT_APPROVED_TEMPLATE_ID),
    approvedImageId: get('approved-image-id') ?? DEFAULT_APPROVED_IMAGE_ID,
    allowSmallHtml: has('allow-small-html'),
    force: has('force'),
    dryRun: has('dry-run'),
  }
}

function decode(b64: string | undefined): string {
  if (!b64) return ''
  try {
    return Buffer.from(b64, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

async function main(): Promise<void> {
  const args = parseArgs()
  console.log('[copy-email-to-sms] args:', JSON.stringify({ ...args }, null, 2))

  await withSweedSession(async () => {
    const before = await callSweedRpc<any>(args.dealerId, 'store.marketing.event.get', {
      id: args.eventId,
    })
    const triggers: any[] = before.triggers ?? []

    const email = args.emailTriggerId
      ? triggers.find((t) => String(t.id) === args.emailTriggerId)
      : triggers.find((t) => t.actionType?.id === 3)
    const sms = args.smsTriggerId
      ? triggers.find((t) => String(t.id) === args.smsTriggerId)
      : triggers.find((t) => t.actionType?.id === 5)

    if (!email) throw new Error('email trigger (actionType 3) not found on event')
    if (email.actionType?.id !== 3) throw new Error(`resolved email trigger ${email.id} is not actionType 3`)
    if (!sms) throw new Error('SMS trigger (actionType 5) not found on event')
    if (sms.actionType?.id !== 5) throw new Error(`resolved SMS trigger ${sms.id} is not actionType 5`)

    const designB64: string | undefined = email.messageText?.design
    const htmlB64: string | undefined = email.messageText?.html
    if (!designB64 || !htmlB64) {
      throw new Error(
        `source email trigger ${email.id} has empty messageText (design=${!!designB64} html=${!!htmlB64}); apply/polish the email first`,
      )
    }

    const decodedHtml = decode(htmlB64)
    const decodedDesign = decode(designB64)
    let designJson: any
    try {
      designJson = JSON.parse(decodedDesign)
    } catch {
      throw new Error(`source email design did not decode to JSON`)
    }
    const designRows: number = designJson?.body?.rows?.length ?? 0
    const schemaVersion = designJson?.schemaVersion
    if (schemaVersion !== 21) {
      console.warn(`[copy-email-to-sms] WARN: email design schemaVersion=${schemaVersion} (expected 21)`)
    }
    if (decodedHtml.length < 1000 && !args.allowSmallHtml) {
      throw new Error(
        `source email html is only ${decodedHtml.length} bytes; looks too small to be a polished email. Pass --allow-small-html to override.`,
      )
    }

    if (sms.enabled && !args.force) {
      throw new Error(
        `target SMS trigger ${sms.id} is currently ENABLED; refusing to overwrite live content without --force`,
      )
    }

    console.log(
      `[copy-email-to-sms] dealer=${args.dealerId} event=${args.eventId} ` +
        `email=${email.id} (htmlLen=${decodedHtml.length}, rows=${designRows}) -> sms=${sms.id}`,
    )

    if (args.dryRun) {
      console.log('[copy-email-to-sms] DRY_RUN: no writes performed.')
      return
    }

    // Step 1: attach approved template + image (gates the messageText write).
    await callSweedRpc<unknown>(args.dealerId, 'store.marketing.trigger.action.edit', {
      id: sms.id,
      approvedTemplateId: args.approvedTemplateId,
      approvedImageId: args.approvedImageId,
    })

    // Step 2: copy the email payload AS-IS; keep DISABLED (canon §1).
    await callSweedRpc<unknown>(args.dealerId, 'store.marketing.trigger.action.edit', {
      id: sms.id,
      enabled: false,
      approvedTemplateId: args.approvedTemplateId,
      approvedImageId: args.approvedImageId,
      messageText: { design: designB64, html: htmlB64 },
    })

    // Verify exact round-trip.
    const after = await callSweedRpc<any>(args.dealerId, 'store.marketing.event.get', {
      id: args.eventId,
    })
    const smsAfter = (after.triggers ?? []).find((t: any) => String(t.id) === String(sms.id))
    const htmlMatches = smsAfter?.messageText?.html === htmlB64
    const designMatches = smsAfter?.messageText?.design === designB64
    const decodedAfterHtml = decode(smsAfter?.messageText?.html)
    const summary = {
      dealerId: args.dealerId,
      eventId: args.eventId,
      emailTriggerId: String(email.id),
      smsTriggerId: String(sms.id),
      smsEnabled: smsAfter?.enabled,
      approvedTemplateId: smsAfter?.approvedTemplate?.id,
      approvedImageId: smsAfter?.approvedImage?.id,
      htmlCopiedExact: htmlMatches,
      designCopiedExact: designMatches,
      decodedHtmlBytes: decodedAfterHtml.length,
      decodedHtmlIsRich: /<table|<div|<img|background|font-family|border-radius/i.test(decodedAfterHtml),
      designRows,
      schemaVersion,
    }
    console.log('[copy-email-to-sms] verified:', JSON.stringify(summary, null, 2))

    if (!htmlMatches || !designMatches) {
      throw new Error('verification failed: SMS messageText does not exactly match the source email')
    }
    if (smsAfter?.enabled !== false) {
      throw new Error('verification failed: SMS trigger is not disabled')
    }
  })
}

main().catch((err: unknown) => {
  console.error('[copy-email-to-sms] FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
