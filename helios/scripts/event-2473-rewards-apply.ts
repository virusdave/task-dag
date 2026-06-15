// Re-theme the state-level Sweed marketing event 2473
// ("baked-out-levels-update" — the 4-tier loyalty/rewards announcement)
// with the Freshly Baked NYC brand chrome: dark card, gold accent,
// Georgia serif headings, logo, high-contrast cream text, and a
// "Learn More" CTA near the top AND bottom.
//
// Brand vocabulary cribbed from birthday-event-apply-v2.ts (event 2232)
// and docs/sweed/marketing.md §1.6:
//   page #161111 · card #1d1514 · gold #e8b265 · cream #f7eee8 /
//   #eadfd6 · dark-on-gold #2b1f1a · footer #8a7e74 · Georgia serif H1.
//
// IMPORTANT (canon §1 — no unreviewed customer sends):
//   This script writes the email *content* only and then DISABLES the
//   event (enabled=false) so the redesign cannot auto-send before Dave
//   reviews it and fills in the real "Learn More" URLs (currently the
//   operator-supplied placeholder https://freshlybaked.nyc/). It never
//   re-enables the event. Re-enabling is a deliberate human step.
//
// Run from helios/:
//   DATABASE_URL=postgres://... npx tsx scripts/event-2473-rewards-apply.ts

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const EVENT_ID = '2473'
const EMAIL_TRIGGER_ID = '27541'

// Preserve the existing approved sender + subject (aesthetic-only change).
const EMAIL_SENDER = {
  id: '9e09e1c4-c0f2-44ca-a81d-e0766f34f2f6',
  name: 'Freshly Baked NYC',
  email: 'support@freshlybaked.nyc',
}
const EMAIL_SUBJECT = 'Improvements to our customer rewards!'

const LOGO_URL =
  'https://assets.unlayer.com/projects/12653/1776278193560-LOGO%20-%20FBNYC%20logo%20midtown%20-%20digital.png'

// Placeholder per operator instruction ("I'll fill in the URLs later").
const CTA_URL = 'https://freshlybaked.nyc/'

const PREHEADER =
  'Our rewards program just leveled up — earn points, perks and discounts faster across four new tiers.'

// ---------------------------------------------------------------------------
// Rendered HTML (what the customer receives). Table-based, inline styles,
// 560px card, high contrast on a dark background.
// ---------------------------------------------------------------------------

// One tier "card" inside the dark content card.
function tierCardHtml(opts: {
  num: string
  name: string
  highlight: boolean
  rows: string // inner <ul> markup
}): string {
  const border = opts.highlight ? '#e8b265' : '#3a2a25'
  return `
        <tr><td style="padding:0 28px 14px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
            <tr><td style="background:#241a18;border:1px solid ${border};border-radius:16px;padding:16px 18px;">
              <p style="margin:0 0 2px 0;text-transform:uppercase;letter-spacing:2px;color:#e8b265;font-size:11px;line-height:140%;font-weight:700;">Tier ${opts.num}</p>
              <p style="margin:0 0 10px 0;font-family:Georgia,'Palatino','Book Antiqua','Palatino Linotype',serif;color:#f7eee8;font-size:20px;line-height:120%;">${opts.name}</p>
              <ul style="margin:0;padding:0 0 0 18px;color:#eadfd6;font-size:15px;line-height:160%;">
                ${opts.rows}
              </ul>
            </td></tr>
          </table>
        </td></tr>`
}

function learnMoreButtonHtml(): string {
  return `
        <tr><td align="center" style="padding:4px 28px 22px 28px;">
          <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${CTA_URL}" style="height:48px;v-text-anchor:middle;width:220px;" arcsize="50%" strokecolor="#e8b265" fillcolor="#e8b265"><w:anchorlock/><center style="color:#2b1f1a;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;">Learn More</center></v:roundrect><![endif]-->
          <!--[if !mso]><!-- -->
          <a href="${CTA_URL}" target="_blank" style="background:#e8b265;color:#2b1f1a;text-decoration:none;display:inline-block;border-radius:999px;padding:15px 40px;font-weight:700;font-size:15px;line-height:120%;letter-spacing:0.5px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Learn More</a>
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
<title>Big upgrades to Freshly Baked NYC rewards</title>
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
        <p style="margin:0;text-transform:uppercase;letter-spacing:2px;color:#e8b265;font-size:12px;line-height:165%;font-weight:700;">Customer Rewards</p>
      </td></tr>
      <tr><td class="pad" style="padding:4px 28px 10px 28px;">
        <h1 style="margin:0;color:#f7eee8;font-family:Georgia,'Palatino','Book Antiqua','Palatino Linotype',serif;font-size:30px;line-height:120%;">Your rewards just leveled up.</h1>
      </td></tr>
      <tr><td class="pad" style="padding:0 28px 16px 28px;color:#eadfd6;font-size:16px;line-height:165%;">
        <p style="margin:0 0 12px 0;color:#eadfd6;">We love our community, and we want our most loyal customers to feel truly appreciated. So we've completely upgraded our rewards program to help you earn perks, points, and discounts faster than ever before.</p>
        <p style="margin:0;color:#eadfd6;">Here's how the new tiers work and what you can look forward to.</p>
      </td></tr>

      <!-- Top CTA -->
      ${learnMoreButtonHtml()}

      <!-- Tiers -->
      ${tierCardHtml({
        num: '1',
        name: 'Baked Out',
        highlight: false,
        rows: `<li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">How to join:</strong> Opt in with your phone number or email address.</li>
                <li style="margin:0;"><strong style="color:#f7eee8;">Your benefits:</strong> Earn <strong style="color:#e8b265;">1 point for every $1 spent</strong> (1% back) on all purchases — previously the only level in our program.</li>`,
      })}
      ${tierCardHtml({
        num: '2',
        name: 'Properly Toasted',
        highlight: false,
        rows: `<li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">How to graduate:</strong> Spend $400 within a 12-month period.</li>
                <li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">Double the points:</strong> Earn <strong style="color:#e8b265;">2 points for every $1 spent</strong>.</li>
                <li style="margin:0;"><strong style="color:#f7eee8;">Milestone reward:</strong> A one-time bonus of <strong style="color:#e8b265;">500 points</strong> ($5 value) credited to your account.</li>`,
      })}
      ${tierCardHtml({
        num: '3',
        name: 'Well Lit',
        highlight: false,
        rows: `<li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">How to graduate:</strong> Reach $900 spent within a 12-month period.</li>
                <li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">Triple the points:</strong> Earn <strong style="color:#e8b265;">3 points for every $1 spent</strong>.</li>
                <li style="margin:0;"><strong style="color:#f7eee8;">Milestone reward:</strong> A one-time bonus of <strong style="color:#e8b265;">2,500 points</strong> ($25 value).</li>`,
      })}
      ${tierCardHtml({
        num: '4',
        name: 'Stoned Immaculate',
        highlight: true,
        rows: `<li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">How to graduate:</strong> Reach $2,000 spent within a 12-month period.</li>
                <li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">Maximum multiplier:</strong> A massive <strong style="color:#e8b265;">5 points for every $1 spent</strong>.</li>
                <li style="margin:0;"><strong style="color:#f7eee8;">Milestone reward:</strong> A one-time bonus of <strong style="color:#e8b265;">5,000 points</strong> ($50 value).</li>`,
      })}

      <!-- Closing callout -->
      <tr><td class="pad" style="padding:6px 28px 18px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="background:#241a18;border-left:3px solid #e8b265;border-radius:8px;padding:14px 18px;color:#eadfd6;font-size:15px;line-height:165%;">
            <strong style="color:#f7eee8;">Ready to start earning?</strong> If you haven't joined yet, make sure your email or phone number is linked to your account next time you visit or order online so you don't miss a single point. Thank you for being such an amazing part of our journey!
          </td></tr>
        </table>
      </td></tr>

      <!-- Bottom CTA -->
      ${learnMoreButtonHtml()}

      <!-- Compliance footer -->
      <tr><td style="padding:8px 28px 30px 28px;border-top:1px solid #2b201d;color:#8a7e74;font-size:12px;line-height:165%;text-align:center;">
        <p style="margin:0;color:#8a7e74;">Consume responsibly. Cannabis can be addictive.</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`

// ---------------------------------------------------------------------------
// Matching Unlayer schema-v21 design (editable in the Sweed Prime UI).
// Buttons are real `button` blocks so the operator can drop in the final
// "Learn More" URLs without touching raw HTML.
// ---------------------------------------------------------------------------

const PAGE_BG = '#161111'
const CARD_BG = '#1d1514'

function tierTextBlock(num: string, name: string, highlight: boolean, innerLis: string) {
  const border = highlight ? '#e8b265' : '#3a2a25'
  return {
    type: 'text',
    values: {
      containerPadding: '0 28px 14px 28px',
      fontSize: '15px',
      color: '#eadfd6',
      lineHeight: '160%',
      text: `<table role="presentation" width="100%" style="border-collapse:separate;"><tr><td style="background:#241a18;border:1px solid ${border};border-radius:16px;padding:16px 18px;"><p style="margin:0 0 2px 0;text-transform:uppercase;letter-spacing:2px;color:#e8b265;font-size:11px;font-weight:700;">Tier ${num}</p><p style="margin:0 0 10px 0;font-family:Georgia,serif;color:#f7eee8;font-size:20px;line-height:120%;">${name}</p><ul style="margin:0;padding:0 0 0 18px;color:#eadfd6;">${innerLis}</ul></td></tr></table>`,
    },
  }
}

function buttonBlock() {
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
      text: '<span style="font-size:15px;line-height:18px;font-weight:700;">Learn More</span>',
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
            text: '<p style="margin:0;text-transform:uppercase;letter-spacing:2px;color:#e8b265;font-weight:700;">Customer Rewards</p>',
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
            text: '<span style="color:#f7eee8;">Your rewards just leveled up.</span>',
          },
        },
        {
          type: 'text',
          values: {
            containerPadding: '0 28px 16px 28px',
            fontSize: '16px',
            color: '#eadfd6',
            lineHeight: '165%',
            text: "<p style=\"margin:0 0 12px 0;color:#eadfd6;\">We love our community, and we want our most loyal customers to feel truly appreciated. So we've completely upgraded our rewards program to help you earn perks, points, and discounts faster than ever before.</p><p style=\"margin:0;color:#eadfd6;\">Here's how the new tiers work and what you can look forward to.</p>",
          },
        },
      ]),
      // Top CTA
      col([buttonBlock()]),
      // Tiers
      col([
        tierTextBlock(
          '1',
          'Baked Out',
          false,
          '<li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">How to join:</strong> Opt in with your phone number or email address.</li><li style="margin:0;"><strong style="color:#f7eee8;">Your benefits:</strong> Earn <strong style="color:#e8b265;">1 point for every $1 spent</strong> (1% back) on all purchases — previously the only level in our program.</li>',
        ),
      ]),
      col([
        tierTextBlock(
          '2',
          'Properly Toasted',
          false,
          '<li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">How to graduate:</strong> Spend $400 within a 12-month period.</li><li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">Double the points:</strong> Earn <strong style="color:#e8b265;">2 points for every $1 spent</strong>.</li><li style="margin:0;"><strong style="color:#f7eee8;">Milestone reward:</strong> A one-time bonus of <strong style="color:#e8b265;">500 points</strong> ($5 value) credited to your account.</li>',
        ),
      ]),
      col([
        tierTextBlock(
          '3',
          'Well Lit',
          false,
          '<li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">How to graduate:</strong> Reach $900 spent within a 12-month period.</li><li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">Triple the points:</strong> Earn <strong style="color:#e8b265;">3 points for every $1 spent</strong>.</li><li style="margin:0;"><strong style="color:#f7eee8;">Milestone reward:</strong> A one-time bonus of <strong style="color:#e8b265;">2,500 points</strong> ($25 value).</li>',
        ),
      ]),
      col([
        tierTextBlock(
          '4',
          'Stoned Immaculate',
          true,
          '<li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">How to graduate:</strong> Reach $2,000 spent within a 12-month period.</li><li style="margin:0 0 6px 0;"><strong style="color:#f7eee8;">Maximum multiplier:</strong> A massive <strong style="color:#e8b265;">5 points for every $1 spent</strong>.</li><li style="margin:0;"><strong style="color:#f7eee8;">Milestone reward:</strong> A one-time bonus of <strong style="color:#e8b265;">5,000 points</strong> ($50 value).</li>',
        ),
      ]),
      // Closing callout
      col([
        {
          type: 'text',
          values: {
            containerPadding: '6px 28px 18px 28px',
            fontSize: '15px',
            color: '#eadfd6',
            lineHeight: '165%',
            text: "<table role=\"presentation\" width=\"100%\"><tr><td style=\"background:#241a18;border-left:3px solid #e8b265;border-radius:8px;padding:14px 18px;color:#eadfd6;\"><strong style=\"color:#f7eee8;\">Ready to start earning?</strong> If you haven't joined yet, make sure your email or phone number is linked to your account next time you visit or order online so you don't miss a single point. Thank you for being such an amazing part of our journey!</td></tr></table>",
          },
        },
      ]),
      // Bottom CTA
      col([buttonBlock()]),
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
                  containerPadding: '14px 28px 30px 28px',
                  fontSize: '12px',
                  color: '#8a7e74',
                  textAlign: 'center',
                  text: '<p style="margin:0;color:#8a7e74;text-align:center;">Consume responsibly. Cannabis can be addictive.</p>',
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
  // Emit the standalone HTML for preview regardless of mode.
  const fs = await import('node:fs')
  fs.writeFileSync('/tmp/event-2473-preview.html', EMAIL_HTML)
  console.log('[event-2473] wrote preview HTML to /tmp/event-2473-preview.html')

  if (DRY_RUN) {
    console.log('[event-2473] DRY_RUN=1 — not calling Sweed. Preview only.')
    return
  }

  const env = getWorkerEnv()
  const dealerId = env.sweedStateDealerId

  await withSweedSession(async () => {
    console.log(`[event-2473] re-theming email trigger ${EMAIL_TRIGGER_ID} with FBNYC brand chrome`)
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
    console.log('[event-2473] email content edit OK:', JSON.stringify(out).slice(0, 200))

    // CANON §1 GATE: disable the event so the redesign cannot auto-send
    // before Dave reviews it and fills in the real "Learn More" URLs.
    // Preserve the existing schedule/audience verbatim (only flip enabled).
    console.log('[event-2473] disabling event to prevent unreviewed auto-send')
    const disableOut = await callSweedRpc<unknown>(dealerId, 'store.marketing.event.edit', {
      id: EVENT_ID,
      enabled: false,
      name: 'baked-out-levels-update',
      fromDate: '2026-06-15',
      toDate: '2026-06-21',
      cronExpression: '0 0 * * 1,3,6 *',
      startTimeMin: 660,
      segments: ['1541'],
    })
    console.log('[event-2473] event.edit (disable) OK:', JSON.stringify(disableOut).slice(0, 200))

    // QA: re-fetch and report.
    const verify = await callSweedRpc<any>(dealerId, 'store.marketing.event.get', { id: EVENT_ID })
    const email = (verify.triggers ?? []).find((t: any) => t.actionType?.id === 3)
    console.log(
      '[event-2473] verified:',
      JSON.stringify(
        {
          eventEnabled: verify.event?.enabled,
          eventState: verify.event?.state,
          nextEventDate: verify.event?.nextEventDate,
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
  console.error('[event-2473] FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
