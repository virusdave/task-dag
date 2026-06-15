// Populate the SMS (Text Notification) trigger 27548 on state-level
// marketing event 2475 ("Level Up!" loyalty nudge, segment 1575 =
// "Less than 100 points to next loyalty level") with a message
// comparable to the redesigned, operator-approved level-up email:
// the same {{loyalty_points_before_next_level}} merge tag, the faster
// points + discount-bonus payoff, and a link to the loyalty profile.
//
// Copy mirrors the approved email tone (human, no AI tells) and honors
// the operator edit that each new level is NOT strictly 2x the prior
// level: it says points add up "faster", not "2x faster". No em-dashes
// (canon §3).
//
// SMS is gated - messageText is rejected unless an approved template +
// image are attached first (docs/sweed/marketing.md §1.5). We reuse the
// same Sweed-approved catch-all template (223) and the gold leaf-logo
// FBNYC SMS image already used on the canonical birthday SMS (event
// 2232) and the 2474 birthday SMS, verified live on the state dealer.
//
// SAFETY (canon §1 - no unreviewed customer sends):
//   The SMS trigger is left DISABLED, and the master event 2475 is
//   disabled, so nothing sends. Content-only edit; a human reviews and
//   enables the channel after approving. This script does not enable any
//   trigger or the event, and does not touch the email/push triggers.
//
// Run from helios/:
//   DATABASE_URL=postgres://... npx tsx scripts/event-2475-sms-apply.ts

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const EVENT_ID = '2475'
const SMS_TRIGGER_ID = '27548'

// Sweed-approved catch-all template + the gold leaf-logo FBNYC SMS image,
// both already live on the birthday SMS (event 2232 / 2474) on the
// state dealer.
const SMS_APPROVED_TEMPLATE_ID = 223
const SMS_APPROVED_IMAGE_ID = '2019999f-f859-4b52-c58b-08de9cc488b6'

// Same loyalty profile CTA as the approved email; the operator keeps this
// store-scoped profile path for now (same wallet regardless of store
// focus) and will swap it once Sweed provides the correct URL.
const CTA_URL = 'https://freshlybaked.nyc/stores/midtown/shop/profile'

// Comparable to the email: keeps the per-recipient points merge tag, the
// faster-points + discount-bonus payoff, and the profile link. No
// em-dashes (canon §3). Honors the operator note that levels are not
// strictly 2x: says points add up "faster", not "2x faster".
const SMS_BODY =
  "You're so close. {{loyalty_points_before_next_level}} points from your next Freshly Baked NYC tier, basically one small order away. " +
  'Cross it and your points start adding up faster, plus a discount bonus drops into your account. ' +
  'See where you stand: ' +
  CTA_URL +
  '. 21+ only. T&C and limits apply.'

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

async function main(): Promise<void> {
  console.log('[event-2475-sms] SMS body:\n  ' + SMS_BODY + '\n  (length=' + SMS_BODY.length + ')')
  if (/[—–]/.test(SMS_BODY)) {
    throw new Error('em/en-dash found in SMS body (canon §3)')
  }

  const env = getWorkerEnv()
  const dealerId = env.sweedStateDealerId

  await withSweedSession(async () => {
    // Step 1: seed approved template + image so messageText is accepted.
    console.log(`[event-2475-sms] seeding SMS trigger ${SMS_TRIGGER_ID} with approved template/image`)
    await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
      id: SMS_TRIGGER_ID,
      approvedTemplateId: SMS_APPROVED_TEMPLATE_ID,
      approvedImageId: SMS_APPROVED_IMAGE_ID,
    })

    // Step 2: write the body; keep DISABLED (canon §1).
    console.log(`[event-2475-sms] writing SMS body to trigger ${SMS_TRIGGER_ID} (kept DISABLED)`)
    const res = await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
      id: SMS_TRIGGER_ID,
      enabled: false,
      messageText: {
        design: b64(JSON.stringify(SMS_DESIGN)),
        html: b64(SMS_HTML),
      },
    })
    console.log('[event-2475-sms] sms edit OK:', JSON.stringify(res).slice(0, 200))

    // Verify
    const verify = await callSweedRpc<any>(dealerId, 'store.marketing.event.get', { id: EVENT_ID })
    const sms = (verify.triggers ?? []).find((t: any) => t.actionType?.id === 5)
    const body = sms?.messageText?.html
      ? Buffer.from(sms.messageText.html, 'base64').toString('utf8')
      : ''
    console.log(
      '[event-2475-sms] verified:',
      JSON.stringify(
        {
          eventEnabled: verify.event?.enabled,
          channels: verify.event?.channels,
          smsTrigger: {
            id: sms?.id,
            enabled: sms?.enabled,
            approvedTemplate: sms?.approvedTemplate,
            approvedImage: sms?.approvedImage,
            body,
            emDashCount: (body.match(/[—–]/g) ?? []).length,
          },
        },
        null,
        2,
      ),
    )
  })
}

main().catch((err: unknown) => {
  console.error('[event-2475-sms] FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
