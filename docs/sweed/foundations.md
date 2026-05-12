# Sweed Foundations

Load this first when you need the operational rules that apply across almost every Sweed workflow in this workspace.

Source: `HOW_SWEED_WORKS.md`

## Fast Constants For Common Live Work

- Dealer ids in this workspace: `210248` = Freshly Baked NY (state holder), `210249` = Freshly Baked NYC - The Bronx, `210705` = Freshly Baked NYC - Midtown.
- Default auth token path used by workspace code: `~/.secret/sweed/auth-token` (also `/Users/amp-local/.secret/sweed/auth-token`).
- Before each live read/write block, call `store.auth.dealer.set { dealerId }` and verify `currentDealerId/currentDealerName`.
- For live sales, live inventory, or BI/Cube work, read [`live-data-and-bi.md`](./live-data-and-bi.md) instead of scanning this whole file first.

## API Shape

Sweed uses an RPC-style API over `POST https://prime.sweedpos.com/api/`.

The HAR shows URLs such as:

```text
https://prime.sweedpos.com/api/#type=rac-api&name=store.product.add&id=...
```

The `#type=...&name=...` part is only a URL fragment used by the frontend for debugging. It is not sent to the server.

The real request body is JSON in this shape:

```json
{
  "auth": "<session token>",
  "name": "store.product.add",
  "params": {
    "...": "..."
  },
  "id": "<client-generated uuid>"
}
```

Response shape is usually:

```json
{
  "result": {"...": "..."},
  "id": "<same request id>",
  "version": "prime-..."
}
```

Observed request-validation nuance from live calls on 2026-04-11:

- the top-level RPC `id` is validated by the API schema
- UUID strings worked consistently, and the validation error also said a numeric `id` would be accepted
- arbitrary non-UUID strings such as `"effect-cats"` were rejected before route handling with `Request validation error`

## Authentication

- Requests include an `auth` token in the JSON body.
- The token appears to be session-bound and should be treated as ephemeral.
- Browser cookies are also present in the HAR, so a working script will likely need a live authenticated browser session or a fresh token/cookie set captured from one.
- Do not assume an `auth` token from an old HAR will remain usable.

Observed session-bootstrap flow from the most recent login HAR on 2026-04-12:

- a new session can be created with `store.auth.user` sent to the normal `POST /api/` RPC endpoint
- the login request body did not include an `auth` field
- the captured request shape was:

```json
{
  "name": "store.auth.user",
  "params": {
    "profileTypeId": 1,
    "login": "<user login>",
    "password": "<user password>"
  },
  "id": "<uuid>"
}
```

- the response returned a fresh session token at `result.auth`
- the response also returned `result.initialData`, including the logged-in user profile, current dealer context, and a large rights list
- the captured `initialData.user` included fields such as `currentDealerId`, `currentDealerName`, `defaultCashierStore`, and `tokenLifeTimes`
- in the captured login response, the session landed in dealer context `Freshly Baked NYC - Midtown`, which is evidence that login alone can start in a site-scoped context rather than the state-scoped context needed for some workflows
- this HAR did not include the follow-up call that would switch the new session to another dealer or level, so do not assume successful login alone puts the session at the right operational scope

Practical implication:

- the reliable session-creation sequence is: call `store.auth.user`, extract `result.auth`, then explicitly set the dealer/level needed for the next workflow rather than assuming the login default is correct

Observed login hardening from live auth work on 2026-04-12:

- fresh `store.auth.user` requests now required an `X-Recaptcha-Token` header in this workspace
- replaying the captured login payload without that header did not yield a reusable fresh session
- for automation, extracting a still-valid `auth` token from a recent HAR remained workable when full browser login replay was blocked by reCAPTCHA

Practical implication:

- if a script only needs authenticated read/write access and a recent HAR is available, prefer replaying the active session token over trying to automate the full login form

## Employee Work Hours

Observed live at the Midtown site on 2026-04-29:

- `user.list { page, pageSize }` works in site dealer context and returns the current user roster for that dealer, including each row's `workTimes`, `blocked`, `userStatus`, and `dealers[]` membership.
- `user.manage { id, workTimes }` updates an employee's stored work-hours schedule and returns the refreshed user payload.
- The captured Midtown HAR showed a `user.manage` request whose submitted `workTimes` duplicated `dayOfWeek: 0`, but the response normalized the saved schedule to unique day entries `0` through `5` with `fromTime: 0` and `toTime: 1439`.
- Observed live at the Bronx site on 2026-05-02: a seven-day near-24-hour schedule saved cleanly when `workTimes` included `dayOfWeek` values `0` through `6` with `fromTime: 0` and `toTime: 1439`, so Saturday uses `dayOfWeek: 6` in this workflow.
- In that same Bronx update, `user.manage` returned the new seven-day payload immediately, while an immediate follow-up `user.list` still showed the old six-day payload for a few seconds before catching up.
- For employee-hours automation, treat this as a site-level workflow: switch into the target site with `store.auth.dealer.set`, verify `currentDealerId/currentDealerName`, enumerate users with `user.list`, then apply each update with `user.manage`.

Practical implications:

- Prefer the `user.manage` response payload over the raw request body when a HAR is being used as the source of truth for target `workTimes`, because the frontend request can contain redundant day rows that the backend normalizes away.
- For seven-day delivery or staffing schedules, send explicit `dayOfWeek` rows `0` through `6`; omitting `6` leaves Saturday uncovered.
- After `user.manage`, treat a briefly stale `user.list` response as possible and retry the site-scoped read before assuming the update failed.
- For bulk employee-hours changes, compute the full Midtown user set from `user.list` in Midtown context rather than guessing employee ids from prior notes or hand-entered lists.

## Customer Duplicate Merge Flow

The 2026-04-19 HAR captured the current Sweed customer-merge workflow for duplicate customers.

Observed RPC sequence:

- `store.customer.merge.get { customerIds: ["4494298", "4509706"] }` returned the merge-preview payload for both customer records, including contact data, identities, referral store, and segment membership.
- `store.customer.merge { ... }` then applied the actual upstream merge.

Observed payload shape from `store.customer.merge`:

```json
{
  "auth": "<session token>",
  "name": "store.customer.merge",
  "params": {
    "alertTypeId": 0,
    "firstName": "MICHAEL",
    "lastName": "SHEPARD",
    "referralStoreId": 167,
    "residentialAddress": "WELLSVILLE 172 MAPLE AVE APT 3",
    "phone": "15856190891",
    "customerIds": ["4494298", "4509706"],
    "identityIds": ["1981747", "1992859"],
    "legalPermitIds": [],
    "physicianPermitIds": [],
    "staticSegmentIds": [],
    "name": "MICHAEL SHEPARD"
  },
  "id": "<uuid>"
}
```

Observed result detail:

- the merge response returned the surviving customer payload directly at `result`
- in this capture, the surviving Sweed customer id was `4509706`, even though the request listed both ids and the canonical display name/address values came from the stronger duplicate row
- the response preserved both identity records in the surviving customer's `identities[]`

Practical implications:

- use `store.customer.merge.get` first rather than guessing which fields or identity ids should be sent to `store.customer.merge`
- customer duplicate merges should be treated as a state-level operation in this workspace; follow the standing rule to switch into dealer `210248` (`Freshly Baked NY`) with `store.auth.dealer.set` and verify the returned context before the merge RPC block
- if you maintain a local mirror of Sweed customers, refresh the surviving local row after the merge and remove the superseded local Sweed row so later reconciliation does not keep treating the pair as two active Sweed customers

Observed ETL duplicate lane from the 2026-04-24 duplicate-queue HAR plus live queue analysis:

- the current ETL-created Sweed duplicate queue includes a large safe pair lane that is suitable for automation but should not be conflated with the separate CRM review tooling
- the strict automation-safe lane in this workspace is: exactly two Sweed rows, exact normalized customer name, exact date of birth, the same non-empty email, the same non-empty phone, and exactly one row carrying document records (`identities`, `legalPermits`, or `physicianPermits`)
- in that lane, the document-bearing row should be treated as the preferred canonical customer, while `store.customer.merge.get` should still be used to union static segments and collect the full merge payload before `store.customer.merge`
- a second conservative automation lane was also validated live on 2026-04-24: exact-name + exact-DOB clusters with exactly one document-bearing row, no conflicting address/ZIP/gender/document-number/referral-source signals, and either one shared contact signal across a pair or a conflict-free contact union across a small multi-row cluster; the local script exposes that lane as `--confidence-band remaining-high-confidence`
- a third lower-but-still-deterministic automation lane was validated live later on 2026-04-24: 2-3 row exact-name + exact-DOB clusters with exactly one document-bearing row, at least one contact signal somewhere in the cluster, and no conflicting address/ZIP/gender/document-number/referral-source signals even if email or phone values conflict across rows; the local script exposes that lane as `--confidence-band contact-conflict-high-confidence`
- for that contact-conflict lane, merge payload construction should preserve the preferred canonical row's email/phone when present and only backfill a missing email or phone if the cluster has exactly one unique non-empty value for that field; if contact values conflict and the canonical row is blank, omit that field from the merge payload instead of arbitrarily picking one duplicate's value
- a fourth deterministic automation lane was validated live later on 2026-04-25: 2-3 row exact-name + exact-DOB clusters whose document-bearing rows share the same likely-real document number, while address/ZIP/gender/referral-source remain conflict-free even if multiple document-bearing rows exist; the local script exposes that lane as `--confidence-band shared-document-high-confidence`
- in that shared-document lane, treat a shared document number as "likely real" only when it contains at least 4 digits, which keeps clearly synthetic placeholders like `ICRESPO` or `WRDVVLLI0` out of the auto-apply set
- the local automation entrypoint for this lane is [`customers/merges/auto_merge_high_confidence_etl_duplicates.py`](../../customers/merges/auto_merge_high_confidence_etl_duplicates.py); it defaults to dry-run and only applies live merges with `--apply`

Observed workspace-specific network quirk from the 2026-04-11 full-catalog HTML regeneration:

- identical `POST /api/` reads that were returning a Cloudflare challenge page and HTTP 403 over the IPv6 path began succeeding again when the client forced IPv4 resolution for `prime.sweedpos.com`
- this looked like an edge-path challenge issue, not a payload-shape issue, because the same RPC body and auth token worked once the address family changed
- treat this as an operational workaround for this workspace and time period, not a universal Sweed guarantee

Observed loyalty preset ceiling from live Midtown loyalty work on 2026-04-29:

- `store.loyalty.pointspreset.add` accepted `points: 32700` at Midtown but consistently failed at `points: 32800` and above with `{"code": 5, "message": "Internal API Error", "subcode": 1007}`
- the practical cap appears to be a signed-16-bit-style upper bound around `32767`, even though the API error is not explicit about the real constraint
- when operators ask for dollar-denominated preset ladders at site level, the highest clean `$5`-increment value that fits this observed limit is `$325` (`32500` points)

## Core Objects

The objects we have identified so far are:

- `product group`: the catalog-level product family, such as `Durban Poison x Cherry Tart`
- `product`: the sellable variant, such as `20x 0.35g`
- `distributor product`: the distributor-facing record that links a distributor's item to a Sweed product
- `distributor product price`: dated wholesale pricing for a distributor product
- `purchase order position`: a line item on an incoming purchase order
- `suggested product`: Sweed's best guess at which existing catalog product should map to an unmapped purchase position

## UI Selection Pattern: Labels Versus IDs

Many Sweed UI fields are live-search or typeahead selectors.

This means the visible text in the UI is often just a label, while the value that matters to the API is an internal primary key selected behind the scenes.

Examples:

- a visible size label such as `7g` or `0.35g` is not itself the payload value; the API usually wants a `sizeId`
- a visible distributor name is not the durable value; the API usually wants a `distributorId`
- a visible brand, strain, category, or subcategory label typically maps to an internal ID that must be looked up first

This pattern appears to be common throughout the UI and should be assumed unless a captured request proves otherwise.

Practical implications:

- Do not automate by replaying UI labels directly when the API expects IDs.
- When a form appears to accept free text, verify in the HAR whether the submitted payload contains the label or a looked-up key.
- Preserve both the human-readable label and the resolved ID when documenting or scripting a workflow.
- Expect many automation tasks to require a lookup phase before the create or update call.

## Levels And Scope

Sweed has a notion of operational level or scope.

Examples mentioned so far include:

- `US`
- `NY`
- individual sites such as `Midtown` or `Arthur`

Observed working rule:

- product catalog operations typically happen at the state level
- inventory operations and purchase operations typically happen at the site level

This matters because the same workflow can behave differently depending on the current level selected in the UI.

Practical implications:

- When capturing HARs, note which level the UI was set to.
- When replaying or scripting actions, make sure the session is operating at the correct level for that task.
- Do not assume that data visible at one level is visible or writable at another.
- If an operation appears to fail mysteriously, verify level before assuming the payload is wrong.

Observed programmatic gotcha from live work on 2026-04-11:

- do not assume the session is still at the right dealer from an earlier step in the same script or shell session
- before each distinct operation block, explicitly call `store.auth.dealer.set { dealerId }` for the intended level and confirm the returned `user.currentDealerId` / `user.currentDealerName`
- treat this as required setup, not optional cleanup
- a wrong-level call can look like a real business result instead of an obvious auth failure

Observed example from purchase order `108224`:

- `store.purchase.order.get { id: 108224 }` returned `PurchaseOrder not Found` until the session was switched to the Midtown site dealer `210705`
- `store.distributor.product.suggestion { orderId: 108224 }` from the wrong level returned an empty `orderPositions` array for that same live order
- after switching to `store.auth.dealer.set { dealerId: 210705 }`, the order read succeeded and the suggestion call returned the four real unmapped positions

Observed follow-on nuance from the 2026-04-11 approved outstanding-PO write pass:

- `store.distributor.product.suggestion { orderId }` does not only report positions with zero matches
- once the state catalog rows and distributor-product links existed for orders `108228`, `108269`, and `108270`, the same response still returned `orderPositions[]`, but each row's `products[]` array was populated with candidate products
- practical rule: an empty `products[]` array means "still no current suggestion"; a populated `products[]` array means the catalog gap may already be closed and the remaining task is purchase-side mapping/assignment

Observed omission nuance from the 2026-04-14 pending-order Sushi Hash follow-up on order `108920`:

- purchase position `668221` carried distributor product `390788` named `Sushi Hash Hash-Hole 1g Single Charmz x Jelly Roller Rosin (S)`
- that distributor-product row was already attached to generic placeholder product `240706` / `Preroll Samples Samples`
- the PO row still had `suggestedProduct: null`, so it was operationally unresolved
- `store.distributor.product.suggestion { orderId: 108920 }` omitted that position entirely instead of returning an `orderPositions[]` row with `products: []`
- after a correct state-catalog create for `Sushi Hash Charmz x Jelly Roller Rosin 1g` plus a new linked distributor-product row, the suggestion endpoint still omitted that placeholder-mapped position

Practical rule:

- do not treat `store.distributor.product.suggestion` as a complete unresolved-line inventory when purchase rows may already be attached to generic placeholder products
- for proposal scans and audits, also inspect `store.purchase.order.get().positions[]` for rows whose current mapped product is a known placeholder such as `Preroll Samples Samples` while `suggestedProduct` remains null
- creating the correct catalog row is still useful in that state, but the remaining purchase-side remediation may require a separate assignment API or manual reassignment because the suggestion endpoint may never surface the row automatically

Observed dealer-enumeration detail from live script work on 2026-04-12:

- `store.auth.initial.data.get` exposed the accessible dealer contexts in `user.dealers`
- with the live automation token used in this workspace, that list included the state-level holder `210248` (`Freshly Baked NY`) plus store-level dealers `210249` (`Freshly Baked NYC - The Bronx`) and `210705` (`Freshly Baked NYC - Midtown`)
- after switching into a dealer and re-reading `store.auth.initial.data.get`, the resulting `store.licenseNumber` distinguished store-level contexts from the state-level holder in this environment: the real stores had license numbers, while `Freshly Baked NY` did not
- starting from a site-level context could collapse `user.dealers` down to only the current store; switching back to `store.auth.dealer.set { dealerId: 210248 }` restored the full multi-dealer list for this workspace token

Practical implication:

- for scripts that need to repeat a site-level inventory workflow across every accessible store, first switch to the shared state-level holder if needed so `user.dealers` is complete, then switch and verify each dealer one at a time, and use the follow-up `store.licenseNumber` presence as a store-level filter before running inventory reads or writes
