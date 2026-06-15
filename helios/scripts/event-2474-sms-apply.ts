// Populate the SMS (Text Notification) trigger 27545 on state-level
// marketing event 2474 ("Happy Birthday from Freshly Baked NYC") with a
// message comparable to the redesigned birthday email: birthday greeting,
// the EXTRA 10% off offer, and a Shop link to the state store picker.
//
// SMS is gated — messageText is rejected unless an approved template +
// image are attached first (docs/sweed/marketing.md §1.5). We reuse the
// same Sweed-approved catch-all template (223) and the gold leaf-logo
// FBNYC SMS image already used on the canonical birthday SMS (event 2232,
// trigger 25922), verified live on the state dealer.
//
// SAFETY (canon §1 — no unreviewed customer sends):
//   The SMS trigger is left DISABLED. All three channels on event 2474
//   are off, so nothing sends. Content-only edit; a human reviews and
//   enables the channel after approving.
//
// Run from helios/:
//   DATABASE_URL=postgres://... npx tsx scripts/event-2474-sms-apply.ts

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const EVENT_ID = '2474'
const SMS_TRIGGER_ID = '27545'

// Sweed-approved catch-all template + the gold leaf-logo FBNYC SMS image,
// both already live on the birthday SMS (event 2232) on the state dealer.
const SMS_APPROVED_TEMPLATE_ID = 223
const SMS_APPROVED_IMAGE_ID = '2019999f-f859-4b52-c58b-08de9cc488b6'

const SHOP_URL = 'https://freshlybaked.nyc/?modal=locations'

// Comparable to the email: birthday greeting + EXTRA 10% off + shop link.
const SMS_BODY =
  "Happy birthday. An extra 10% off from us, and here's the thing: it stacks on top of our everyday prices. Most birthday deals don't. This one does. Today only. " +
  SHOP_URL +
  '. 21+ only. T&C and limits apply.'

// Sweed does not render the Unlayer design for SMS — it just stores it.
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
  console.log('[event-2474-sms] SMS body:\n  ' + SMS_BODY + '\n  (length=' + SMS_BODY.length + ')')

  const env = getWorkerEnv()
  const dealerId = env.sweedStateDealerId

  await withSweedSession(async () => {
    // Step 1: seed approved template + image so messageText is accepted.
    console.log(`[event-2474-sms] seeding SMS trigger ${SMS_TRIGGER_ID} with approved template/image`)
    await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
      id: SMS_TRIGGER_ID,
      approvedTemplateId: SMS_APPROVED_TEMPLATE_ID,
      approvedImageId: SMS_APPROVED_IMAGE_ID,
    })

    // Step 2: write the body; keep DISABLED (canon §1).
    console.log(`[event-2474-sms] writing SMS body to trigger ${SMS_TRIGGER_ID} (kept DISABLED)`)
    const res = await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
      id: SMS_TRIGGER_ID,
      enabled: false,
      messageText: {
        design: b64(JSON.stringify(SMS_DESIGN)),
        html: b64(SMS_HTML),
      },
    })
    console.log('[event-2474-sms] sms edit OK:', JSON.stringify(res).slice(0, 200))

    // Verify
    const verify = await callSweedRpc<any>(dealerId, 'store.marketing.event.get', { id: EVENT_ID })
    const sms = (verify.triggers ?? []).find((t: any) => t.actionType?.id === 5)
    console.log(
      '[event-2474-sms] verified:',
      JSON.stringify(
        {
          eventEnabled: verify.event?.enabled,
          channels: verify.event?.channels,
          smsTrigger: {
            id: sms?.id,
            enabled: sms?.enabled,
            approvedTemplate: sms?.approvedTemplate,
            approvedImage: sms?.approvedImage,
            body: sms?.messageText?.html
              ? Buffer.from(sms.messageText.html, 'base64').toString('utf8')
              : '',
          },
        },
        null,
        2,
      ),
    )
  })
}

main().catch((err: unknown) => {
  console.error('[event-2474-sms] FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
