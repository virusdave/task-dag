// One-time import of the hardcoded FB-NYC loyalty/rewards FAQ into the
// Helios SEO FAQ control plane (child FreshlyBakedNYC/automation#46, P1).
//
// SOURCE OF TRUTH (provenance pinned below): the live, hand-authored FAQ
// page in the renderer repo,
//   Nicponskis/mostly-static-sites :
//     apps/freshlybaked-site/app/sites/all/loyalty-faq/page.tsx
// captured verbatim. This module is the bridge that moves that copy under
// the control plane so it can flow through the IRONCLAD human-approval gate
// (canon §1) and into the signed SEO bundle — after which FB.nyc renders it
// from the bundle instead of from hardcoded source (epic §4).
//
// What this module is and is NOT:
//   • It is a PURE, I/O-free data module: the verbatim `.nyc` raw answers,
//     the SANITIZED `.us` variants drafted from them, and a shared,
//     sanitized-safe question for each item. The importer (seoFaqQueries.ts)
//     and the one-off script (scripts/import-fb-nyc-faq.ts) consume it.
//   • It NEVER approves or publishes anything. The importer writes a single
//     `draft` set (source_key `fbus-global-faq`, status `draft`,
//     approval_id null). A human reviews raw+sanitized side-by-side and
//     approves the EXACT content through the gate; only then can the bundle
//     publisher (operator-only) ship it.
//
// Content rules honored here (parent EPIC_PLAN §5–§6, this child #46):
//   • answer_raw — VERBATIM from the mss source (the `.nyc` raw copy). It is
//     allowed to carry cannabis terms, the "Freshly Baked NYC" brand phrase,
//     and `.nyc` contact details; the FBUS denylist is NOT applied to it.
//   • answer_sanitized — drafted for the SANITIZED `.us` host: zero cannabis
//     meta-terms, zero "Freshly Baked NYC" brand phrase, zero `.nyc`
//     host/URL/email. Where the raw copy is already sanitized-safe (most
//     of the rewards-mechanics answers carry no cannabis/brand/.nyc terms)
//     the sanitized variant is intentionally identical.
//   • question — SHARED across both hosts, so it is held to the stricter
//     FBUS rule too: questions that named cannabis ("weed"), the brand
//     phrase, or "dispensary" were rephrased to a generic, equivalent
//     question. The mss source questions are preserved in the per-item
//     `sourceQuestion` for provenance / the reviewer's diff.
//
// KNOWN reviewer follow-up (surfaced, not hidden): the verbatim raw answer
// to "Is pay-on-delivery legal?" contains the phrase "fully legal", which
// trips the Google-Ads forbidden-claim lint (CI gate 9, `adsPolicy.ts`).
// That is real, currently-live `.nyc` copy; the import preserves it
// faithfully and the approval gate will block until a human softens it (the
// sanitized variant already says "legal"). See FB_NYC_FAQ_KNOWN_RAW_ADS_FLAGS.
//
// Satisfies: virusdave/top-level#17 · Phase: P1

import type { FaqItemInput } from './faqContent.js'
import { FBUS_GLOBAL_FAQ_SOURCE_KEY } from './faqSourceKey.js'
import { RESERVED_GLOBAL_SITE_ID } from './routeRegistry.js'

// ── provenance ────────────────────────────────────────────────────────

/** Where the verbatim raw copy was captured from (for audit / re-sync). */
export const FB_NYC_FAQ_SOURCE_PROVENANCE = {
  repo: 'Nicponskis/mostly-static-sites',
  path: 'apps/freshlybaked-site/app/sites/all/loyalty-faq/page.tsx',
  /** Default-branch (`master`) commit the copy was captured at. */
  commitSha: '13178adcb2e975565cee2f8547688bb682b2de2f',
  /** Git blob sha of the captured file. */
  blobSha: '16bdd1b35591f098f67431c8271e2a9a07e268c7',
  capturedOn: '2026-06-17',
} as const

/** Reserved global scope (`all`): the FAQ lives at `/sites/all/loyalty-faq`. */
export const FB_NYC_FAQ_SCOPE = RESERVED_GLOBAL_SITE_ID
/** Stable FBUS source identity for this imported set. */
export const FB_NYC_FAQ_SOURCE_KEY = FBUS_GLOBAL_FAQ_SOURCE_KEY

// ── the items ─────────────────────────────────────────────────────────
//
// `sourceQuestion` is the EXACT mss question (kept for provenance/diff);
// `question` is the shared, sanitized-safe phrasing actually stored. When
// the source question was already sanitized-safe the two are identical.

export interface FbNycFaqImportItem extends FaqItemInput {
  /** The exact question text in the mss source (provenance / reviewer diff). */
  readonly sourceQuestion: string
}

export const FB_NYC_FAQ_ITEMS: readonly FbNycFaqImportItem[] = [
  {
    sourceQuestion: `How does the Baked Out Club rewards program work?`,
    question: `How does the Baked Out Club rewards program work?`,
    answer_raw: `The Baked Out Club is the free loyalty program at Freshly Baked NYC, and it has four levels you climb based on how much you spend with us in a calendar year. Every purchase you make in 2026 counts toward your level, and whatever level your spending earns lasts through the end of the following year, so what you spend in 2026 sets your level all the way through the end of 2027. Everyone starts at Tier 1, Baked Out, earning 1 point per dollar (1% back) just for joining. Spend $400 in a calendar year to reach Tier 2, Properly Toasted, and earn 2 points per dollar plus a one-time 500-point bonus (a $5 value). Reach $900 for Tier 3, Well Lit, earning 3 points per dollar plus a one-time 2,500-point bonus ($25). Reach $2,000 for our top level, Tier 4, Stoned Immaculate, earning a huge 5 points per dollar plus a one-time 5,000-point bonus ($50). Every 100 points is worth $1 in credit toward future cannabis purchases in store or on delivery.`,
    answer_sanitized: `The Baked Out Club is the free loyalty program at Freshly Baked, and it has four levels you climb based on how much you spend with us in a calendar year. Every purchase you make in 2026 counts toward your level, and whatever level your spending earns lasts through the end of the following year, so what you spend in 2026 sets your level all the way through the end of 2027. Everyone starts at Tier 1, Baked Out, earning 1 point per dollar (1% back) just for joining. Spend $400 in a calendar year to reach Tier 2, Properly Toasted, and earn 2 points per dollar plus a one-time 500-point bonus (a $5 value). Reach $900 for Tier 3, Well Lit, earning 3 points per dollar plus a one-time 2,500-point bonus ($25). Reach $2,000 for our top level, Tier 4, Stoned Immaculate, earning a huge 5 points per dollar plus a one-time 5,000-point bonus ($50). Every 100 points is worth $1 in credit toward future purchases in store or on delivery.`,
  },
  {
    sourceQuestion: `What's new, and how is this different from the old program?`,
    question: `What's new, and how is this different from the old program?`,
    answer_raw: `Before, everyone earned a flat 1 point per dollar spent, no matter how loyal they were. Now 1 point per dollar is just the starting line: as your spending grows, you graduate to 2, then 3, and ultimately 5 points per dollar. On top of the faster earn rate, every new tier unlocks a one-time bonus, from 500 points ($5) at Properly Toasted up to 5,000 points ($50) at Stoned Immaculate. Same great products; you just get rewarded a lot more for being a regular.`,
    answer_sanitized: `Before, everyone earned a flat 1 point per dollar spent, no matter how loyal they were. Now 1 point per dollar is just the starting line: as your spending grows, you graduate to 2, then 3, and ultimately 5 points per dollar. On top of the faster earn rate, every new tier unlocks a one-time bonus, from 500 points ($5) at Properly Toasted up to 5,000 points ($50) at Stoned Immaculate. Same great products; you just get rewarded a lot more for being a regular.`,
  },
  {
    sourceQuestion: `When does the new rewards program start?`,
    question: `When does the new rewards program start?`,
    answer_raw: `The new Baked Out Club launches on June 15, 2026. That's the date the multi-level point earning and level-up bonuses go live.`,
    answer_sanitized: `The new Baked Out Club launches on June 15, 2026. That's the date the multi-level point earning and level-up bonuses go live.`,
  },
  {
    sourceQuestion: `I already spent a lot earlier in 2026; does that count toward my level?`,
    question: `I already spent a lot earlier in 2026; does that count toward my level?`,
    answer_raw: `Yes. Every purchase you have made in 2026 counts toward your level, not just purchases from the launch date forward. The next time you shop, we add up all of your 2026 spending together with that purchase and move you up to whatever level you have earned. Your loyalty so far already counts, so keep shopping and watch your level climb.`,
    answer_sanitized: `Yes. Every purchase you have made in 2026 counts toward your level, not just purchases from the launch date forward. The next time you shop, we add up all of your 2026 spending together with that purchase and move you up to whatever level you have earned. Your loyalty so far already counts, so keep shopping and watch your level climb.`,
  },
  {
    sourceQuestion: `How do I move up to a higher points-per-dollar level?`,
    question: `How do I move up to a higher points-per-dollar level?`,
    answer_raw: `Just keep shopping; all of your spending in a calendar year sets your level, and every 2026 purchase counts. The level you reach lasts through the end of the following year. For example, what you spend in 2026 keeps your level all the way through 2027. Spend $400 in a calendar year to graduate from Tier 1 (Baked Out) to Tier 2 (Properly Toasted) and earn 2 points per dollar. Reach $900 for Tier 3 (Well Lit) at 3 points per dollar, and $2,000 for Tier 4 (Stoned Immaculate) at 5 points per dollar.`,
    answer_sanitized: `Just keep shopping; all of your spending in a calendar year sets your level, and every 2026 purchase counts. The level you reach lasts through the end of the following year. For example, what you spend in 2026 keeps your level all the way through 2027. Spend $400 in a calendar year to graduate from Tier 1 (Baked Out) to Tier 2 (Properly Toasted) and earn 2 points per dollar. Reach $900 for Tier 3 (Well Lit) at 3 points per dollar, and $2,000 for Tier 4 (Stoned Immaculate) at 5 points per dollar.`,
  },
  {
    sourceQuestion: `What are the level-up bonuses?`,
    question: `What are the level-up bonuses?`,
    answer_raw: `Each time you graduate to a new tier, we say thank you with a one-time bonus dropped straight into your account: 500 points (a $5 value) when you reach Properly Toasted, 2,500 points ($25) at Well Lit, and 5,000 points ($50) at Stoned Immaculate. Since every 100 points is worth $1, those bonuses are real credit toward your next order, on top of the faster earn rate you unlock at each level.`,
    answer_sanitized: `Each time you graduate to a new tier, we say thank you with a one-time bonus dropped straight into your account: 500 points (a $5 value) when you reach Properly Toasted, 2,500 points ($25) at Well Lit, and 5,000 points ($50) at Stoned Immaculate. Since every 100 points is worth $1, those bonuses are real credit toward your next order, on top of the faster earn rate you unlock at each level.`,
  },
  {
    sourceQuestion: `How do I join the Baked Out Club?`,
    question: `How do I join the Baked Out Club?`,
    answer_raw: `It's free to join. Sign up in a few seconds when you create your Freshly Baked NYC account, ask a budtender at checkout in the Bronx or Midtown, or join online before you order delivery. Once you're in, you start earning automatically on every purchase.`,
    answer_sanitized: `It's free to join. Sign up in a few seconds when you create your Freshly Baked account, ask a team member at checkout in the Bronx or Midtown, or join online before you order delivery. Once you're in, you start earning automatically on every purchase.`,
  },
  {
    sourceQuestion: `Do I earn points on delivery as well as in-store and pickup?`,
    question: `Do I earn points on delivery as well as in-store and pickup?`,
    answer_raw: `Yes. Points add up on qualifying purchases no matter how you shop: in store at our Bronx (Arthur Avenue) and Midtown locations, on pickup orders, and on delivery throughout New York City.`,
    answer_sanitized: `Yes. Points add up on qualifying purchases no matter how you shop: in store at our Bronx (Arthur Avenue) and Midtown locations, on pickup orders, and on delivery throughout New York City.`,
  },
  {
    sourceQuestion: `How do I redeem my points?`,
    question: `How do I redeem my points?`,
    answer_raw: `Your points convert into credits you can apply toward future purchases. Sign in to your account or let a budtender know at checkout, and your earned credits come off your order.`,
    answer_sanitized: `Your points convert into credits you can apply toward future purchases. Sign in to your account or let a team member know at checkout, and your earned credits come off your order.`,
  },
  {
    sourceQuestion: `Where are Freshly Baked NYC's locations, and how can I find a dispensary near me?`,
    question: `Where are the Freshly Baked locations, and how can I find a store near me?`,
    answer_raw: `Freshly Baked NYC operates two licensed dispensaries: 2375 Arthur Ave in the Bronx's Little Italy neighborhood and 40 W 55th St in Midtown Manhattan. You can call (212) 729-9333 or email inquiries@freshlybaked.nyc for directions or additional details.`,
    answer_sanitized: `Freshly Baked operates two licensed stores: 2375 Arthur Ave in the Bronx's Little Italy neighborhood and 40 W 55th St in Midtown Manhattan. You can call (212) 729-9333 for directions or additional details.`,
  },
  {
    sourceQuestion: `Is it legal to have weed delivered in NYC?`,
    question: `Is it legal to have an order delivered in NYC?`,
    answer_raw: `Yes, delivery from a state-licensed adult-use cannabis retailer is legal in New York. Our delivery service follows state regulations and tracks all orders through the seed-to-sale system.`,
    answer_sanitized: `Yes, delivery from a state-licensed adult-use retailer is legal in New York. Our delivery service follows state regulations and tracks all orders through the required tracking system.`,
  },
  {
    sourceQuestion: `How does weed delivery work, and which boroughs are covered?`,
    question: `How does delivery work, and which boroughs are covered?`,
    answer_raw: `You can place an order online, and our drivers deliver to the four NYC boroughs where we are licensed: the Bronx, Manhattan, Brooklyn, and Queens. Delivery windows are daily from 4PM to 8PM in the Bronx and from 1PM to 11PM in Manhattan, Brooklyn, and Queens.`,
    answer_sanitized: `You can place an order online, and our drivers deliver to the four NYC boroughs where we are licensed: the Bronx, Manhattan, Brooklyn, and Queens. Delivery windows are daily from 4PM to 8PM in the Bronx and from 1PM to 11PM in Manhattan, Brooklyn, and Queens.`,
  },
  {
    sourceQuestion: `Do you offer same-day weed delivery in the Bronx?`,
    question: `Do you offer same-day delivery in the Bronx?`,
    answer_raw: `Yes, we provide same-day delivery in the Bronx every day between 4PM and 8PM. As a licensed dispensary, we track each order and ensure it arrives within that window.`,
    answer_sanitized: `Yes, we provide same-day delivery in the Bronx every day between 4PM and 8PM. As a licensed store, we track each order and ensure it arrives within that window.`,
  },
  {
    sourceQuestion: `Do I need a medical card to shop at Freshly Baked NYC?`,
    question: `Do I need a medical card to shop at Freshly Baked?`,
    answer_raw: `No, a medical card is not required because Freshly Baked NYC is a recreational dispensary. You can purchase cannabis legally in NYC if you are 21 or older and present a valid ID. Our Baked Out Club loyalty program is free for all adult customers.`,
    answer_sanitized: `No, a medical card is not required because Freshly Baked is a recreational store. You can shop legally in NYC if you are 21 or older and present a valid ID. Our Baked Out Club loyalty program is free for all adult customers.`,
  },
  {
    sourceQuestion: `What ID is required for purchase or delivery?`,
    question: `What ID is required for purchase or delivery?`,
    answer_raw: `All customers must be at least 21 years old and show a government-issued photo ID such as a driver's license, state ID, or passport. This requirement applies to both in-store purchases and delivery, and no medical recommendation or card is needed.`,
    answer_sanitized: `All customers must be at least 21 years old and show a government-issued photo ID such as a driver's license, state ID, or passport. This requirement applies to both in-store purchases and delivery, and no medical recommendation or card is needed.`,
  },
  {
    sourceQuestion: `What are the store hours, and can I pre-order for in-store pickup?`,
    question: `What are the store hours, and can I pre-order for in-store pickup?`,
    answer_raw: `Our Bronx location is open Sun-Thu 11AM-9PM and Fri-Sat 11AM-11PM; the Manhattan store is open Sun-Thu 10AM-12AM and Fri-Sat 10AM-1AM. Both locations let you pre-order online and pick up your order in person. Hours may vary on holidays, so please check ahead if needed.`,
    answer_sanitized: `Our Bronx location is open Sun-Thu 11AM-9PM and Fri-Sat 11AM-11PM; the Manhattan store is open Sun-Thu 10AM-12AM and Fri-Sat 10AM-1AM. Both locations let you pre-order online and pick up your order in person. Hours may vary on holidays, so please check ahead if needed.`,
  },
  {
    sourceQuestion: `Is pay-on-delivery legal?`,
    question: `Is pay-on-delivery legal?`,
    answer_raw: `Yes, you can pay when we bring your order. It's fully legal under New York State cannabis delivery rules, and Freshly Baked NYC is a licensed dispensary, so you can trust the service. Just place your order online and pay at the door.`,
    answer_sanitized: `Yes, you can pay when we bring your order. It's legal under New York State delivery rules, and Freshly Baked is a licensed store, so you can trust the service. Just place your order online and pay at the door.`,
  },
  {
    sourceQuestion: `How can I pay when you deliver?`,
    question: `How can I pay when you deliver?`,
    answer_raw: `When the driver shows up you can pay with cash, a debit card, or ACH. Cash on delivery is fine, and debit card payments carry the same ATM fee we charge in our stores. We process everything at the door; we don't take credit cards.`,
    answer_sanitized: `When the driver shows up you can pay with cash, a debit card, or ACH. Cash on delivery is fine, and debit card payments carry the same ATM fee we charge in our stores. We process everything at the door; we don't take credit cards.`,
  },
  {
    sourceQuestion: `Is there a fee for delivery?`,
    question: `Is there a fee for delivery?`,
    answer_raw: `No, we don't charge a delivery fee. Delivery is free within our NYC delivery area, and you only pay for the product and any payment fees that apply.`,
    answer_sanitized: `No, we don't charge a delivery fee. Delivery is free within our NYC delivery area, and you only pay for the product and any payment fees that apply.`,
  },
  {
    sourceQuestion: `Is there a pay-on-delivery fee?`,
    question: `Is there a pay-on-delivery fee?`,
    answer_raw: `There's no extra fee just for paying on delivery, whether you use cash or ACH. If you use a debit card, the standard ATM fee we apply in our stores will be added. Otherwise the total you see online is what you pay at your door.`,
    answer_sanitized: `There's no extra fee just for paying on delivery, whether you use cash or ACH. If you use a debit card, the standard ATM fee we apply in our stores will be added. Otherwise the total you see online is what you pay at your door.`,
  },
  {
    sourceQuestion: `Why doesn't anyone else offer pay-on-delivery?`,
    question: `Why doesn't anyone else offer pay-on-delivery?`,
    answer_raw: `New York State rules make compliant pay-on-delivery cannabis hard for most businesses. We've built a process that meets those regulations, which is why we are the only licensed dispensary offering it, and it follows all the legal weed delivery requirements for NYC.`,
    answer_sanitized: `New York State rules make compliant pay-on-delivery hard for most businesses. We've built a process that meets those regulations, which is why we are the only licensed store offering it, and it follows all the delivery requirements for NYC.`,
  },
  {
    sourceQuestion: `Anything else I should know?`,
    question: `Anything else I should know?`,
    answer_raw: `Baked Out Club Terms and Conditions apply, and the program may change or update at any time (hopefully to keep getting even better). Check back here for the latest details on levels, bonuses, and rewards.`,
    answer_sanitized: `Baked Out Club Terms and Conditions apply, and the program may change or update at any time (hopefully to keep getting even better). Check back here for the latest details on levels, bonuses, and rewards.`,
  },
]

/**
 * The control-plane FAQ items (question + raw + sanitized) to import,
 * stripped of the provenance-only `sourceQuestion` field.
 */
export function fbNycFaqItemInputs(): FaqItemInput[] {
  return FB_NYC_FAQ_ITEMS.map((item) => ({
    question: item.question,
    answer_raw: item.answer_raw,
    answer_sanitized: item.answer_sanitized,
  }))
}

/**
 * KNOWN ads-policy lint flags on the VERBATIM raw copy that a human must
 * resolve before approval (the import preserves the live `.nyc` copy
 * faithfully rather than silently rewriting it). Asserted by the test so a
 * new accidental flag can never slip in unnoticed.
 */
export const FB_NYC_FAQ_KNOWN_RAW_ADS_FLAGS: ReadonlyArray<{
  readonly itemIndex: number
  readonly field: 'answer_raw'
  readonly category: 'legal'
  readonly phrase: string
}> = [{ itemIndex: 16, field: 'answer_raw', category: 'legal', phrase: 'fully legal' }]

/**
 * Terms kept VERBATIM in the sanitized `.us` variants on purpose: they are
 * the loyalty program's own names + the business's legal/regulatory
 * descriptors, NOT cannabis meta-terms, so they pass the FBUS denylist by
 * design. Surfaced for the human reviewer so the "is this really sanitized?"
 * judgement is explicit rather than implicit (Oracle review note).
 */
export const FB_NYC_FAQ_RETAINED_SANITIZED_TERMS: readonly string[] = [
  // Official Baked Out Club tier names (program identity, shown on `.us`).
  'Baked Out',
  'Properly Toasted',
  'Well Lit',
  'Stoned Immaculate',
  // Legal/regulatory descriptors of the business (not product meta-terms).
  'adult-use retailer',
  'recreational store',
  'medical card',
  'medical recommendation',
]

/** Compact provenance payload stored in the imported set's generation_meta. */
export function fbNycFaqImportMeta(now: Date = new Date()): Record<string, unknown> {
  return {
    kind: 'fb-nyc-faq-import',
    source: FB_NYC_FAQ_SOURCE_PROVENANCE,
    importedAt: now.toISOString(),
    itemCount: FB_NYC_FAQ_ITEMS.length,
    // Reviewer aids — neither blocks import; both inform the human approver.
    knownRawAdsFlags: FB_NYC_FAQ_KNOWN_RAW_ADS_FLAGS,
    retainedSanitizedTerms: FB_NYC_FAQ_RETAINED_SANITIZED_TERMS,
  }
}
