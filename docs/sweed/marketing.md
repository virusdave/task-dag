# Sweed marketing — events, triggers, discount campaigns, promo actions

> **Source:** reverse-engineered live from `https://prime.sweedpos.com/api/`
> across multiple one-off ops in May 2026 (see
> [`helios/scripts/birthday-event-apply.ts`](../../helios/scripts/birthday-event-apply.ts),
> [`helios/scripts/birthday-event-apply-v2.ts`](../../helios/scripts/birthday-event-apply-v2.ts),
> [`helios/scripts/birthday-imagery-recon.ts`](../../helios/scripts/birthday-imagery-recon.ts),
> [`helios/scripts/promo-daily-apply.ts`](../../helios/scripts/promo-daily-apply.ts)).
> Everything below is Sweed's JSON-RPC over POST. We always call it
> through `callSweedRpc(dealerId, name, params)` inside an active
> `withSweedSession` scope; the surrounding envelope (`auth`, `id`,
> `version`) is handled by the transport
> (see [`helios/src/worker/sweed/rpc.ts`](../../helios/src/worker/sweed/rpc.ts)
> and [`helios/src/worker/sweed/transport.ts`](../../helios/src/worker/sweed/transport.ts)).
>
> Audience: future Helios features that author or operate marketing
> campaigns / events from inside Helios rather than the Sweed Prime UI.

## Dealer-context choice for marketing reads/writes

Sweed marketing objects belong to a dealer; you must pick the right one
**before** the RPC call. Wrong dealer = empty list, or "does not exist
or you do not have permission" error.

| dealer id  | name (Sweed)                  | what lives there                                                             |
| ---------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `210248`   | `Freshly Baked NY`            | **state-level** marketing events and discount campaigns that span both sites |
| `210705`   | `Freshly Baked NYC Midtown`   | Midtown-only events / campaigns / promo actions                              |
| `210249`   | `Freshly Baked NYC - The Bronx` | Bronx-only events / campaigns / promo actions                              |

Use `env.sweedStateDealerId` (defaults to `210248`) for state-level work,
and the site IDs above for store-scoped work. The `withSweedSession` +
`callSweedRpc(dealerId, ...)` pair handles dealer-pinning automatically;
no manual `store.auth.dealer.set` is needed in callers.

A campaign or event whose URL is shown in the Prime UI as
`/marketing/events/event/<id>` or `/marketing/discounts/campaign/<id>`
will only resolve on the dealer that owns it. If you don't know which,
probe `store.promo.campaign.get { id }` (campaigns) or
`store.marketing.event.get { id }` (events) against each candidate
dealer and take the one that returns a non-error result.

## Skip disabled records by default

Per [the helios AGENTS.md disabled-DEAD rule](../../helios/AGENTS.md),
any marketing object whose `enabled === false` (or whose name starts
with `DEAD - …`, `DEAD-`, `DELETED`, `RETIRED`) is operationally
out of service. Filter it out at the list step. Don't try to edit it,
re-schedule it, or treat its presence as an error. The
`promo-daily-apply` script is a worked example: it skips the three
`(unused probe …)` disabled rows in campaign 13119 and logs a
`console.warn` per skip.

---

## 1. Marketing events (Email / SMS / Push to a customer segment)

A "marketing event" is the Sweed concept behind
`https://prime.sweedpos.com/marketing/events/event/<id>`. Each event:

- owns a schedule (`cronExpression`, `startTimeMin`, `fromDate`, `periodType`),
- targets one or more **segments** (e.g. "Birthday is Today"),
- has up to **3 channel triggers** (Push, Email, Text Notification),
  each of which carries its own subject / sender / message body and an
  independent `enabled` toggle.

Worked example throughout this section: event `2232` ("Happy Birthday",
state dealer `210248`, with email + SMS triggers populated by
[`birthday-event-apply-v2.ts`](../../helios/scripts/birthday-event-apply-v2.ts)).

### 1.1 `store.marketing.event.get` — read an event + its triggers

```json
{
  "name": "store.marketing.event.get",
  "params": { "id": "2232" }
}
```

Returns `{ event, triggers }`. Notable fields on `event`:

| field                  | example                                              | meaning                                                       |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `id`                   | `"2232"`                                             | event id                                                      |
| `dealerId`             | `210248`                                             | owning dealer (always matches the calling context)            |
| `name`                 | `"Happy Birthday"`                                   | operator-visible label                                        |
| `enabled`              | `true`                                               | master on/off; per-channel `enabled` overrides this           |
| `cronExpression`       | `"0 0 * * * *"`                                      | Sweed 6-field cron `sec min hour dom month dow`               |
| `startTimeMin`         | `660`                                                | minutes-after-midnight **UTC** for this event's send time     |
| `fromDate`             | `"2026-05-26T00:00:00Z"`                             | first eligible day                                            |
| `periodType`           | `"Daily"` / `"Once"` / `"Weekly"` / ...              | repetition kind                                               |
| `nextEventDate`        | `"2026-05-27T11:00:00Z"`                             | Sweed's computed next fire (read-only)                        |
| `segments`             | `[{ id: "1531", name: "Birthday is Today" }]`        | audience                                                      |
| `excludeSegments`      | `[]`                                                 | exclusion audience                                            |
| `ignoreGlobalLimits`   | `true`                                               | bypass the global per-customer marketing throttles            |
| `smsMmsAllowedTimeWindow` | `{ startTimeMin: 510, endTimeMin: 1200 }`         | CTIA quiet-hour window for the SMS trigger                    |
| `state`                | `{ id: 6, name: "Didn't send" }`                     | Sweed lifecycle state (see below)                             |
| `stateDescriptions`    | `["Old event"]`                                      | human-readable hints alongside `state`                        |
| `channels`             | `[{ id, actionTypeId, name, enabled }, ...]`        | per-channel enabled summary (mirrors `triggers[].enabled`)    |

`triggers` is an array, one per channel (Push, Email, Text Notification —
even when the channel is disabled). Each trigger carries:

| trigger field           | example                                              | meaning                                                                     |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `id`                    | `"25921"`                                            | trigger id, used by `store.marketing.trigger.action.edit`                   |
| `actionType.id`         | `2` / `3` / `5`                                      | Push / Email / Text Notification                                            |
| `enabled`               | `true`                                               | channel toggle (drives `event.channels[].enabled`)                          |
| `messageHeaderText`     | `"🎂 Happy Birthday — …"`                            | email subject                                                                |
| `messageText.design`    | base64(unlayer-JSON)                                 | Unlayer editor's document (decoded → schema v21 JSON)                       |
| `messageText.html`      | base64(rendered HTML)                                | what's actually delivered                                                    |
| `sender`                | `{ id, name, email }`                                | Email only: approved sender record                                          |
| `approvedTemplate`      | `{ id: 223, name: "…" }`                             | SMS only: required Sweed-approved template                                  |
| `approvedImage`         | `{ id: "<uuid>", imageUrl }`                         | SMS only: approved image attachment                                         |
| `pushAction`            | `{ id, name, hint, payloadMetadata }`                | Push only: click action                                                     |
| `lastUpdated`           | `"2026-05-26T15:36:44Z"`                             | server-side `mtime`                                                          |

#### `actionType.id` cheat-sheet

| id  | channel              |
| --- | -------------------- |
| `2` | Push                 |
| `3` | Email                |
| `5` | Text Notification    |

#### `event.state.id` cheat-sheet (observed values)

| id  | name           | what it means                                                                  |
| --- | -------------- | ------------------------------------------------------------------------------ |
| `6` | `Didn't send`  | The event's `fromDate` / `startTimeMin` window has already passed without a fire. Bumping `fromDate` + `cronExpression` + `startTimeMin` (to ≥ 5 min in the future) clears it. |

(Other ids — `Scheduled`, `Sent`, etc. — exist but weren't sampled in
the May 2026 sessions; record them here when next observed.)

### 1.2 `store.marketing.event.list`

```json
{
  "name": "store.marketing.event.list",
  "params": { "page": 1, "pageSize": 50 }
}
```

Returns `{ data: EventListRow[], totalCount }`. Each row is a slim
projection of the event (`id`, `name`, `enabled`, schedule fields) and
**does not** include `triggers`. To read trigger content, follow up
with `store.marketing.event.get { id }`.

Used by [`birthday-imagery-recon.ts`](../../helios/scripts/birthday-imagery-recon.ts)
to walk every event on every dealer, then crib image URLs and design
JSON out of each email trigger.

### 1.3 `store.marketing.event.add` — create an event

```json
{
  "name": "store.marketing.event.add",
  "params": {
    "enabled": true,
    "name": "midtown-delivery",
    "cronExpression": "0 0 15 4 * 2026",
    "fromDate": "2026-04-15",
    "startTimeMin": 900,
    "segments": ["7752"]
  }
}
```

Sweed auto-creates one trigger per channel (Push / Email / Text)
disabled by default; populate them with
`store.marketing.trigger.action.edit` afterwards.

### 1.4 `store.marketing.event.edit` — schedule / audience changes

```json
{
  "name": "store.marketing.event.edit",
  "params": {
    "id": "1890",
    "enabled": true,
    "name": "midtown-delivery-rain-or-shine-2026-04-26",
    "fromDate": "2026-04-26",
    "cronExpression": "0 0 26 4 * 2026",
    "startTimeMin": 720,
    "segments": ["7906", "7926", "7942", "7944", "7946", "7948", "7950"]
  }
}
```

**Schedule-recovery pattern (event stuck in `state.id = 6` "Didn't send"):**
update `fromDate`, `cronExpression`, and `startTimeMin` together with a
time at least 5 minutes in the future of the call. Updating any of those
three in isolation will be silently accepted but won't move the event
out of "Didn't send".

### 1.5 `store.marketing.trigger.action.edit` — write a trigger's content

This is what populates the email body, SMS body, or push payload.
Partial edits are accepted — pass only the fields you want changed.

#### Email trigger

```json
{
  "name": "store.marketing.trigger.action.edit",
  "params": {
    "id": "25921",
    "enabled": true,
    "messageHeaderText": "🎂 Happy Birthday — your 5% gift inside",
    "sender": {
      "id": "9e09e1c4-c0f2-44ca-a81d-e0766f34f2f6",
      "name": "Freshly Baked NYC",
      "email": "support@freshlybaked.nyc"
    },
    "messageText": {
      "design": "<base64(JSON.stringify(unlayerDesign))>",
      "html":   "<base64(renderedHtml)>"
    }
  }
}
```

- `messageText.design` and `messageText.html` are **base64-encoded
  strings on the wire**, even though the Sweed Prime UI shows them as
  parsed JSON / HTML. Use `Buffer.from(value, 'utf8').toString('base64')`
  on the producer side and `Buffer.from(value, 'base64').toString('utf8')`
  on the consumer side. The
  [`birthday-event-apply.ts`](../../helios/scripts/birthday-event-apply.ts)
  `b64()` helper is the canonical reference.
- `messageText.design` decoded is an Unlayer editor document with
  `"schemaVersion": 21` and the standard `body.rows[].columns[].contents[]`
  hierarchy (block `type`s observed: `heading`, `text`, `image`,
  `button`, `divider`, `menu`, `social`, `video`).
- `messageText.html` decoded is the rendered HTML email body. Sweed
  delivers this to the customer; the design is only used when an
  operator later re-opens the trigger in the UI.
- **QA**: after a write, fetch `event.get` and decode both fields. The
  preheader sometimes drifts independently — `messageText.design.body.values.preheaderText`
  vs the `<span style="display:none">` inside the HTML.
- `sender` requires `{ id, name, email }`. Get the `id` from an existing
  trigger's `sender` field; you cannot make one up. The
  Freshly-Baked-NYC sender id `9e09e1c4-c0f2-44ca-a81d-e0766f34f2f6`
  is the only approved one on the state dealer as of May 2026.

##### Recipe: surgical hero accent + FAQ CTA swap

When an email is already polished/operator-edited and you only need a
small, non-destructive touch-up (add the brand hero accent; repoint a
CTA), edit the live trigger **in place** rather than regenerating — that
preserves every operator edit exactly.
[`event-emails-hero-divider-and-faq.ts`](../../helios/scripts/event-emails-hero-divider-and-faq.ts)
is the worked example. It:

1. Inserts a gold leaf-divider hero accent (`&#127811;` flanked by two
   `#e8b265` rules) directly under the logo, into **both**
   `messageText.html` and `messageText.design`. Idempotent via an
   `fbnyc-hero-divider` HTML-comment marker.
2. Handles both email origins: hand-authored 560px table cards (anchor:
   the eyebrow comment) and Unlayer `u-row-container` layouts (insert a
   mimic row before the 2nd container / at design row index 1).
3. (Optional, `--no-swap` to skip) repoints only the **"Learn More"** CTA
   button hrefs to the FAQ url, leaving the logo's home link and any
   other URL untouched.

It is content-only (canon §1): never changes enabled state, schedule,
segment, or channel. Always `--dry-run` first and eyeball the
`/tmp/preview-email-<id>.html` it writes. After polishing the email this
way, propagate to SMS with the copy-to-rich-SMS recipe below so the SMS
inherits the same accent and (already-swapped) CTA URLs.

#### SMS / Text Notification trigger

SMS is gated: messageText is rejected unless an approved template and
image are attached first.

```json
{
  "name": "store.marketing.trigger.action.edit",
  "params": {
    "id": "25922",
    "approvedTemplateId": 223,
    "approvedImageId": "2019999f-f859-4b52-c58b-08de9cc488b6"
  }
}
```

…then a follow-up call with `messageText.design` / `messageText.html`.

- `approvedTemplateId: 223` corresponds to Sweed-side template
  `"New updates! See what's happening 💡"` and is the catch-all template
  we use for non-promo SMS. Sweed populates the trigger `name` and
  `messageHeaderText` from the template — those values are not what the
  customer sees; the actual SMS body comes from `messageText.html`.
- `approvedImageId: "2019999f-f859-4b52-c58b-08de9cc488b6"` is the
  **sanitized (cannabis-stripped) gold-coin FBNYC SMS image** — a
  carrier-safe asset with no cannabis leaf/product imagery. Resolves to
  `https://media-prime.sweedpos.com/store/prime/1776460022_babde2d7-1180-4cde-a555-91259b53df90.png`.
  Treat the `approvedImage` field as carrier-facing/compliance-sensitive:
  for cannabis campaigns use a sanitized image here unless the operator
  has specifically approved otherwise.

> **SMS bodies ARE rich (do not "keep it minimal").** An earlier version
> of this doc claimed SMS content should be a single `<p>` text block
> because "Sweed doesn't render the Unlayer design for SMS." **That is
> wrong.** Text Notification triggers (`actionType.id === 5`) carry the
> same rich `messageText.design` + `messageText.html` shape as email
> triggers, and live *enabled* SMS triggers across our dealers commonly
> hold full marketing creative (images, headings, buttons, styled HTML at
> 500–600px Unlayer layouts; 25k–43k bytes is normal). A plain `<p>` body
> is only a fallback/anomaly. See the recipe below.

##### Recipe: copy a polished email into a rich SMS

This is a **recurring activity** ("make the SMS match the polished
email"). The canonical, automated way is
[`sweed-copy-email-to-rich-sms.ts`](../../helios/scripts/sweed-copy-email-to-rich-sms.ts),
which copies the email trigger's exact `messageText` onto the SMS trigger:

```bash
DATABASE_URL=postgres://... npx tsx scripts/sweed-copy-email-to-rich-sms.ts \
  --event-id 2474 \
  [--dealer state|midtown|bronx | --dealer-id 210248] \
  [--email-trigger-id 27544] [--sms-trigger-id 27545] \
  [--approved-template-id 223] \
  [--approved-image-id 2019999f-f859-4b52-c58b-08de9cc488b6]
```

What it does (and the manual steps, if you ever do it by hand):

1. Polish + review the **email** trigger first; it is the single source
   of truth for the creative.
2. Attach the SMS-approved template + (carrier-safe) image to the SMS
   trigger — this gates the `messageText` write.
3. Copy the email's `messageText.design` and `messageText.html`
   **as the raw base64 strings, byte-for-byte**. Do NOT decode and
   re-encode (risks double-base64 / drift); decode only to validate.
4. Leave the SMS trigger `enabled: false` (canon §1 — no unreviewed
   sends). The script refuses to overwrite an already-enabled SMS trigger
   without `--force`, and never touches the event's enabled state,
   schedule, segment, or channels.
5. Do **not** copy email-only fields to SMS: not the `sender`, and not
   the email subject into the SMS `messageHeaderText` (the approved
   template owns SMS naming/header metadata, which the customer does not
   see).

**Logo / cannabis nuance:** keep the carrier-safe sanitized image in
`approvedImage`. The rich `messageText.html` copied from the email may use
the **standard** brand creative (including the leaf logo) when the
operator has approved that creative — live rich SMS examples support this.
But do not assume the rich HTML is invisible to carriers (Sweed may
render/host/transform it for MMS/RCS/rich delivery); if deliverability or
filtering issues appear, switch the rich SMS body to sanitized creative
too.

#### Disabling a trigger

```json
{ "name": "store.marketing.trigger.action.edit",
  "params": { "id": "25922", "enabled": false } }
```

Per-trigger `enabled: false` disables that one channel; the event's
master `enabled` stays on so the other channels continue.

### 1.6 Cribbing imagery from existing events

For brand-consistent emails, recon then crib. The canonical assets
found in May 2026 across Midtown + Bronx events:

| asset                                                                 | url                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| FBNYC digital logo (header, used everywhere)                          | `https://assets.unlayer.com/projects/12653/1776278193560-LOGO%20-%20FBNYC%20logo%20midtown%20-%20digital.png`                             |
| FBNYC faded logo (alt)                                                | `https://assets.unlayer.com/projects/12653/1776368349719-FBNYC%20-%20Logo%20faded.png`                                                    |
| FBNYC round logo (Bronx variant)                                      | `https://freshlybaked.nyc/wp-content/uploads/2024/01/FB-Logo-round2.png`                                                                  |
| FBNYC gold leaf logo (SMS approvedImage)                              | `https://media-prime.sweedpos.com/store/prime/1776460022_babde2d7-1180-4cde-a555-91259b53df90.png`                                        |
| Standard Instagram / Facebook circle icons                            | `https://cdn.tools.unlayer.com/social/icons/circle/instagram.png` / `…/facebook.png`                                                      |

Brand palette in current emails:

| token                  | value      | usage                              |
| ---------------------- | ---------- | ---------------------------------- |
| page background        | `#161111`  | outer body                         |
| card background        | `#1d1514`  | content card on top of page bg     |
| primary text (cream)   | `#f7eee8`  | headings on dark card              |
| secondary text         | `#eadfd6`  | body copy on dark card             |
| gold accent            | `#e8b265`  | banner pills, CTA buttons, links   |
| dark text on gold      | `#2b1f1a`  | text inside gold banners / buttons |
| caption / footer text  | `#8a7e74`  | compliance line                    |
| card-radius            | `30px`     | outer card; `20px` for inner pill  |
| heading font           | Georgia    | serif H1                           |

[`birthday-imagery-recon.ts`](../../helios/scripts/birthday-imagery-recon.ts)
re-runs this lookup whenever fresh assets are needed (it walks every
dealer's events and prints unique image URLs per email trigger).

### 1.7 Compliance lines we always include

Per Sweed compliance + the NY OCM marketing rules, every customer-facing
marketing email must end with at minimum:

> Consume responsibly. Cannabis can be addictive.

Per-store license footer (when the email is store-scoped):

- Midtown: `OCM-RETL-26-000488`
- Bronx: `OCM-CAURD-24-000137`

State-level (cross-store) emails default to the addiction-warning line
alone unless the operator says otherwise.

---

## 2. Discount campaigns and promo actions

Campaigns at `https://prime.sweedpos.com/marketing/discounts/campaign/<id>`
are managed via the `store.promo.*` namespace.

Worked example: campaign `13119` ("SmokeShopConquest") on Bronx dealer
`210249`, brought onto a daily-recurring schedule by
[`promo-daily-apply.ts`](../../helios/scripts/promo-daily-apply.ts).

### 2.1 `store.promo.campaign.get` — read a campaign header

```json
{ "name": "store.promo.campaign.get", "params": { "id": "13119" } }
```

Returns just campaign metadata (no actions):

```json
{
  "stores": [],
  "originator": { "id": 210249, "name": "Freshly Baked NYC - The Bronx" },
  "distributionLevel": { "id": 1, "name": "Current store" },
  "name": "SmokeShopConquest",
  "id": "13119",
  "fromDate": "2026-05-23T00:00:00Z",
  "enabled": true
}
```

`distributionLevel.id`:

| id  | name             | meaning                                              |
| --- | ---------------- | ---------------------------------------------------- |
| `1` | `Current store`  | applies only at the originator dealer                |
| `3` | `All stores`     | applies cross-store (originator = state dealer often)|

### 2.2 `store.promo.campaign.list`

```json
{ "name": "store.promo.campaign.list", "params": { "page": 1, "pageSize": 100 } }
```

Returns `{ data: CampaignRow[] }`. Same fields as `.get`.

### 2.3 `store.promo.action.list` — promo actions inside a campaign

```json
{
  "name": "store.promo.action.list",
  "params": { "campaignId": "13119", "page": 1, "pageSize": 100 }
}
```

`campaignId` is **required** (validated server-side; omitting it
yields `Parameters validation error`). The parameter is camelCase
singular `campaignId` — `campaignIds` and `campaign` both fail.

Returns `{ page, pageSize, totalCount, data: ActionRow[] }`. The
`ActionRow` is rich; notable fields:

| field                          | example                                       | meaning                                                                  |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------ |
| `id`                           | `"45603"`                                     | promo-action id (= the URL-bar id in `/discounts/action/<id>` etc.)      |
| `name` / `shortName`           | `"$25.00 Herb 3.5g Durban Poison"`            | operator-visible labels                                                  |
| `campaignId` / `campaignName`  | `"13119"` / `"SmokeShopConquest"`             | parent campaign                                                          |
| `enabled`                      | `true`                                        | per-action toggle (independent of campaign.enabled)                      |
| `fromDate`                     | `"2026-05-23T00:00:00Z"`                      | earliest applicable day                                                  |
| `toDate`                       | `"2026-04-21T23:59:59Z"`                      | (optional) latest applicable day; omitted = open-ended                   |
| `cronExpression`               | `"0 0 * * * *"` / `null`                      | 6-field `sec min hour dom month dow` recurrence (see § 2.5)              |
| `startTimeMin` / `endTimeMin`  | `480` / `960`                                 | (optional) daily time-of-day window in minutes-from-midnight             |
| `dates`                        | `[]`                                          | array of specific-date overrides; not used for recurring (always `[]`)   |
| `actionType.id`                | `3`                                           | `1` = % off, `2` = $ off, `3` = promo price (override SKU price), …      |
| `applicationStep.id`           | `1`                                           | `1` = Discount, others observed but not catalogued                       |
| `applicationTarget.id`         | `1`                                           | `1` = Product (apply to specific SKUs)                                   |
| `actionMixAndMatchType.id`     | `1`                                           | `1` = Best for customer (favoured choice)                                |
| `promoPrice`                   | `25`                                          | only set when `actionType.id === 3`                                      |
| `discountPercent`              | `20`                                          | only set when `actionType.id === 1`                                      |
| `getSelectors[]`               | see below                                     | the product matchers (one per applicable SKU set)                        |
| `targetStoreNames`             | `["All stores"]`                              | derived from `getSelectors[].distributionLevel`                          |
| `originator`                   | `{ id, name }`                                | dealer the action was authored on                                        |
| `displayInEcommerceProducts`   | `true`                                        | toggles the badge on the e-commerce menu                                 |
| `isBonusLoyaltyQualifying`     | `true`                                        | counts toward loyalty bonus accrual                                      |

`getSelectors[]` is the product matcher:

```json
{
  "products": [{ "id": "437913", "name": "Herb 3.5g Durban Poison" }],
  "applicationMode": { "id": 2, "name": "Any product" },
  "distributionLevel": { "id": 3, "name": "All stores" },
  "selectorType": { "id": 1, "name": "Get selector" },
  "stackType": { "id": 1, "name": "Or" },
  "actionId": "45603",
  "id": "33372",
  "enabled": true,
  "productCount": 1,
  "selectorData": "<base64(JSON.stringify(react-query-builder document))>"
}
```

`selectorData` decoded is the JSON document of the Sweed product
rule-builder (e.g. `{"field":"productsIds","operator":"equal","value":[...]}`).

### 2.4 `store.promo.action.get` — single promo action

Same shape as a list row. Use when you only need one.

### 2.5 `store.promo.action.edit` — schedule / enable / content

Partial edits supported. The most common Helios operation will be
toggling a schedule:

```json
{
  "name": "store.promo.action.edit",
  "params": { "id": "45603", "cronExpression": "0 0 * * * *" }
}
```

Common `cronExpression` shapes observed in production:

| cron                    | meaning                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `"0 0 * * * *"`         | **every day, all day** (the default Helios should produce for "daily")   |
| `"0 0 * * 1-4 *"`       | Mon-Thu (used with `startTimeMin`/`endTimeMin` for time-windowed deals)  |
| `"0 0 26 4 * 2026"`     | one-shot — April 26 2026 (used for marketing-event one-time fires)       |

When `cronExpression = "0 0 * * * *"` and `startTimeMin` / `endTimeMin`
are omitted/null, the action is in effect the entire day, every day —
that's what [`promo-daily-apply.ts`](../../helios/scripts/promo-daily-apply.ts)
sets across the 7 enabled actions in campaign 13119.

To bound a daily action to a time window, send both
`startTimeMin` (minutes after midnight, store-local timezone) and
`endTimeMin` together with the cron. The `Happy Hour` campaign on
Bronx (cron `"0 0 * * 1-4 *"`, `startTimeMin: 480`, `endTimeMin: 960`)
is the canonical example: Mon-Thu 8am-4pm.

### 2.6 Common gotchas

- **List endpoint hides cron.** `store.promo.action.list` and
  `store.promo.action.get` only include `cronExpression` /
  `startTimeMin` / `endTimeMin` when they're set; if the rows your
  Helios feature is iterating come back without those keys, treat
  them as null, not as a Sweed bug.
- **Per-dealer permission errors.** Hitting `store.promo.campaign.get`
  on the wrong dealer returns `Campaign does not exist or you do not
  have permission` — the same error covers "wrong dealer" and "really
  doesn't exist". Always probe across `[210248, 210705, 210249]` when
  the dealer isn't known up front.
- **Disabled actions appear in `.list` results.** Filter `enabled ===
  false` out at the call site; per AGENTS.md treat them as DEAD.
- **`dates` is for one-shot overrides.** None of the recurring promos
  in production use `dates`. If a future Helios feature wants
  "tomorrow only", set `dates` and skip `cronExpression`; for
  "every day", use `cronExpression`.

---

## 2b. Customer segments — membership reads

Helios caches Sweed marketing-segment membership (migration
`059_sweed_customer_segments.sql`; tables `sweed_customer_segments`,
`sweed_marketing_segments`). Wrappers in
[`customers.ts`](../../helios/src/worker/sweed/customers.ts). Three read
RPCs, by direction:

### `store.marketing.segment.list { page, pageSize }` — the catalog

Dealer-CONTEXT-scoped. From the state dealer it returns every segment
across stores (site-specific ones carry their store in
`targetStoreNames`); the static segments (delivery zones, imports) only
appear under the SITE dealer that owns them — so Helios fans the call
out across state + both sites (`listSweedMarketingSegmentsCatalogForDealers`).
Row: `{ id, name, type:{id,name}, enabled, totalCustomers, targetStoreNames[] }`.

### `store.customer.segment.list { id }` — one customer → their segments

VERIFIED context-independent: returns a customer's FULL membership
regardless of pinned dealer; each row's `dealer.id` is the segment's
owning scope (`210248` = state/all-stores, `210705` = Midtown,
`210249` = Bronx). One RPC PER CUSTOMER, so this is the
on-demand / details-page path only — it never gives complete coverage.

### `store.marketing.segment.get { id }` — one segment → its DEFINITION

Returns the segment's metadata + rule, NOT its members:
`{ id, name, type, enabled, ruleData, distributionLevel, accountForType,
stores, totalCustomers, targetStoreNames }`. `ruleData` is base64 JSON —
the dynamic-segment rule (e.g. `customer.ticketsOnline = 0 AND
customer.hasAccount = 1`). Use this for segment metadata / sizing
(`totalCustomers`), not membership.

### `store.marketing.segment.result.list { id, page, pageSize }` — one segment → ALL its members (BULK)

The efficient inverse: paginated, returns every customer IN a segment
(works for DYNAMIC rule segments too — Sweed materialises the result
set). This is how Helios populates membership COMPLETELY
(O(#segments × pages) RPCs instead of O(#customers)) —
`getSweedMarketingSegmentMembers` → `snapshotSegmentMembers` →
`refreshSegmentMembershipBulk` →
[`scripts/refresh-segment-members-bulk.ts`](../../helios/scripts/refresh-segment-members-bulk.ts)
(dry-run by default). It is the "result" family — sibling of the
verified add RPC `store.marketing.segment.result.add`.

VERIFIED shape (live probe, segment 1532 @ state dealer 210248):

```jsonc
{ "total": 1412, "withEmail": …, "withPhone": …, "lastUpdated": "…",
  "customers": { "page": 1, "pageSize": 500, "totalCount": 1412,
    "data": [ { "customerId": "404200",  // STRING
                "customerName": "…", "dateOfBirth": "…", "age": 36,
                "dateOnEnter": "2025-07-15T12:34:56Z",
                "genderType": {…}, "hasEmail": …, "hasPhone": … }, … ] } }
```

Helios caches only `customerId` + `dateOnEnter` (the rest is PII).
Sibling guesses (`segment.result.get`, `segment.customer.list`,
`segment.member.list`) all return "Action is not available". The page
parser (`parseSegmentResultPage`) is fail-closed — it throws on an
unrecognised envelope so a bulk snapshot can never wipe a segment's
membership from a parse miss. Spot-check with
[`scripts/probe-sweed-segment-members.ts`](../../helios/scripts/probe-sweed-segment-members.ts)
`<segmentId> [dealerId]`.

---

## 3. Reference scripts in the repo

These one-offs live in [`helios/scripts/`](../../helios/scripts/) and
double as worked references for the patterns above. They are safe to
re-run (read-only ones especially) and to copy/adapt:

| script                                                                                                       | purpose                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [`birthday-event-recon.ts`](../../helios/scripts/birthday-event-recon.ts)                                    | dumps event 2232 (state-dealer) and its triggers — pattern for `store.marketing.event.get`       |
| [`birthday-event-apply.ts`](../../helios/scripts/birthday-event-apply.ts)                                    | v1 of the email/SMS populate flow on event 2232 — minimal HTML, shows the b64 round-trip         |
| [`birthday-event-apply-v2.ts`](../../helios/scripts/birthday-event-apply-v2.ts)                              | v2 with FBNYC brand chrome — cribs design vocabulary from Midtown 420 event 1804                  |
| [`birthday-imagery-recon.ts`](../../helios/scripts/birthday-imagery-recon.ts)                                | walks every event on every dealer and prints image URLs — use to discover brand assets           |
| [`promo-daily-apply.ts`](../../helios/scripts/promo-daily-apply.ts)                                          | enumerates promo actions in a campaign, skips disabled, sets `cronExpression` to daily-all-day   |

When Helios grows a first-class "Marketing" surface, it should grow
new TypeScript wrappers under `helios/src/worker/sweed/marketing.ts`
mirroring [`customers.ts`](../../helios/src/worker/sweed/customers.ts)'
shape (named constants for RPC method strings, Zod parsers around
responses), and these one-offs should be retired in its favour.
