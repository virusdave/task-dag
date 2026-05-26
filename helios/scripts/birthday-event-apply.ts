// One-off: populate the email + SMS messages on the state-level
// "Happy Birthday" marketing event (event 2232) in Sweed Prime.
//
// Recon (see scripts/birthday-event-recon.ts) showed:
//   - state dealer: 210248
//   - event id:     2232  ("Happy Birthday", segment 1531 "Birthday is Today")
//   - email trigger id: 25921  (sender already set: Freshly Baked NYC <support@freshlybaked.nyc>)
//   - SMS   trigger id: 25922
//   - both triggers are currently blank (enabled=false, empty design/html).
//
// What this script does:
//   1. Edit the email trigger (25921) with subject + design + html and
//      ENABLE it.
//   2. Edit the SMS trigger (25922) with the SMS body (raw text inside
//      a tiny unlayer design) but leave enabled=false.
//   3. Re-fetch the event to confirm trigger state.
//
// SMS content requires an approved template + image to be set first
// (per Sweed). For the state dealer we seed with the same approved
// pair the prior thread used; if Sweed rejects them for state, the
// script logs the error and continues — the email update is
// independent and already saved.
//
// Run:
//   DATABASE_URL=postgres://... \
//   SWEED_API_URL=https://prime.sweedpos.com/api/ \
//   npx tsx scripts/birthday-event-apply.ts

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const EVENT_ID = '2232'
const EMAIL_TRIGGER_ID = '25921'
const SMS_TRIGGER_ID = '25922'

const EMAIL_SENDER = {
  id: '9e09e1c4-c0f2-44ca-a81d-e0766f34f2f6',
  name: 'Freshly Baked NYC',
  email: 'support@freshlybaked.nyc',
}

const EMAIL_SUBJECT = '🎂 Happy Birthday from Freshly Baked — your 5% gift inside'

// Body the operator approved, plus the mandatory NY cannabis
// "Consume responsibly. Cannabis can be addictive." closing line
// (per docs/sweed/getting-a-token-for-one-offs.md compliance notes).
const EMAIL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Happy Birthday from Freshly Baked NYC</title>
</head>
<body style="margin:0;padding:0;background:#f6f3ef;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#2b1f1a;">
<span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">A little something to celebrate you today — 5% off, just for your birthday.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f3ef;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:32px 32px 8px 32px;text-align:center;">
        <div style="font-size:36px;line-height:1.1;margin:0 0 4px 0;">🎂</div>
        <h1 style="font-size:24px;line-height:1.25;margin:0;color:#2b1f1a;">Happy Birthday!!</h1>
      </td></tr>
      <tr><td style="padding:16px 32px 0 32px;color:#2b1f1a;font-size:16px;line-height:1.5;">
        <p style="margin:0 0 16px 0;">From everyone at Freshly Baked NYC, we hope today is exactly the kind of day you're in the mood for.</p>
        <p style="margin:0 0 16px 0;">To celebrate, here's a little gift from us:</p>
      </td></tr>
      <tr><td style="padding:8px 32px 0 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff7e6;border-radius:6px;">
          <tr><td style="padding:18px 16px;text-align:center;font-size:18px;font-weight:600;color:#2b1f1a;">
            🎁&nbsp;&nbsp;5% OFF your order — today only
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 32px 0 32px;color:#2b1f1a;font-size:16px;line-height:1.5;">
        <p style="margin:0 0 16px 0;">The discount is automatically applied at checkout on your account. No code, no fuss — just shop and we'll take care of the rest.</p>
        <ul style="margin:0 0 16px 18px;padding:0;color:#2b1f1a;font-size:15px;line-height:1.5;">
          <li>Valid today only (your birthday).</li>
          <li>In-store, pickup, or delivery orders.</li>
          <li>T&amp;C and limits may apply.</li>
        </ul>
        <p style="margin:0 0 16px 0;">Thanks for being part of the Freshly Baked family. Have a great one.</p>
        <p style="margin:0 0 24px 0;color:#2b1f1a;">— The Freshly Baked NYC team</p>
      </td></tr>
      <tr><td style="padding:16px 32px 28px 32px;border-top:1px solid #e8e3dc;color:#6b6058;font-size:12px;line-height:1.5;text-align:center;">
        Consume responsibly. Cannabis can be addictive.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`

// Minimal unlayer schema-v21 design that mirrors the same content.
// Sweed accepts a minimal design; the canonical view stays the HTML
// above and the design is used by the Unlayer editor when an operator
// later opens this trigger in Sweed Prime.
const EMAIL_DESIGN = {
  body: {
    rows: [
      {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: 'heading',
                values: {
                  headingType: 'h1',
                  containerPadding: '24px 16px 8px 16px',
                  textAlign: 'center',
                  color: '#2b1f1a',
                  text: '🎂 Happy Birthday!!',
                },
              },
              {
                type: 'text',
                values: {
                  containerPadding: '8px 16px',
                  color: '#2b1f1a',
                  text: '<p style="margin:0 0 16px 0;color:#2b1f1a;">From everyone at Freshly Baked NYC, we hope today is exactly the kind of day you\'re in the mood for.</p><p style="margin:0 0 16px 0;color:#2b1f1a;">To celebrate, here\'s a little gift from us:</p>',
                },
              },
              {
                type: 'text',
                values: {
                  containerPadding: '8px 16px',
                  color: '#2b1f1a',
                  text: '<p style="margin:0;padding:18px 16px;background:#fff7e6;border-radius:6px;text-align:center;font-size:18px;font-weight:600;color:#2b1f1a;">🎁&nbsp;&nbsp;5% OFF your order — today only</p>',
                },
              },
              {
                type: 'text',
                values: {
                  containerPadding: '8px 16px',
                  color: '#2b1f1a',
                  text: '<p style="margin:0 0 16px 0;color:#2b1f1a;">The discount is automatically applied at checkout on your account. No code, no fuss — just shop and we\'ll take care of the rest.</p><ul style="margin:0 0 16px 18px;padding:0;color:#2b1f1a;"><li>Valid today only (your birthday).</li><li>In-store, pickup, or delivery orders.</li><li>T&amp;C and limits may apply.</li></ul><p style="margin:0 0 16px 0;color:#2b1f1a;">Thanks for being part of the Freshly Baked family. Have a great one.</p><p style="margin:0;color:#2b1f1a;">— The Freshly Baked NYC team</p>',
                },
              },
              {
                type: 'divider',
                values: {
                  containerPadding: '16px 16px 8px 16px',
                  border: {
                    borderTopWidth: '1px',
                    borderTopStyle: 'solid',
                    borderTopColor: '#e8e3dc',
                  },
                },
              },
              {
                type: 'text',
                values: {
                  containerPadding: '0 16px 24px 16px',
                  color: '#6b6058',
                  text: '<p style="margin:0;color:#6b6058;font-size:12px;text-align:center;">Consume responsibly. Cannabis can be addictive.</p>',
                },
              },
            ],
          },
        ],
      },
    ],
    values: {
      backgroundColor: '#f6f3ef',
      contentWidth: '560px',
      preheaderText: 'A little something to celebrate you today — 5% off, just for your birthday.',
    },
  },
  schemaVersion: 21,
}

const SMS_BODY =
  'Happy Birthday from Freshly Baked! 🎂 Enjoy 5% off today only — in-store, pickup, or delivery. Auto-applied at checkout. T&C and limits may apply.'

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
    values: {
      backgroundColor: '#ffffff',
      contentWidth: '500px',
    },
  },
  schemaVersion: 21,
}

const SMS_HTML = `<p style="margin:0;color:#2b1f1a;">${SMS_BODY}</p>`

// Sweed-approved template + image IDs used by prior marketing events
// in this workspace. If they aren't valid for the state dealer,
// Sweed will return an error and we'll skip the SMS update — the
// email update above is independent and already committed.
const SMS_APPROVED_TEMPLATE_ID = 223
const SMS_APPROVED_IMAGE_ID = '2019999f-f859-4b52-c58b-08de9cc488b6'

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

async function main(): Promise<void> {
  const env = getWorkerEnv()
  const dealerId = env.sweedStateDealerId

  await withSweedSession(async () => {
    // ---------- Email ----------
    console.log(`[birthday-event-apply] editing email trigger ${EMAIL_TRIGGER_ID} (ENABLED)`)
    const emailResult = await callSweedRpc<unknown>(
      dealerId,
      'store.marketing.trigger.action.edit',
      {
        id: EMAIL_TRIGGER_ID,
        enabled: true,
        messageHeaderText: EMAIL_SUBJECT,
        sender: EMAIL_SENDER,
        messageText: {
          design: b64(JSON.stringify(EMAIL_DESIGN)),
          html: b64(EMAIL_HTML),
        },
      },
    )
    console.log('[birthday-event-apply] email edit OK:', JSON.stringify(emailResult).slice(0, 200))

    // ---------- SMS (disabled) ----------
    // Step 1: seed approved template + image so messageText is accepted.
    try {
      console.log(`[birthday-event-apply] seeding SMS trigger ${SMS_TRIGGER_ID} with approved template/image`)
      await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
        id: SMS_TRIGGER_ID,
        approvedTemplateId: SMS_APPROVED_TEMPLATE_ID,
        approvedImageId: SMS_APPROVED_IMAGE_ID,
      })

      // Step 2: write content; keep enabled=false (the email-only ask).
      console.log(`[birthday-event-apply] editing SMS trigger ${SMS_TRIGGER_ID} (DISABLED)`)
      const smsResult = await callSweedRpc<unknown>(
        dealerId,
        'store.marketing.trigger.action.edit',
        {
          id: SMS_TRIGGER_ID,
          enabled: false,
          messageText: {
            design: b64(JSON.stringify(SMS_DESIGN)),
            html: b64(SMS_HTML),
          },
        },
      )
      console.log('[birthday-event-apply] sms edit OK:', JSON.stringify(smsResult).slice(0, 200))
    } catch (err) {
      console.warn(
        '[birthday-event-apply] SMS edit skipped (state dealer may need a different approved template/image):',
        err instanceof Error ? err.message : err,
      )
    }

    // ---------- Verify ----------
    const verify = await callSweedRpc<unknown>(dealerId, 'store.marketing.event.get', { id: EVENT_ID })
    console.log('[birthday-event-apply] post-edit event state:')
    console.log(JSON.stringify(verify, null, 2))
  })
}

main().catch((error: unknown) => {
  console.error('[birthday-event-apply] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
