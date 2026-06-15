// Channel split for the "rewards program upgrade" state-level campaign.
//
// The operator split the original rewards-update event 2473 into two so
// that Email (cheap, high ROI) is preferred where available and SMS
// (expensive) only goes to the SMS-only audience:
//   - 2473 "baked-out-levels-update-email"  segment "Customers opted into email"
//   - 2476 "baked-out-levels-update-sms"    segment "Customers opted into SMS"  (duplicate)
//
// 2476 was duplicated from 2473, so it arrived with the rewards EMAIL
// content live and an empty SMS trigger. This script:
//   1. Creates the SMS message contents on 2476's SMS trigger (27551),
//      comparable to the 2473 rewards email (program upgrade, four tiers,
//      faster points/perks/discounts, link your phone/email), with the
//      same "Learn More" placeholder link https://freshlybaked.nyc/.
//      No em-dashes (canon §3).
//   2. Disables the EMAIL trigger on 2476 (27550) so the SMS event does
//      not also email.
//   3. Ensures SMS is disabled on the prior event 2473 (trigger 27542).
//
// SMS is gated - messageText is rejected unless an approved template +
// image are attached first (docs/sweed/marketing.md §1.5). We reuse the
// Sweed-approved catch-all template (223) and the gold leaf-logo FBNYC
// SMS image already live on the birthday/level-up SMS on this dealer.
//
// SAFETY (canon §1 - no unreviewed customer sends):
//   The new SMS trigger is left DISABLED, and master events 2473/2476
//   are both disabled, so nothing sends. The operator reviews the new
//   SMS copy and enables the SMS trigger + master event when ready.
//
// Run from helios/:
//   DATABASE_URL=postgres://... npx tsx scripts/event-2476-rewards-sms-apply.ts

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const SMS_EVENT_ID = '2476'
const SMS_TRIGGER_ID = '27551'
const SMS_EMAIL_TRIGGER_ID = '27550' // email trigger on 2476, to disable

const PRIOR_EVENT_ID = '2473'
const PRIOR_SMS_TRIGGER_ID = '27542' // SMS trigger on 2473, ensure disabled

// Sweed-approved catch-all template + gold leaf-logo FBNYC SMS image,
// already live on the birthday (2474) and level-up (2475) SMS triggers.
const SMS_APPROVED_TEMPLATE_ID = 223
const SMS_APPROVED_IMAGE_ID = '2019999f-f859-4b52-c58b-08de9cc488b6'

// Same placeholder "Learn More" link the 2473 email uses; operator swaps
// it for the real rewards page later.
const LEARN_MORE_URL = 'https://freshlybaked.nyc/'

// Comparable to the rewards email, condensed for SMS. Human, no em-dashes.
const SMS_BODY =
  'Good news from Freshly Baked NYC: we rebuilt our rewards program. ' +
  'Four tiers now, so you earn points, perks and discounts faster the more you shop. ' +
  'Make sure your phone or email is linked to your account so every dollar counts. ' +
  'Learn more: ' +
  LEARN_MORE_URL +
  ' 21+ only. T&C and limits apply.'

// Sweed does not render the Unlayer design for SMS - it just stores it.
// Keep it minimal: one text block carrying the same body.
const SMS_HTML = `<p style="margin:0;color:#2b1f1a;">${SMS_BODY}</p>`
const SMS_DESIGN = {
  body: {
    rows: [
      {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: 'text',
                values: {
                  containerPadding: '10px',
                  color: '#2b1f1a',
                  text: `<p style="margin:0;color:#2b1f1a;">${SMS_BODY}</p>`,
                },
              },
            ],
          },
        ],
      },
    ],
    values: { backgroundColor: '#ffffff', contentWidth: '500px' },
  },
  schemaVersion: 21,
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

async function summarize(dealerId: string, eventId: string, label: string): Promise<void> {
  const v = await callSweedRpc<any>(dealerId, 'store.marketing.event.get', { id: eventId })
  const row = (id: number) => (v.triggers ?? []).find((t: any) => t.actionType?.id === id)
  const email = row(3)
  const sms = row(5)
  const smsBody = sms?.messageText?.html
    ? Buffer.from(sms.messageText.html, 'base64').toString('utf8')
    : ''
  console.log(
    `[${label}] event ${eventId} (${v.event?.name}) masterEnabled=${v.event?.enabled} ` +
      `| email trigger ${email?.id} enabled=${email?.enabled} ` +
      `| sms trigger ${sms?.id} enabled=${sms?.enabled} tpl=${sms?.approvedTemplate?.id ?? null} ` +
      `img=${sms?.approvedImage?.id ?? null} emDash=${(smsBody.match(/[—–]/g) ?? []).length}`,
  )
  if (smsBody) console.log(`[${label}]   sms body: ${smsBody}`)
}

async function main(): Promise<void> {
  console.log('[event-2476-sms] SMS body:\n  ' + SMS_BODY + '\n  (length=' + SMS_BODY.length + ')')
  if (/[—–]/.test(SMS_BODY)) {
    throw new Error('em/en-dash found in SMS body (canon §3)')
  }

  const env = getWorkerEnv()
  const dealerId = env.sweedStateDealerId

  await withSweedSession(async () => {
    // Step 1: seed approved template + image so messageText is accepted.
    console.log(`[event-2476-sms] seeding SMS trigger ${SMS_TRIGGER_ID} with approved template/image`)
    await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
      id: SMS_TRIGGER_ID,
      approvedTemplateId: SMS_APPROVED_TEMPLATE_ID,
      approvedImageId: SMS_APPROVED_IMAGE_ID,
    })

    // Step 2: write the SMS body; keep DISABLED (canon §1).
    console.log(`[event-2476-sms] writing SMS body to trigger ${SMS_TRIGGER_ID} (kept DISABLED)`)
    await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
      id: SMS_TRIGGER_ID,
      enabled: false,
      messageText: {
        design: b64(JSON.stringify(SMS_DESIGN)),
        html: b64(SMS_HTML),
      },
    })

    // Step 3: disable the EMAIL trigger on the SMS event 2476.
    console.log(`[event-2476-sms] disabling EMAIL trigger ${SMS_EMAIL_TRIGGER_ID} on event ${SMS_EVENT_ID}`)
    await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
      id: SMS_EMAIL_TRIGGER_ID,
      enabled: false,
    })

    // Step 4: ensure SMS is disabled on the prior (email) event 2473.
    // Only toggle if currently active: an empty/un-configured SMS trigger
    // rejects an edit with "Image is required" (SMS gating), and disabling
    // an already-disabled trigger is a no-op anyway.
    const prior = await callSweedRpc<any>(dealerId, 'store.marketing.event.get', { id: PRIOR_EVENT_ID })
    const priorSms = (prior.triggers ?? []).find((t: any) => t.actionType?.id === 5)
    if (priorSms?.enabled) {
      console.log(`[event-2476-sms] disabling active SMS trigger ${PRIOR_SMS_TRIGGER_ID} on event ${PRIOR_EVENT_ID}`)
      await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
        id: PRIOR_SMS_TRIGGER_ID,
        enabled: false,
      })
    } else {
      console.log(`[event-2476-sms] prior SMS trigger ${PRIOR_SMS_TRIGGER_ID} already disabled; nothing to do`)
    }

    // Verify both events
    await summarize(dealerId, SMS_EVENT_ID, 'verify-2476')
    await summarize(dealerId, PRIOR_EVENT_ID, 'verify-2473')
  })
}

main().catch((err: unknown) => {
  console.error('[event-2476-sms] FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
