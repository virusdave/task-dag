// v2 of birthday-event-apply: re-themes the email body with the
// Freshly Baked NYC brand palette + logo, cribbed from the
// site-level Midtown 420 / delivery emails (e.g. event 1804 on
// dealer 210705). The recon script (birthday-imagery-recon.ts)
// turned up the canonical assets:
//
//   - Header logo (used across Midtown + Bronx):
//       https://assets.unlayer.com/projects/12653/1776278193560-LOGO%20-%20FBNYC%20logo%20midtown%20-%20digital.png
//   - Page bg #161111, card #1d1514, gold accent #e8b265,
//     cream text #f7eee8 / #eadfd6, dark text #2b1f1a,
//     Georgia serif headings, 30px rounded card, pill button.
//
// Only the email trigger (25921) is rewritten. SMS trigger (25922)
// already has the body + leaf logo from v1 and stays untouched.

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const EVENT_ID = '2232'
const EMAIL_TRIGGER_ID = '25921'

const EMAIL_SENDER = {
  id: '9e09e1c4-c0f2-44ca-a81d-e0766f34f2f6',
  name: 'Freshly Baked NYC',
  email: 'support@freshlybaked.nyc',
}

const EMAIL_SUBJECT = '🎂 Happy Birthday from Freshly Baked — your 5% gift inside'

const LOGO_URL =
  'https://assets.unlayer.com/projects/12653/1776278193560-LOGO%20-%20FBNYC%20logo%20midtown%20-%20digital.png'
const SHOP_URL = 'https://freshlybaked.nyc/?modal=locations'

const EMAIL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<title>Happy Birthday from Freshly Baked NYC</title>
<style>
  body { margin:0; padding:0; background:#161111; color:#f7eee8; font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; }
  a { color:#e8b265; text-decoration:none; }
  .card { background:#1d1514; border-radius:30px; }
  .pill { background:#e8b265; color:#2b1f1a; text-decoration:none; display:inline-block; border-radius:999px; padding:14px 28px; font-weight:600; font-size:14px; line-height:120%; }
  .eyebrow { text-transform:uppercase; letter-spacing:2px; color:#e8b265; font-size:12px; line-height:165%; margin:0; }
  .serif { font-family:Georgia,'Palatino','Book Antiqua','Palatino Linotype',serif; }
  .banner { background:#e8b265; color:#2b1f1a; border-radius:20px; padding:14px 18px; text-align:center; font-weight:600; letter-spacing:1.6px; text-transform:uppercase; font-size:13px; line-height:140%; }
</style>
</head>
<body style="margin:0;padding:0;background:#161111;color:#f7eee8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">A little something to celebrate you today — 5% off, just for your birthday.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#161111;">
  <tr><td align="center" style="padding:18px 0;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="card" style="background:#1d1514;border-radius:30px;width:560px;max-width:560px;">
      <tr><td align="center" style="padding:24px 28px 4px 28px;">
        <a href="${SHOP_URL}" target="_blank" style="display:inline-block;">
          <img src="${LOGO_URL}" alt="Freshly Baked NYC" width="220" style="display:block;width:220px;max-width:60%;height:auto;border:0;outline:none;" />
        </a>
      </td></tr>
      <tr><td style="padding:8px 28px 0 28px;" class="eyebrow">
        <p class="eyebrow" style="margin:0;text-transform:uppercase;letter-spacing:2px;color:#e8b265;font-size:12px;line-height:165%;">🎂 Happy Birthday</p>
      </td></tr>
      <tr><td style="padding:4px 28px 12px 28px;">
        <h1 class="serif" style="margin:0;color:#f7eee8;font-family:Georgia,'Palatino','Book Antiqua','Palatino Linotype',serif;font-size:32px;line-height:118%;">Happy Birthday from Freshly Baked NYC.</h1>
      </td></tr>
      <tr><td style="padding:0 28px 14px 28px;color:#eadfd6;font-size:16px;line-height:165%;">
        <p style="margin:0 0 14px 0;color:#eadfd6;">From everyone at Freshly Baked NYC, we hope today is exactly the kind of day you're in the mood for.</p>
        <p style="margin:0;color:#eadfd6;">To celebrate, here's a little gift from us.</p>
      </td></tr>
      <tr><td style="padding:6px 28px 14px 28px;">
        <div class="banner" style="background:#e8b265;color:#2b1f1a;border-radius:20px;padding:14px 18px;text-align:center;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;font-size:13px;line-height:140%;">
          🎁&nbsp;&nbsp;5% OFF YOUR ORDER — TODAY ONLY
        </div>
      </td></tr>
      <tr><td style="padding:0 28px 14px 28px;color:#eadfd6;font-size:16px;line-height:165%;">
        <p style="margin:0 0 14px 0;color:#eadfd6;">The discount is automatically applied at checkout on your account. No code, no fuss — just shop and we'll take care of the rest.</p>
        <ul style="margin:0 0 14px 18px;padding:0;color:#eadfd6;font-size:15px;line-height:165%;">
          <li>Valid today only (your birthday).</li>
          <li>In-store, pickup, or delivery orders.</li>
          <li>T&amp;C and limits may apply.</li>
        </ul>
      </td></tr>
      <tr><td align="center" style="padding:0 28px 28px 28px;">
        <a href="${SHOP_URL}" target="_blank" class="pill" style="background:#e8b265;color:#2b1f1a;text-decoration:none;display:inline-block;border-radius:999px;padding:14px 28px;font-weight:600;font-size:14px;line-height:120%;">Shop Now</a>
      </td></tr>
      <tr><td style="padding:0 28px 28px 28px;color:#eadfd6;font-size:14px;line-height:165%;">
        <p style="margin:0;color:#eadfd6;">Thanks for being part of the Freshly Baked family. Have a great one.</p>
        <p style="margin:8px 0 0 0;color:#eadfd6;">— The Freshly Baked NYC team</p>
      </td></tr>
      <tr><td style="padding:14px 28px 28px 28px;border-top:1px solid #2b201d;color:#8a7e74;font-size:12px;line-height:165%;text-align:center;">
        Consume responsibly. Cannabis can be addictive.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`

// Matching unlayer schema-v21 design. Mirrors the Midtown-420 (event
// 1804) styling vocabulary: dark card, gold accent, Georgia heading,
// pill button.
const EMAIL_DESIGN = {
  body: {
    rows: [
      // Logo
      {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: 'image',
                values: {
                  containerPadding: '24px 28px 4px 28px',
                  src: { url: LOGO_URL, width: 2168, height: 1984 },
                  textAlign: 'center',
                  altText: 'Freshly Baked NYC',
                  action: {
                    name: 'web',
                    values: { href: SHOP_URL, target: '_blank' },
                  },
                  width: '220px',
                },
              },
            ],
            values: { backgroundColor: '#1d1514', borderRadius: '30px' },
          },
        ],
        values: { backgroundColor: '#161111', columnsBackgroundColor: '#1d1514', padding: '18px 18px 0 18px' },
      },
      // Eyebrow + heading + intro
      {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: 'text',
                values: {
                  containerPadding: '8px 28px 0 28px',
                  fontSize: '12px',
                  color: '#e8b265',
                  text: '<p style="margin:0;text-transform:uppercase;letter-spacing:2px;color:#e8b265;">🎂 Happy Birthday</p>',
                },
              },
              {
                type: 'heading',
                values: {
                  containerPadding: '4px 28px 12px 28px',
                  headingType: 'h1',
                  fontFamily: { label: 'Georgia', value: "georgia,palatino,book antiqua,palatino linotype,serif" },
                  fontSize: '32px',
                  color: '#f7eee8',
                  lineHeight: '118%',
                  text: '<span style="color:#f7eee8;">Happy Birthday from Freshly Baked NYC.</span>',
                },
              },
              {
                type: 'text',
                values: {
                  containerPadding: '0 28px 14px 28px',
                  fontSize: '16px',
                  color: '#eadfd6',
                  lineHeight: '165%',
                  text: '<p style="margin:0 0 14px 0;color:#eadfd6;">From everyone at Freshly Baked NYC, we hope today is exactly the kind of day you\'re in the mood for.</p><p style="margin:0;color:#eadfd6;">To celebrate, here\'s a little gift from us.</p>',
                },
              },
            ],
            values: { backgroundColor: '#1d1514' },
          },
        ],
        values: { backgroundColor: '#161111', columnsBackgroundColor: '#1d1514', padding: '0 18px 0 18px' },
      },
      // 5% off banner
      {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: 'text',
                values: {
                  containerPadding: '14px 18px',
                  fontSize: '13px',
                  color: '#2b1f1a',
                  textAlign: 'center',
                  text: '<p style="margin:0;text-transform:uppercase;letter-spacing:1.6px;color:#2b1f1a;font-weight:600;">🎁&nbsp;&nbsp;5% OFF YOUR ORDER — TODAY ONLY</p>',
                },
              },
            ],
            values: { backgroundColor: '#e8b265', borderRadius: '20px' },
          },
        ],
        values: { backgroundColor: '#161111', padding: '6px 28px 14px 28px' },
      },
      // Body + bullets
      {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: 'text',
                values: {
                  containerPadding: '0 28px 14px 28px',
                  fontSize: '16px',
                  color: '#eadfd6',
                  lineHeight: '165%',
                  text: '<p style="margin:0 0 14px 0;color:#eadfd6;">The discount is automatically applied at checkout on your account. No code, no fuss — just shop and we\'ll take care of the rest.</p><ul style="margin:0 0 14px 18px;padding:0;color:#eadfd6;"><li>Valid today only (your birthday).</li><li>In-store, pickup, or delivery orders.</li><li>T&amp;C and limits may apply.</li></ul>',
                },
              },
            ],
            values: { backgroundColor: '#1d1514' },
          },
        ],
        values: { backgroundColor: '#161111', columnsBackgroundColor: '#1d1514', padding: '0 18px 0 18px' },
      },
      // Shop Now pill button
      {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: 'button',
                values: {
                  containerPadding: '0 28px 28px 28px',
                  href: { name: 'web', values: { href: SHOP_URL, target: '_blank' } },
                  buttonColors: {
                    color: '#2b1f1a',
                    backgroundColor: '#e8b265',
                    hoverColor: '#2b1f1a',
                    hoverBackgroundColor: '#e8b265',
                  },
                  size: { autoWidth: true, width: '100%' },
                  fontSize: '14px',
                  lineHeight: '120%',
                  textAlign: 'center',
                  padding: '14px 28px',
                  borderRadius: '999px',
                  text: '<span style="font-size:14px;line-height:16.8px;">Shop Now</span>',
                },
              },
            ],
            values: { backgroundColor: '#1d1514' },
          },
        ],
        values: { backgroundColor: '#161111', columnsBackgroundColor: '#1d1514', padding: '0 18px 0 18px' },
      },
      // Sign-off
      {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: 'text',
                values: {
                  containerPadding: '0 28px 28px 28px',
                  fontSize: '14px',
                  color: '#eadfd6',
                  lineHeight: '165%',
                  text: '<p style="margin:0;color:#eadfd6;">Thanks for being part of the Freshly Baked family. Have a great one.</p><p style="margin:8px 0 0 0;color:#eadfd6;">— The Freshly Baked NYC team</p>',
                },
              },
            ],
            values: { backgroundColor: '#1d1514' },
          },
        ],
        values: { backgroundColor: '#161111', columnsBackgroundColor: '#1d1514', padding: '0 18px 0 18px' },
      },
      // Compliance footer
      {
        cells: [1],
        columns: [
          {
            contents: [
              {
                type: 'divider',
                values: {
                  containerPadding: '0 28px 0 28px',
                  border: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: '#2b201d' },
                },
              },
              {
                type: 'text',
                values: {
                  containerPadding: '14px 28px 28px 28px',
                  fontSize: '12px',
                  color: '#8a7e74',
                  textAlign: 'center',
                  text: '<p style="margin:0;color:#8a7e74;text-align:center;">Consume responsibly. Cannabis can be addictive.</p>',
                },
              },
            ],
            values: { backgroundColor: '#1d1514' },
          },
        ],
        values: { backgroundColor: '#161111', columnsBackgroundColor: '#1d1514', padding: '0 18px 18px 18px' },
      },
    ],
    values: {
      backgroundColor: '#161111',
      contentWidth: '560px',
      fontFamily: { label: "Helvetica", value: "helvetica,arial,sans-serif" },
      preheaderText: "A little something to celebrate you today — 5% off, just for your birthday.",
    },
  },
  schemaVersion: 21,
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

async function main(): Promise<void> {
  const env = getWorkerEnv()
  const dealerId = env.sweedStateDealerId

  await withSweedSession(async () => {
    console.log(`[birthday-event-apply-v2] re-theming email trigger ${EMAIL_TRIGGER_ID} with FBNYC brand chrome`)
    const out = await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
      id: EMAIL_TRIGGER_ID,
      enabled: true,
      messageHeaderText: EMAIL_SUBJECT,
      sender: EMAIL_SENDER,
      messageText: {
        design: b64(JSON.stringify(EMAIL_DESIGN)),
        html: b64(EMAIL_HTML),
      },
    })
    console.log('[birthday-event-apply-v2] email edit OK:', JSON.stringify(out).slice(0, 200))

    const verify = await callSweedRpc<any>(dealerId, 'store.marketing.event.get', { id: EVENT_ID })
    const email = (verify.triggers ?? []).find((t: any) => t.actionType?.id === 3)
    console.log('[birthday-event-apply-v2] verified email trigger:', JSON.stringify({
      id: email?.id,
      enabled: email?.enabled,
      messageHeaderText: email?.messageHeaderText,
      sender: email?.sender,
      lastUpdated: email?.lastUpdated,
      htmlBytes: email?.messageText?.html?.length ?? 0,
      designBytes: email?.messageText?.design?.length ?? 0,
    }, null, 2))
    const channels = verify.event?.channels ?? []
    console.log('[birthday-event-apply-v2] channel summary:', JSON.stringify(channels, null, 2))
  })
}

main().catch((err: unknown) => {
  console.error('[birthday-event-apply-v2] FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
