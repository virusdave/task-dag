// Re-theme the state-level Sweed marketing event 2475 ("Level Up!" — a
// loyalty nudge to members who are <100 points from the next tier,
// segment 1575) with FBNYC brand chrome: dark card, gold accent, Georgia
// serif heading, logo, high-contrast cream copy, and a "See Your Progress"
// CTA at the top AND bottom.
//
// Copy generated via the private Mantle/Bedrock LLM (moonshotai.kimi-k2.5)
// per the brand brief: human, no em-dashes (canon), no AI tells. The
// subject + intro keep the Sweed merge tag {{loyalty_points_before_next_level}}.
//
// SAFETY (canon §1 — no unreviewed customer sends):
//   Event 2475 is DISABLED and all three channels are off, so nothing
//   sends. This edits the email *content only* and KEEPS the trigger
//   disabled. It does not touch the event and never enables a channel.
//
// Run from helios/:
//   DATABASE_URL=postgres://... npx tsx scripts/event-2475-levelup-apply.ts

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const EVENT_ID = '2475'
const EMAIL_TRIGGER_ID = '27547'

const EMAIL_SENDER = {
  id: '9e09e1c4-c0f2-44ca-a81d-e0766f34f2f6',
  name: 'Freshly Baked NYC',
  email: 'support@freshlybaked.nyc',
}
// Keep the Sweed merge tag intact; it is filled per-recipient at send.
const EMAIL_SUBJECT = "You're {{loyalty_points_before_next_level}} points away"

const LOGO_URL =
  'https://assets.unlayer.com/projects/12653/1776278193560-LOGO%20-%20FBNYC%20logo%20midtown%20-%20digital.png'

// Loyalty profile (preserved from the existing trigger). NOTE: this is a
// store-specific profile path; see the operator note in the report.
const CTA_URL = 'https://freshlybaked.nyc/stores/midtown/shop/profile'
const CTA_LABEL = 'See Your Progress'

const PREHEADER = 'Your next tier is right there. Faster points, bonus discount, and you.'

// ---- Mandatory compliance footer (verbatim from recent site-level emails) ----
const COMPLIANCE_LINE_1 =
  '&copy; Freshly Baked NYC&nbsp;&nbsp;&bull;&nbsp;&nbsp;OCM-RETL-26-000488&nbsp;&nbsp;&bull;&nbsp;&nbsp;OCM-CAURD-24-000137&nbsp;&nbsp;&bull;&nbsp;&nbsp;NYS HOPELINE ph: 877-846-7369 text: 467369'
const COMPLIANCE_LINE_2 =
  'For use only by persons 21 years of age and older. Keep out of reach of children and pets.'
const COMPLIANCE_LINE_3 = 'If someone accidentally consumes cannabis, contact the Poison Center.'
const COMPLIANCE_LINE_4 = 'Consume responsibly. Cannabis can be addictive.'
const COMPLIANCE_BAND_INNER =
  `<div style="font-family:arial,helvetica,sans-serif;font-size:11px;line-height:160%;text-align:center;color:#1a1a1a;word-wrap:break-word;">` +
  `<span style="color:#1a1a1a;">${COMPLIANCE_LINE_1}</span><br>` +
  `<span style="color:#1a1a1a;">${COMPLIANCE_LINE_2}</span><br>` +
  `<span style="color:#1a1a1a;">${COMPLIANCE_LINE_3}</span><br>` +
  `<span style="color:#1a1a1a;">${COMPLIANCE_LINE_4}</span>` +
  `</div>`

const PAGE_BG = '#161111'
const CARD_BG = '#1d1514'

// ---------------------------------------------------------------------------
// Rendered HTML (customer-facing). Table-based, inline styles, 560px card.
// ---------------------------------------------------------------------------

function ctaButtonHtml(): string {
  return `
        <tr><td align="center" style="padding:4px 28px 22px 28px;">
          <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${CTA_URL}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="50%" strokecolor="#e8b265" fillcolor="#e8b265"><w:anchorlock/><center style="color:#2b1f1a;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;">${CTA_LABEL}</center></v:roundrect><![endif]-->
          <!--[if !mso]><!-- -->
          <a href="${CTA_URL}" target="_blank" style="background:#e8b265;color:#2b1f1a;text-decoration:none;display:inline-block;border-radius:999px;padding:15px 40px;font-weight:700;font-size:15px;line-height:120%;letter-spacing:0.6px;text-transform:uppercase;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${CTA_LABEL}</a>
          <!--<![endif]-->
        </td></tr>`
}

const EMAIL_HTML = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="x-apple-disable-message-reformatting" />
<title>You're almost at your next Freshly Baked NYC tier</title>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  body { margin:0; padding:0; background:#161111; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  a { color:#e8b265; }
  @media only screen and (max-width:600px) {
    .card { width:100% !important; max-width:100% !important; border-radius:0 !important; }
    .pad { padding-left:20px !important; padding-right:20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#161111;color:#f7eee8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${PREHEADER}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#161111;">
  <tr><td align="center" style="padding:18px 12px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="card" style="background:#1d1514;border-radius:30px;width:560px;max-width:560px;overflow:hidden;">

      <!-- Logo -->
      <tr><td align="center" style="padding:30px 28px 6px 28px;">
        <a href="${CTA_URL}" target="_blank" style="display:inline-block;">
          <img src="${LOGO_URL}" alt="Freshly Baked NYC" width="220" style="display:block;width:220px;max-width:62%;height:auto;" />
        </a>
      </td></tr>

      <!-- Eyebrow + heading + intro -->
      <tr><td class="pad" style="padding:10px 28px 0 28px;">
        <p style="margin:0;text-transform:uppercase;letter-spacing:2px;color:#e8b265;font-size:12px;line-height:165%;font-weight:700;">Almost there 🍃</p>
      </td></tr>
      <tr><td class="pad" style="padding:4px 28px 10px 28px;">
        <h1 style="margin:0;color:#f7eee8;font-family:Georgia,'Palatino','Book Antiqua','Palatino Linotype',serif;font-size:30px;line-height:120%;">This close. Seriously.</h1>
      </td></tr>
      <tr><td class="pad" style="padding:0 28px 16px 28px;color:#eadfd6;font-size:16px;line-height:165%;">
        <p style="margin:0 0 12px 0;color:#eadfd6;">You're sitting <strong style="color:#f7eee8;">{{loyalty_points_before_next_level}} points</strong> from your next tier. That's not a metaphor. That's a small purchase, a pre-roll, maybe a gummy or two.</p>
        <p style="margin:0;color:#eadfd6;">We see you. We know you've been building this. And we're the annoying friend who's going to tell you: you're right there.</p>
      </td></tr>

      <!-- Payoff banner -->
      <tr><td class="pad" style="padding:2px 28px 18px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="background:#e8b265;border-radius:18px;padding:16px 18px;text-align:center;">
            <p style="margin:0;color:#2b1f1a;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;font-size:14px;line-height:140%;">Level up and earn points 2x faster, starting with your next order</p>
          </td></tr>
        </table>
      </td></tr>

      <!-- Top CTA -->
      ${ctaButtonHtml()}

      <!-- Details -->
      <tr><td class="pad" style="padding:0 28px 18px 28px;color:#eadfd6;font-size:15px;line-height:165%;">
        <p style="margin:0 0 10px 0;color:#eadfd6;">Here's what actually happens when you hit the next tier: every dollar you spend starts earning double points (or more, if you're climbing high). Plus we drop a discount bonus straight into your account for the next time you shop. No hoops, no waiting.</p>
        <ul style="margin:0;padding:0 0 0 18px;color:#eadfd6;font-size:15px;line-height:165%;">
          <li style="margin:0 0 6px 0;">Earn 2x to 5x points per dollar at higher tiers.</li>
          <li style="margin:0 0 6px 0;">Automatic discount bonus loaded to your account.</li>
          <li style="margin:0;">Keep climbing; the math keeps getting better.</li>
        </ul>
      </td></tr>

      <!-- Bottom CTA -->
      ${ctaButtonHtml()}

      <!-- Sign-off -->
      <tr><td class="pad" style="padding:0 28px 18px 28px;color:#eadfd6;font-size:14px;line-height:165%;">
        <p style="margin:0;color:#eadfd6;">Come grab something good. We'll count the points.</p>
        <p style="margin:8px 0 0 0;color:#eadfd6;">Freshly Baked NYC</p>
      </td></tr>

      <!-- Mandatory compliance footer (site-level boilerplate) -->
      <tr><td style="padding:14px 24px 28px 24px;border-top:1px solid #2b201d;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="background-color:#fbeeb8;border-radius:8px;padding:12px 16px;">
            ${COMPLIANCE_BAND_INNER}
          </td></tr>
        </table>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`

// ---------------------------------------------------------------------------
// Matching Unlayer schema-v21 design (editable in the Sweed Prime UI).
// ---------------------------------------------------------------------------

function ctaButtonBlock() {
  return {
    type: 'button',
    values: {
      containerPadding: '4px 28px 22px 28px',
      href: { name: 'web', values: { href: CTA_URL, target: '_blank' } },
      buttonColors: {
        color: '#2b1f1a',
        backgroundColor: '#e8b265',
        hoverColor: '#2b1f1a',
        hoverBackgroundColor: '#e8b265',
      },
      size: { autoWidth: true, width: '100%' },
      fontSize: '15px',
      lineHeight: '120%',
      textAlign: 'center',
      padding: '15px 40px',
      borderRadius: '999px',
      text: `<span style="font-size:15px;line-height:18px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;">${CTA_LABEL}</span>`,
    },
  }
}

function col(contents: unknown[]) {
  return {
    cells: [1],
    columns: [{ contents, values: { backgroundColor: CARD_BG } }],
    values: { backgroundColor: PAGE_BG, columnsBackgroundColor: CARD_BG, padding: '0 18px 0 18px' },
  }
}

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
                  containerPadding: '30px 28px 6px 28px',
                  src: { url: LOGO_URL, width: 2168, height: 1984 },
                  textAlign: 'center',
                  altText: 'Freshly Baked NYC',
                  action: { name: 'web', values: { href: CTA_URL, target: '_blank' } },
                  width: '220px',
                },
              },
            ],
            values: { backgroundColor: CARD_BG, borderRadius: '30px' },
          },
        ],
        values: { backgroundColor: PAGE_BG, columnsBackgroundColor: CARD_BG, padding: '18px 18px 0 18px' },
      },
      // Eyebrow + heading + intro
      col([
        {
          type: 'text',
          values: {
            containerPadding: '10px 28px 0 28px',
            fontSize: '12px',
            color: '#e8b265',
            text: '<p style="margin:0;text-transform:uppercase;letter-spacing:2px;color:#e8b265;font-weight:700;">Almost there 🍃</p>',
          },
        },
        {
          type: 'heading',
          values: {
            containerPadding: '4px 28px 10px 28px',
            headingType: 'h1',
            fontFamily: { label: 'Georgia', value: 'georgia,palatino,book antiqua,palatino linotype,serif' },
            fontSize: '30px',
            color: '#f7eee8',
            lineHeight: '120%',
            text: '<span style="color:#f7eee8;">This close. Seriously.</span>',
          },
        },
        {
          type: 'text',
          values: {
            containerPadding: '0 28px 16px 28px',
            fontSize: '16px',
            color: '#eadfd6',
            lineHeight: '165%',
            text: "<p style=\"margin:0 0 12px 0;color:#eadfd6;\">You're sitting <strong style=\"color:#f7eee8;\">{{loyalty_points_before_next_level}} points</strong> from your next tier. That's not a metaphor. That's a small purchase, a pre-roll, maybe a gummy or two.</p><p style=\"margin:0;color:#eadfd6;\">We see you. We know you've been building this. And we're the annoying friend who's going to tell you: you're right there.</p>",
          },
        },
      ]),
      // Payoff banner
      col([
        {
          type: 'text',
          values: {
            containerPadding: '2px 28px 18px 28px',
            fontSize: '14px',
            color: '#2b1f1a',
            textAlign: 'center',
            text: '<table role="presentation" width="100%"><tr><td style="background:#e8b265;border-radius:18px;padding:16px 18px;text-align:center;"><p style="margin:0;color:#2b1f1a;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">Level up and earn points 2x faster, starting with your next order</p></td></tr></table>',
          },
        },
      ]),
      // Top CTA
      col([ctaButtonBlock()]),
      // Details
      col([
        {
          type: 'text',
          values: {
            containerPadding: '0 28px 18px 28px',
            fontSize: '15px',
            color: '#eadfd6',
            lineHeight: '165%',
            text: '<p style="margin:0 0 10px 0;color:#eadfd6;">Here\'s what actually happens when you hit the next tier: every dollar you spend starts earning double points (or more, if you\'re climbing high). Plus we drop a discount bonus straight into your account for the next time you shop. No hoops, no waiting.</p><ul style="margin:0;padding:0 0 0 18px;color:#eadfd6;"><li style="margin:0 0 6px 0;">Earn 2x to 5x points per dollar at higher tiers.</li><li style="margin:0 0 6px 0;">Automatic discount bonus loaded to your account.</li><li style="margin:0;">Keep climbing; the math keeps getting better.</li></ul>',
          },
        },
      ]),
      // Bottom CTA
      col([ctaButtonBlock()]),
      // Sign-off
      col([
        {
          type: 'text',
          values: {
            containerPadding: '0 28px 18px 28px',
            fontSize: '14px',
            color: '#eadfd6',
            lineHeight: '165%',
            text: '<p style="margin:0;color:#eadfd6;">Come grab something good. We\'ll count the points.</p><p style="margin:8px 0 0 0;color:#eadfd6;">Freshly Baked NYC</p>',
          },
        },
      ]),
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
                  containerPadding: '14px 24px 28px 24px',
                  fontSize: '11px',
                  color: '#1a1a1a',
                  textAlign: 'center',
                  text:
                    '<table role="presentation" width="100%"><tr><td style="background-color:#fbeeb8;border-radius:8px;padding:12px 16px;">' +
                    COMPLIANCE_BAND_INNER +
                    '</td></tr></table>',
                },
              },
            ],
            values: { backgroundColor: CARD_BG },
          },
        ],
        values: { backgroundColor: PAGE_BG, columnsBackgroundColor: CARD_BG, padding: '0 18px 18px 18px' },
      },
    ],
    values: {
      backgroundColor: PAGE_BG,
      contentWidth: '560px',
      fontFamily: { label: 'Helvetica', value: 'helvetica,arial,sans-serif' },
      preheaderText: PREHEADER,
    },
  },
  schemaVersion: 21,
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

const DRY_RUN = process.env.DRY_RUN === '1'

async function main(): Promise<void> {
  const fs = await import('node:fs')
  fs.writeFileSync('/tmp/event-2475-preview.html', EMAIL_HTML)
  console.log('[event-2475] wrote preview HTML to /tmp/event-2475-preview.html')

  if (DRY_RUN) {
    console.log('[event-2475] DRY_RUN=1 (no Sweed calls).')
    return
  }

  const env = getWorkerEnv()
  const dealerId = env.sweedStateDealerId

  await withSweedSession(async () => {
    console.log(`[event-2475] re-theming email trigger ${EMAIL_TRIGGER_ID} (kept DISABLED)`)
    const out = await callSweedRpc<unknown>(dealerId, 'store.marketing.trigger.action.edit', {
      id: EMAIL_TRIGGER_ID,
      enabled: false, // canon §1: keep disabled; human enables after review
      messageHeaderText: EMAIL_SUBJECT,
      sender: EMAIL_SENDER,
      messageText: {
        design: b64(JSON.stringify(EMAIL_DESIGN)),
        html: b64(EMAIL_HTML),
      },
    })
    console.log('[event-2475] email content edit OK:', JSON.stringify(out).slice(0, 200))

    const verify = await callSweedRpc<any>(dealerId, 'store.marketing.event.get', { id: EVENT_ID })
    const email = (verify.triggers ?? []).find((t: any) => t.actionType?.id === 3)
    console.log(
      '[event-2475] verified:',
      JSON.stringify(
        {
          eventEnabled: verify.event?.enabled,
          channels: verify.event?.channels,
          emailTrigger: {
            id: email?.id,
            enabled: email?.enabled,
            subject: email?.messageHeaderText,
            sender: email?.sender,
            lastUpdated: email?.lastUpdated,
            htmlBytes: email?.messageText?.html?.length ?? 0,
            designBytes: email?.messageText?.design?.length ?? 0,
          },
        },
        null,
        2,
      ),
    )
  })
}

main().catch((err: unknown) => {
  console.error('[event-2475] FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
